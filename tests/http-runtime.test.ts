import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { Previews } from '../src/server/preview.ts';
import { Codex } from '../src/server/codex.ts';
import { createApp } from '../src/server/app.ts';
import type { ConversationPage } from '../src/shared/types.ts';

class RuntimeCodex extends Codex {
  override async start() {}
  override async stop() {}
  override async modelCapabilities() {
    return [
      {
        id: 'runtime-model',
        model: 'runtime-model',
        provider: 'fixture-provider',
        displayName: 'Runtime fixture',
        reasoning: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
        reasoningEfforts: ['low'],
      },
    ];
  }
  override async probe() {
    return {
      backend: 'codex',
      protocol: 'fixture',
      models: await this.modelCapabilities(),
      capabilities: {
        sessions: true,
        streaming: true,
        steering: true,
        followUp: true,
        abort: true,
        images: true,
        hostTools: true,
        usage: true,
        accountAllowance: true,
        modelListing: true,
        nestedAgents: false,
        extensions: false,
        rules: false,
        skills: false,
      },
      allowance: { status: 'available' as const },
    };
  }
  override async accountAllowance() {
    return { status: 'available' as const };
  }
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  await mkdir(join('.phantom', 'test'), { recursive: true });
  const root = await mkdtemp(join('.phantom', 'test', 'http-runtime-'));
  const store = new Store(join(root, 'state.sqlite'));
  const workspaces = new Workspaces(root, store);
  const engine = new Engine(store, new GitHub(store), workspaces, root);
  const app = createApp(
    store,
    engine,
    new Previews(store, workspaces),
    4317,
    () => new RuntimeCodex(),
  );
  t.after(async () => {
    await app.close();
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
  const headers = {
    host: '127.0.0.1:4317',
    cookie: String(session.headers['set-cookie']).split(';')[0],
    'x-phantom-csrf': session.json().csrf,
  };
  const request = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: Record<string, unknown> | string | Buffer,
    extra?: Record<string, string>,
  ) =>
    app.inject({
      method,
      url: '/api' + url,
      headers: { ...headers, ...extra },
      ...(payload === undefined ? {} : { payload }),
    });
  return { app, store, request };
}

test('HTTP PM history is bounded on initial state, refresh and cursor pages', async (t) => {
  const { store, request } = await fixture(t);
  const project = store.createProject('Bounded history', '');
  const other = store.createProject('Other history', '');
  const foreign = store.addMessage(other.id, 'user', 'private');
  const expected: string[] = [];
  for (let index = 0; index < 1003; index++) {
    const message = store.addMessage(project.id, 'user', `full body ${index}`);
    store.updateMessage(message.id, { createdAt: '2026-01-01T00:00:00.000Z' });
    expected.push(message.id);
  }
  const get = async (query = '') => {
    const response = await request('GET', `/projects/${project.id}/messages${query}`);
    assert.equal(response.statusCode, 200);
    return response.json<ConversationPage>();
  };
  const state = await request('GET', '/state?messages=none');
  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.json().messages, []);
  assert.deepEqual(state.json().activities, []);
  const first = await get();
  assert.deepEqual(
    first.entries.map((entry) => entry.cursor),
    expected.slice(-50),
  );
  assert.equal(first.hasBefore, true);
  assert.equal(first.hasAfter, false);
  const cursor = first.entries[0]!.cursor;
  const arrival = store.addMessage(project.id, 'assistant', 'New reply');
  let page = first;
  const history = page.entries.map((entry) => entry.cursor);
  while (page.hasBefore) {
    page = await get(`?before=${page.entries[0]!.cursor}`);
    assert.ok(page.entries.length <= 50);
    history.unshift(...page.entries.map((entry) => entry.cursor));
  }
  assert.deepEqual(history, expected);
  assert.deepEqual(
    (await get(`?after=${expected.at(-1)}`)).entries.map((entry) => entry.cursor),
    [arrival.id],
  );
  store.updateMessage(expected[10]!, { content: 'updated queued message', status: 'completed' });
  const refreshedIds = await get(`?ids=${expected.slice(0, 50).join(',')}`);
  const changed = refreshedIds.entries[10]!;
  assert.equal(changed.kind, 'message');
  if (changed.kind === 'message') {
    assert.equal(changed.value.content, 'updated queued message');
    assert.equal(changed.value.status, 'completed');
  }
  const cross = await request('GET', `/projects/${other.id}/messages?before=${cursor}`);
  assert.equal(cross.statusCode, 403);
  const crossIds = await request('GET', `/projects/${project.id}/messages?ids=${foreign.id}`);
  assert.equal(crossIds.statusCode, 403);
  const unauthenticated = await request('GET', `/projects/${project.id}/messages`, undefined, {
    cookie: '',
  });
  assert.equal(unauthenticated.statusCode, 401);
  const invalid = await request(
    'GET',
    `/projects/${project.id}/messages?before=${cursor}&after=${cursor}`,
  );
  assert.equal(invalid.statusCode, 400);
  const oversized = await request(
    'GET',
    `/projects/${project.id}/messages?ids=${Array(51).fill(cursor).join(',')}`,
  );
  assert.equal(oversized.statusCode, 400);
  const refreshed = await request('GET', '/state?messages=none');
  assert.equal(refreshed.body.includes('full body'), false);
  assert.equal(store.list('message').length, 1005);
});

