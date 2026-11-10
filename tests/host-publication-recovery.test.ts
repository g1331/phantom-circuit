import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, blockedOnPublication } from './host-publication-fixture.ts';

test('host recovery authorizes one controlled publication and completes without rework', async (t) => {
  // Only explicit cycles drive the engine: a background tick could publish between the two resumes.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture();
  try {
    const failed = await blockedOnPublication(f);
    const evidence = failed.tests;

    await f.engine.resume(f.task().id);
    assert.equal(f.task().control, 'active');
    const authorization = f.operation()!.reconciliation!;
    assert.equal(authorization.verdict, 'absent');
    assert.equal(authorization.actor, 'user');
    assert.equal(authorization.observedOperation.status, 'uncertain');
    // The authorization names the revision that was verified: it moves with the pinned head and
    // base, and stays put while they do.
    assert.ok(authorization.taskRevision.includes(failed.repoId));
    assert.ok(authorization.taskRevision.includes(failed.branch!));
    assert.ok(authorization.taskRevision.includes(failed.head!));
    assert.ok(authorization.taskRevision.includes(failed.base!));

    // Repeating the explicit resume before any publication re-affirms the same single-use
    // authorization instead of stacking a second one.
    await f.engine.resume(f.task().id);
    assert.equal(f.operation()!.reconciliation!.id, authorization.id);
    assert.equal(f.github.posted.length, 1, 'coordination alone never writes');

    const result = await f.cycle();
    assert.equal(result.stage, 'reviewing', result.blocked);
    assert.equal(result.pr, 41);
    assert.equal(result.blocked, undefined);
    assert.equal(result.retries, 0, 'recovery must not spend product retry budget');
    assert.equal(f.github.posted.length, 2, 'exactly one controlled retry was attempted');
    assert.equal(f.github.writes, 1, 'exactly one PR ever reached the remote');
    assert.equal(f.operation()!.status, 'done');
    assert.equal(f.operation()!.reconciliation, undefined, 'the authorization is consumed');
    assert.equal(f.starts(), 0, 'no extra Dev session after recovery');
    assert.equal(f.turns(), 0, 'no reimplementation turn');
    // The pinned revision did not move, and it still carries passing formal evidence for the
    // same commands. (Recovery may reuse the unchanged head's evidence or run it again, so this
    // compares content, not the identity of the original evidence record.)
    assert.equal(result.head, failed.head);
    assert.equal(result.base, failed.base);
    assert.deepEqual(
      result.tests.map((t) => [t.command, t.exitCode]),
      evidence.map((t) => [t.command, t.exitCode]),
      'the same commands still pass for the pinned revision',
    );
    assert.equal(
      await readFile(join(f.task().worktree!, 'implementation.txt'), 'utf8'),
      'implemented\n',
      'the worktree is preserved',
    );
    assert.equal(await f.ws.git(f.task().worktree!, ['status', '--porcelain']), '');
    assert.equal(
      await f.ws.git(f.source, ['status', '--porcelain']),
      '',
      'origin checkout untouched',
    );

    // A further tick adopts the completed operation instead of publishing again.
    await f.cycle();
    assert.equal(f.github.posted.length, 2);
    assert.equal(f.task().stage, 'reviewing');
  } finally {
    await f.close();
  }
});

test('two concurrent resumes coordinate once and leave the task publishable', async () => {
  const f = await fixture();
  try {
    const failed = await blockedOnPublication(f);
    // Hold every remote reconciliation read so both resumes park inside the same await, which
    // makes the interleaving deterministic rather than timing-dependent.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    f.github.readGate = held;
    const first = f.engine.resume(f.task().id);
    const second = f.engine.resume(f.task().id);
    release();
    const settled = await Promise.allSettled([first, second]);
    f.github.readGate = undefined;

    // Whatever the loser reported, the task must still be recoverable and must publish once.
    const result = await f.cycle();
    assert.equal(
      result.stage,
      'reviewing',
      `blocked=${result.blocked} outcomes=${settled.map((s) => s.status).join(',')}`,
    );
    assert.equal(result.pr, 41);
    assert.equal(result.blocked, undefined);
    assert.equal(result.retries, 0, 'concurrency must not spend product retry budget');
    assert.equal(f.github.posted.length, 2, 'exactly one controlled retry is attempted');
    assert.equal(f.github.writes, 1, 'exactly one PR ever reached the remote');
    assert.equal(f.operation()!.status, 'done');
    assert.equal(f.operation()!.reconciliation, undefined);
    assert.ok(f.operation()!.attempt! <= 2, 'no extra attempt version was allocated');
    assert.equal(f.starts(), 0, 'concurrency never starts an extra Dev session');
    assert.equal(f.turns(), 0, 'concurrency never runs a reimplementation turn');
    assert.equal(result.head, failed.head, 'the pinned revision did not move');
    assert.equal(result.base, failed.base);
    assert.deepEqual(
      result.tests.map((t) => [t.command, t.exitCode]),
      failed.tests.map((t) => [t.command, t.exitCode]),
      'the pinned revision keeps its own evidence',
    );
    assert.equal(await f.ws.git(f.task().worktree!, ['status', '--porcelain']), '');
    assert.equal(await f.ws.git(f.source, ['status', '--porcelain']), '');
    console.log('  concurrent resume outcomes: %s', JSON.stringify(settled.map((s) => s.status)));
  } finally {
    await f.close();
  }
});

