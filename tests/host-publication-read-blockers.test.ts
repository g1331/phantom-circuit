import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pullFixture } from './fake-github.ts';
import { fixture, blockedOnPublication } from './host-publication-fixture.ts';

test('a listing that cannot be read to its end blocks with the reason and spends nothing', async () => {
  const f = await fixture();
  try {
    const failed = await blockedOnPublication(f);
    // The remote answers, but the listing never ends, so no page bound can confirm its end.
    f.github.endlessPages = true;
    await assert.rejects(f.engine.resume(f.task().id), /最多 500 页的上限/);
    f.github.endlessPages = false;

    const blocked = f.task();
    assert.equal(blocked.control, 'paused');
    assert.equal(blocked.stage, 'developing');
    assert.equal(blocked.devPhase, 'finalize');
    assert.match(blocked.blocked!, /任务恢复环境阻塞/);
    assert.match(blocked.blocked!, /最多 500 页的上限/, 'the read blocker names the reason');
    assert.equal(blocked.retries, 0, 'an unread listing never spends product retry budget');
    assert.equal(blocked.head, failed.head, 'the pinned revision did not move');
    assert.equal(blocked.base, failed.base);
    assert.equal(f.operation()!.reconciliation, undefined, 'nothing was authorized');
    assert.equal(f.operation()!.status, 'uncertain');
    assert.equal(f.github.posted.length, 1, 'nothing was created');
    assert.equal(f.github.writes, 0);
    assert.equal(f.starts(), 0, 'no extra Dev session');
    assert.equal(f.turns(), 0);

    // Ticks must not turn an unread listing into a retry loop either. Check the invariant at
    // every step: the task stays paused, so no tick can claim it, and no grant or write appears.
    for (let i = 0; i < 4; i++) {
      assert.equal((await f.cycle()).control, 'paused', `tick ${i} must not resume the task`);
      assert.equal(f.github.posted.length, 1, `tick ${i} must not create`);
      assert.equal(f.operation()!.reconciliation, undefined, `tick ${i} must not authorize`);
      assert.equal(f.store.activeRuns().length, 0, `tick ${i} must not start a Run`);
    }

    // Once the listing can be read to its end, the same explicit resume recovers normally.
    await f.engine.resume(f.task().id);
    const result = await f.cycle();
    assert.equal(result.stage, 'reviewing', result.blocked);
    assert.equal(result.pr, 41);
    assert.equal(result.blocked, undefined);
    assert.equal(f.github.posted.length, 2, 'exactly one controlled retry after recovery');
    assert.equal(f.github.writes, 1);
    assert.equal(result.retries, 0, 'recovery still spends no product retry budget');
    assert.equal(result.head, failed.head);
    assert.equal(f.starts(), 0);
    assert.equal(f.turns(), 0);
    assert.equal(await f.ws.git(f.task().worktree!, ['status', '--porcelain']), '');
  } finally {
    await f.close();
  }
});

test('an incomplete read at resume keeps the outstanding authorization for a later resume', async () => {
  const f = await fixture();
  try {
    const failed = await blockedOnPublication(f);
    // An explicit resume verifies absence and records the one outstanding authorization.
    await f.engine.resume(f.task().id);
    const granted = f.operation()!.reconciliation;
    assert.ok(granted, 'the first resume authorized the controlled retry');

    // A later resume cannot read the listing to its end. The grant must survive that untouched.
    f.github.endlessPages = true;
    await assert.rejects(f.engine.resume(f.task().id), /最多 500 页的上限/);
    f.github.endlessPages = false;
    assert.equal(f.operation()!.reconciliation!.id, granted.id, 'the grant was not replaced');
    assert.equal(f.operation()!.reconciliation!.verdict, 'absent');
    assert.equal(f.task().retries, 0, 'an unread listing spends no product retry budget');
    assert.equal(f.github.posted.length, 1, 'and reaches no creation');
    assert.equal(f.github.writes, 0);
    assert.equal(f.starts(), 0, 'no extra Dev session');
    assert.equal(f.turns(), 0);

    // The same single-use grant still publishes exactly once when the listing is readable again.
    // A second explicit resume re-affirms that grant rather than replacing or spending it.
    f.github.endlessPages = false;
    await f.engine.resume(f.task().id);
    assert.equal(
      f.operation()!.reconciliation!.id,
      granted.id,
      'coordination re-affirms the outstanding grant instead of stacking a new one',
    );
    const result = await f.cycle();
    assert.equal(result.stage, 'reviewing', result.blocked);
    assert.equal(result.pr, 41);
    assert.equal(f.github.posted.length, 2);
    assert.equal(f.github.writes, 1);
    assert.equal(f.operation()!.reconciliation, undefined, 'the grant was consumed exactly once');
    assert.equal(result.retries, 0);
    assert.equal(result.head, failed.head);
    assert.equal(f.starts(), 0);
    assert.equal(f.turns(), 0);
  } finally {
    await f.close();
  }
});

test('an unreadable remote at resume leaves a concrete blocker and authorizes nothing', async () => {
  const f = await fixture();
  try {
    await blockedOnPublication(f);
    f.failRead(true);
    await assert.rejects(f.engine.resume(f.task().id), /HTTP 502/);
    const blocked = f.task();
    assert.equal(blocked.control, 'paused');
    assert.match(blocked.blocked!, /任务恢复环境阻塞/);
    assert.equal(f.operation()!.reconciliation, undefined);
    assert.equal(f.github.posted.length, 1);

    // Periodic ticks must not quietly authorize or retry the publication.
    for (let n = 0; n < 3; n++) await f.cycle();
    assert.equal(f.operation()!.reconciliation, undefined);
    assert.equal(f.github.posted.length, 1);
    assert.equal(f.github.writes, 0);
  } finally {
    await f.close();
  }
});

test('a related PR the host cannot adopt blocks recovery and preserves the human body', async () => {
  const f = await fixture();
  try {
    await blockedOnPublication(f);
    const edited = 'A maintainer rewrote this PR body by hand.\n';
    f.github.pulls = [
      pullFixture({
        number: 7,
        slug: 'example/repo',
        branch: f.task().branch!,
        body: edited,
        headSha: f.task().head!,
      }),
    ];
    await assert.rejects(f.engine.resume(f.task().id), /需要人工核对.*缺少任务标记/);
    assert.match(f.task().blocked!, /任务恢复环境阻塞/);
    assert.equal(f.operation()!.reconciliation, undefined);
    assert.equal(f.github.posted.length, 1, 'a marker-less PR never authorizes a new one');
    assert.equal(f.github.pulls[0].body, edited);
    for (let n = 0; n < 3; n++) await f.cycle();
    assert.equal(f.github.posted.length, 1);
  } finally {
    await f.close();
  }
});
