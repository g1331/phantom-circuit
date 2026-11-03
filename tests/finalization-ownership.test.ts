import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from '../src/server/process.ts';
import { fixture } from './finalization-fixture.ts';

test('finalization refuses a worktree path assigned to another task', async (t) => {
  const f = await fixture(t);
  const other = join(f.ws.root, f.repo.id, 'task-other');
  await mkdir(other);
  await writeFile(join(other, 'value.txt'), 'preserve');
  f.store.updateTask(f.task().id, { stage: 'developing', devPhase: 'finalize', worktree: other });
  const result = await f.run();
  assert.equal(result.control, 'paused');
  assert.equal(result.retries, 0);
  assert.match(result.blocked!, /不属于当前任务/);
  assert.equal(await readFile(join(other, 'value.txt'), 'utf8'), 'preserve');
});

test('finalization rejects a base that is not an ancestor of the task HEAD', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.path, 'value.txt'), 'after');
  await writeFile(join(f.source, 'later.txt'), 'later');
  await f.git(f.source, ['add', '.']);
  await f.git(f.source, ['commit', '-m', 'Later default']);
  await f.git(f.source, ['push', 'origin', 'main']);
  await f.ws.mirror(f.store.repo(f.repo.id));
  const later = (await f.git(f.source, ['rev-parse', 'HEAD'])).stdout.trim();
  f.store.updateTask(f.task().id, { stage: 'developing', devPhase: 'finalize', base: later });
  const result = await f.run();
  assert.equal(result.control, 'paused');
  assert.equal(result.retries, 0);
  assert.match(result.blocked!, /祖先关系不可接受/);
  assert.equal(await readFile(join(f.path, 'value.txt'), 'utf8'), 'after');
});

for (const problem of ['branch', 'conflict', 'submodule', 'commit'] as const) {
  test(`${problem} failure pauses finalization and preserves the implementation`, async (t) => {
    const f = await fixture(t, async (cwd) => {
      await writeFile(join(cwd, 'value.txt'), 'after');
      if (problem === 'branch') await command('git', ['checkout', '-b', 'wrong-branch'], cwd);
      if (problem === 'conflict') {
        const oid = (await command('git', ['rev-parse', 'HEAD:value.txt'], cwd)).stdout.trim();
        await command(
          'git',
          ['update-index', '--index-info'],
          cwd,
          `0 ${'0'.repeat(40)}\tvalue.txt\n100644 ${oid} 1\tvalue.txt\n100644 ${oid} 2\tvalue.txt\n100644 ${oid} 3\tvalue.txt\n`,
        );
      }
      if (problem === 'submodule') {
        const oid = (await command('git', ['rev-parse', 'HEAD'], cwd)).stdout.trim();
        await command('git', ['update-index', '--add', '--cacheinfo', `160000,${oid},nested`], cwd);
      }
      if (problem === 'commit') {
        const common = (await command('git', ['rev-parse', '--git-common-dir'], cwd)).stdout.trim();
        await writeFile(
          join(common, 'hooks', 'pre-commit'),
          '#!/bin/sh\necho "host commit unavailable" >&2\nexit 1\n',
          { mode: 0o755 },
        );
      }
    });
    const result = await f.run();
    assert.equal(result.control, 'paused', JSON.stringify(result));
    assert.equal(result.retries, 0);
    assert.match(
      result.blocked!,
      {
        branch: /分支不匹配/,
        conflict: /未合并冲突.*value.txt/,
        submodule: /子模块/,
        commit: /host commit unavailable/,
      }[problem],
    );
    assert.equal(await readFile(join(f.path, 'value.txt'), 'utf8'), 'after');
    await f.engine.tick();
    assert.equal(f.turns(), 1);
  });
}

test('an untracked nested repository is rejected before it can become a staged gitlink', async (t) => {
  const f = await fixture(t, async (cwd) => {
    await writeFile(join(cwd, 'value.txt'), 'after');
    const nested = join(cwd, 'nested');
    await command('git', ['init', nested]);
    await command('git', ['config', 'user.name', 'Test'], nested);
    await command('git', ['config', 'user.email', 'test@example.invalid'], nested);
    await writeFile(join(nested, 'file.txt'), 'nested');
    await command('git', ['add', '.'], nested);
    await command('git', ['commit', '-m', 'Nested fixture'], nested);
  });
  const result = await f.run();
  assert.equal(result.control, 'paused');
  assert.equal(result.retries, 0);
  assert.match(result.blocked!, /子模块|嵌套仓库/);
  assert.equal((await f.git(f.path, ['diff', '--cached', '--name-only'])).stdout, '');
});

test('same-repository host commits serialize and release their lock after a failed commit', async (t) => {
  const f = await fixture(t, async (cwd) => {
    await writeFile(join(cwd, 'value.txt'), 'after');
  });
  const original = f.task();
  const second = f.store.createTask({
    projectId: original.projectId,
    repoId: original.repoId,
    sourceMessageId: original.sourceMessageId,
    title: 'Second task',
    spec: original.spec,
    acceptance: original.acceptance,
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  f.store.updateTask(second.id, { issue: 2 });
  f.store.patchRepo(f.repo.id, { devLimit: 2 });
  f.store.put('project', f.task().projectId, {
    ...f.store.project(f.task().projectId),
    devLimit: 2,
  });
  const guard = join(f.root, 'commit-active');
  const visits = join(f.root, 'commit-visits');
  const script = join(f.mirror, 'hooks', 'serialize.cjs');
  await writeFile(
    script,
    `const fs=require('node:fs'); const lock=${JSON.stringify(guard)}; const visits=${JSON.stringify(visits)}; fs.openSync(lock,'wx'); setTimeout(()=>{fs.unlinkSync(lock); if(!fs.existsSync(visits)){fs.writeFileSync(visits,'first failed');process.exit(1)}},250);`,
  );
  await writeFile(
    join(f.mirror, 'hooks', 'pre-commit'),
    '#!/bin/sh\nnode "$(git rev-parse --git-common-dir)/hooks/serialize.cjs"\n',
    { mode: 0o755 },
  );
  await f.engine.tick();
  await f.engine.tick();
  for (let i = 0; i < 1500 && f.store.activeRuns().length; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.store.activeRuns().length, 0);
  const tasks = [f.task(), f.store.task(second.id)];
  assert.equal(tasks.filter((task) => task.stage === 'reviewing').length, 1, JSON.stringify(tasks));
  assert.equal(tasks.filter((task) => task.control === 'paused' && task.retries === 0).length, 1);
  assert.equal(f.turns(), 2);
});

for (const method of ['UI', 'PM'] as const) {
  test(`${method} resume refuses another branch and records the blocker`, async (t) => {
    const f = await fixture(t);
    f.store.updateTask(f.task().id, { control: 'paused', stage: 'developing', retries: 2 });
    await f.git(f.path, ['checkout', '-b', 'other']);
    await assert.rejects(
      method === 'UI' ? f.engine.resume(f.task().id) : f.resolve(),
      /分支不匹配/,
    );
    assert.equal(f.task().control, 'paused');
    assert.equal(f.task().retries, 2);
    assert.match(f.task().blocked!, /分支不匹配/);
  });
}
