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
  const task = (title: string, deps: string[] = []) =>
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
      priority: 0,
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
  a.task('independent');
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
