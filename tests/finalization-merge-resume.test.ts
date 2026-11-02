import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { environmentBlock, fixture, conflictingTask } from './finalization-fixture.ts';

for (const failure of ['install', 'validation'] as const) {
  test(`resume keeps the merged finalize checkpoint after ${failure} fails before pushing an existing PR`, async (t) => {
    const f = await conflictingTask(
      t,
      async (cwd) => {
        await writeFile(join(cwd, 'value.txt'), 'after');
      },
      'task',
    );
    const commands = f.store.repo(f.repo.id).commands;
    f.store.patchRepo(f.repo.id, {
      commands: { ...commands, [failure === 'install' ? 'install' : 'test']: environmentBlock },
    });
    const paused = await f.run();
    assert.equal(paused.control, 'paused', paused.blocked);
    assert.equal(paused.devPhase, 'finalize');
    assert.equal(paused.pendingMerge, undefined);
    assert.equal(f.turns(), 1);
    const merged = paused.head!;
    assert.notEqual(merged, f.incoming);
    assert.equal(
      (await f.git(f.path, ['ls-remote', 'origin', `refs/heads/${paused.branch}`])).stdout.split(
        /\s/,
      )[0],
      f.incoming,
    );
    f.store.patchRepo(f.repo.id, { commands });
    await f.engine.resume(paused.id);
    assert.equal(f.task().devPhase, 'finalize');
    const result = await f.run();
    assert.equal(result.stage, 'reviewing', result.blocked);
    assert.equal(result.head, merged);
    assert.equal(result.pr, 2);
    assert.equal(result.retries, 2);
    assert.equal(f.turns(), 1);
    assert.equal(result.tests[0].head, merged);
    assert.equal(
      (await f.git(f.path, ['ls-remote', 'origin', `refs/heads/${result.branch}`])).stdout.split(
        /\s/,
      )[0],
      merged,
    );
  });
}

test('resume still coordinates genuinely new remote PR commits before another implementation turn', async (t) => {
  const f = await fixture(t, async (cwd) => {
    await writeFile(join(cwd, 'value.txt'), 'after');
  });
  const first = await f.run();
  assert.equal(first.stage, 'reviewing', first.blocked);
  f.store.updateTask(first.id, { stage: 'developing', control: 'paused', devPhase: 'finalize' });
  await f.git(f.source, ['fetch', 'origin', `refs/heads/${first.branch}`]);
  await f.git(f.source, ['checkout', '-b', 'remote-edit', 'FETCH_HEAD']);
  await writeFile(join(f.source, 'remote-feature.txt'), 'new remote work');
  await f.git(f.source, ['add', '.']);
  await f.git(f.source, ['commit', '-m', 'Remote contribution']);
  await f.git(f.source, ['push', 'origin', `HEAD:refs/heads/${first.branch}`]);
  const incoming = (await f.git(f.source, ['rev-parse', 'HEAD'])).stdout.trim();
  await f.engine.resume(first.id);
  assert.equal(f.task().devPhase, 'implement');
  const result = await f.run();
  assert.equal(result.stage, 'reviewing', result.blocked);
  assert.equal(f.turns(), 2);
  assert.equal(result.retries, 0);
  assert.equal(await readFile(join(f.path, 'remote-feature.txt'), 'utf8'), 'new remote work');
  assert.equal(
    (await f.git(f.path, ['merge-base', '--is-ancestor', incoming, result.head!])).code,
    0,
  );
});

