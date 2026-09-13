import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { Codex } from '../src/server/codex.ts';
import { command } from '../src/server/process.ts';
import { FakeGitHub, pullFixture } from './fake-github.ts';
import type { Task } from '../src/shared/types.ts';

/**
 * Complete host recovery for a create-pr whose remote outcome is unknown, driven through the real
 * Engine lifecycle: a real temporary Git repository, the real workspace finalization and push,
 * the real GitHub adapter, and only the `gh` process boundary faked. Nothing here calls an
 * adapter method directly to stand in for the host - every assertion follows `engine.resume` and
 * `engine.tick`, which is where the host actually recovers.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'phantom-publication-'));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  await command('git', ['init', '--bare', remote]);
  await command('git', ['init', '-b', 'main', source]);
  const git = (args: string[], cwd = source) => command('git', args, cwd);
  await git(['config', 'user.name', 'Phantom Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(source, 'implementation.txt'), 'baseline\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Fixture']);
  await git(['remote', 'add', 'origin', remote]);
  await git(['push', 'origin', 'main']);
  const store = new Store(join(root, 'db.sqlite'));
  const project = store.createProject('Fixture', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'source',
    path: source,
    github: 'example/repo',
    defaultBranch: 'main',
    authorized: true,
  });
  // The work switch stays closed: recovering an already-claimed task must not need a new claim.
  store.patchRepo(repo.id, {
    enabled: false,
    commands: { install: '', build: '', test: 'node -e "process.exit(0)"', start: '', port: 3000 },
  });
  const message = store.addMessage(project.id, 'user', 'Implement', 'implement');
  let task = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: message.id,
    title: 'Implement',
    spec: 'Change implementation',
    acceptance: ['Implementation exists'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  const ws = new Workspaces(join(root, 'workspaces'), store);
  task = await ws.prepare(task);
  await git(['config', 'user.name', 'Phantom Test'], task.worktree);
  await git(['config', 'user.email', 'test@example.invalid'], task.worktree);
  const base = await ws.git(task.worktree!, ['rev-parse', 'HEAD']);
  task = store.updateTask(task.id, { base, stage: 'developing' });
  let starts = 0;
  let turns = 0;
  class Agent extends Codex {
    override async start() {
      starts++;
    }
    override async stop() {}
    override async thread() {
      return 'fixture';
    }
    override async turn() {
      turns++;
      await writeFile(join(task.worktree!, 'implementation.txt'), 'implemented\n');
      return 'Handing off';
    }
  }
  class Remote extends FakeGitHub {
    override async publishIssue(t: Task) {
      store.updateTask(t.id, { issue: 1 });
      return { number: 1 } as any;
    }
  }
  const github = new Remote(store);
  const engine = new Engine(store, github, ws, root, () => new Agent());
  async function cycle() {
    await engine.tick();
    for (let n = 0; n < 500 && store.activeRuns().length; n++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(store.activeRuns().length, 0, 'Run must terminate');
    return store.task(task.id);
  }
  const marker = () => `<!-- phantom-task:${task.id} -->`;
  const key = () => `pr:${task.id}`;
  // Recovery must add no Dev work of its own; tests compare against this baseline.
  let marks = { starts: 0, turns: 0 };
  return {
    root,
    source,
    store,
    repo,
    ws,
    git,
    engine,
    github,
    marker,
    key,
    operation: () => store.get('operation', key()),
    task: () => store.task(task.id),
    cycle,
    starts: () => starts - marks.starts,
    turns: () => turns - marks.turns,
    mark: () => {
      marks = { starts, turns };
    },
    /** Model the accepted-request-with-lost-response variant of the same unknown outcome. */
    loseResponse: (value: boolean) => {
      github.loseWriteResponse = value;
    },
    failWrite: (value: boolean) => {
      github.failWrite = value ? new Error('gh (1): gh: Server Error (HTTP 502)') : undefined;
    },
    failRead: (value: boolean) => {
      github.failRead = value ? new Error('gh (1): gh: Server Error (HTTP 502)') : undefined;
    },
    close: async () => {
      await engine.stop();
      store.close();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * Reach the real Task #32 state, in the order production reached it: the first run fails on the
 * 502 itself, and a later uncoordinated re-entry is refused by the unresolved-outcome guard. That
 * second entry is driven by the public Store control operation rather than `engine.resume`,
 * because explicit recovery is exactly what must not have happened yet.
 */
async function blockedOnPublication(f: Fixture) {
  f.failWrite(true);
  const first = await f.cycle();
  f.failWrite(false);
  assert.equal(first.control, 'paused');
  assert.equal(first.stage, 'developing');
  assert.equal(first.devPhase, 'finalize');
  assert.match(first.blocked!, /HTTP 502/);
  assert.equal(f.operation()!.status, 'uncertain');
  assert.equal(f.operation()!.result, undefined);
  assert.equal(f.operation()!.reconciliation, undefined);
  assert.equal(f.github.posted.length, 1);
  assert.equal(f.github.writes, 0, 'the remote never accepted the request');
  assert.ok(first.head, 'the finalized revision is pinned');
  assert.equal(first.tests[0].exitCode, 0, 'formal evidence exists for that revision');
  assert.equal(
    await f.ws.git(f.task().worktree!, ['ls-remote', 'origin', `refs/heads/${f.task().branch}`]),
    `${first.head}\trefs/heads/${f.task().branch}`,
    'the push succeeded before publication was attempted',
  );

  f.store.control(f.task().id, 'resume');
  const second = await f.cycle();
  assert.equal(second.control, 'paused');
  assert.equal(second.stage, 'developing');
  assert.equal(second.devPhase, 'finalize');
  assert.match(second.blocked!, /外部操作结果不明，需核对后恢复：create-pr/);
  assert.equal(second.head, first.head, 'the pinned revision did not move');
  assert.equal(second.retries, 0);
  assert.equal(f.github.posted.length, 1, 'entry without coordination never writes again');
  assert.equal(f.operation()!.reconciliation, undefined);
  f.mark();
  return second;
}

test('host recovery authorizes one controlled publication and completes without rework', async () => {
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
    // same commands. (Recovery re-runs verify on the unchanged worktree, so this is content
    // equality of a fresh run, not identity of the original evidence record.)
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
    assert.equal(await f.ws.git(f.source, ['status', '--porcelain']), '', 'origin checkout untouched');

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

test('an already merged remote delivery is adopted by recovery without a write', async () => {
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
    assert.equal(result.stage, 'reviewing');
    assert.equal(f.github.posted.length, 1, 'the existing delivery is adopted, never duplicated');
    assert.equal(f.github.writes, 0);
    assert.equal(f.turns(), 0);
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
