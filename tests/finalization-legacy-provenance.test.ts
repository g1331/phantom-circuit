import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  environmentBlock,
  trackRef,
  publishBranch,
  advancedLegacyTask,
  legacyBaselineScenes,
  installProbe,
  assertNoInstall,
} from './finalization-fixture.ts';

test('advanced default branch adopts the recorded legacy merge and integrates the new default after', async (t) => {
  const f = await advancedLegacyTask(t, async (cwd) => {
    await writeFile(join(cwd, 'value.txt'), 'after');
  });
  assert.equal(f.task().pendingMerge, undefined);
  await f.engine.resume(f.task().id);
  const result = await f.run();
  assert.equal(result.stage, 'reviewing', result.blocked);
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 1);
  assert.equal(result.pendingMerge, undefined);
  // The recorded merge is completed first, with its own two parents, and only then is the advanced
  // default branch coordinated as a second, separate merge commit.
  const history = f.store.task(f.task().id).mergeHistory!;
  assert.equal(history.length, 2);
  assert.equal(history[0].origin, 'legacy');
  assert.equal(history[0].sourceRef, 'refs/remotes/origin/main');
  assert.equal(history[0].sourceHead, f.incoming);
  assert.equal(history[0].targetBase, f.incoming);
  assert.equal(history[1].sourceRef, 'refs/remotes/origin/main');
  assert.equal(history[1].sourceHead, f.advanced);
  assert.equal(
    (await f.git(f.path, ['show', '-s', '--format=%P', history[0].head])).stdout.trim(),
    `${f.oldHead} ${f.incoming}`,
  );
  assert.equal(
    (await f.git(f.path, ['show', '-s', '--format=%P', result.head!])).stdout.trim(),
    `${history[0].head} ${f.advanced}`,
  );
  assert.equal(await readFile(join(f.path, 'later.txt'), 'utf8'), 'advanced default work');
  assert.equal((await f.git(f.path, ['status', '--porcelain'])).stdout, '');
  assert.equal(result.base, f.advanced);
  assert.equal(result.tests[0].head, result.head);
});

test('advanced default branch leaves the legacy merge pending while no target baseline is recorded', async (t) => {
  const f = await advancedLegacyTask(t);
  f.store.updateTask(f.task().id, { base: undefined, targetBase: undefined });
  const result = await f.run();
  assert.equal(result.control, 'paused', JSON.stringify(result));
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 0);
  assert.match(result.blocked!, /来源证据不足.*没有已记录的目标基线/);
  assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
  assert.equal((await f.git(f.path, ['rev-parse', 'MERGE_HEAD'])).stdout.trim(), f.incoming);
  assert.match((await f.git(f.path, ['status', '--porcelain'])).stdout, /UU value\.txt/);
});

test('advanced default branch leaves the legacy merge pending while target records conflict', async (t) => {
  const f = await advancedLegacyTask(t);
  f.store.updateTask(f.task().id, { base: f.base, targetBase: f.incoming });
  const result = await f.run();
  assert.equal(result.control, 'paused', JSON.stringify(result));
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 0);
  assert.match(result.blocked!, /来源证据不足.*目标基线互相冲突/);
});

test('advanced default branch leaves the legacy merge pending when the source was rewritten', async (t) => {
  const f = await advancedLegacyTask(t);
  await f.git(f.source, ['push', '--force', 'origin', `${f.base}:refs/heads/main`]);
  await trackRef(f, 'main');
  const result = await f.run();
  assert.equal(result.control, 'paused', JSON.stringify(result));
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 0);
  assert.match(result.blocked!, /来源证据不足.*已被改写或回退/);
  assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
  assert.match((await f.git(f.path, ['status', '--porcelain'])).stdout, /UU value\.txt/);
});

test('advanced default branch leaves the legacy merge pending while no coordination event is recorded', async (t) => {
  const f = await advancedLegacyTask(t, undefined, { record: false });
  const result = await f.run();
  assert.equal(result.control, 'paused', JSON.stringify(result));
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 0);
  assert.match(result.blocked!, /来源证据不足.*合并协调记录/);
  assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
});

