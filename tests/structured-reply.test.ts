import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { GitHub, type PullState } from '../src/server/github.ts';
import { Engine, mergeReady } from '../src/server/engine.ts';
import { Providers } from '../src/server/providers.ts';
import { Codex } from '../src/server/codex.ts';
import { command } from '../src/server/process.ts';
import type { Profile, ReviewResult, Task } from '../src/shared/types.ts';

type Kind = 'review' | 'feedback' | 'merge';
/** Prose the model may legitimately print around its structured verdict. */
type Respond = (kind: Kind, prompt: string, json: string) => string;

const REVIEW_AXES = ['standards', 'spec'] as const;

async function lifecycle(respond: Respond, options: { feedback?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'phantom-structured-'));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  await command('git', ['init', '--bare', remote]);
  await command('git', ['init', '-b', 'main', source]);
  const git = (args: string[]) => command('git', args, source);
  await git(['config', 'user.name', 'Phantom Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(source, 'sum.cjs'), 'module.exports=(a,b)=>0;\n');
  await writeFile(
    join(source, 'verify.cjs'),
    "require('node:assert/strict').equal(require('./sum.cjs')(2,3),5);\n",
  );
  await git(['add', '.']);
  await git(['commit', '-m', 'Fixture']);
  await git(['remote', 'add', 'origin', remote]);
  await git(['push', '-u', 'origin', 'main']);
  const store = new Store(join(root, 'db.sqlite'));
  const project = store.createProject('Structured', '');
  const providers = new Providers(store);
  const upstream = await providers.save({
    name: 'Structured upstream',
    baseUrl: 'http://localhost:9999/v1',
    apiKey: 'structured-private-key',
  });
  const assigned = structuredClone(project.profiles);
  assigned.backend = { providerId: upstream.id, model: 'dev-model', effort: 'low' };
  assigned.pm = { providerId: upstream.id, model: 'pm-model', effort: 'medium' };
  assigned.review = { providerId: upstream.id, model: 'review-model', effort: 'high' };
  store.saveProjectProfiles(project.id, assigned);
  const repo = store.createRepo({
    projectId: project.id,
    name: 'source',
    path: source,
    github: 'fixture/source',
    defaultBranch: 'main',
    authorized: true,
  });
  store.patchRepo(repo.id, {
    enabled: true,
    commands: { install: '', build: '', test: 'node verify.cjs', start: '', port: 3000 },
  });
  const message = store.addMessage(project.id, 'user', 'Implement sum', 'implement');
  const task = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: message.id,
    title: 'Sum numbers',
    spec: 'Add two numbers',
    acceptance: ['2 + 3 = 5'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  if (options.feedback)
    store.updateTask(task.id, {
      pendingFeedback: ['An external reviewer asked for a clearer revision comment.'],
    });
  const turns = {
    review: { standards: 0, spec: 0 } as Record<(typeof REVIEW_AXES)[number], number>,
    feedback: 0,
    merge: 0,
  };
  const withoutSchema: string[] = [];
  const axes: string[] = [];
  let issue: any = { body: '', state: 'open' };
  let merged = false;
  class FakeGitHub extends GitHub {
    override async setupProject() {}
    override async publishPR(t: Task) {
      store.updateTask(t.id, { pr: 2, prUrl: 'https://example.invalid/pull/2' });
      return this.pull(t);
    }
    override async pull(t: Task): Promise<PullState> {
      return {
        number: 2,
        html_url: 'https://example.invalid/pull/2',
        state: 'open',
        merged,
        mergeable: true,
        mergeable_state: 'clean',
        head: { sha: t.head!, ref: t.branch, repo: { full_name: 'fixture/source' } },
        base: { sha: t.base!, repo: { full_name: 'fixture/source' } },
        body: '',
      };
    }
    override async checks() {
      return { ready: true };
    }
    override async feedback() {
      return [];
    }
    override async reviewComment(_t: Task, r: ReviewResult) {
      axes.push(r.axis);
      return {};
    }
    override async merge(t: Task) {
      assert.equal(mergeReady(t), true);
      merged = true;
      return this.pull(t);
    }
    override async syncStatus() {}
    override async api<T = any>(endpoint: string, method = 'GET', data?: any): Promise<T> {
      if (method === 'POST' && endpoint.endsWith('/issues'))
        issue = { number: 1, html_url: 'https://example.invalid/issues/1', ...data };
      else if (method === 'PATCH' || (method === 'POST' && endpoint.endsWith('/labels')))
        issue = { ...issue, ...data };
      return { ...issue } as T;
    }
    override async paged() {
      return [];
    }
  }
  class StructuredModel extends Codex {
    cwd = '';
    role = '';
    axis = '';
    override async start() {}
    override async stop() {}
    override async thread(options: Parameters<Codex['thread']>[0]) {
      this.cwd = options.cwd;
      this.role = options.instructions.includes('Task Developer')
        ? 'dev'
        : options.instructions.includes('Independent Reviewer')
          ? 'review'
          : 'pm';
      return `fixture-${this.role}`;
    }
    override async turn(
      _id: string,
      prompt: string,
      _profile: Profile,
      _signal?: AbortSignal,
      outputSchema?: unknown,
    ) {
      if (this.role === 'dev') {
        await writeFile(join(this.cwd, 'sum.cjs'), 'module.exports=(a,b)=>a+b;\n');
        return 'Implemented in the task worktree; host must commit and validate.';
      }
      if (this.role === 'review') {
        const matched = /Axis: (standards|spec)/.exec(prompt);
        if (matched) this.axis = matched[1];
        turns.review[this.axis as 'standards' | 'spec']++;
        if (!outputSchema) withoutSchema.push(`review:${this.axis}`);
        return respond(
          'review',
          prompt,
          JSON.stringify({
            approved: true,
            summary: `Inspected the ${this.axis} diff; behavior and conventions match.`,
            findings: [],
          }),
        );
      }
      if (prompt.includes('Evaluate external feedback')) {
        turns.feedback++;
        if (!outputSchema) withoutSchema.push('feedback');
        return respond(
          'feedback',
          prompt,
          JSON.stringify({
            action: 'ignore',
            reason: 'Comments are acknowledgements outside the approved scope.',
          }),
        );
      }
      turns.merge++;
      if (!outputSchema) withoutSchema.push('merge');
      return respond(
        'merge',
        prompt,
        JSON.stringify({
          approved: true,
          reason: 'Acceptance criteria and both reviews pass.',
        }),
      );
    }
  }
  const ws = new Workspaces(join(root, 'workspaces'), store);
  const mirror = await ws.mirror(store.repo(repo.id));
  await command('git', ['config', 'user.name', 'Phantom Test'], mirror);
  await command('git', ['config', 'user.email', 'test@example.invalid'], mirror);
  const engine = new Engine(store, new FakeGitHub(store), ws, root, () => new StructuredModel());
  try {
    for (let i = 0; i < 400; i++) {
      const current = store.task(task.id);
      if (current.stage === 'done' || (current.blocked && !store.activeRuns().length)) break;
      await engine.tick();
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    await engine.stop();
  }
  return {
    store,
    task: () => store.task(task.id),
    events: () => store.events(),
    turns,
    withoutSchema,
    axes,
    close: () => store.close(),
  };
}

const shapes: [string, (json: string) => string][] = [
  ['a bare JSON object', (json) => json],
  ['a JSON code fence', (json) => '```json\n' + json + '\n```'],
  [
    'prose before a JSON code fence',
    (json) => `Evidence is taken from the pinned diff.\n\n\`\`\`json\n${json}\n\`\`\`\n`,
  ],
  [
    'prose before a bare JSON object',
    (json) => `Evidence is taken from the pinned diff: ${json}\nReviewed at the pinned revision.`,
  ],
];

for (const [name, wrap] of shapes)
  test(`review, feedback and merge turns accept ${name} without losing schema enforcement`, async () => {
    const run = await lifecycle((_kind, _prompt, json) => wrap(json), { feedback: true });
    try {
      const task = run.task();
      assert.equal(
        task.stage,
        'done',
        JSON.stringify({ blocked: task.blocked, events: run.events().slice(0, 5) }),
      );
      assert.deepEqual(run.withoutSchema, [], 'structured turns must still carry the JSON schema');
      assert.equal(run.turns.review.standards, 1, 'a parsable reply needs no re-ask');
      assert.equal(run.turns.review.spec, 1, 'a parsable reply needs no re-ask');
      assert.equal(run.turns.feedback, 1, 'the feedback verdict must be parsed on the first reply');
      assert.equal(run.turns.merge, 1, 'the merge decision must be parsed on the first reply');
      assert.deepEqual([...run.axes].sort(), ['spec', 'standards']);
      assert.ok(
        run
          .events()
          .some(
            (e) =>
              e.type === 'feedback' &&
              e.message.includes('PM 未要求返工：Comments are acknowledgements'),
          ),
        'the parsed feedback verdict must be the one the host acts on',
      );
      assert.equal(task.blocked, undefined);
    } finally {
      run.close();
    }
  });

test('a reply without JSON pauses the task with a readable domain reason instead of a SyntaxError', async () => {
  const marker = 'Evidence is unavailable in this pinned worktree';
  const run = await lifecycle(
    (kind, _prompt, json) =>
      kind === 'review' ? `${marker}. ${'supporting detail '.repeat(400)}` : json,
    { feedback: true },
  );
  try {
    const task = run.task();
    assert.equal(task.control, 'paused');
    assert.equal(task.stage !== 'done', true, 'an unparsable review must never count as a pass');
    assert.equal(task.reviews.length, 0);
    assert.match(task.blocked ?? '', /评审回合未返回可解析的结构化结果/);
    assert.doesNotMatch(
      task.blocked ?? '',
      /SyntaxError|Unexpected token|is not valid JSON|JSON\.parse|ZodError|invalid_type/i,
    );
    assert.ok(
      (task.blocked ?? '').includes(marker),
      'the redacted raw reply must be retained as bounded evidence',
    );
    assert.ok(
      Buffer.byteLength(task.blocked ?? '') < 2560,
      'the retained reply evidence must be length limited',
    );
    assert.deepEqual(
      run.turns.review,
      { standards: 2, spec: 2 },
      'each review axis may re-ask at most once before pausing',
    );
    assert.ok(
      run.turns.feedback <= 1 && run.turns.merge <= 1,
      'a review pause must not start unbounded extra structured turns',
    );
    assert.ok(
      run.events().some((e) => e.type === 'blocked' && e.taskId === task.id),
      'the pause must be recorded as a PM-visible incident',
    );
  } finally {
    run.close();
  }
});

test('a reply that violates the strict schema is still rejected and pauses with a readable reason', async () => {
  const run = await lifecycle(() =>
    JSON.stringify({
      approved: true,
      summary: 'Everything looks fine at the pinned revision.',
      findings: [],
      confidence: 0.98,
    }),
  );
  try {
    const task = run.task();
    assert.equal(task.control, 'paused');
    assert.notEqual(task.stage, 'done');
    assert.equal(
      task.reviews.length,
      0,
      'an invalid verdict must not be recorded as review evidence',
    );
    assert.match(task.blocked ?? '', /评审回合未返回可解析的结构化结果/);
    assert.doesNotMatch(
      task.blocked ?? '',
      /SyntaxError|unrecognized_keys|invalid_type|ZodError|issue(s)? on/i,
    );
    assert.deepEqual(run.turns.review, { standards: 2, spec: 2 });
  } finally {
    run.close();
  }
});

test('an unparsable verdict is re-asked once on the same Codex thread and still carries the host output schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-protocol-'));
  const store = new Store(join(root, 'db.sqlite'));
  const project = store.createProject('Protocol', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'repo',
    path: root,
    github: 'fixture/protocol',
    defaultBranch: 'main',
    authorized: true,
  });
  const providers = new Providers(store);
  const upstream = await providers.save({
    name: 'Protocol upstream',
    baseUrl: 'http://localhost:9999/v1',
    apiKey: 'protocol-private-key',
  });
  const assigned = structuredClone(project.profiles);
  assigned.pm = { providerId: upstream.id, model: 'pm-model', effort: 'medium' };
  store.saveProjectProfiles(project.id, assigned);
  const message = store.addMessage(project.id, 'user', 'Implement', 'implement');
  const task = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: message.id,
    title: 'Merge decision',
    spec: 'Build it',
    acceptance: ['Works'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  store.updateTask(task.id, {
    worktree: root,
    pr: 2,
    head: 'head',
    base: 'base',
    stage: 'merging',
    tests: [{ command: 'node verify.cjs', exitCode: 0, output: 'pass', head: 'head', at: 'now' }],
    reviews: REVIEW_AXES.map((axis) => ({
      axis,
      head: 'head',
      base: 'base',
      approved: true,
      findings: [],
      summary: 'pass',
    })),
  });
  const turnStarts: any[] = [];
  let issue: any = { body: '', state: 'open' };
  let merged = false;
  class Remote extends GitHub {
    override async setupProject() {}
    override async pull(t: Task): Promise<PullState> {
      return {
        number: 2,
        html_url: '',
        state: merged ? 'closed' : 'open',
        merged,
        mergeable: true,
        mergeable_state: 'clean',
        head: { sha: t.head! },
        base: { sha: t.base! },
        body: '',
      };
    }
    override async checks() {
      return { ready: true };
    }
    override async feedback() {
      return [];
    }
    override async merge(t: Task) {
      merged = true;
      return this.pull(t);
    }
    override async syncStatus() {}
    override async api<T = any>(endpoint: string, method = 'GET', data?: any): Promise<T> {
      if (method === 'POST' && endpoint.endsWith('/issues'))
        issue = { number: 1, html_url: 'https://example.invalid/issues/1', ...data };
      else if (method === 'PATCH' || method === 'POST') issue = { ...issue, ...data };
      return { ...issue } as T;
    }
    override async paged() {
      return [];
    }
  }
  // Real app-server child process: records every turn/start request the host actually sends.
  const script = `
    const readline = require('node:readline');
    let turns = 0;
    const send = (value) => console.log(JSON.stringify(value));
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const m = JSON.parse(line);
      if (m.id === undefined) return;
      if (m.method === 'initialize') return send({ id: m.id, result: {} });
      if (m.method === 'thread/start' || m.method === 'thread/resume')
        return send({ id: m.id, result: { thread: { id: 'fixture-thread' }, model: m.params.model, modelProvider: m.params.modelProvider, reasoningEffort: m.params.config.model_reasoning_effort } });
      if (m.method === 'turn/start') {
        turns += 1;
        const id = 'turn-' + turns;
        const threadId = m.params.threadId;
        send({ method: 'fixture/turn-start', params: { threadId, input: m.params.input, outputSchema: m.params.outputSchema } });
        send({ id: m.id, result: { turn: { id } } });
        send({ method: 'turn/started', params: { threadId, turn: { id } } });
        const text = turns === 1
          ? 'Evidence is unavailable in this pinned worktree.'
          : '{"approved":true,"reason":"Acceptance criteria and both reviews pass."}';
        send({ method: 'item/agentMessage/delta', params: { threadId, turnId: id, delta: text } });
        send({ method: 'turn/completed', params: { threadId, turn: { id, status: 'completed' } } });
        return;
      }
      if (m.method === 'fixture/exit') return setImmediate(() => process.exit(0));
      send({ id: m.id, result: {} });
    });
  `;
  const exits: Promise<void>[] = [];
  const engine = new Engine(
    store,
    new Remote(store),
    new Workspaces(join(root, 'ws'), store),
    root,
    () => {
      const codex = new Codex((_binary, _args, options) => {
        const child = spawn(process.execPath, ['-e', script], options);
        exits.push(new Promise((resolve) => child.on('close', () => resolve())));
        return child;
      });
      codex.on('notification', (method: string, params: any) => {
        if (method === 'fixture/turn-start') turnStarts.push(params);
      });
      return codex;
    },
  );
  try {
    for (let i = 0; i < 400; i++) {
      const current = store.task(task.id);
      if (current.stage === 'done' || (current.blocked && !store.activeRuns().length)) break;
      await engine.tick();
      await new Promise((r) => setTimeout(r, 50));
    }
    const result = store.task(task.id);
    assert.equal(
      result.stage,
      'done',
      JSON.stringify({
        blocked: result.blocked,
        issue: result.issue,
        issueBody: result.issueBody?.slice(0, 40),
        events: store.events().slice(0, 8),
      }),
    );
    assert.equal(merged, true);
    assert.equal(turnStarts.length, 2, 'exactly one bounded re-ask is allowed');
    assert.equal(turnStarts[0].threadId, 'fixture-thread');
    assert.equal(turnStarts[1].threadId, 'fixture-thread', 'the re-ask stays on the same thread');
    assert.ok(turnStarts[0].outputSchema, 'the host output schema must reach the first turn');
    assert.ok(turnStarts[1].outputSchema, 'the host output schema must reach the re-ask');
    const first = turnStarts[0].input[0].text as string;
    const second = turnStarts[1].input[0].text as string;
    assert.notEqual(first, second);
    assert.match(second, /Reply with ONLY one JSON object/);
    assert.doesNotMatch(second, /Evidence is unavailable/);
  } finally {
    await engine.stop();
    await Promise.allSettled(exits);
    store.close();
  }
});
