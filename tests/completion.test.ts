import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { command } from '../src/server/process.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { GitHub, GitHubRejected, type PullState } from '../src/server/github.ts';
import { Engine, mergeReady } from '../src/server/engine.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Codex } from '../src/server/codex.ts';
import type { Task } from '../src/shared/types.ts';
import { hasOwner, teamView, workGroup } from '../src/shared/team.ts';
import {
  taskAttention,
  taskDeliveryHead,
  taskDeliveryRevision,
} from '../src/shared/task-history.ts';
import { deliveryPreview } from '../src/shared/delivery-preview.ts';
import { completionNotice } from '../src/server/delivery-runtime.ts';
import { renderReport } from '../src/server/report.ts';

function fixture(source = '.', dataDir = '.cache', dbPath = ':memory:') {
  let store = new Store(dbPath);
  const p = store.createProject('Completion', '');
  store.saveProjectAgentSelection(p.id, { mode: 'override', agent: 'codex' });
  const repo = store.createRepo({
    projectId: p.id,
    name: 'repo',
    path: source,
    github: 'example/repo',
    authorized: true,
    defaultBranch: 'main',
  });
  const m = store.addMessage(p.id, 'user', 'Implement', 'implement');
  const t = store.createTask({
    projectId: p.id,
    repoId: repo.id,
    sourceMessageId: m.id,
    title: 'Task',
    spec: 'Build it',
    acceptance: ['Works', 'Persists'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  const body = `<!-- phantom-task:${t.id} -->\n## What to build\nBuild it\n\n## Acceptance criteria\n- [ ] Works\n- [ ] Persists\n\n## Blocked by\nNone (can start immediately)\n`;
  store.updateTask(t.id, {
    issue: 1,
    issueBody: body,
    pr: 2,
    head: 'head',
    base: 'base',
    stage: 'merging',
    mergeApproval: { head: 'head', base: 'base' },
    tests: [{ command: 'test', exitCode: 0, output: 'pass', head: 'head', at: 'now' }],
    reviews: [
      {
        axis: 'primary' as const,
        head: 'head',
        base: 'base',
        approved: true,
        findings: [],
        summary: 'pass',
        verdict: 'pass' as const,
      },
    ],
  });
  const remote = { body, state: 'open' };
  let merged = true;
  let writes = 0;
  let lost = false;
  let reject = false;
  let projectUnavailable = false;
  const statuses: string[] = [];
  const questions: string[] = [];
  let pmCalls = 0;
  let revision: unknown;
  class Remote extends GitHub {
    override async api<T = any>(_endpoint: string, method = 'GET', data?: any): Promise<T> {
      if (method === 'PATCH') {
        writes++;
        if (reject) throw new GitHubRejected('HTTP 403 Forbidden', 403);
        Object.assign(remote, data);
        if (lost) throw new Error('Lost response');
      }
      return { ...remote } as T;
    }
    override async pull(task: Task): Promise<PullState> {
      return {
        number: 2,
        html_url: '',
        state: merged ? 'closed' : 'open',
        merged,
        head: { sha: task.head! },
        base: { sha: task.base! },
        mergeable: true,
        mergeable_state: 'clean',
        body: '',
      };
    }
    override async feedback() {
      return [];
    }
    override async syncStatus(task: Task) {
      if (projectUnavailable) throw new Error('Project unavailable');
      statuses.push(task.stage);
    }
  }
  class PM extends Codex {
    override async start() {}
    override async stop() {}
    handler?: Parameters<Codex['thread']>[0]['toolHandler'];
    override async thread(options: Parameters<Codex['thread']>[0]) {
      pmCalls++;
      this.handler = options.toolHandler;
      return 'pm';
    }
    override async turn(_id: string, text: string) {
      pmCalls++;
      questions.push(text);
      if (revision) await this.handler!('revise_task', revision);
      return 'Needs user confirmation';
    }
  }
  const engine = () =>
    new Engine(
      store,
      new Remote(store),
      new Workspaces(join(dataDir, 'workspaces'), store),
      dataDir,
      () => new PM(),
    );
  return {
    get store() {
      return store;
    },
    reopen: () => {
      store.close();
      store = new Store(dbPath);
      store.recover();
    },
    engine,
    remote,
    revise: () => {
      revision = {
        taskId: t.id,
        spec: 'Build the revised behavior',
        acceptance: ['Revised behavior works'],
        guidance: 'Implement revised requirements',
      };
    },
    projectFailure: (value: boolean) => {
      projectUnavailable = value;
    },
    task: () => store.task(t.id),
    patch: (patch: Partial<Task>) => store.updateTask(t.id, patch),
    writes: () => writes,
    statuses,
    questions,
    pmCalls: () => pmCalls,
    unmerged: () => {
      merged = false;
    },
    merged: () => {
      merged = true;
    },
    lose: () => {
      lost = true;
    },
    reject: (value: boolean) => {
      reject = value;
    },
    messages: () => store.list('message').filter((m) => m.role === 'assistant'),
  };
}

test('transient GitHub sync failure preserves completion and backs off without event flooding', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const f = fixture();
  f.patch({ stage: 'done' });
  const engine = f.engine();
  const original = engine.github.pull.bind(engine.github);
  let calls = 0;
  let unavailable = true;
  engine.github.pull = async (task) => {
    calls++;
    if (unavailable) throw new Error('gh (1): gh: HTTP 502');
    return original(task);
  };
  const before = f.task();
  await engine.sync();
  assert.deepEqual(f.task(), before);
  await engine.sync();
  assert.equal(calls, 1);
  assert.equal(f.store.events().filter((e) => e.type === 'sync').length, 1);
  t.mock.timers.tick(60000);
  await engine.sync();
  assert.equal(calls, 2);
  await engine.sync();
  assert.equal(calls, 2);
  unavailable = false;
  t.mock.timers.tick(120000);
  await engine.sync();
  assert.equal(f.task().stage, 'done');
  assert.equal(f.task().blocked, undefined);
  assert.ok(f.store.events().some((e) => e.message.includes('同步已恢复')));
  f.store.close();
});

for (const message of [
  'gh (1): gh: Something went wrong while executing your query on 2026-09-13',
  'gh (1): unexpected end of JSON input',
]) {
  test(`completion synchronization defers transient failure: ${message}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
    const f = fixture();
    const engine = f.engine();
    let calls = 0;
    engine.github.completeIssue = async () => {
      calls++;
      throw new Error(message);
    };
    const before = f.task();
    for (const delay of [0, 60000, 120000, 240000, 300000, 300000]) {
      t.mock.timers.tick(delay);
      await engine.sync();
      const attempts = calls;
      await engine.sync();
      assert.equal(calls, attempts);
      assert.deepEqual(f.task(), { ...before, prState: 'merged', issueState: 'open' });
    }
    assert.equal(calls, 6);
    assert.equal(f.store.events().filter((e) => e.type === 'sync').length, 6);
    f.store.close();
  });
}

test('sync reconciles a lost completion response before done and Project delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-restart-'));
  const f = fixture('.', root, join(root, 'state.sqlite'));
  const first = f.engine();
  try {
    f.lose();
    const before = f.task();
    await first.sync();
    assert.equal(f.task().stage, 'merging');
    assert.equal(f.messages().length, 0);
    assert.deepEqual(f.task().tests, before.tests);
    assert.deepEqual(f.task().reviews, before.reviews);
    assert.equal(f.task().head, before.head);
    assert.equal(f.task().pr, before.pr);
    assert.equal(f.statuses.includes('done'), false);
    await first.stop();
    f.reopen();
    const restarted = f.engine();
    try {
      await restarted.sync();
      assert.equal(f.task().stage, 'done');
      assert.equal(f.task().issueBody, f.remote.body);
      assert.equal(f.remote.state, 'closed');
      assert.match(f.remote.body, /- \[x\] Works\n- \[x\] Persists/);
      assert.equal(f.messages().length, 1);
      await restarted.sync();
      assert.equal(f.writes(), 1);
      assert.equal(f.messages().length, 1);
    } finally {
      await restarted.stop();
    }
  } finally {
    await first.stop();
    f.store.close();
  }
});

test('historical done tasks receive safe completion compensation without another delivery message', async () => {
  const f = fixture();
  f.patch({ stage: 'done' });
  const engine = f.engine();
  try {
    await engine.sync();
    assert.match(f.remote.body, /- \[x\] Works/);
    assert.equal(f.remote.state, 'closed');
    assert.equal(f.task().issueBody, f.remote.body);
    await engine.sync();
    assert.equal(f.writes(), 1);
    assert.equal(f.messages().length, 0);
  } finally {
    await engine.stop();
    f.store.close();
  }
});

test('a definite Issue PATCH rejection preserves evidence and retries after recovery', async () => {
  const f = fixture();
  const engine = f.engine();
  try {
    f.reject(true);
    const before = f.task();
    await engine.sync();
    assert.equal(f.task().stage, 'merging');
    assert.equal(f.messages().length, 0);
    assert.deepEqual(f.task().tests, before.tests);
    assert.deepEqual(f.task().reviews, before.reviews);
    assert.equal(f.task().head, before.head);
    assert.equal(f.task().pr, before.pr);
    assert.equal(f.remote.body, before.issueBody);
    f.reject(false);
    await engine.sync();
    assert.equal(f.task().stage, 'done');
  } finally {
    await engine.stop();
    f.store.close();
  }
});

for (const stage of ['developing', 'reviewing'] as const) {
  test(`${stage} cannot complete an Issue even if the PR was merged externally`, async () => {
    const f = fixture();
    f.patch({ stage });
    const engine = f.engine();
    try {
      await engine.sync();
      assert.equal(f.writes(), 0);
      assert.equal(f.task().stage, stage);
      assert.match(f.remote.body, /- \[ \] Works/);
    } finally {
      await engine.stop();
      f.store.close();
    }
  });
}
for (const invalid of ['tests', 'primary', 'head', 'base', 'unmerged', 'paused'] as const) {
  test(`completion remains unchecked with invalid ${invalid} evidence`, async () => {
    const f = fixture();
    if (invalid === 'tests') f.patch({ tests: f.task().tests.map((t) => ({ ...t, exitCode: 1 })) });
    if (invalid === 'primary')
      f.patch({
        reviews: f.task().reviews.map((r) => (r.axis === invalid ? { ...r, approved: false } : r)),
      });
    if (invalid === 'head' || invalid === 'base') f.patch({ [invalid]: 'changed' });
    if (invalid === 'unmerged') f.unmerged();
    if (invalid === 'paused') f.patch({ control: 'paused' });
    const engine = f.engine();
    try {
      await engine.sync();
      assert.equal(f.writes(), 0);
      assert.equal(f.task().stage, 'merging');
      assert.equal(f.messages().length, 0);
      assert.match(f.remote.body, /- \[ \] Works/);
    } finally {
      await engine.stop();
      f.store.close();
    }
  });
}

test('external Issue drift pauses completion for PM without adopting or overwriting the edit', async () => {
  const f = await repositoryFixture();
  const original = f.task().issueBody;
  f.remote.body += '\nMaintainer added requirements';
  const engine = f.engine();
  try {
    await engine.sync();
    await engine.stop();
    assert.equal(f.task().stage, 'merging');
    assert.equal(f.task().control, 'paused');
    assert.equal(f.task().issueBody, original);
    assert.equal(f.writes(), 0);
    assert.equal(f.questions.length, 1);
    assert.match(f.questions[0], /external body changes/);
    await engine.sync();
    assert.equal(f.questions.length, 1);
  } finally {
    await engine.stop();
    f.store.close();
  }
});

for (const invalid of ['evidence', 'merge-witness', 'unmerged', 'drift', 'marker'] as const) {
  test(`historical compensation skips ${invalid} and records a concrete blocker`, async () => {
    const f = fixture();
    legacyCompletion(f);
    if (invalid === 'evidence') f.patch({ reviews: [] });
    if (invalid === 'merge-witness')
      f.store.put('operation', `merge:${f.task().id}:${f.task().head}`, {
        id: `merge:${f.task().id}:${f.task().head}`,
        kind: 'merge-pr',
        status: 'done',
        result: undefined,
      });
    if (invalid === 'unmerged') f.unmerged();
    if (invalid === 'drift') f.remote.body += '\nExternal change';
    if (invalid === 'marker') f.patch({ issueBody: 'Unmanaged Issue' });
    const engine = f.engine();
    try {
      await engine.sync();
      assert.equal(f.writes(), 0);
      assert.equal(f.task().stage, 'done');
      assert.ok(f.task().blocked);
      assert.equal(f.questions.length, 0);
    } finally {
      await engine.stop();
      f.store.close();
    }
  });
}

test('Project recovery delivers the completion message once after Issue synchronization', async () => {
  const f = fixture();
  const engine = f.engine();
  try {
    f.projectFailure(true);
    await engine.sync();
    assert.equal(f.task().stage, 'done');
    assert.equal(f.remote.state, 'closed');
    assert.equal(f.messages().length, 0);
    f.projectFailure(false);
    await engine.sync();
    assert.equal(f.messages().length, 1);
    const delivered = f.messages()[0];
    assert.ok(delivered.descriptor?.code.startsWith('delivery_'));
    assert.doesNotMatch(delivered.content, /启动.*体验环境/);
    await engine.sync();
    assert.equal(f.messages().length, 1);
    assert.deepEqual(f.messages()[0], delivered, 'reconciliation never rewrites an old delivery');
    const restarted = f.engine();
    try {
      await restarted.sync();
      assert.deepEqual(f.messages(), [delivered], 'a successor host does not redeliver');
    } finally {
      await restarted.stop();
    }
    assert.equal(f.writes(), 1);
  } finally {
    await engine.stop();
    f.store.close();
  }
});

async function repositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), 'phantom-completion-'));
  const source = join(root, 'source');
  await command('git', ['init', '-b', 'main', source]);
  await command('git', ['config', 'user.name', 'Test'], source);
  await command('git', ['config', 'user.email', 'test@example.invalid'], source);
  await writeFile(join(source, 'README.md'), 'Fixture');
  await command('git', ['add', '.'], source);
  await command('git', ['commit', '-m', 'Fixture'], source);
  await command('git', ['remote', 'add', 'origin', source], source);
  return fixture(source, root, join(root, 'state.sqlite'));
}

for (const control of ['paused', 'active'] as const)
  test(`settled ${control} legacy evidence gaps remain immutable history across sync, tick and restart`, async () => {
    const f = await repositoryFixture();
    legacyCompletion(f);
    const reason =
      'Error: 历史 Task 完成同步缺少固定 revision 的测试、双轴 Review 或 PM 验收证据，需要 PM 核对';
    f.patch({
      tests: [],
      reviews: [],
      control,
      pausedByUser: false,
      pendingFeedback: ['Historical feedback remains available'],
      completionDeliveryPending: false,
      blocked: reason,
      reviewPolicyVersion: 2,
      prUrl: 'https://github.com/example/repo/pull/2',
      feedback: ['External PR delivered: https://github.com/example/repo/pull/2'],
    });
    for (const message of f.store.list('message'))
      f.store.updateMessage(message.id, { status: 'completed' });
    f.store.createIncident({
      projectId: f.task().projectId,
      taskId: f.task().id,
      phase: 'sync',
      message: reason,
      evidence: 'Original audit evidence',
    });
    const before = f.store.snapshot();
    for (let restart = 0; restart < 2; restart++) {
      const engine = f.engine();
      let remoteCalls = 0;
      engine.github.pull = async () => {
        remoteCalls++;
        throw new Error('Must not poll history');
      };
      try {
        await engine.start();
        for (let tick = 0; tick < 3; tick++) {
          await engine.sync();
          await engine.tick();
        }
        assert.deepEqual(
          f.store.snapshot(),
          before,
          'read/recovery cycles preserve all historical audit data',
        );
        const reasons = f.store.explainScheduling(f.task().projectId).tasks[0].reasons;
        assert.equal(
          reasons.some((r) => r.code === 'blocked' || r.code === 'paused'),
          false,
        );
        assert.equal(
          reasons.some((r) => r.code === 'feedback'),
          false,
          'historical feedback is not presented as a current waiting condition',
        );
        assert.equal(remoteCalls, 0);
        assert.equal(f.writes(), 0);
        assert.equal(f.statuses.length, 0);
        assert.equal(f.pmCalls(), 0);
      } finally {
        await engine.stop();
      }
      if (!restart) f.reopen();
    }
    f.store.close();
  });

test('revise_task publishes unchecked criteria and invalidates evidence until the new revision passes', async () => {
  const f = await repositoryFixture();
  f.unmerged();
  const engine = f.engine();
  try {
    const old = f.task();
    f.remote.body = f.remote.body.replaceAll('- [ ]', '- [x]');
    f.revise();
    const request = f.store.addMessage(
      old.projectId,
      'user',
      'Please implement the revised behavior',
      'implement',
    );
    await engine.chat(request);
    assert.deepEqual(f.task().acceptance, ['Revised behavior works']);
    assert.deepEqual(f.task().tests, []);
    assert.equal(f.task().mergeApproval, undefined);
    assert.deepEqual(f.task().reviews, []);
    assert.match(f.remote.body, /- \[ \] Revised behavior works/);
    assert.doesNotMatch(f.remote.body, /- \[x\]/);
    const writes = f.writes();
    await engine.sync();
    assert.equal(f.writes(), writes);
    f.patch({
      stage: 'merging',
      head: 'revised-head',
      mergeApproval: { head: 'revised-head', base: old.base! },
      tests: old.tests.map((t) => ({ ...t, head: 'revised-head' })),
      reviews: old.reviews.map((r) => ({ ...r, head: 'revised-head' })),
    });
    f.merged();
    await engine.sync();
    assert.equal(f.task().stage, 'done');
    assert.match(f.remote.body, /- \[x\] Revised behavior works/);
    await assert.rejects(
      engine.chat(f.store.addMessage(old.projectId, 'user', 'Revise again', 'implement')),
      /可修改范围/,
    );
    assert.match(f.remote.body, /- \[x\] Revised behavior works/);
  } finally {
    await engine.stop();
    f.store.close();
  }
});

test('an externally merged PR without deterministic merge evidence cannot complete its Issue or call PM', async () => {
  const f = fixture();
  const engine = f.engine();
  try {
    f.patch({ mergeApproval: undefined });
    await engine.sync();
    assert.equal(f.task().stage, 'merging');
    assert.equal(f.writes(), 0);
    assert.match(taskAttention(f.task()).blocked ?? '', /远端已合并.*待团队核对/);
    assert.equal(f.pmCalls(), 0, 'merge completion must not call PM for an acceptance decision');
  } finally {
    await engine.stop();
    f.store.close();
  }
});

function legacyCompletion(f: ReturnType<typeof fixture>) {
  const {
    mergeApproval: _approval,
    completionDeliveryPending: _delivery,
    reviewPolicyVersion: _policy,
    ...legacy
  } = f.task();
  const primary = f.task().reviews.find((review) => review.axis === 'primary')!;
  const oldReviews = (['standards', 'spec'] as const).map((axis) => ({
    ...primary,
    axis,
    verdict: undefined,
  }));
  f.store.put('task', legacy.id, { ...legacy, stage: 'done', reviews: oldReviews });
  const id = `merge:${legacy.id}:${legacy.head}`;
  f.store.put('operation', id, {
    id,
    kind: 'merge-pr',
    status: 'done',
    result: { number: 2, merged: true, head: { sha: 'head' }, base: { sha: 'base' } },
  });
  return id;
}

test('legacy persisted done task without new fields reconciles its historical host merge witness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-legacy-'));
  const f = fixture('.', root, join(root, 'state.sqlite'));
  legacyCompletion(f);
  f.reopen();
  const engine = f.engine();
  try {
    assert.equal(Object.hasOwn(f.task(), 'mergeApproval'), false);
    await engine.sync();
    assert.match(f.remote.body, /- \[x\] Works\n- \[x\] Persists/);
    assert.equal(f.remote.state, 'closed');
    assert.equal(f.task().issueBody, f.remote.body);
    await engine.sync();
    assert.equal(f.writes(), 1);
    assert.equal(f.messages().length, 0);
  } finally {
    await engine.stop();
    f.store.close();
  }
});

for (const invalid of [
  'pending',
  'uncertain',
  'kind',
  'missing-result',
  'pr',
  'head',
  'base',
  'unmerged',
  'tests',
  'reviews',
  'drift',
] as const) {
  test(`legacy persisted compensation refuses ${invalid} evidence`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'phantom-legacy-refusal-'));
    const f = fixture('.', root, join(root, 'state.sqlite'));
    const key = legacyCompletion(f);
    const op = f.store.get('operation', key)!;
    const result = op.result as {
      number: number;
      merged: boolean;
      head: { sha: string };
      base: { sha: string };
    };
    if (invalid === 'pending' || invalid === 'uncertain') op.status = invalid;
    if (invalid === 'kind') op.kind = 'create-pr';
    if (invalid === 'missing-result') op.result = undefined;
    if (invalid === 'pr') result.number = 99;
    if (invalid === 'head' || invalid === 'base') result[invalid].sha = 'different';
    if (invalid === 'unmerged') f.unmerged();
    if (invalid === 'tests') f.patch({ tests: [] });
    if (invalid === 'reviews') f.patch({ reviews: [] });
    if (invalid === 'drift') f.remote.body += '\nExternal edit';
    f.store.put('operation', key, op);
    f.reopen();
    const engine = f.engine();
    try {
      await engine.sync();
      assert.equal(f.writes(), 0);
      assert.equal(f.task().stage, 'done');
      assert.ok(f.task().blocked);
      assert.equal(f.messages().length, 0);
    } finally {
      await engine.stop();
      f.store.close();
    }
  });
}

test('a done Task that stays blocked for the same reason records it once, not every sync cycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-legacy-repeat-'));
  const f = fixture('.', root, join(root, 'state.sqlite'));
  legacyCompletion(f);
  f.patch({ tests: [] });
  f.reopen();
  const engine = f.engine();
  try {
    for (let i = 0; i < 5; i++) await engine.sync();
    assert.ok(f.task().blocked);
    const recorded = f.store.events().filter((e) => e.type === 'sync' && e.taskId === f.task().id);
    assert.equal(recorded.length, 1);
  } finally {
    await engine.stop();
    f.store.close();
  }
});

test('a completed and synchronized Task leaves the GitHub polling loop until something blocks it', async () => {
  const f = fixture();
  const engine = f.engine();
  const original = engine.github.pull.bind(engine.github);
  let pulls = 0;
  engine.github.pull = async (task) => {
    pulls++;
    return original(task);
  };
  try {
    await engine.sync();
    await engine.sync();
    assert.equal(f.task().stage, 'done');
    assert.equal(f.task().blocked, undefined);
    const settled = { pulls, statuses: f.statuses.length };
    for (let i = 0; i < 5; i++) await engine.sync();
    assert.equal(pulls, settled.pulls, 'a settled done Task is not fetched again');
    assert.equal(f.statuses.length, settled.statuses, 'its Project status is not rewritten');
    f.patch({ blocked: 'Project unavailable' });
    await engine.sync();
    assert.equal(pulls, settled.pulls + 1, 'a blocked done Task is reconciled again');
    assert.equal(f.task().blocked, undefined);
  } finally {
    await engine.stop();
    f.store.close();
  }
});

test('a new fixed-revision failure on a settled Task stays actionable on repeated sync', async () => {
  const f = await repositoryFixture();
  const validTests = f.task().tests;
  f.patch({
    stage: 'done',
    completionDeliveryPending: false,
    tests: f.task().tests.map((evidence) => ({ ...evidence, exitCode: 1 })),
  });
  let engine = f.engine();
  try {
    await engine.sync();
    const failed = f.task();
    for (let i = 0; i < 3; i++) await engine.sync();
    assert.deepEqual(f.task(), failed, 'the failure is recorded once');
    assert.equal(f.writes(), 0);
    assert.equal(f.messages().length, 0);
    assert.ok(
      f.store
        .explainScheduling(f.task().projectId)
        .tasks[0].reasons.some((reason) => reason.code === 'blocked'),
      'new verification failures never become historical notes',
    );
    assert.equal(f.task().tests[0].exitCode, 1);
    assert.equal(f.task().blockedDescriptor?.code, 'completion_evidence_invalid');
    await engine.stop();
    f.reopen();
    engine = f.engine();
    for (let i = 0; i < 2; i++) await engine.sync();
    assert.deepEqual(
      f.task(),
      failed,
      'the diagnostic survives Store reopen without repeated writes',
    );
    assert.ok(
      f.store
        .explainScheduling(f.task().projectId)
        .tasks[0].reasons.some((reason) => reason.code === 'blocked'),
    );
    f.patch({ tests: validTests });
    f.unmerged();
    await engine.sync();
    assert.match(f.task().blocked ?? '', /远端合并状态/);
    assert.equal(
      f.task().blockedDescriptor,
      undefined,
      'a different cause clears the previous diagnostic',
    );
  } finally {
    await engine.stop();
    f.store.close();
  }
});

for (const mode of [
  'drift-resume',
  'matched-no-review',
  'drift-reassign',
  'paginated',
  'same-pr-closer',
  'missing-relationship',
  'wrong-closure',
  'incomplete-page',
  'relation-read-failure',
  'legacy-marker',
  'issue-only',
  'issue-only-missing',
  'issue-only-not-planned',
  'issue-only-observed-not-planned',
] as const) {
  test(`external delivery settles original development through ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'phantom-external-settle-'));
    const f = fixture('.', root, join(root, 'state.sqlite'));
    const adopt = [
      'drift-resume',
      'matched-no-review',
      'drift-reassign',
      'paginated',
      'same-pr-closer',
      'issue-only',
    ].includes(mode);
    const issueOnly = mode.startsWith('issue-only');
    const remoteHead = 'a'.repeat(40);
    const localHead = mode === 'matched-no-review' ? remoteHead : 'b'.repeat(40);
    const base = 'c'.repeat(40);
    const mergeCommit = 'd'.repeat(40);
    const oldRun = f.store.run('dev', f.task().projectId, 'backend', f.task());
    f.store.finishRun(oldRun.id, 'completed');
    f.patch({
      stage: 'developing',
      head: localHead,
      base,
      worktree: 'never-open-user-worktree',
      ownerRunId: oldRun.id,
      devThreadId: 'original-owner-thread',
      retries: 2,
      tests: [{ command: 'test', exitCode: 0, output: 'pass', head: remoteHead, at: 'now' }],
      reviews: [],
      mergeApproval: undefined,
      pr: issueOnly ? undefined : 2,
      prState: issueOnly ? undefined : 'merged',
    });
    if (mode === 'issue-only-observed-not-planned')
      f.patch({
        issueState: 'completed',
        remoteMerge: {
          repoId: f.task().repoId,
          repository: 'example/repo',
          pr: 3,
          head: 'e'.repeat(40),
          base,
          baseRef: 'main',
          mergeCommit: 'f'.repeat(40),
          mergedAt: '2026-11-10T08:47:41Z',
          checkedAt: '2026-11-10T08:47:42Z',
        },
      });
    f.store.control(f.task().id, 'pause', { source: 'user', reason: 'original_pause' });
    f.store.put('run', oldRun.id, { ...oldRun, status: 'running' });
    const recovery = f.store.recover().find((item) => item.oldRunId === oldRun.id)!;
    const incident = f.store.createIncident({
      projectId: f.task().projectId,
      taskId: f.task().id,
      phase: 'validation',
      message: 'Original diagnosis',
      evidence: 'Original evidence',
    });
    f.store.updateIncident(incident.id, { status: 'waiting_user' });
    const before = f.task();
    f.store.patchRepo(before.repoId, { enabled: true });
    const dependent = f.store.createTask({
      projectId: before.projectId,
      repoId: before.repoId,
      sourceMessageId: before.sourceMessageId,
      title: 'Dependent',
      spec: 'Next',
      acceptance: ['Works'],
      dependencies: [before.id],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    f.store.control(dependent.id, 'pause');
    const controls = f.store.taskEvents(before.id).filter((event) => event.control);
    let issueReads = 0;
    class Remote extends GitHub {
      override async gh(args: string[], input?: string) {
        let response: unknown;
        if (args[1] === 'graphql') {
          if (mode === 'relation-read-failure') throw new Error('Relation read unavailable');
          const query = JSON.parse(input!);
          assert.doesNotMatch(query.query, /mutation/);
          const firstPage = mode === 'paginated' && !query.variables.prCursor;
          response = {
            data: {
              repository: {
                pullRequest: {
                  number: query.variables.pr,
                  closingIssuesReferences: {
                    nodes:
                      mode === 'missing-relationship' || mode === 'issue-only-missing' || firstPage
                        ? []
                        : [{ number: 1, repository: { nameWithOwner: 'example/repo' } }],
                    pageInfo: {
                      hasNextPage: mode === 'incomplete-page' || firstPage,
                      endCursor: firstPage ? 'next-pr' : null,
                    },
                  },
                },
                issue: {
                  number: 1,
                  state: 'CLOSED',
                  stateReason: 'COMPLETED',
                  timelineItems: {
                    nodes: firstPage
                      ? [{ __typename: 'ReopenedEvent', createdAt: '2026-11-10T08:00:00Z' }]
                      : [
                          {
                            __typename: 'ClosedEvent',
                            createdAt: '2026-11-10T08:47:42Z',
                            closer: {
                              __typename: 'PullRequest',
                              number: mode === 'same-pr-closer' ? 2 : 3,
                              repository: {
                                nameWithOwner:
                                  mode === 'wrong-closure' ? 'other/repo' : 'example/repo',
                              },
                            },
                          },
                        ],
                    pageInfo: {
                      hasNextPage: firstPage,
                      endCursor: firstPage ? 'next-issue' : null,
                    },
                  },
                },
              },
            },
          };
        } else if (/\/pulls\/[23]$/.test(args[1])) {
          assert.equal(args[args.indexOf('--method') + 1], 'GET');
          const closing = args[1].endsWith('/3');
          response = {
            number: closing ? 3 : 2,
            html_url: 'https://github.com/example/repo/pull/2',
            state: 'closed',
            merged: true,
            merged_at: '2026-11-10T08:47:41Z',
            merge_commit_sha:
              mode === 'legacy-marker' ? null : closing ? 'f'.repeat(40) : mergeCommit,
            head: {
              sha: closing ? 'e'.repeat(40) : remoteHead,
              ref: 'external-branch',
              repo: { full_name: 'example/repo' },
            },
            base: { sha: base, ref: 'main', repo: { full_name: 'example/repo' } },
            body: '',
          };
        } else if (args[1].endsWith('/issues/1')) {
          issueReads++;
          response = {
            state: 'closed',
            state_reason: mode.endsWith('not-planned') ? 'not_planned' : 'completed',
            body: before.issueBody,
            closed_at: '2026-11-10T08:47:42Z',
          };
        } else throw new Error(`Unexpected remote read: ${args[1]}`);
        return { stdout: JSON.stringify(response), stderr: '', code: 0 };
      }
    }
    class UntouchedWorkspaces extends Workspaces {
      override async assertTask() {}
    }
    const engine = new Engine(
      f.store,
      new Remote(f.store),
      new UntouchedWorkspaces('never-open-workspaces', f.store),
      '.',
      () => {
        throw new Error('Model calls forbidden');
      },
    );
    try {
      await engine.sync();
      const eventCount = f.store.events().length;
      await engine.sync();
      assert.equal(f.store.events().length, eventCount, 'repeated merge observation adds no event');
      if (mode.endsWith('not-planned')) {
        assert.equal(f.task().stage, 'cancelled');
        assert.equal(f.task().completion, undefined);
        assert.equal(f.messages().length, 0);
        return;
      }
      if (!adopt) {
        assert.equal(f.task().stage, before.stage);
        assert.equal(f.task().completion, undefined);
        assert.ok(f.task().externalCompletionPendingReason);
        f.store.control(dependent.id, 'resume');
        assert.equal(
          f.store.claimNext(),
          undefined,
          'unknown relationships do not release dependencies',
        );
        await assert.rejects(engine.resume(before.id), /待团队核对/);
        assert.equal(f.task().pausedByUser, true);
        assert.equal(f.task().ownerRunId, oldRun.id);
        assert.equal(f.messages().length, 0);
        return;
      }
      let refusal: unknown;
      try {
        if (mode === 'drift-reassign')
          await engine.reassign(before.id, { source: 'user', reason: 'test_reassign' });
        else await engine.resume(before.id, undefined, { source: 'user', reason: 'test_resume' });
      } catch (error) {
        refusal = error;
      }
      f.store.control(dependent.id, 'resume');
      assert.equal(
        f.store.claimNext()?.taskId,
        dependent.id,
        'only the released dependency may claim',
      );
      assert.match(String(refusal), /任务已经结束/);
      assert.equal(issueReads, 1, 'settled external delivery leaves the polling loop');
      assert.equal(f.task().issueState, 'completed');
      assert.equal(f.task().stage, 'done');
      const completion = f.task().completion;
      assert.equal(completion?.source, 'external');
      assert.ok(completion?.source === 'external');
      assert.equal(completion.localCheckpoint.stage, before.stage);
      assert.equal(completion.primary.pr, issueOnly ? 3 : 2);
      assert.equal(completion.closing.pr, mode === 'same-pr-closer' ? 2 : 3);
      assert.equal(f.task().pr, before.pr, 'original PR binding is never silently replaced');
      const deliveredHead = issueOnly ? 'e'.repeat(40) : remoteHead;
      const deliveredCommit = issueOnly ? 'f'.repeat(40) : mergeCommit;
      assert.equal(taskDeliveryHead(f.task()), deliveredHead);
      assert.deepEqual(taskDeliveryRevision(f.task()), {
        head: deliveredHead,
        commit: deliveredCommit,
      });
      assert.equal(mergeReady(f.task()), false, 'host review remains absent');
      assert.equal(f.task().control, 'paused');
      assert.equal(f.task().pausedByUser, true);
      assert.equal(f.task().head, localHead);
      assert.equal(f.task().ownerRunId, oldRun.id);
      assert.equal(f.task().devThreadId, before.devThreadId);
      assert.equal(f.task().retries, 2);
      assert.deepEqual(f.task().tests, before.tests);
      assert.deepEqual(f.task().reviews, []);
      assert.deepEqual(
        f.store.taskEvents(before.id).filter((event) => event.control),
        controls,
      );
      assert.equal(hasOwner(f.task()), false);
      assert.equal(taskAttention(f.task()).paused, false);
      const work = teamView(f.store.snapshot(), before.projectId).work.find(
        (work) => work.taskId === before.id,
      )!;
      assert.equal(workGroup(work), 'delivered');
      assert.equal(f.messages().length, 1);
      assert.equal(f.messages()[0].descriptor?.code, 'delivery_external_completed');
      const notice = await completionNotice(f.task(), f.store.repo(before.repoId), {
        kind: 'unknown',
        source: 'must-not-read-original-checkout',
      });
      assert.equal(notice.descriptor.code, 'delivery_external_completed');
      const report = renderReport({
        file: 'memory',
        readAt: new Date().toISOString(),
        events: [],
        documents: [
          {
            kind: 'project',
            id: before.projectId,
            body: JSON.stringify(f.store.project(before.projectId)),
          },
          { kind: 'repo', id: before.repoId, body: JSON.stringify(f.store.repo(before.repoId)) },
          { kind: 'task', id: before.id, body: JSON.stringify(f.task()) },
        ],
      });
      assert.match(report, /确认合并任务：1；历史 done 未确认：0/);
      assert.match(report, /来源=external/);
      assert.equal(
        f.store.events().filter((event) => event.type === 'external-completion').length,
        1,
      );
      const previewRepo = {
        ...f.store.repo(before.repoId),
        preview: {
          status: 'running' as const,
          url: 'http://localhost:7777',
          revision: deliveredCommit,
          taskHeads: [deliveredHead],
        },
      };
      assert.equal(deliveryPreview(f.task(), [previewRepo]), undefined);
      assert.ok(
        deliveryPreview(f.task(), [
          {
            ...previewRepo,
            preview: {
              ...previewRepo.preview,
              deliveryCommits: [deliveredCommit, 'f'.repeat(40)],
            },
          },
        ]),
      );
      assert.equal(f.store.get('incident', incident.id)?.message, 'Original diagnosis');
      assert.equal(f.store.get('incident', incident.id)?.status, 'waiting_user');
      assert.ok(f.store.get('incident', incident.id)?.supersededByExternalCompletionAt);
      assert.equal(f.store.get('recovery', recovery.id)?.successorRunId, undefined);
      assert.ok(f.store.get('recovery', recovery.id)?.supersededByExternalCompletionAt);
      f.reopen();
      const settled = f.task();
      const restarted = new Engine(
        f.store,
        new Remote(f.store),
        new UntouchedWorkspaces('unused', f.store),
        '.',
        () => {
          throw new Error('No retrospective model');
        },
      );
      await restarted.sync();
      assert.deepEqual(f.task(), settled, 'external done bypasses host evidence and remote writes');
      assert.equal(f.messages().length, 1);
      await restarted.resumeRecovery(before.projectId, recovery.id);
      assert.equal(f.store.get('recovery', recovery.id)?.successorRunId, undefined);
    } finally {
      f.store.close();
    }
  });
}

test('PM revision preserves remotely merged requirements and evidence', async () => {
  const f = await repositoryFixture();
  f.patch({
    stage: 'developing',
    worktree: 'must-not-open',
    control: 'paused',
    pausedByUser: true,
  });
  const before = f.task();
  const engine = f.engine();
  f.revise();
  try {
    const message = f.store.addMessage(before.projectId, 'user', 'Revise the behavior', 'feedback');
    await assert.rejects(engine.chat(message), /远端已合并/);
    assert.equal(f.task().spec, before.spec);
    assert.deepEqual(f.task().acceptance, before.acceptance);
    assert.deepEqual(f.task().tests, before.tests);
    assert.deepEqual(f.task().reviews, before.reviews);
    assert.equal(f.task().pausedByUser, true);
    assert.equal(f.task().stage, before.stage);
    assert.equal(f.writes(), 0);
    assert.equal(f.store.claimNext(), undefined);
  } finally {
    await engine.stop();
    f.store.close();
  }
});