test('advanced default branch refuses a coordination record that names another merge', async (t) => {
  const f = await advancedLegacyTask(t, undefined, { record: false });
  // A host record that names commits is evidence about a specific merge, so one that names a
  // different pair cannot authorize this pending merge.
  f.store.event('merge-conflict', `待完成合并 ${f.base} + ${f.base}；冲突文件：value.txt`, {
    projectId: f.task().projectId,
    taskId: f.task().id,
  });
  const result = await f.run();
  assert.equal(result.control, 'paused', JSON.stringify(result));
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 0);
  assert.match(result.blocked!, /来源证据不足.*都不指向该待完成合并/);
  assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
  assert.match((await f.git(f.path, ['status', '--porcelain'])).stdout, /UU value\.txt/);
});

for (const scene of legacyBaselineScenes) {
  for (const drift of ['head', 'orig-head'] as const) {
    test(`advanced default branch leaves the legacy merge pending on ${drift} drift with ${scene[0]}`, async (t) => {
      const f = await scene[1](t);
      const installed = installProbe(f);
      if (drift === 'head') f.store.updateTask(f.task().id, { head: f.base });
      else {
        const path = (await f.git(f.path, ['rev-parse', '--git-path', 'ORIG_HEAD'])).stdout.trim();
        await writeFile(path, `${f.base}\n`);
      }
      const result = await f.run();
      assert.equal(result.control, 'paused', JSON.stringify(result));
      assert.equal(result.retries, 2);
      assert.equal(f.turns(), 0);
      assert.match(result.blocked!, drift === 'head' ? /HEAD 漂移/ : /ORIG_HEAD 不匹配/);
      assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
      await assertNoInstall(installed);
    });
  }
}

for (const scene of legacyBaselineScenes) {
  test(`advanced default branch refuses to guess between two allowed sources that both moved on with ${scene[0]}`, async (t) => {
    const f = await scene[1](t);
    const installed = installProbe(f);
    f.store.updateTask(f.task().id, { pr: 2, mergeSourceBranch: f.task().branch });
    // A second allowed source - the original PR branch - also advances past the pending merge head.
    await f.git(f.source, ['checkout', '-b', 'task-advance', f.incoming]);
    await writeFile(join(f.source, 'task-advance.txt'), 'task branch advance');
    await f.git(f.source, ['add', '.']);
    await f.git(f.source, ['commit', '-m', 'Task branch advance']);
    await publishBranch(f, f.task().branch!);
    const result = await f.run();
    assert.equal(result.control, 'paused', JSON.stringify(result));
    assert.equal(result.retries, 2);
    assert.equal(f.turns(), 0);
    assert.match(result.blocked!, /来源歧义/);
    assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
    await assertNoInstall(installed);
  });
}

test('recovering a recorded legacy merge twice repeats neither Dev nor merge nor commit', async (t) => {
  const f = await advancedLegacyTask(t, async (cwd) => {
    await writeFile(join(cwd, 'value.txt'), 'after');
  });
  const retries = f.task().retries;
  const first = await f.ws.prepareBase(f.task(), undefined, false);
  assert.equal(first.status, 'conflicted');
  const id = f.store.task(f.task().id).pendingMerge!.id;
  assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
  // Coordinating the same unfinished merge again reuses the persisted record and starts no merge.
  const again = await f.ws.prepareBase(f.task(), undefined, false);
  assert.equal(again.status, 'conflicted');
  assert.equal(f.store.task(f.task().id).pendingMerge!.id, id);
  assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
  assert.equal((await f.git(f.path, ['rev-parse', 'MERGE_HEAD'])).stdout.trim(), f.incoming);

  // An environment failure after the host completed both merges leaves the finalize checkpoint.
  const commands = f.store.repo(f.repo.id).commands;
  f.store.patchRepo(f.repo.id, {
    commands: {
      ...commands,
      install: environmentBlock,
    },
  });
  const paused = await f.run();
  assert.equal(paused.control, 'paused', paused.blocked);
  assert.equal(paused.devPhase, 'finalize');
  assert.equal(paused.pendingMerge, undefined);
  assert.equal(f.turns(), 1);
  assert.equal(paused.retries, retries);
  assert.equal(paused.mergeHistory!.length, 2);
  const merged = paused.head!;

  f.store.patchRepo(f.repo.id, { commands });
  await f.engine.resume(paused.id);
  const result = await f.run();
  assert.equal(result.stage, 'reviewing', result.blocked);
  assert.equal(result.head, merged);
  assert.equal(result.base, f.advanced);
  assert.equal(result.retries, retries);
  assert.equal(f.turns(), 1);
  assert.equal(f.store.task(f.task().id).mergeHistory!.length, 2);
});