test('committed merge with interrupted state persistence resumes without Dev or a second commit', async (t) => {
  const f = await conflictingTask(
    t,
    async () => {
      throw new Error('must adopt completed merge');
    },
    'default',
    true,
  );
  const coordinated = await f.ws.prepareBase(f.task());
  assert.equal(coordinated.status, 'conflicted');
  if (coordinated.status !== 'conflicted') return;
  const previousRun = f.store.run('dev', f.task().projectId, f.task().profile, f.task());
  await f.ws.claimConflict(f.task(), coordinated.merge.id, previousRun.id);
  f.store.finishRun(previousRun.id, 'interrupted');
  await writeFile(join(f.path, 'value.txt'), 'after');
  f.store.updateTask(f.task().id, {
    devPhase: 'implement',
    pendingMerge: { ...f.task().pendingMerge!, phase: 'committing' },
  });
  await f.git(f.path, ['add', '.']);
  await f.git(f.path, ['commit', '--no-edit']);
  const committed = (await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim();
  const result = await f.run();
  assert.equal(result.stage, 'reviewing', result.blocked);
  assert.equal(result.head, committed);
  assert.equal(f.turns(), 0);
  assert.equal(result.pendingMerge, undefined);
});

test('fixed merge provenance survives a later tracking ref update and interrupted Dev edits with UU', async (t) => {
  const f = await conflictingTask(
    t,
    async () => {
      throw new Error('do not repeat interrupted Dev');
    },
    'default',
    true,
  );
  const coordinated = await f.ws.prepareBase(f.task());
  assert.equal(coordinated.status, 'conflicted');
  if (coordinated.status !== 'conflicted') return;
  const previous = f.store.run('dev', f.task().projectId, f.task().profile, f.task());
  await f.ws.claimConflict(f.task(), coordinated.merge.id, previous.id);
  f.store.finishRun(previous.id, 'interrupted');
  await writeFile(join(f.path, 'value.txt'), 'after');
  await f.git(f.mirror, ['update-ref', 'refs/remotes/origin/main', f.base]);
  assert.match((await f.git(f.path, ['status', '--porcelain'])).stdout, /UU value.txt/);
  const result = await f.run();
  assert.equal(result.stage, 'reviewing', result.blocked);
  assert.equal(f.turns(), 0);
  assert.equal(result.retries, 2);
});

test('concurrent baseline coordination and Engine ticks start only one conflict Dev and no second merge', async (t) => {
  const f = await conflictingTask(t, async (cwd) => {
    await writeFile(join(cwd, 'value.txt'), 'after');
  });
  const states = await Promise.all([f.ws.prepareBase(f.task()), f.ws.prepareBase(f.task())]);
  assert.equal(states[0].status, 'conflicted');
  assert.equal(states[1].status, 'conflicted');
  assert.deepEqual(states[0], states[1]);
  if (states[0].status !== 'conflicted') return;
  // Coordination alone records one pending merge and leaves the worktree at the old HEAD; the
  // merge itself is created once, by the host commit at the end of the single Run.
  assert.equal(f.store.task(f.task().id).pendingMerge!.id, states[0].merge.id);
  assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
  await Promise.all([f.engine.tick(), f.engine.tick()]);
  const result = await f.run();
  assert.equal(result.stage, 'reviewing', result.blocked);
  assert.equal(f.turns(), 1);
  assert.equal(await f.store.task(f.task().id).mergeHistory!.length, 1);
  assert.equal(
    (await f.git(f.path, ['show', '-s', '--format=%P', 'HEAD'])).stdout.trim(),
    `${f.oldHead} ${f.incoming}`,
  );
});

test('old validation and reviews remain historical while the merged revision receives new evidence', async (t) => {
  const f = await conflictingTask(
    t,
    async (cwd) => {
      await writeFile(join(cwd, 'value.txt'), 'after');
    },
    'default',
    true,
  );
  const tests = [
    {
      head: f.oldHead,
      command: 'old failing test',
      exitCode: 1,
      output: 'old failure',
      at: '2026-01-01',
    },
  ];
  const reviews = [
    {
      axis: 'spec' as const,
      head: f.oldHead,
      base: f.base,
      approved: true,
      summary: 'old review',
      findings: [],
    },
  ];
  f.store.updateTask(f.task().id, { tests, reviews });
  const result = await f.run();
  assert.equal(result.stage, 'reviewing', result.blocked);
  assert.deepEqual(result.revisionHistory![0].tests, tests);
  assert.deepEqual(result.revisionHistory![0].reviews, reviews);
  assert.equal(result.tests[0].head, result.head);
  assert.equal(result.tests[0].exitCode, 0);
  assert.equal(result.reviews.length, 0);
});

test('legacy default merge uses its verified source even when the PR tracking ref is absent', async (t) => {
  const f = await conflictingTask(
    t,
    async (cwd) => {
      await writeFile(join(cwd, 'value.txt'), 'after');
    },
    'default',
    true,
  );
  await f.git(f.path, ['push', 'origin', `HEAD:refs/heads/${f.task().branch}`]);
  await f.git(f.path, ['update-ref', '-d', `refs/remotes/origin/${f.task().branch}`]);
  f.store.updateTask(f.task().id, { pr: 2 });
  const result = await f.run();
  assert.equal(result.stage, 'reviewing', result.blocked);
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 1);
  // The default-branch source must be the one verified from the remaining ref, not the task branch
  // whose tracking ref was deleted.
  const [merge] = f.store.task(f.task().id).mergeHistory!;
  assert.equal(merge.sourceRef, 'refs/remotes/origin/main');
  assert.equal(merge.sourceHead, f.incoming);
  assert.equal(
    (await f.git(f.path, ['show', '-s', '--format=%P', 'HEAD'])).stdout.trim(),
    `${f.oldHead} ${f.incoming}`,
  );
});

test('legacy PR merge with a missing base is adopted before fetching another branch', async (t) => {
  const f = await conflictingTask(
    t,
    async (cwd) => {
      await writeFile(join(cwd, 'value.txt'), 'after');
    },
    'task',
    true,
  );
  f.store.updateTask(f.task().id, { base: undefined, control: 'paused' });
  await f.engine.resume(f.task().id);
  const result = await f.run();
  assert.equal(result.stage, 'reviewing', result.blocked);
  assert.equal(result.pr, 2);
  assert.equal(result.retries, 2);
  assert.equal(await readFile(join(f.path, 'later.txt'), 'utf8'), 'default branch must wait');
});

test('a pending merge cannot adopt edits when its recorded Dev Run is unknown', async (t) => {
  const f = await conflictingTask(t, async () => {}, 'default', true);
  assert.equal((await f.ws.prepareBase(f.task())).status, 'conflicted');
  await writeFile(join(f.path, 'value.txt'), 'after');
  f.store.updateTask(f.task().id, {
    pendingMerge: { ...f.task().pendingMerge!, phase: 'editing', runId: 'unknown-run' },
  });
  const result = await f.run();
  assert.equal(result.control, 'paused');
  assert.match(result.blocked!, /冲突 Dev Run.*不匹配/);
  assert.equal(result.retries, 2);
  assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
  assert.match((await f.git(f.path, ['status', '--porcelain'])).stdout, /UU value.txt/);
});
