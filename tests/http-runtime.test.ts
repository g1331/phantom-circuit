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
