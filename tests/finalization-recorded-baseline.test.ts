import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  advancedRecordedBaselineTask,
  installProbe,
  assertNoInstall,
} from './finalization-fixture.ts';

test("advanced recorded baseline adopts the legacy merge from this run's own evidence", async (t) => {
  const f = await advancedRecordedBaselineTask(t, async () => {
    throw new Error('adoption must not start Dev');
  });
  const installed = installProbe(f);
  const retries = f.task().retries;
  const result = await f.ws.prepareBase(f.task(), undefined, false);
  assert.equal(result.status, 'conflicted');
  if (result.status !== 'conflicted') return;
  assert.equal(result.merge.origin, 'legacy');
  assert.equal(result.merge.sourceRef, 'refs/remotes/origin/main');
  assert.equal(result.merge.sourceHead, f.incoming);
  assert.equal(result.merge.integratedBase, f.fork);
  assert.equal(result.merge.targetBase, f.incoming);
  // The persisted record is written from this run's evidence, never the stale recorded tip: a
  // carried-over baseline would fail the later "source contains target baseline" check.
  const stored = f.store.task(f.task().id);
  assert.deepEqual(stored.pendingMerge, result.merge);
  assert.equal(stored.targetBase, f.incoming);
  assert.equal(stored.integratedBase, f.fork);
  assert.notEqual(stored.targetBase, f.recorded);
  // Adoption alone: no commit, no install, retries untouched, and the unmerged index kept.
  assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
  assert.equal((await f.git(f.path, ['rev-parse', 'MERGE_HEAD'])).stdout.trim(), f.incoming);
  assert.equal(f.turns(), 0);
  assert.equal(f.store.task(f.task().id).retries, retries);
  assert.match((await f.git(f.path, ['status', '--porcelain'])).stdout, /UU value\.txt/);
  await assertNoInstall(installed);
});

test('advanced recorded baseline is read from targetBase as well as the legacy base', async (t) => {
  const f = await advancedRecordedBaselineTask(t);
  // A coordination written after #45 records the same baseline in `targetBase` instead of `base`.
  f.store.updateTask(f.task().id, { base: undefined, targetBase: f.recorded });
  const result = await f.ws.prepareBase(f.task(), undefined, false);
  assert.equal(result.status, 'conflicted');
  if (result.status !== 'conflicted') return;
  assert.equal(result.merge.sourceRef, 'refs/remotes/origin/main');
  assert.equal(result.merge.sourceHead, f.incoming);
  assert.equal(result.merge.integratedBase, f.fork);
  assert.equal(result.merge.targetBase, f.incoming);
  assert.equal(f.store.task(f.task().id).targetBase, f.incoming);
  assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
});

test('advanced recorded baseline completes the legacy merge and then integrates the new default', async (t) => {
  const f = await advancedRecordedBaselineTask(t, async (cwd) => {
    await writeFile(join(cwd, 'value.txt'), 'after');
  });
  assert.equal(f.task().pendingMerge, undefined);
  await f.engine.resume(f.task().id);
  const result = await f.run();
  assert.equal(result.stage, 'reviewing', result.blocked);
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 1);
  assert.equal(result.pendingMerge, undefined);
  const history = f.store.task(f.task().id).mergeHistory!;
  assert.equal(history.length, 2);
  assert.equal(history[0].origin, 'legacy');
  assert.equal(history[0].sourceRef, 'refs/remotes/origin/main');
  assert.equal(history[0].sourceHead, f.incoming);
  assert.equal(history[0].targetBase, f.incoming);
  assert.equal(history[0].integratedBase, f.fork);
  assert.equal(
    (await f.git(f.path, ['show', '-s', '--format=%P', history[0].head])).stdout.trim(),
    `${f.oldHead} ${f.incoming}`,
  );
  assert.equal(history[1].sourceRef, 'refs/remotes/origin/main');
  assert.equal(history[1].sourceHead, f.advanced);
  assert.equal(await readFile(join(f.path, 'recorded.txt'), 'utf8'), 'recorded default work');
  assert.equal(await readFile(join(f.path, 'later.txt'), 'utf8'), 'advanced default work');
  assert.equal((await f.git(f.path, ['status', '--porcelain'])).stdout, '');
  assert.equal(result.base, f.advanced);
});

test('advanced recorded baseline repeats neither Dev nor merge nor commit on a second recovery', async (t) => {
  const f = await advancedRecordedBaselineTask(t, async () => {
    throw new Error('recovery must not start Dev');
  });
  const retries = f.task().retries;
  const first = await f.ws.prepareBase(f.task(), undefined, false);
  assert.equal(first.status, 'conflicted');
  const id = f.store.task(f.task().id).pendingMerge!.id;
  // Recovering the same unfinished merge again reuses the persisted record, re-verifies the source
  // and starts no merge, no commit and no Dev run.
  const again = await f.ws.prepareBase(f.task(), undefined, false);
  assert.equal(again.status, 'conflicted');
  if (again.status !== 'conflicted') return;
  assert.equal(again.merge.id, id);
  assert.deepEqual(again.merge, first.merge);
  assert.equal(f.store.activeRuns().length, 0);
  assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
  assert.equal((await f.git(f.path, ['rev-parse', 'MERGE_HEAD'])).stdout.trim(), f.incoming);
  assert.match((await f.git(f.path, ['status', '--porcelain'])).stdout, /UU value\.txt/);
  assert.equal(f.store.task(f.task().id).retries, retries);
});
