import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from '../src/server/process.ts';
import {
  trackRef,
  advancedRecordedBaselineTask,
  installProbe,
  assertNoInstall,
} from './finalization-fixture.ts';

for (const lineage of ['an-ancestor', 'another-lineage'] as const) {
  test(`advanced recorded baseline stays pending while the recorded target is ${lineage}`, async (t) => {
    const f = await advancedRecordedBaselineTask(t);
    const installed = installProbe(f);
    // Neither a recorded baseline that MERGE_HEAD descends from nor one from an unrelated lineage
    // is the later default tip ADR 0014 accepts.
    f.store.updateTask(f.task().id, { base: lineage === 'an-ancestor' ? f.base : f.oldHead });
    const result = await f.run();
    assert.equal(result.control, 'paused', JSON.stringify(result));
    assert.equal(result.retries, 2);
    assert.equal(f.turns(), 0);
    assert.match(
      result.blocked!,
      lineage === 'an-ancestor'
        ? /来源证据不足.*与宿主记录的目标基线 .* 不一致.*是 .* 的祖先/
        : /来源证据不足.*与宿主记录的目标基线 .* 不一致.*没有祖先关系/,
    );
    assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
    assert.match((await f.git(f.path, ['status', '--porcelain'])).stdout, /UU value\.txt/);
    await assertNoInstall(installed);
  });
}

test('advanced recorded baseline stays pending when the source no longer contains it', async (t) => {
  const f = await advancedRecordedBaselineTask(t);
  const installed = installProbe(f);
  // A rewritten default branch that still descends from MERGE_HEAD but dropped the recorded tip.
  await f.git(f.source, ['checkout', '-b', 'rewritten-default', f.incoming]);
  await writeFile(join(f.source, 'rewritten.txt'), 'rewritten default work');
  await f.git(f.source, ['add', '.']);
  await f.git(f.source, ['commit', '-m', 'Rewritten default']);
  await f.git(f.source, ['push', '--force', 'origin', 'HEAD:refs/heads/main']);
  await trackRef(f, 'main');
  const result = await f.run();
  assert.equal(result.control, 'paused', JSON.stringify(result));
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 0);
  assert.match(result.blocked!, /来源证据不足.*已不再包含宿主记录的目标基线/);
  assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
  assert.match((await f.git(f.path, ['status', '--porcelain'])).stdout, /UU value\.txt/);
  await assertNoInstall(installed);
});

test('advanced recorded baseline stays pending when the recorded integrated base is not the fork', async (t) => {
  const f = await advancedRecordedBaselineTask(t);
  const installed = installProbe(f);
  f.store.updateTask(f.task().id, { integratedBase: f.oldHead });
  const result = await f.run();
  assert.equal(result.control, 'paused', JSON.stringify(result));
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 0);
  assert.match(result.blocked!, /来源证据不足.*与已整合基线 .* 不一致/);
  assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
  assert.match((await f.git(f.path, ['status', '--porcelain'])).stdout, /UU value\.txt/);
  await assertNoInstall(installed);
});

test('advanced recorded baseline stays pending when the source was reverted onto MERGE_HEAD', async (t) => {
  const f = await advancedRecordedBaselineTask(t);
  const installed = installProbe(f);
  // A source reset back onto MERGE_HEAD no longer contains the recorded later tip, so ADR 0014's
  // condition cannot hold even though the pointer now matches exactly.
  await f.git(f.source, ['push', '--force', 'origin', `${f.incoming}:refs/heads/main`]);
  await trackRef(f, 'main');
  const result = await f.run();
  assert.equal(result.control, 'paused', JSON.stringify(result));
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 0);
  assert.match(result.blocked!, /来源不包含目标基线/);
  assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
  assert.match((await f.git(f.path, ['status', '--porcelain'])).stdout, /UU value\.txt/);
  await assertNoInstall(installed);
});

test('advanced recorded baseline stays pending while no target baseline is recorded', async (t) => {
  const f = await advancedRecordedBaselineTask(t);
  const installed = installProbe(f);
  f.store.updateTask(f.task().id, { base: undefined, targetBase: undefined });
  const result = await f.run();
  assert.equal(result.control, 'paused', JSON.stringify(result));
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 0);
  assert.match(result.blocked!, /来源证据不足.*没有已记录的目标基线/);
  assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
  assert.match((await f.git(f.path, ['status', '--porcelain'])).stdout, /UU value\.txt/);
  await assertNoInstall(installed);
});

test('advanced recorded baseline stays pending while no coordination event is recorded', async (t) => {
  const f = await advancedRecordedBaselineTask(t, undefined, { record: false });
  const installed = installProbe(f);
  const result = await f.run();
  assert.equal(result.control, 'paused', JSON.stringify(result));
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 0);
  assert.match(result.blocked!, /来源证据不足.*合并协调记录/);
  assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
  assert.match((await f.git(f.path, ['status', '--porcelain'])).stdout, /UU value\.txt/);
  await assertNoInstall(installed);
});

test('advanced recorded baseline stays pending when the coordination event names another merge', async (t) => {
  const f = await advancedRecordedBaselineTask(t, undefined, { record: false });
  const installed = installProbe(f);
  f.store.event('merge-conflict', `待完成合并 ${f.recorded} + ${f.recorded}；冲突文件：value.txt`, {
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
  await assertNoInstall(installed);
});

for (const drift of ['outside', 'index'] as const) {
  test(`advanced recorded baseline refuses ${drift} drift from the conflict Dev`, async (t) => {
    const f = await advancedRecordedBaselineTask(t, async (cwd) => {
      await writeFile(join(cwd, 'value.txt'), 'after');
      if (drift === 'outside') await writeFile(join(cwd, 'verify.cjs'), 'unexpected');
      else await command('git', ['add', '.'], cwd);
    });
    const installed = installProbe(f);
    const result = await f.run();
    assert.equal(result.control, 'paused', JSON.stringify(result));
    assert.equal(result.retries, 2);
    assert.match(result.blocked!, drift === 'outside' ? /冲突文件以外/ : /改变了 Git 索引/);
    assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
    await assertNoInstall(installed);
  });
}

test('advanced recorded baseline stays pending when Git cannot answer the ancestry question', async (t) => {
  const f = await advancedRecordedBaselineTask(t);
  const installed = installProbe(f);
  // A MERGE_HEAD naming an object Git cannot resolve: the ancestry command fails instead of
  // answering "not an ancestor", which must pause as an unknown Git result.
  const metadata = (await f.git(f.path, ['rev-parse', '--git-path', 'MERGE_HEAD'])).stdout.trim();
  await writeFile(metadata, '1234567890abcdef1234567890abcdef12345678\n');
  const result = await f.run();
  assert.equal(result.control, 'paused', JSON.stringify(result));
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 0);
  assert.match(result.blocked!, /祖先关系检查结果未知/);
  assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
  await assertNoInstall(installed);
});
