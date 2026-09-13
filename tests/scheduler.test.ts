import { DatabaseSync } from 'node:sqlite';
import type { PriorityLevel } from '../src/shared/priority.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function fixture(s: Store, name: string) {
  const p = s.createProject(name, '');
  const r = s.createRepo({
    projectId: p.id,
    name,
    path: `/fixture/${name}`,
    github: `owner/${name}`,
    defaultBranch: 'main',
    authorized: true,
  });
  const m = s.addMessage(p.id, 'user', 'Build', 'implement');
  const task = (title: string, deps: string[] = [], priority: number | PriorityLevel = 0) =>
    s.createTask({
      projectId: p.id,
      repoId: r.id,
      sourceMessageId: m.id,
      title,
      spec: title,
      acceptance: ['Observable behavior'],
      dependencies: deps,
      kind: 'backend',
      complexity: 'normal',
      priority,
      ...(typeof priority === 'string' ? { priorityReason: 'Scheduling decision' } : {}),
    });
  s.patchRepo(r.id, { enabled: true });
  return { p, r, task };
}

test('a closed repository can prepare work but cannot claim it; opening respects limits', () => {
  const s = new Store(':memory:');
  const p = s.createProject('Example', '');
  const r = s.createRepo({
    projectId: p.id,
    name: 'web',
    path: '/fixture',
    github: 'owner/web',
    defaultBranch: 'main',
    authorized: true,
  });
  const m = s.addMessage(p.id, 'user', 'Build login', 'implement');
  const t = s.createTask({
    projectId: p.id,
    repoId: r.id,
    sourceMessageId: m.id,
    title: 'Login',
    spec: 'Email login',
    acceptance: ['Can sign in'],
    dependencies: [],
    kind: 'frontend',
    complexity: 'normal',
    priority: 0,
  });
  assert.equal(s.claimNext(), undefined);
  s.patchRepo(r.id, { enabled: true, devLimit: 1 });
  assert.equal(s.claimNext()?.taskId, t.id);
  assert.equal(s.claimNext(), undefined);
  s.patchRepo(r.id, { enabled: false });
  assert.equal(s.task(t.id).stage, 'developing');
  s.close();
});

test('discussion cannot authorize work or cross-project dependencies', () => {
  const s = new Store(':memory:');
  const a = fixture(s, 'a');
  const b = fixture(s, 'b');
  const discuss = s.addMessage(a.p.id, 'user', 'What if?', 'discuss');
  assert.throws(
    () =>
      s.createTask({
        projectId: a.p.id,
        repoId: a.r.id,
        sourceMessageId: discuss.id,
        title: 'No',
        spec: 'No',
        acceptance: ['No'],
        dependencies: [],
        kind: 'backend',
        complexity: 'normal',
        priority: 0,
      }),
    /明确实施/,
  );
  assert.throws(() => a.task('bad', [b.task('other').id]), /同一|当前项目/);
  s.close();
});
test('global fairness, dependency gates, and repo/project caps govern claims', () => {
  const s = new Store(':memory:');
  const a = fixture(s, 'a');
  const b = fixture(s, 'b');
  const first = a.task('first');
  const dependent = a.task('dependent', [first.id]);
  const independent = a.task('independent');
  s.updateTask(first.id, { createdAt: '2026-01-01T00:00:00Z' });
  s.updateTask(dependent.id, { createdAt: '2026-01-02T00:00:00Z' });
  s.updateTask(independent.id, { createdAt: '2026-01-03T00:00:00Z' });
  const bt = b.task('other project');
  s.saveSettings({ ...s.settings(), globalDevLimit: 2 });
  const runA = s.claimNext()!;
  const runB = s.claimNext()!;
  assert.equal(runA.taskId, first.id);
  assert.equal(runB.taskId, bt.id);
  assert.equal(s.claimNext(), undefined);
  s.finishRun(runA.id, 'completed');
  s.updateTask(first.id, { stage: 'done' });
  assert.equal(s.claimNext()?.taskId, dependent.id);
  s.close();
});
test('closing claims does not prevent an existing task returning from review', () => {
  const s = new Store(':memory:');
  const a = fixture(s, 'a');
  const t = a.task('existing');
  const run = s.claimNext()!;
  s.finishRun(run.id, 'completed');
  s.patchRepo(a.r.id, { enabled: false });
  s.updateTask(t.id, { stage: 'developing' });
  a.task('new task');
  assert.equal(s.claimNext()?.taskId, t.id);
  assert.equal(s.claimNext(), undefined);
  s.close();
});
test('reopening the database preserves work and recovery pauses interrupted execution', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'phantom-db-')), 'test.sqlite');
  let s = new Store(file);
  const a = fixture(s, 'a');
  const t = a.task('durable');
  const run = s.claimNext()!;
  s.close();
  s = new Store(file);
  s.recover();
  assert.equal(s.task(t.id).control, 'paused');
  assert.equal(s.get('run', run.id)?.status, 'interrupted');
  assert.equal(s.claimNext(), undefined);
  s.control(t.id, 'resume');
  assert.equal(s.claimNext()?.taskId, t.id);
  s.close();
});
test('two store connections cannot claim the same task', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'phantom-race-')), 'test.sqlite');
  const a = new Store(file);
  const f = fixture(a, 'a');
  const t = f.task('one');
  const b = new Store(file);
  assert.equal(a.claimNext()?.taskId, t.id);
  assert.equal(b.claimNext(), undefined);
  a.close();
  b.close();
});