test('engine shutdown drains a review Incident assessment before the Store closes', async () => {
  const f = await fixture();
  try {
    await blockedOnPublication(f);
    await f.engine.resume(f.task().id);
    const result = await f.cycle();
    assert.equal(result.stage, 'reviewing', result.blocked);

    // The next public tick launches the review. The fixture reviewer returns a non-structured
    // handoff, so its failure schedules a PM Incident assessment while shutdown is racing it.
    await f.engine.tick();
    await f.engine.stop();
    assert.equal(f.store.activeRuns().length, 0, 'stop must finish every Run before Store close');
  } finally {
    await f.close();
  }
});

test('a controlled retry that fails again pauses with the blocker and never loops on ticks', async () => {
  const f = await fixture();
  try {
    await blockedOnPublication(f);
    await f.engine.resume(f.task().id);
    assert.ok(f.operation()!.reconciliation, 'the verified absence was recorded');

    f.failWrite(true);
    const failed = await f.cycle();
    f.failWrite(false);
    assert.equal(failed.control, 'paused');
    assert.equal(failed.stage, 'developing');
    assert.equal(failed.devPhase, 'finalize');
    assert.match(failed.blocked!, /HTTP 502/);
    assert.equal(f.github.posted.length, 2);
    assert.equal(f.operation()!.status, 'uncertain');
    assert.equal(f.operation()!.reconciliation, undefined, 'the authorization was consumed');
    assert.equal(failed.retries, 0);

    for (let n = 0; n < 4; n++) await f.cycle();
    assert.equal(f.operation()!.reconciliation, undefined, 'ticks never re-authorize');
    assert.equal(f.github.posted.length, 2, 'ticks never re-attempt the write');
    assert.equal(f.task().control, 'paused');

    // Only another explicit host resume can move it forward, and it does so once.
    await f.engine.resume(f.task().id);
    assert.ok(f.operation()!.reconciliation);
    const result = await f.cycle();
    assert.equal(result.stage, 'reviewing', result.blocked);
    assert.equal(f.github.posted.length, 3);
    assert.equal(f.github.writes, 1);
  } finally {
    await f.close();
  }
});

for (const status of ['uncertain', 'pending'] as const) {
  test(`a ${status} create-pr is reconciled on resume rather than assumed unperformed`, async () => {
    const f = await fixture();
    try {
      await blockedOnPublication(f);
      // `pending` is what an interruption between recording the attempt and the write leaves.
      f.store.put('operation', f.key(), { id: f.key(), kind: 'create-pr', status });
      await f.engine.resume(f.task().id);
      assert.equal(f.task().control, 'active');
      assert.equal(f.operation()!.reconciliation!.observedOperation.status, status);
      const result = await f.cycle();
      assert.equal(result.stage, 'reviewing', result.blocked);
      assert.equal(f.github.posted.length, 2);
      assert.equal(f.github.writes, 1);
    } finally {
      await f.close();
    }
  });
}

test('a revision that moves after verification converges in one more resume, never duplicating', async () => {
  const f = await fixture();
  try {
    const failed = await blockedOnPublication(f);
    await f.engine.resume(f.task().id);
    const stale = f.operation()!.reconciliation!;

    // Work left in the worktree is committed by the next finalization, moving the revision the
    // verification was about. The stale conclusion must not be spent on the new revision.
    await writeFile(join(f.task().worktree!, 'implementation.txt'), 'implemented again\n');
    const refused = await f.cycle();
    assert.equal(refused.control, 'paused');
    assert.match(refused.blocked!, /核对结论与当前任务版本不一致/);
    assert.notEqual(refused.head, failed.head, 'the revision really did move');
    assert.ok(
      stale.taskRevision.includes(failed.head!),
      'the stale conclusion names the revision that was verified',
    );
    assert.ok(
      !stale.taskRevision.includes(refused.head!),
      'and not the revision the task now has, which is why it was refused',
    );
    assert.equal(f.github.posted.length, 1, 'the stale conclusion never reached the remote');

    await f.engine.resume(f.task().id);
    assert.notEqual(f.operation()!.reconciliation!.id, stale.id);
    const result = await f.cycle();
    assert.equal(result.stage, 'reviewing', result.blocked);
    assert.equal(f.github.posted.length, 2, 'the moved revision publishes exactly once');
    assert.equal(f.github.writes, 1);
    assert.equal(f.turns(), 0, 'the preserved work is reused, not reimplemented');
    assert.equal(
      await readFile(join(f.task().worktree!, 'implementation.txt'), 'utf8'),
      'implemented again\n',
    );
  } finally {
    await f.close();
  }
});
