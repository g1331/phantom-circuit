import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pullFixture } from './fake-github.ts';
import { fixture, blockedOnPublication } from './host-publication-fixture.ts';

test('a creation whose response was lost is adopted at resume, never created twice', async () => {
  const f = await fixture();
  try {
    // The remote accepted the creation; only the response was lost. This is the other half of
    // the real incident, and the variant that must never produce a second PR.
    f.loseResponse(true);
    const lost = await f.cycle();
    f.loseResponse(false);
    assert.equal(lost.control, 'paused');
    assert.match(lost.blocked!, /unexpected end of JSON input/);
    assert.equal(f.operation()!.status, 'uncertain');
    assert.equal(f.operation()!.result, undefined, 'the host never learned the result');
    assert.equal(f.github.posted.length, 1);
    assert.equal(f.github.writes, 1, 'the remote really did accept it');
    assert.equal(lost.head, await f.ws.git(f.task().worktree!, ['rev-parse', 'HEAD']));
    // Recovery must add no Dev work of its own; compare against the state after that first run.
    f.mark();

    // The visible PR is adopted on the next explicit resume, with no authorization and no write.
    await f.engine.resume(f.task().id);
    assert.equal(f.operation()!.reconciliation, undefined, 'a visible PR needs no authorization');
    const result = await f.cycle();
    assert.equal(result.stage, 'reviewing', result.blocked);
    assert.equal(result.pr, 41);
    assert.equal(result.blocked, undefined);
    assert.equal(f.github.posted.length, 1, 'the lost-response PR is adopted, not recreated');
    assert.equal(f.github.writes, 1, 'and no second PR ever reached the remote');
    assert.equal(result.retries, 0);
    // Adoption must not move the pinned revision, and must leave it with passing evidence for
    // the same commands. `base` is pinned by the fixture and origin/main never moves, so that
    // assertion only records the value; the head and evidence comparisons are the real checks.
    assert.equal(result.head, lost.head);
    assert.equal(result.base, lost.base);
    assert.deepEqual(
      result.tests.map((t) => [t.command, t.exitCode]),
      lost.tests.map((t) => [t.command, t.exitCode]),
      'the same commands still pass for the pinned revision',
    );
    assert.equal(f.starts(), 0, 'adoption needs no Dev session');
    assert.equal(f.turns(), 0);
    assert.equal(await f.ws.git(f.task().worktree!, ['status', '--porcelain']), '');
  } finally {
    await f.close();
  }
});

test('merged publication with incomplete relations stays held without writes', async () => {
  const f = await fixture();
  try {
    const failed = await blockedOnPublication(f);
    f.github.pulls = [
      pullFixture({
        number: 4,
        slug: 'example/repo',
        branch: f.task().branch!,
        body: `${f.marker()}\nSpec\n`,
        headSha: failed.head!,
        state: 'closed',
        merged: true,
      }),
    ];
    await f.engine.resume(f.task().id);
    const result = await f.cycle();
    assert.equal(result.pr, 4);
    assert.equal(result.stage, 'developing');
    assert.equal(result.prState, 'merged');
    assert.equal(f.store.claimNext(), undefined);
    assert.equal(f.github.posted.length, 1, 'the existing delivery is adopted, never duplicated');
    assert.equal(f.github.writes, 0);
    assert.equal(f.turns(), 0);
  } finally {
    await f.close();
  }
});

test('a remote delivery created before the crash is adopted on resume, not recreated', async () => {
  const f = await fixture();
  try {
    const failed = await blockedOnPublication(f);
    // The remote did accept the creation; only the response was lost. Model that by making the
    // existing PR visible, which is exactly what a re-read at resume discovers.
    f.github.pulls = [
      pullFixture({
        number: 3,
        slug: 'example/repo',
        branch: f.task().branch!,
        body: `${f.marker()}\nSpec\n`,
        headSha: failed.head!,
      }),
    ];
    await f.engine.resume(f.task().id);
    assert.equal(f.operation()!.reconciliation, undefined, 'adoption needs no authorization');
    const result = await f.cycle();
    assert.equal(result.pr, 3);
    assert.equal(f.github.posted.length, 1, 'the invisible-to-the-crash PR is adopted');
    assert.equal(f.github.writes, 0);
    assert.equal(f.turns(), 0);
  } finally {
    await f.close();
  }
});