test('priority adjustment is durable metadata and changes the next claim without preemption', () => {
  const s = new Store(':memory:');
  const a = fixture(s, 'priority');
  const first = a.task('first');
  const second = a.task('second');
  const before = s.task(second.id);
  const request = {
    taskId: second.id,
    level: 'high' as const,
    reason: 'Unblocks delivery',
    expectedVersion: 0,
    requestId: 'adjust-1',
  };
  const changed = s.setTaskPriority(a.p.id, request, { actor: 'user' });
  assert.equal(changed.priority, 5);
  assert.equal(changed.priorityHistory?.length, 1);
  assert.deepEqual(changed.acceptance, before.acceptance);
  assert.deepEqual(s.setTaskPriority(a.p.id, request, { actor: 'user' }), changed);
  assert.throws(
    () => s.setTaskPriority(a.p.id, { ...request, requestId: 'stale' }, { actor: 'user' }),
    /version/i,
  );
  assert.equal(s.claimNext()?.taskId, second.id);
  s.setTaskPriority(
    a.p.id,
    { ...request, taskId: first.id, level: 'urgent', requestId: 'adjust-2' },
    { actor: 'pm' },
  );
  assert.equal(s.activeRuns().length, 1);
  assert.equal(s.claimNext()?.taskId, first.id);
  s.close();
});

test('schedule explanation preserves every gate and agrees with claims without writes', () => {
  const s = new Store(':memory:');
  const a = fixture(s, 'explain');
  const dep = a.task('dependency');
  const high = a.task('high', [dep.id]);
  s.updateTask(high.id, { priority: 10, control: 'paused', blocked: 'repair' });
  const before = s.snapshot();
  const explanation = s.explainScheduling(a.p.id);
  assert.deepEqual(explanation.candidates, [dep.id]);
  assert.deepEqual(
    explanation.tasks.find((t) => t.taskId === high.id)?.reasons.map((r) => r.code),
    ['paused', 'blocked', 'dependency'],
  );
  assert.deepEqual(s.snapshot(), before);
  assert.equal(s.claimNext()?.taskId, dep.id);
  s.saveSettings({ ...s.settings(), globalDevLimit: 1 });
  assert.deepEqual(s.explainScheduling(a.p.id).candidates, []);
  assert.ok(
    s
      .explainScheduling(a.p.id)
      .tasks.every((t) => t.reasons.some((r) => r.code === 'globalCapacity')),
  );
  s.close();
});

test('all named levels and legacy numeric priorities retain numeric descending claim order', () => {
  const s = new Store(':memory:');
  const a = fixture(s, 'levels');
  const levels = [
    a.task('low', [], 'low'),
    a.task('normal', [], 'normal'),
    a.task('high', [], 'high'),
    a.task('urgent', [], 'urgent'),
  ];
  assert.deepEqual(
    levels.map((t) => t.priority),
    [-5, 0, 5, 10],
  );
  for (const task of levels) s.updateTask(task.id, { stage: 'done' });
  const numbers = Array.from({ length: 21 }, (_, i) => a.task(`number ${i - 10}`, [], i - 10));
  for (const expected of [...numbers].reverse()) {
    const run = s.claimNext()!;
    assert.equal(run.taskId, expected.id);
    s.finishRun(run.id, 'completed');
    s.updateTask(expected.id, { stage: 'done' });
  }
  s.close();
});

