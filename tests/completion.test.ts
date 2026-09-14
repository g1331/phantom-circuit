import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { command } from '../src/server/process.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { GitHub, GitHubRejected, type PullState } from '../src/server/github.ts';
import { Engine } from '../src/server/engine.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Codex } from '../src/server/codex.ts';
import type { Task } from '../src/shared/types.ts';

function fixture(source = '.', dataDir = '.cache', dbPath = ':memory:') {
  let store = new Store(dbPath);
  const p = store.createProject('Completion', '');
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
    reviews: ['standards', 'spec'].map((axis) => ({
      axis: axis as 'standards' | 'spec',
      head: 'head',
      base: 'base',
      approved: true,
      findings: [],
      summary: 'pass',
    })),
  });
  const remote = { body, state: 'open' };
  let merged = true;
  let writes = 0;
  let lost = false;
  let reject = false;
  let projectUnavailable = false;
  const statuses: string[] = [];
  const questions: string[] = [];
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
      this.handler = options.toolHandler;
      return 'pm';
    }
    override async turn(_id: string, text: string) {
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
    unmerged: () => {
      merged = false;
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
      assert.deepEqual(f.task(), before);
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
for (const invalid of [
  'tests',
  'standards',
  'spec',
  'head',
  'base',
  'unmerged',
  'paused',
] as const) {
  test(`completion remains unchecked with invalid ${invalid} evidence`, async () => {
    const f = fixture();
    if (invalid === 'tests') f.patch({ tests: f.task().tests.map((t) => ({ ...t, exitCode: 1 })) });
    if (invalid === 'standards' || invalid === 'spec')
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

for (const invalid of ['evidence', 'pm-acceptance', 'unmerged', 'drift', 'marker'] as const) {
  test(`historical compensation skips ${invalid} and records a concrete blocker`, async () => {
    const f = fixture();
    f.patch({ stage: 'done' });
    if (invalid === 'evidence') f.patch({ reviews: [] });
    if (invalid === 'pm-acceptance') f.patch({ mergeApproval: undefined });
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
    await engine.sync();
    assert.equal(f.messages().length, 1);
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
  return fixture(source, root);
}

test('revise_task publishes unchecked criteria and invalidates evidence until the new revision passes', async () => {
  const f = await repositoryFixture();
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

test('an externally merged PR without pinned PM acceptance cannot complete its Issue', async () => {
  const f = fixture();
  const engine = f.engine();
  try {
    f.patch({ mergeApproval: undefined });
    await engine.sync();
    assert.equal(f.task().stage, 'merging');
    assert.equal(f.writes(), 0);
    assert.match(f.task().blocked ?? '', /PM/);
  } finally {
    await engine.stop();
    f.store.close();
  }
});

function legacyCompletion(f: ReturnType<typeof fixture>) {
  const { mergeApproval: _approval, completionDeliveryPending: _delivery, ...legacy } = f.task();
  f.store.put('task', legacy.id, { ...legacy, stage: 'done' });
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
