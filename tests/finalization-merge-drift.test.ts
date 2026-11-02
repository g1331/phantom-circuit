import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from '../src/server/process.ts';
import { conflictingTask } from './finalization-fixture.ts';

for (const change of [
  'source',
  'head',
  'merge-head',
  'branch',
  'common-dir',
  'repo',
  'unknown-base',
  'outside',
  'index',
] as const) {
  test(`pending merge refuses ${change} drift and preserves the scene without retries`, async (t) => {
    const f = await conflictingTask(
      t,
      async (cwd) => {
        await writeFile(join(cwd, 'value.txt'), 'after');
        if (change === 'outside') await writeFile(join(cwd, 'verify.cjs'), 'unexpected');
        if (change === 'index') await command('git', ['add', '.'], cwd);
      },
      'default',
      true,
    );
    if (!['source', 'outside', 'index'].includes(change)) {
      const result = await f.ws.prepareBase(f.task());
      assert.equal(result.status, 'conflicted');
    }
    if (change === 'source')
      await f.git(f.mirror, ['update-ref', 'refs/remotes/origin/main', f.base]);
    if (change === 'head') await f.git(f.path, ['update-ref', 'HEAD', f.base]);
    if (change === 'merge-head') {
      const metadata = (
        await f.git(f.path, ['rev-parse', '--git-path', 'MERGE_HEAD'])
      ).stdout.trim();
      await writeFile(metadata, f.base + '\n');
    }
    if (change === 'branch') await f.git(f.path, ['symbolic-ref', 'HEAD', 'refs/heads/wrong']);
    if (change === 'common-dir') {
      const foreign = join(f.root, 'foreign.git');
      await f.git(f.root, ['clone', '--bare', f.source, foreign]);
      const foreignWorktree = join(f.root, 'foreign-worktree');
      await f.git(foreign, ['worktree', 'add', '-b', f.task().branch!, foreignWorktree, 'main']);
      const metadata = await open(join(f.path, '.git'), 'r+');
      try {
        await metadata.truncate(0);
        await metadata.writeFile(await readFile(join(foreignWorktree, '.git')));
      } finally {
        await metadata.close();
      }
    }
    if (change === 'repo') {
      const other = f.store.createProject('Other', '');
      f.store.saveProjectAgentSelection(other.id, { mode: 'override', agent: 'codex' });
      f.store.updateTask(f.task().id, { projectId: other.id });
    }
    if (change === 'unknown-base')
      f.store.updateTask(f.task().id, {
        pendingMerge: { ...f.task().pendingMerge!, integratedBase: 'invalid-object' },
      });
    const result = await f.run();
    assert.equal(result.control, 'paused', JSON.stringify(result));
    assert.equal(result.retries, 2);
    const reason = {
      source: /来源证据不足/,
      head: /HEAD.*不匹配/,
      'merge-head': /MERGE_HEAD.*不匹配/,
      branch: /分支不匹配/,
      'common-dir': /Git 归属不匹配/,
      repo: /项目归属不匹配/,
      'unknown-base': /结果未知/,
      outside: /冲突文件以外/,
      index: /改变了 Git 索引/,
    }[change];
    if (change === 'repo') assert.match(JSON.stringify(f.store.list('incident')), reason);
    else assert.match(result.blocked!, reason);
    if (!['head', 'branch', 'common-dir'].includes(change))
      assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
    if (!['outside', 'index', 'common-dir'].includes(change)) assert.equal(f.turns(), 0);
  });
}
