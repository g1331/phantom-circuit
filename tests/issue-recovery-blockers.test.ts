import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { issueFixture } from './issue-recovery-fixture.ts';
import { until } from './dev-fixture.ts';

const blockers = [
  ['multiple candidates', '存在 2 个相关候选'],
  ['body drift', '内容或状态发生漂移'],
  ['title drift', '内容或状态发生漂移'],
  ['closed Issue', '内容或状态发生漂移'],
  ['removed marker', '内容或状态发生漂移'],
  ['access failure', 'HTTP 403'],
  ['malformed response', '无法解析'],
  ['partial identity', '缺少必要字段'],
  ['truncated response', '响应被截断'],
  ['unfinished listing', '500 页上限'],
  ['incomplete access evidence', '缺少完整仓库访问证据'],
  ['changed requirements', '创建内容已变化'],
] as const;

for (const [scenario, reason] of blockers) {
  test(`PM preserves the operation and internal blocker on ${scenario}`, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const f = await issueFixture();
    try {
      await f.blocked();
      const original = f.operation();
      const issue = f.github.issues[0];
      if (scenario === 'multiple candidates') {
        // Put the second match on a later page; a first-page match is insufficient.
        const filler = Array.from({ length: 19 }, (_, n) => ({
          ...issue,
          number: 100 + n,
          title: `Other ${n}`,
          body: 'Unrelated',
        }));
        f.github.issues.push(...filler, {
          ...issue,
          number: 42,
          html_url: `https://github.com/${f.repo.github}/issues/42`,
        });
      }
      if (scenario === 'body drift') issue.body += '\nExternal edit';
      if (scenario === 'title drift') issue.title = 'Changed';
      if (scenario === 'closed Issue') issue.state = 'closed';
      if (scenario === 'removed marker') issue.body = 'User replaced the body';
      if (scenario === 'access failure')
        f.github.readError = new Error('gh (1): HTTP 403 Forbidden');
      if (scenario === 'malformed response') f.github.readBody = '{';
      if (scenario === 'partial identity') f.github.readBody = '[{"number":41}]';
      if (scenario === 'truncated response') {
        f.github.readBody = '[]';
        f.github.truncated = true;
      }
      if (scenario === 'unfinished listing')
        f.github.readBody = JSON.stringify(
          Array.from({ length: 20 }, (_, n) => ({ number: n + 100, title: 'Other', body: null })),
        );
      if (scenario === 'incomplete access evidence') f.github.access = {};
      if (scenario === 'changed requirements') f.store.updateTask(f.task().id, { spec: 'Changed' });
      await f.engine.start();
      await f.pm();
      assert.equal(f.result().action, 'blocked');
      assert.equal(f.result().resumed, false);
      assert.match(f.result().reason, new RegExp(reason));
      assert.equal(f.task().control, 'paused');
      assert.match(f.task().blocked!, new RegExp(reason));
      assert.deepEqual(f.operation(), original);
      await f.engine.sync();
      assert.equal(f.github.posts, 1);
      assert.equal(f.devTurns(), 0);
    } finally {
      await f.engine.stop();
      f.store.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

for (const created of [true, false]) {
  const outcome = created ? 'adoption' : 'authorized creation';
  test(`user pause during reconciliation holds ${outcome}`, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const f = await issueFixture();
    try {
      f.github.rejectBeforeWrite = !created;
      await f.blocked();
      await f.engine.start();
      let release!: () => void;
      f.github.readGate = new Promise<void>((resolve) => (release = resolve));
      const reconciling = f.pm();
      await until(() => f.github.heldReads > 0, 'host is reading remote evidence');
      f.engine.control(f.task().id, 'pause', { source: 'user', reason: 'task_pause' });
      release();
      await reconciling;
      f.github.readGate = undefined;
      assert.equal(f.result().action, 'blocked');
      assert.match(f.result().reason, /暂停/);
      assert.equal(f.task().control, 'paused');
      assert.equal(f.task().pausedByUser, true);
      await f.engine.sync();
      assert.equal(f.github.posts, 1, 'sync leaves the controlled retry unconsumed');
      await f.pm();
      assert.equal(f.result().action, 'blocked', 'PM cannot release the user pause');
      await f.engine.resume(f.task().id, undefined, { source: 'user', reason: 'task_resume' });
      await f.engine.sync();
      assert.equal(f.task().issue, 41);
      assert.equal(f.github.posts, created ? 1 : 2);
    } finally {
      await f.engine.stop();
      f.store.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test('user pause during authorized publication preserves the single-use authorization', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await issueFixture();
  try {
    f.github.rejectBeforeWrite = true;
    await f.blocked();
    await f.engine.start();
    await f.pm();
    assert.equal(f.result().action, 'authorize');
    const authorization = f.operation()!.reconciliation!;
    let release!: () => void;
    f.github.readGate = new Promise<void>((resolve) => (release = resolve));
    const publishing = f.github.publishIssue(f.task());
    const rejected = assert.rejects(publishing, /任务已暂停或结束/);
    await until(() => f.github.heldReads > 0, 'authorized publication is reading remote evidence');
    f.engine.control(f.task().id, 'pause', { source: 'user', reason: 'task_pause' });
    release();
    await rejected;
    f.github.readGate = undefined;
    assert.equal(f.github.posts, 1);
    assert.equal(f.task().pausedByUser, true);
    assert.equal(f.operation()!.reconciliation!.id, authorization.id);
    assert.equal(f.operation()!.attempt, 1);
    await f.engine.resume(f.task().id, undefined, { source: 'user', reason: 'task_resume' });
    await f.github.publishIssue(f.task());
    assert.equal(f.github.posts, 2);
    assert.equal(f.github.issues.length, 1);
    assert.equal(f.task().issue, 41);
    assert.equal(f.operation()!.reconciliation, undefined);
  } finally {
    await f.engine.stop();
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Issue reconciliation leaves unrelated blocked work paused', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await issueFixture();
  try {
    f.store.updateTaskControl(
      f.task().id,
      { control: 'paused', pausedByUser: false, blocked: 'Other engineering blocker' },
      'pause',
      { source: 'host', reason: 'task_blocked' },
    );
    await f.engine.start();
    await f.pm();
    assert.equal(f.result().action, 'none');
    assert.equal(f.result().resumed, false);
    assert.equal(f.task().control, 'paused');
    assert.equal(f.task().blocked, 'Other engineering blocker');
    assert.equal(f.github.posts, 0);
  } finally {
    await f.engine.stop();
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