test('HTTP review answers stay Project-scoped, persist partial answers and never auto-resume an independent pause', async (t) => {
  const { store, request } = await fixture(t);
  const project = store.createProject('Review answers', '');
  const other = store.createProject('Other', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'fixture',
    path: '/fixture',
    github: 'fixture/repo',
    defaultBranch: 'main',
    authorized: true,
  });
  const source = store.addMessage(project.id, 'user', 'Implement', 'implement');
  const task = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: source.id,
    title: 'Review fixture',
    spec: 'Implement',
    acceptance: ['Done'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  const pinned = store.updateTask(task.id, { stage: 'reviewing', head: 'head', base: 'base' });
  const run = store.run('review', project.id, 'review', pinned, {
    reviewAxis: 'secondary',
    secondaryReview: true,
  });
  const c = store.recordReviewClarification(run.id, {
    approved: false,
    verdict: 'needs_user',
    summary: 'Need policy',
    findings: [],
    head: 'head',
    base: 'base',
    questions: [{ question: 'Which audience?' }, { question: 'Which retention period?' }],
  });
  const path = `/projects/${project.id}/clarifications/${c.id}/answer`;
  assert.equal(
    (
      await request('POST', `/projects/${other.id}/clarifications/${c.id}/answer`, {
        answers: [{ questionId: 'q1', value: 'A' }],
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await request('POST', path, { answers: [{ questionId: 'q1', value: '  ' }] })).statusCode,
    400,
  );
  assert.equal(
    (await request('POST', path, { answers: [{ questionId: 'unknown', value: 'A' }] })).statusCode,
    400,
  );
  const partial = await request('POST', path, { answers: [{ questionId: 'q1', value: 'Teams' }] });
  assert.equal(partial.statusCode, 200);
  assert.equal(partial.json().status, 'open');
  store.control(task.id, 'pause');
  const answered = await request('POST', path, {
    answers: [{ questionId: 'q2', value: 'Seven years' }],
  });
  assert.equal(answered.statusCode, 200);
  assert.equal(answered.json().status, 'answered');
  assert.deepEqual(answered.json().review, {
    runId: run.id,
    axis: 'secondary',
    head: 'head',
    base: 'base',
  });
  assert.equal(
    (await request('POST', path, { answers: [{ questionId: 'q2', value: 'Repeated answer' }] }))
      .statusCode,
    200,
  );
  assert.equal(store.get('clarification', c.id)?.answers?.[1].value, 'Seven years');
  assert.equal(store.task(task.id).pausedByUser, true);
  assert.equal(store.task(task.id).control, 'paused');
  assert.equal(store.task(task.id).retries, 0);
  assert.equal(store.list('run').length, 1);
  const state = (await request('GET', '/state')).json();
  assert.equal(state.clarifications[0].taskId, task.id);
  assert.equal(state.clarifications[0].status, 'answered');
});

test('runtime HTTP boundaries expose structured errors and sanitized agent data', async (t) => {
  const { request, store } = await fixture(t);
  const unauthorized = await request('GET', '/state', undefined, { cookie: '' });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.json().code, 'unauthorized');
  assert.equal(unauthorized.json().message, '本地会话已失效，请刷新页面');

  const models = await request('GET', '/agents/codex/models');
  assert.equal(models.statusCode, 200, models.body);
  assert.deepEqual(models.json().models[0], {
    id: 'runtime-model',
    provider: 'fixture-provider',
    displayName: 'Runtime fixture',
    reasoning: true,
    reasoningEfforts: ['low'],
  });
  assert.equal(models.json().available, true);
  assert.equal(JSON.stringify(models.json()).includes('apiKey'), false);

  const probe = await request('GET', '/agents/codex/probe?locale=en');
  assert.equal(probe.statusCode, 200, probe.body);
  assert.equal(probe.json().available, true);
  assert.equal(probe.json().models[0].raw, undefined);

  const allowance = await request('GET', '/agents/codex/allowance');
  assert.equal(allowance.statusCode, 200, allowance.body);
  assert.equal(allowance.json().agentKind, 'codex');
  assert.equal(allowance.json().providerId, 'codex');
  assert.equal(allowance.json().state, 'available');
  assert.equal(allowance.json().status, 'available');
  assert.equal(typeof allowance.json().capturedAt, 'string');
  assert.equal(store.accountAllowance('codex', 'codex')?.state, 'available');
});

test('project runtime accepts per-agent secondary profiles and clears legacy override', async (t) => {
  const { request, store } = await fixture(t);
  const project = (await request('POST', '/projects', { name: 'Runtime', description: '' })).json();
  const profileModes = Object.fromEntries(
    ['backend', 'frontend', 'fullstack', 'complex', 'pm', 'review'].map((role) => [
      role,
      'inherit',
    ]),
  );
  const response = await request('PATCH', `/projects/${project.id}/runtime`, {
    agentSelection: { mode: 'override', agent: 'codex' },
    profileModes,
    secondaryReviewProfile: null,
    secondaryReviewProfiles: {
      codex: { providerId: 'codex', model: 'runtime-model', effort: 'low' },
    },
    recoveryPolicy: 'manual',
  });
  assert.equal(response.statusCode, 200, response.body);
  const saved = store.project(project.id);
  assert.deepEqual(saved.agentSelection, { mode: 'override', agent: 'codex' });
  assert.equal(saved.recoveryPolicy, 'manual');
  assert.equal(saved.secondaryReviewProfile, undefined);
  assert.equal(saved.secondaryReviewProfiles?.codex?.model, 'runtime-model');
});

test('custom Provider prices preserve exact decimal strings and never apply to official login', async (t) => {
  const { request } = await fixture(t);
  const created = await request('POST', '/providers', {
    name: 'Price fixture',
    baseUrl: 'https://example.test/v1',
    apiKey: 'price-fixture-secret',
  });
  assert.equal(created.statusCode, 200, created.body);
  const provider = created.json();
  const prices = {
    'fixture-model': {
      currency: 'USD',
      inputPerMillion: '0.000001000000000000000001',
      outputPerMillion: '12.34000000000000000001',
    },
  };
  const saved = await request('PATCH', `/providers/${provider.id}/prices`, { prices });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(
    saved.json().prices['fixture-model'].inputPerMillion,
    prices['fixture-model'].inputPerMillion,
  );
  assert.equal(saved.body.includes('price-fixture-secret'), false);
  assert.equal(
    (
      await request('PATCH', `/providers/${provider.id}/prices`, {
        prices: { bad: { currency: 'USD', inputPerMillion: '-1' } },
      })
    ).statusCode,
    400,
  );
  assert.equal((await request('PATCH', '/providers/codex/prices', { prices })).statusCode, 400);
});

test('task usage keeps multi-currency totals and per-run unknown coverage visible', async (t) => {
  const { request, store } = await fixture(t);
  const project = store.createProject('Usage', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'usage',
    path: '/fixture/usage',
    github: 'owner/usage',
    defaultBranch: 'main',
    authorized: true,
  });
  const source = store.addMessage(project.id, 'user', 'Measure', 'implement');
  const task = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: source.id,
    title: 'Usage',
    spec: 'Usage',
    acceptance: ['Usage is visible'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  const usd = store.run('dev', project.id, 'backend', task, {
    priceSnapshot: { currency: 'USD', inputPerMillion: '1', outputPerMillion: '2' },
  });
  store.updateRunUsage(usd.id, { inputTokens: 100, outputTokens: 20 });
  store.finishRun(usd.id, 'completed');
  const eur = store.run('dev', project.id, 'backend', task, {
    priceSnapshot: { currency: 'EUR', inputPerMillion: '1' },
  });
  store.updateRunUsage(eur.id, { inputTokens: 50 });
  store.finishRun(eur.id, 'completed');
  const unknown = store.run('dev', project.id, 'backend', task, {
    priceSnapshot: { currency: 'USD', inputPerMillion: '1' },
  });
  store.finishRun(unknown.id, 'completed');

  const response = await request('GET', `/tasks/${task.id}/usage`);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.deepEqual(
    body.costs.map((cost: any) => [cost.currency, cost.partial]),
    [
      ['USD', true],
      ['EUR', true],
    ],
  );
  assert.equal(body.cost, undefined, 'legacy singular cost is absent for multiple currencies');
  assert.equal(body.runCosts[usd.id].currency, 'USD');
  assert.equal(body.runCosts[eur.id].currency, 'EUR');
  assert.equal(body.runCosts[unknown.id], undefined);
  assert.equal(body.usage.complete, false);
  assert.equal(body.usage.runs, 3);
});

test('task records include the complete scoped history after it leaves the recent event feed', async (t) => {
  const { request, store } = await fixture(t);
  const project = store.createProject('History', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'history',
    path: '/fixture/history',
    github: 'owner/history',
    defaultBranch: 'main',
    authorized: true,
  });
  const source = store.addMessage(project.id, 'user', 'Keep the work history', 'implement');
  const task = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: source.id,
    title: 'Historical work',
    spec: 'Keep the complete record',
    acceptance: ['Every event remains readable'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  const initialEvents = store.snapshot().events.filter((event) => event.taskId === task.id);
  const recorded = Array.from({ length: 225 }, (_, index) =>
    store.event('command', `work history ${index}`, { projectId: project.id, taskId: task.id }),
  );
  for (let index = 0; index < 225; index++)
    store.event('pm', `unrelated event ${index}`, { projectId: project.id });
  assert.equal(
    store.snapshot().events.some((event) => event.taskId === task.id),
    false,
  );
  const response = await request('GET', `/tasks/${task.id}/usage`);
  assert.equal(response.statusCode, 200, response.body);
  const events = response.json().events;
  assert.deepEqual(
    events?.map((event: { id: number }) => event.id),
    [...initialEvents.map((event) => event.id).sort((a, b) => a - b), ...recorded],
  );
  assert.equal(events.at(-225).message, 'work history 0');
  assert.equal(events.at(-1).message, 'work history 224');
  assert.ok(events.every((event: { taskId: string }) => event.taskId === task.id));
});

test('project-scoped runtime actions reject cross-project IDs and invalid input with locale descriptors', async (t) => {
  const { request, store } = await fixture(t);
  const first = store.createProject('First', '');
  const second = store.createProject('Second', '');
  const source = store.addMessage(first.id, 'user', 'Choose', 'implement');
  const clarification = store.createClarification({
    projectId: first.id,
    sourceMessageId: source.id,
    questions: [{ id: 'q1', question: 'Which?' }],
  });
  const crossProject = await request(
    'POST',
    `/projects/${second.id}/clarifications/${clarification.id}/answer`,
    { answers: [{ questionId: 'q1', value: 'A' }] },
  );
  assert.equal(crossProject.statusCode, 403);
  assert.equal(crossProject.json().code, 'forbidden');
  const invalid = await request(
    'PATCH',
    `/projects/${first.id}/runtime`,
    { recoveryPolicy: 'invalid' },
    { 'accept-language': 'en-US,en;q=0.8' },
  );
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().message, 'Invalid request');
});
