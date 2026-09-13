import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { GitHub, type PullState } from '../src/server/github.ts';
import { Engine } from '../src/server/engine.ts';
import { Codex } from '../src/server/codex.ts';
import { command } from '../src/server/process.ts';
import type { Task } from '../src/shared/types.ts';

async function fixture(t: TestContext, dev: (cwd: string) => Promise<void> = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'phantom-finalization-'));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  await command('git', ['init', '--bare', remote]);
  await command('git', ['init', '-b', 'main', source]);
  const git = (cwd: string, args: string[]) => command('git', args, cwd);
  await git(source, ['config', 'user.name', 'Phantom Test']);
  await git(source, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(source, 'value.txt'), 'before');
  await writeFile(
    join(source, 'verify.cjs'),
    "require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt','utf8'),'after');",
  );
  await git(source, ['add', '.']);
  await git(source, ['commit', '-m', 'Fixture']);
  await git(source, ['remote', 'add', 'origin', remote]);
  await git(source, ['push', 'origin', 'main']);
  const store = new Store(join(root, 'db.sqlite'));
  const project = store.createProject('Fixture', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'source',
    path: source,
    github: 'fixture/source',
    defaultBranch: 'main',
    authorized: true,
  });
  store.patchRepo(repo.id, {
    enabled: true,
    commands: { install: '', build: '', test: 'node verify.cjs', start: '', port: 3000 },
  });
  const message = store.addMessage(project.id, 'user', 'Implement', 'implement');
  const created = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: message.id,
    title: 'Deliver value',
    spec: 'Change value',
    acceptance: ['value is after'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  const ws = new Workspaces(join(root, 'workspaces'), store);
  const prepared = await ws.prepare(created);
  const base = await ws.git(prepared.worktree!, ['rev-parse', 'HEAD']);
  store.updateTask(created.id, { base, issue: 1 });
  const mirror = join(ws.root, repo.id, 'mirror.git');
  await git(mirror, ['config', 'user.name', 'Phantom Test']);
  await git(mirror, ['config', 'user.email', 'test@example.invalid']);
  let turns = 0;
  class Remote extends GitHub {
    override async publishPR(task: Task) {
      store.updateTask(task.id, { pr: 2 });
      return this.pull(task);
    }
    override async pull(task: Task): Promise<PullState> {
      return {
        number: 2,
        html_url: '',
        state: 'open',
        merged: false,
        mergeable: true,
        mergeable_state: 'clean',
        head: { sha: task.head! },
        base: { sha: task.base! },
        body: '',
      };
    }
    override async syncStatus() {}
    override async api<T = any>(): Promise<T> {
      return { state: 'open' } as T;
    }
    override async paged() {
      return [];
    }
  }
  class Model extends Codex {
    options?: Parameters<Codex['thread']>[0];
    override async start() {}
    override async stop() {}
    override async thread(options: Parameters<Codex['thread']>[0]) {
      this.options = options;
      return 'fixture';
    }
    override async turn() {
      if (this.options!.instructions.includes('Task Developer')) {
        turns++;
        await dev(this.options!.cwd);
      } else {
        await this.options!.toolHandler!('resolve_task', {
          taskId: created.id,
          guidance: 'Reuse the existing implementation; host finalizes it.',
          upgrade: false,
        });
      }
      return 'Done';
    }
  }
  const engine = new Engine(store, new Remote(store), ws, root, () => new Model());
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  return {
    root,
    source,
    mirror,
    store,
    repo,
    ws,
    engine,
    base,
    path: prepared.worktree!,
    task: () => store.task(created.id),
    turns: () => turns,
    git,
    async run() {
      await engine.tick();
      for (let i = 0; i < 400 && store.activeRuns().length; i++)
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(store.activeRuns().length, 0, 'lifecycle must finish its run');
      return store.task(created.id);
    },
    async resolve() {
      await engine.chat(store.addMessage(project.id, 'user', 'Resume the task', 'discuss'));
    },
  };
}

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

test('host validation permission failure pauses with passed evidence and no product retry', async (t) => {
  const f = await fixture(t, async (cwd) => {
    await writeFile(join(cwd, 'value.txt'), 'after');
  });
  f.store.patchRepo(f.repo.id, {
    commands: {
      install: '',
      build: 'node -e "process.exit(0)"',
      test: 'node -e "console.error(\'Error: spawn taskkill EPERM\');process.exit(1)"',
      start: '',
      port: 3000,
    },
  });
  const result = await f.run();
  assert.equal(result.control, 'paused', JSON.stringify(result));
  assert.equal(result.retries, 0);
  assert.match(result.blocked!, /宿主.*验证.*EPERM/s);
  assert.equal(result.tests.length, 2);
  assert.equal(result.tests[0].exitCode, 0);
  assert.equal(result.tests[0].head, result.head);
  assert.equal(result.tests[1].exitCode, 1);
  await f.engine.tick();
  assert.equal(f.turns(), 1);
});

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

test('an assertion failure remains product rework', async (t) => {
  const f = await fixture(t, async (cwd) => {
    await writeFile(join(cwd, 'value.txt'), 'wrong');
  });
  const result = await f.run();
  assert.equal(result.control, 'active');
  assert.equal(result.retries, 1);
  assert.match(result.feedback[0], /AssertionError/);
});

test('mentioning a permission code in an assertion is not environment evidence', async (t) => {
  const f = await fixture(t, async (cwd) => {
    await writeFile(join(cwd, 'value.txt'), 'after');
  });
  f.store.patchRepo(f.repo.id, {
    commands: {
      install: '',
      build: '',
      test: 'node -e "console.error(\'AssertionError: expected EPERM but got success\');process.exit(1)"',
      start: '',
      port: 3000,
    },
  });
  const result = await f.run();
  assert.equal(result.control, 'active');
  assert.equal(result.retries, 1);
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
  for (let i = 0; i < 500 && f.store.activeRuns().length; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.store.activeRuns().length, 0);
  const tasks = [f.task(), f.store.task(second.id)];
  assert.equal(tasks.filter((task) => task.stage === 'reviewing').length, 1, JSON.stringify(tasks));
  assert.equal(tasks.filter((task) => task.control === 'paused' && task.retries === 0).length, 1);
  assert.equal(f.turns(), 2);
});

for (const mutation of ['files', 'revision'] as const) {
  test(`formal validation rejects changed ${mutation} and retains its evidence`, async (t) => {
    const f = await fixture(t, async (cwd) => {
      await writeFile(join(cwd, 'value.txt'), 'after');
    });
    const testCommand =
      mutation === 'files'
        ? "node -e \"require('node:fs').writeFileSync('generated.txt','unexpected')\""
        : 'git commit --allow-empty -m unexpected';
    f.store.patchRepo(f.repo.id, {
      commands: { install: '', build: '', test: testCommand, start: '', port: 3000 },
    });
    const result = await f.run();
    assert.equal(result.control, 'paused');
    assert.equal(result.retries, 0);
    assert.match(result.blocked!, /验证过程改变/);
    assert.equal(result.tests[0].exitCode, 0);
    assert.equal(result.tests[0].head, result.head);
  });
}

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
