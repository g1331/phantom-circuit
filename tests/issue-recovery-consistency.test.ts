import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { issueFixture } from './issue-recovery-fixture.ts';

test('concurrent reconciliations share one authorization for a pending attempt', async () => {
  const f = await issueFixture();
  try {
    f.github.rejectBeforeWrite = true;
    await f.blocked();
    f.store.put('operation', f.key, { ...f.operation()!, status: 'pending' });
    let release!: () => void;
    f.github.readGate = new Promise<void>((resolve) => (release = resolve));
    const first = f.engine.reconcileTaskIssue(f.project.id, f.task().id);
    const second = f.engine.reconcileTaskIssue(f.project.id, f.task().id);
    release();
    const outcomes = await Promise.all([first, second]);
    f.github.readGate = undefined;
    assert.deepEqual(
      outcomes.map((result) => result.action),
      ['authorize', 'authorize'],
    );
    const authorization = f.operation()!.reconciliation!;
    assert.equal(authorization.observedOperation.status, 'pending');
    assert.equal(f.task().control, 'active');
    await f.engine.sync();
    await f.engine.sync();
    assert.equal(f.github.posts, 2);
    assert.equal(f.github.issues.length, 1);
    assert.equal(f.operation()!.attempt, 2);
  } finally {
    await f.engine.stop();
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a failed controlled Issue creation never repeats during background sync', async () => {
  const f = await issueFixture();
  try {
    f.github.rejectBeforeWrite = true;
    await f.blocked();
    const result = await f.engine.reconcileTaskIssue(f.project.id, f.task().id);
    assert.equal(result.action, 'authorize');
    f.github.rejectBeforeWrite = true;
    await f.engine.sync();
    assert.equal(f.github.posts, 2);
    assert.equal(f.operation()!.status, 'uncertain');
    assert.equal(f.operation()!.attempt, 2);
    assert.equal(f.operation()!.reconciliation, undefined);
    f.github.rejectBeforeWrite = false;
    await f.engine.sync();
    assert.equal(f.github.posts, 2);
    assert.equal(f.github.issues.length, 0);
    await assert.rejects(f.github.publishIssue(f.task()), /外部操作结果不明/);
    assert.equal(f.github.posts, 2);
  } finally {
    await f.engine.stop();
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a verification outlived by a new operation attempt never overwrites it', async () => {
  const f = await issueFixture();
  try {
    f.github.rejectBeforeWrite = true;
    await f.blocked();
    const original = f.operation()!;
    let release!: () => void;
    f.github.readGate = new Promise<void>((resolve) => (release = resolve));
    const stale = f.github.authorizeTaskIssueRetry(f.task(), 'pm');
    const newer = { ...original, attempt: 2 };
    f.store.put('operation', f.key, newer);
    release();
    await assert.rejects(stale, /任务或操作已变化/);
    assert.deepEqual(f.operation(), newer);
    assert.equal(f.github.posts, 1);
  } finally {
    await f.engine.stop();
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('authorization and project scope remain required for Issue recovery', async () => {
  const f = await issueFixture();
  try {
    await f.blocked();
    const original = f.operation();
    const other = f.store.createProject('Other', '');
    await assert.rejects(f.engine.reconcileTaskIssue(other.id, f.task().id), /跨项目/);
    f.store.patchRepo(f.repo.id, { authorized: false });
    const result = await f.engine.reconcileTaskIssue(f.project.id, f.task().id);
    assert.equal(result.action, 'blocked');
    assert.match('reason' in result ? result.reason : '', /仓库尚未授权/);
    assert.deepEqual(f.operation(), original);
    assert.equal(f.task().control, 'paused');
    assert.equal(f.github.posts, 1);
  } finally {
    await f.engine.stop();
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('fresh publication still permits a separate Issue with the same title', async () => {
  const f = await issueFixture();
  try {
    f.github.issues.push({
      number: 5,
      id: 50,
      node_id: 'other',
      html_url: `https://github.com/${f.repo.github}/issues/5`,
      title: f.task().title,
      body: 'Another Task with the same title',
      state: 'closed',
    });
    f.github.loseResponse = false;
    await f.github.publishIssue(f.task());
    assert.equal(f.task().issue, 41);
    assert.equal(f.github.posts, 1);
    assert.equal(f.github.issues.length, 2);
  } finally {
    await f.engine.stop();
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
