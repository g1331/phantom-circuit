import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from '../src/server/process.ts';
import { fixture } from './finalization-fixture.ts';

for (const method of ['UI', 'PM'] as const) {
  test(`${method} resume adopts a legacy paused dirty worktree without another Dev turn`, async (t) => {
    const f = await fixture(t, async () => {
      throw new Error('existing implementation must be reused');
    });
    await writeFile(join(f.path, 'value.txt'), 'after');
    const metadata = await readFile(join(f.path, '.git'), 'utf8');
    f.store.updateTask(f.task().id, {
      stage: 'developing',
      control: 'paused',
      retries: 3,
      blocked: '没有可交付的实现差异',
      feedback: Array(3).fill('没有可交付的实现差异，请完成任务或向 PM 说明具体阻塞'),
    });
    if (method === 'UI') await f.engine.resume(f.task().id);
    else await f.resolve();
    const result = await f.run();
    assert.equal(result.stage, 'reviewing', result.blocked);
    assert.equal(f.turns(), 0);
    assert.equal(result.retries, 0);
    assert.equal(result.worktree, f.path);
    assert.equal(await readFile(join(f.path, '.git'), 'utf8'), metadata);
    assert.notEqual(result.head, f.base);
    assert.equal(result.tests[0].exitCode, 0);
    assert.equal(result.tests[0].head, result.head);
  });
}

test('host-triggered PM re-evaluation can resolve its associated Task after repeated missing implementation', async (t) => {
  const f = await fixture(t);
  f.store.updateTask(f.task().id, { retries: 2 });
  const result = await f.run();
  const pm = f.store.list('run').find((run) => run.role === 'pm');
  assert.equal(pm?.taskId, result.id);
  assert.equal(pm?.status, 'completed', pm?.error);
  assert.equal(result.control, 'active');
  assert.equal(result.blocked, undefined);
  assert.ok(result.feedback.includes('Reuse the existing implementation; host finalizes it.'));
  assert.ok(
    f.store
      .snapshot()
      .activities.some(
        (a) => a.runId === pm?.id && a.taskId === result.id && a.title === '宿主事件：连续失败重评',
      ),
  );
});

for (const role of ['dev', 'review'] as const) {
  test(`PM guidance cannot resume a Task while its ${role} Run is still active`, async (t) => {
    const f = await fixture(t);
    f.store.updateTask(f.task().id, { control: 'paused' });
    const run = f.store.run(
      role,
      f.task().projectId,
      role === 'dev' ? 'backend' : 'review',
      f.task(),
    );
    await assert.rejects(f.resolve(), /正在停止任务/);
    assert.equal(f.task().control, 'paused');
    f.store.finishRun(run.id, 'paused');
  });
}

test('legacy recovery derives the common ancestor when the default branch advanced', async (t) => {
  const f = await fixture(t, async () => {
    throw new Error('must reuse legacy work');
  });
  await writeFile(join(f.path, 'value.txt'), 'after');
  await writeFile(join(f.source, 'later.txt'), 'new default-branch work');
  await f.git(f.source, ['add', '.']);
  await f.git(f.source, ['commit', '-m', 'Advance default branch']);
  await f.git(f.source, ['push', 'origin', 'main']);
  f.store.updateTask(f.task().id, { stage: 'developing', control: 'paused', base: undefined });
  await f.engine.resume(f.task().id);
  const result = await f.run();
  assert.equal(result.base, f.base);
  assert.equal(result.stage, 'reviewing', result.blocked);
  assert.equal(f.turns(), 0);
});

test('legacy committed work is also resumed without another Dev turn', async (t) => {
  const f = await fixture(t, async () => {
    throw new Error('must reuse legacy commit');
  });
  await writeFile(join(f.path, 'value.txt'), 'after');
  await f.git(f.path, ['add', '.']);
  await f.git(f.path, ['commit', '-m', 'Legacy commit']);
  f.store.updateTask(f.task().id, { stage: 'developing', control: 'paused' });
  await f.engine.resume(f.task().id);
  const result = await f.run();
  assert.equal(result.stage, 'reviewing', result.blocked);
  assert.equal(f.turns(), 0);
});

for (const supplement of [false, true]) {
  test(`host accepts an existing commit${supplement ? ' plus supplemental dirty files' : ''}`, async (t) => {
    const f = await fixture(t, async (cwd) => {
      await writeFile(join(cwd, 'value.txt'), 'after');
      await command('git', ['add', '.'], cwd);
      await command('git', ['commit', '-m', 'Legacy Dev commit'], cwd);
      if (supplement) await writeFile(join(cwd, 'additional file.txt'), 'supplement');
    });
    const result = await f.run();
    assert.equal(result.stage, 'reviewing', result.blocked);
    assert.equal(
      (await f.git(f.path, ['rev-list', '--count', `${f.base}..HEAD`])).stdout.trim(),
      supplement ? '2' : '1',
    );
    assert.equal((await f.git(f.path, ['status', '--porcelain'])).stdout, '');
  });
}

test('only an unchanged worktree enters missing-implementation rework', async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.control, 'active');
  assert.equal(result.retries, 1);
  assert.match(result.feedback[0], /没有可交付的实现差异/);
});
