import { test } from 'node:test';
import assert from 'node:assert/strict';
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

type Kind = 'review' | 'feedback';
/** Prose the model may legitimately print around its structured verdict. `attempt` counts the
 * structured turns this run already took, so a re-ask is identified by turn order, not wording. */
type Respond = (kind: Kind, prompt: string, json: string, attempt: number) => string;

const REVIEW_AXES = ['primary', 'secondary'] as const;

async function lifecycle(
  respond: Respond,
  options: {
    feedback?: boolean;
    reviewViaTool?: boolean;
    reviewToolFinal?: 'json' | 'prose';
    reviewToolWrongRevision?: boolean;
  } = {},
) {
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
  store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
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
  store.updateMessage(message.id, { status: 'completed', draftStatus: 'completed' });
  if (options.feedback)
    store.updateTask(task.id, {
      pendingFeedback: ['An external reviewer asked for a clearer revision comment.'],
    });
  const turns = {
    review: { primary: 0, secondary: 0 } as Record<(typeof REVIEW_AXES)[number], number>,
    feedback: 0,
  };
  const withoutSchema: string[] = [];
  const axes: string[] = [];
  let pmCalls = 0;
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
    handler?: Parameters<Codex['thread']>[0]['toolHandler'];
    override async start() {}
    override async stop() {}
    override async thread(options: Parameters<Codex['thread']>[0]) {
      this.cwd = options.cwd;
      this.handler = options.toolHandler;
      if (options.instructions.includes('Project PM')) pmCalls++;
      this.role = options.instructions.includes('Task Developer')
        ? 'dev'
        : options.instructions.includes('Independent Review')
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
        const matched = /Axis: (primary|secondary)/.exec(prompt);
        if (matched) this.axis = matched[1];
        const attempt = ++turns.review[this.axis as (typeof REVIEW_AXES)[number]];
        if (options.reviewViaTool !== false) {
          assert.ok(this.handler, 'the host must expose submit_review to reviewers');
          const evidence = store.task(task.id);
          const input: Record<string, unknown> = {
            approved: true,
            summary: `Inspected the ${this.axis} diff; behavior and conventions match.`,
            findings: [],
            verdict: 'pass',
          };
          if (options.reviewToolWrongRevision) input.head = 'wrong-revision';
          await this.handler('submit_review', input);
          if (options.reviewToolFinal === 'prose') return 'The host accepted this review.';
          return JSON.stringify({
            approved: true,
            summary: `Inspected the ${this.axis} diff; behavior and conventions match.`,
            findings: [],
            verdict: 'pass',
            head: evidence.head,
            base: evidence.base,
            tests: evidence.tests,
          });
        }
        if (!outputSchema) withoutSchema.push(`review:${this.axis}`);
        const evidence = store.task(task.id);
        return respond(
          'review',
          prompt,
          JSON.stringify({
            approved: true,
            summary: `Inspected the ${this.axis} diff; behavior and conventions match.`,
            findings: [],
            verdict: 'pass',
            head: evidence.head,
            base: evidence.base,
            tests: evidence.tests,
          }),
          attempt,
        );
      }
      if (prompt.includes('Evaluate external feedback')) {
        pmCalls++;
        const attempt = ++turns.feedback;
        if (!outputSchema) withoutSchema.push('feedback');
        return respond(
          'feedback',
          prompt,
          JSON.stringify({
            action: 'ignore',
            reason: 'Comments are acknowledgements outside the approved scope.',
          }),
          attempt,
        );
      }
      assert.fail('Policy 2 merge completion must not call PM for acceptance');
    }
  }
  const ws = new Workspaces(join(root, 'workspaces'), store);
  const mirror = await ws.mirror(store.repo(repo.id));
  await command('git', ['config', 'user.name', 'Phantom Test'], mirror);
  await command('git', ['config', 'user.email', 'test@example.invalid'], mirror);
  const engine = new Engine(store, new FakeGitHub(store), ws, root, () => new StructuredModel());
  try {
    await engine.start();
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
    pmCalls: () => pmCalls,
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
  test(`review and feedback turns accept ${name} without losing schema enforcement`, async () => {
    const run = await lifecycle((_kind, _prompt, json) => wrap(json), { feedback: true });
    try {
      const task = run.task();
      assert.equal(
        task.stage,
        'done',
        JSON.stringify({ blocked: task.blocked, events: run.events().slice(0, 5) }),
      );
      assert.deepEqual(run.withoutSchema, [], 'structured turns must still carry the JSON schema');
      assert.equal(run.turns.review.primary, 1, 'a host-submitted review needs one turn');
      assert.equal(run.turns.review.secondary, 0, 'a normal task needs no secondary review');
      assert.equal(run.turns.feedback, 1, 'the feedback verdict must be parsed on the first reply');
      assert.equal(run.pmCalls(), 2, 'PM may evaluate feedback but never merge acceptance');
      assert.deepEqual([...run.axes].sort(), ['primary']);
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

test('an accepted review tool owns pinned evidence when the model finishes with prose', async () => {
  const run = await lifecycle((_kind, _prompt, json) => json, {
    reviewToolFinal: 'prose',
  });
  try {
    const task = run.task();
    assert.equal(task.stage, 'done', JSON.stringify({ blocked: task.blocked }));
    assert.equal(task.reviews.length, 1);
    assert.equal(run.turns.review.primary, 1, 'the accepted host tool must end the review turn');
    assert.equal(run.withoutSchema.length, 0);
  } finally {
    run.close();
  }
});

test('a review tool call cannot smuggle a different pinned revision', async () => {
  const run = await lifecycle((_kind, _prompt, json) => json, {
    reviewToolWrongRevision: true,
  });
  try {
    const task = run.task();
    assert.equal(task.control, 'paused');
    assert.notEqual(task.stage, 'done');
    assert.equal(task.reviews.length, 0, 'rejected tool input must not become review evidence');
    assert.ok(
      run.store.list('run').some((entry) => entry.role === 'review' && entry.status === 'failed'),
    );
  } finally {
    run.close();
  }
});

test('a reply without JSON pauses the task with a readable domain reason instead of a SyntaxError', async () => {
  const first = 'Evidence is unavailable in this pinned worktree';
  const second = 'Still prose after the explicit JSON-only instruction';
  const run = await lifecycle(
    (kind, _prompt, json, attempt) => {
      if (kind !== 'review') return json;
      const marker = attempt > 1 ? second : first;
      return `${marker}. ${'supporting detail '.repeat(400)}`;
    },
    { feedback: true, reviewViaTool: false },
  );
  try {
    const task = run.task();
    assert.equal(task.control, 'paused');
    assert.equal(task.stage !== 'done', true, 'an unparsable review must never count as a pass');
    assert.equal(task.reviews.length, 0);
    const reviewRun = run.store
      .list('run')
      .find((r) => r.taskId === task.id && r.role === 'review');
    const reviewError = reviewRun?.error ?? '';
    assert.match(reviewError, /评审回合未返回可解析的结构化结果/);
    assert.doesNotMatch(
      task.blocked ?? '',
      /SyntaxError|Unexpected token|is not valid JSON|JSON\.parse|ZodError|invalid_type/i,
    );
    assert.ok(
      reviewError.includes(first),
      'the redacted reply that failed first must be retained as bounded evidence',
    );
    assert.ok(
      reviewError.includes(second),
      'the redacted reply to the bounded re-ask must be retained as bounded evidence',
    );
    assert.ok(
      Buffer.byteLength(reviewError) < 2560,
      'the retained reply evidence must be length limited',
    );
    assert.deepEqual(
      run.turns.review,
      { primary: 2, secondary: 0 },
      'each review axis may re-ask at most once before pausing',
    );
    assert.ok(
      run.turns.feedback <= 1,
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

test('a parser exception from a structured turn never reaches the task as raw JavaScript text', async () => {
  const run = await lifecycle(
    () => {
      throw new SyntaxError('Unexpected token \'E\', "Evidence i"... is not valid JSON');
    },
    { reviewViaTool: false },
  );
  try {
    const task = run.task();
    assert.equal(task.control, 'paused');
    assert.notEqual(task.stage, 'done');
    assert.doesNotMatch(
      task.blocked ?? '',
      /SyntaxError|Unexpected token|is not valid JSON|JSON\.parse/i,
    );
    assert.match(task.blocked ?? '', /Incident/);
    assert.ok(
      run.events().some((e) => e.type === 'incident' && /review/.test(e.message)),
      'the parser failure must create a PM-visible incident',
    );
    // The Run record is the surface the UI reports failures from, and `store.list('run')` is how the
    // existing lifecycle/feedback tests read it: the raw exception must stay visible there.
    const reviewRun = run.store
      .list('run')
      .find((r) => r.taskId === task.id && r.role === 'review');
    assert.equal(reviewRun?.status, 'failed', 'a failed structured turn must not be swallowed');
    assert.match(reviewRun?.error ?? '', /SyntaxError/);
  } finally {
    run.close();
  }
});

test('a parseable candidate that fails the schema does not hide the later valid verdict', async () => {
  const run = await lifecycle(
    (kind, _prompt, json) =>
      kind === 'review'
        ? `\`\`\`json\n{"note":"shape example only, not the verdict"}\n\`\`\`\nEvidence is taken from the pinned diff.\n${json}\n`
        : json,
    { feedback: true, reviewViaTool: false },
  );
  try {
    const task = run.task();
    assert.equal(task.stage, 'done', JSON.stringify({ blocked: task.blocked }));
    assert.equal(run.turns.review.primary, 1, 'a stale example object must not force a re-ask');
    assert.equal(run.turns.review.secondary, 0);
  } finally {
    run.close();
  }
});

test('prose containing many brace characters still yields the balanced verdict object', async () => {
  const run = await lifecycle(
    (kind, _prompt, json) =>
      kind === 'review'
        ? `${'{ '.repeat(200)}Evidence is taken from the pinned diff. ${json}\n`
        : json,
    { feedback: true, reviewViaTool: false },
  );
  try {
    const task = run.task();
    assert.equal(task.stage, 'done', JSON.stringify({ blocked: task.blocked }));
    assert.equal(run.turns.review.primary, 1);
    assert.equal(run.turns.review.secondary, 0);
  } finally {
    run.close();
  }
});

test('a reply that violates the strict schema is still rejected and pauses with a readable reason', async () => {
  const run = await lifecycle(
    () =>
      JSON.stringify({
        approved: true,
        summary: 'Everything looks fine at the pinned revision.',
        findings: [],
        confidence: 0.98,
      }),
    { reviewViaTool: false },
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
    const reviewRun = run.store
      .list('run')
      .find((r) => r.taskId === task.id && r.role === 'review');
    assert.match(reviewRun?.error ?? '', /评审回合未返回可解析的结构化结果/);
    assert.doesNotMatch(
      task.blocked ?? '',
      /SyntaxError|unrecognized_keys|invalid_type|ZodError|issue(s)? on/i,
    );
    assert.deepEqual(run.turns.review, { primary: 2, secondary: 0 });
  } finally {
    run.close();
  }
});

test('Policy 2 merge completion is deterministic and never asks PM for acceptance', async () => {
  const run = await lifecycle((_kind, _prompt, json) => json);
  try {
    assert.equal(run.task().stage, 'done', JSON.stringify({ blocked: run.task().blocked }));
    assert.equal(run.pmCalls(), 0, 'a clean Policy 2 merge must not start a PM turn');
    assert.equal(run.turns.feedback, 0);
    assert.equal(run.turns.review.primary, 1);
    assert.equal(run.turns.review.secondary, 0);
  } finally {
    run.close();
  }
});
