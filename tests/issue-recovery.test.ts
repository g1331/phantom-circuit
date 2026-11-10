import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { issueFixture } from './issue-recovery-fixture.ts';
import { until } from './dev-fixture.ts';

test('PM adopts a lost-response Issue and continues original work', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await issueFixture();
  try {
    await f.blocked();
    const original = f.task();
    const { taskRevision: _binding, ...legacy } = f.operation()!;
    f.store.put('operation', f.key, legacy);
    await f.engine.start();
    await f.pm();
    assert.equal(f.exposed(), true);
    assert.equal(f.result().action, 'adopt');
    assert.equal(f.result().resumed, true);
    assert.equal(f.result().issue.number, 41);
    assert.equal(f.task().control, 'active');
    assert.equal(f.task().worktree, original.worktree);
    assert.equal(f.task().spec, original.spec);
    assert.deepEqual(f.task().acceptance, original.acceptance);
    f.store.patchRepo(f.repo.id, { enabled: true });
    await f.engine.tick();
    await until(() => f.devTurns() === 1, 'original work resumed');
    assert.equal(f.task().issue, 41);
    assert.equal(f.github.posts, 1);
    assert.equal(f.operation()!.status, 'done');
  } finally {
    await f.engine.stop();
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Issue recovery retains finalize and pinned engineering evidence', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await issueFixture();
  try {
    await writeFile(join(f.task().worktree!, 'index.cjs'), 'module.exports = 2;\n');
    const base = await f.ws.git(f.task().worktree!, ['rev-parse', 'HEAD']);
    f.store.updateTask(f.task().id, { stage: 'developing', devPhase: 'finalize', base });
    await f.ws.finalize(f.task());
    const tests = await f.ws.verify(f.task());
    f.store.updateTask(f.task().id, { tests });
    await f.blocked();
    const original = f.task();
    await f.engine.start();
    await f.pm();
    assert.equal(f.result().action, 'adopt');
    assert.equal(f.task().stage, 'developing');
    assert.equal(f.task().devPhase, 'finalize');
    assert.equal(f.task().head, original.head);
    assert.equal(f.task().base, original.base);
    assert.deepEqual(f.task().tests, tests);
    assert.equal(f.task().retries, original.retries);
    assert.equal(
      await readFile(join(f.task().worktree!, 'index.cjs'), 'utf8'),
      'module.exports = 2;\n',
    );
    assert.equal(f.devTurns(), 0);
    assert.equal(f.github.posts, 1);
  } finally {
    await f.engine.stop();
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('confirmed absence creates once across repeated PM calls and restart', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await issueFixture();
  let restarted: ReturnType<typeof f.makeEngine> | undefined;
  let reopened: Store | undefined;
  let originalClosed = false;
  try {
    f.github.rejectBeforeWrite = true;
    await f.blocked();
    const original = f.task();
    const { taskRevision: _binding, ...legacy } = f.operation()!;
    f.store.put('operation', f.key, legacy);
    const failed = f.operation();
    await f.engine.start();
    await f.pm();
    assert.equal(f.result().action, 'authorize');
    assert.equal(f.result().resumed, true);
    const authorization = f.operation()!.reconciliation!;
    assert.equal(authorization.actor, 'pm');
    assert.equal(authorization.observedOperation.attempt, 1);
    await f.pm();
    assert.equal(f.operation()!.reconciliation!.id, authorization.id);
    assert.equal(f.github.posts, 1, 'reconciliation itself never creates');
    await f.engine.stop();
    f.store.close();
    originalClosed = true;
    reopened = new Store(join(f.root, 'db.sqlite'));
    const remote = new f.Remote(reopened);
    remote.loseResponse = false;
    restarted = f.makeEngine(reopened, remote);
    await restarted.start();
    reopened.patchRepo(f.repo.id, { enabled: true });
    await restarted.tick();
    await until(() => f.devTurns() === 1, 'continued after restart');
    const continued = reopened.task(original.id);
    assert.equal(continued.issue, 41);
    assert.equal(remote.issues.length, 1);
    assert.equal(remote.posts, 1, 'one controlled creation in the successor host');
    assert.equal(reopened.get('operation', f.key)!.attempt, 2);
    assert.equal(reopened.get('operation', f.key)!.reconciliation, undefined);
    assert.equal(continued.worktree, original.worktree);
    assert.deepEqual(continued.acceptance, original.acceptance);
    assert.ok(
      reopened.taskEvents(original.id).some((event) => event.message.includes(failed!.error!)),
      'original failed operation remains in durable history',
    );
    await restarted.sync();
    assert.equal(remote.posts, 1);
  } finally {
    await restarted?.stop();
    await f.engine.stop();
    reopened?.close();
    if (!originalClosed) f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