test('new exact ties use stable IDs, older creation time wins, and explanation never advances rotation', () => {
  const s = new Store(':memory:');
  const a = fixture(s, 'stable');
  const b = fixture(s, 'rotation');
  const template = a.task('template');
  s.updateTask(template.id, { stage: 'done' });
  for (const [id, createdAt] of [
    ['z-new', '2026-01-02'],
    ['a-new', '2026-01-02'],
    ['older', '2026-01-01'],
  ])
    s.put('task', id, { ...template, id, createdAt });
  const other = b.task('other');
  assert.deepEqual(s.explainScheduling(a.p.id).candidates, ['older', 'a-new', 'z-new']);
  s.explainScheduling(b.p.id);
  s.explainScheduling(a.p.id);
  assert.equal(s.claimNext()?.taskId, 'older');
  assert.equal(s.claimNext()?.taskId, other.id);
  assert.equal(s.claimNext()?.taskId, 'a-new');
  s.close();
});

test('legacy database upgrade preserves exact insertion ties, mixed ordering, values and persisted audit', () => {
  const seed = new Store(':memory:');
  const a = fixture(seed, 'legacy');
  const template = a.task('old');
  const file = join(mkdtempSync(join(tmpdir(), 'phantom-priority-upgrade-')), 'db.sqlite');
  // Build a pre-contract SQLite fixture using its persisted document format and insertion order.
  const legacy = new DatabaseSync(file);
  legacy.exec(
    'CREATE TABLE documents (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));',
  );
  const insert = legacy.prepare('INSERT INTO documents VALUES (?,?,?)');
  for (const [kind, value] of [
    ['project', a.p],
    ['repo', seed.repo(a.r.id)],
  ] as const)
    insert.run(kind, value.id, JSON.stringify(value));
  for (const id of ['z-legacy', 'a-legacy']) {
    const { priorityVersion, priorityHistory, priorityReason, ...old } = template;
    insert.run('task', id, JSON.stringify({ ...old, id, priority: 1, createdAt: '2026-01-01' }));
  }
  legacy.close();
  seed.close();
  let s = new Store(file);
  assert.deepEqual(s.explainScheduling(a.p.id).candidates, ['z-legacy', 'a-legacy']);
  s.put('task', '0-new', { ...template, id: '0-new', createdAt: '2026-01-01', priority: 1 });
  assert.deepEqual(s.explainScheduling(a.p.id).candidates, ['z-legacy', 'a-legacy', '0-new']);
  s.close();
  s = new Store(file);
  assert.deepEqual(s.explainScheduling(a.p.id).candidates, ['z-legacy', 'a-legacy', '0-new']);
  assert.equal(s.task('z-legacy').priority, 1);
  assert.equal(s.task('z-legacy').priorityReason, undefined);
  const before = s.snapshot();
  s.explainScheduling(a.p.id);
  assert.deepEqual(s.snapshot(), before);
  assert.equal(s.claimNext()?.taskId, 'z-legacy');
  const request = {
    taskId: 'a-legacy',
    level: 'urgent',
    expectedVersion: 0,
    requestId: 'durable-adjust',
    reason: 'Release blocked',
  };
  s.setTaskPriority(a.p.id, request, { actor: 'user' });
  s.close();
  s = new Store(file);
  assert.equal(s.task('a-legacy').priorityReason, 'Release blocked');
  assert.equal(s.setTaskPriority(a.p.id, request, { actor: 'user' }).priorityHistory?.length, 1);
  assert.equal(s.task('a-legacy').legacyPriorityOrder, 1);
  assert.equal(s.claimNext()?.taskId, 'a-legacy');
  s.close();
});

test('priority writes preserve requirements and execution evidence and reject invalid or terminal edits', () => {
  const s = new Store(':memory:');
  const a = fixture(s, 'metadata');
  const other = fixture(s, 'other');
  const task = a.task('active');
  s.updateTask(task.id, {
    control: 'paused',
    blocked: 'Needs repair',
    stage: 'reviewing',
    head: 'head',
    base: 'base',
    pr: 4,
    retries: 2,
    tests: [{ command: 'verify', exitCode: 0, output: 'pass', head: 'head', at: '2026-01-01' }],
    reviews: [
      { axis: 'spec', head: 'head', base: 'base', approved: true, summary: 'works', findings: [] },
    ],
  });
  const before = s.task(task.id);
  const request = {
    taskId: task.id,
    level: 'high',
    reason: 'Delivery blocker',
    expectedVersion: 0,
    requestId: 'metadata',
  };
  assert.throws(() => s.setTaskPriority(other.p.id, request, { actor: 'pm' }), /跨项目/);
  assert.throws(() => s.setTaskPriority(a.p.id, { ...request, reason: ' ' }, { actor: 'pm' }));
  assert.throws(() =>
    s.setTaskPriority(a.p.id, { ...request, level: 'critical' }, { actor: 'pm' }),
  );
  assert.deepEqual(s.task(task.id), before);
  const result = s.setTaskPriority(a.p.id, request, { actor: 'pm' });
  const { priority, priorityVersion, priorityReason, priorityHistory, updatedAt, ...unchanged } =
    result;
  const {
    priority: oldPriority,
    priorityVersion: oldVersion,
    priorityReason: oldReason,
    priorityHistory: oldHistory,
    updatedAt: oldAt,
    ...expected
  } = before;
  assert.deepEqual(unchanged, expected);
  assert.throws(
    () => s.setTaskPriority(a.p.id, { ...request, reason: 'different payload' }, { actor: 'pm' }),
    /Request ID/,
  );
  for (const stage of ['done', 'cancelled'] as const) {
    s.updateTask(task.id, { stage });
    assert.throws(
      () =>
        s.setTaskPriority(
          a.p.id,
          { ...request, expectedVersion: 1, requestId: stage },
          { actor: 'user' },
        ),
      /结束/,
    );
  }
  s.close();
});

test('all waiting gates are explained while eligible lower-priority work proceeds with project and repository caps', () => {
  const s = new Store(':memory:');
  const a = fixture(s, 'gates');
  const b = fixture(s, 'available');
  const dep = a.task('dependency');
  const high = a.task('urgent', [dep.id], 'urgent');
  s.updateTask(high.id, { control: 'paused', blocked: 'repair', pendingFeedback: ['Clarify'] });
  s.patchRepo(a.r.id, {
    authorized: false,
    enabled: false,
    blocked: 'Remote unavailable',
    devLimit: 1,
  });
  s.put('project', a.p.id, { ...s.project(a.p.id), devLimit: 1 });
  s.run('dev', a.p.id, 'backend', high);
  const low = b.task('low', [], 'low');
  const reasons = s
    .explainScheduling(a.p.id)
    .tasks.find((t) => t.taskId === high.id)!
    .reasons.map((r) => r.code);
  assert.deepEqual(reasons, [
    'paused',
    'blocked',
    'feedback',
    'unauthorized',
    'repositoryBlocked',
    'workSwitch',
    'activeRun',
    'dependency',
    'projectCapacity',
    'repositoryCapacity',
  ]);
  assert.equal(s.claimNext()?.taskId, low.id);
  assert.equal(s.claimNext(), undefined);
  s.close();
});

test('SQLite persistence failure cannot leave priority or audit partially written', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'phantom-priority-atomic-')), 'db.sqlite');
  const s = new Store(file);
  const a = fixture(s, 'atomic');
  const task = a.task('before');
  const before = s.snapshot();
  const database = new DatabaseSync(file);
  // Inject failure at the external persistence adapter; observe results only through Store.
  database.exec(
    "CREATE TRIGGER reject_task_update BEFORE UPDATE ON documents WHEN NEW.kind='task' BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END;",
  );
  assert.throws(
    () =>
      s.setTaskPriority(
        a.p.id,
        {
          taskId: task.id,
          level: 'urgent',
          reason: 'Delivery',
          expectedVersion: 0,
          requestId: 'atomic',
        },
        { actor: 'user' },
      ),
    /fixture persistence failure/,
  );
  assert.deepEqual(s.snapshot(), before);
  database.exec('DROP TRIGGER reject_task_update');
  const changed = s.setTaskPriority(
    a.p.id,
    {
      taskId: task.id,
      level: 'urgent',
      reason: 'Delivery',
      expectedVersion: 0,
      requestId: 'atomic',
    },
    { actor: 'user' },
  );
  assert.equal(changed.priority, 10);
  assert.equal(changed.priorityHistory?.length, 1);
  database.close();
  s.close();
});
