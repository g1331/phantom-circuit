import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { GitHub, type PullState } from '../src/server/github.ts';
import { Engine } from '../src/server/engine.ts';
import { Codex } from '../src/server/codex.ts';
import { command } from '../src/server/process.ts';
import type { Task } from '../src/shared/types.ts';

/** A configured-command failure the host must read as an environment block, not product rework. */
const environmentBlock =
  'node -e "console.error(\'Error: EACCES: permission denied\');process.exit(1)"';

async function fixture(
  t: TestContext,
  dev: (cwd: string) => Promise<void> = async () => {},
  files: Record<string, string> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'phantom-finalization-'));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  await command('git', ['init', '--bare', remote]);
  await command('git', ['init', '-b', 'main', source]);
  const git = (cwd: string, args: string[]) => command('git', args, cwd);
  await git(source, ['config', 'user.name', 'Phantom Test']);
  await git(source, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(source, 'value.txt'), 'before');
  for (const [path, content] of Object.entries(files)) await writeFile(join(source, path), content);
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
  store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
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
  store.updateMessage(message.id, { status: 'completed', draftStatus: 'completed' });
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
  const prIdentity = {
    headRepo: 'fixture/source',
    baseRepo: 'fixture/source',
    branch: prepared.branch!,
  };
  class Remote extends GitHub {
    override async publishPR(task: Task) {
      store.updateTask(task.id, { pr: 2 });
      return this.pull(task);
    }
    override async pull(task: Task): Promise<PullState> {
      const remoteHead = await command(
        'git',
        ['rev-parse', '--verify', '--quiet', `refs/heads/${task.branch}`],
        remote,
        undefined,
        120000,
        false,
      );
      return {
        number: 2,
        html_url: '',
        state: 'open',
        merged: false,
        mergeable: true,
        mergeable_state: 'clean',
        head: {
          sha: remoteHead.code === 0 ? remoteHead.stdout.trim() : task.head!,
          ref: prIdentity.branch,
          repo: { full_name: prIdentity.headRepo },
        },
        base: { sha: task.base!, repo: { full_name: prIdentity.baseRepo } },
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
    override async turn(_thread: string, prompt: string) {
      if (this.options!.instructions.includes('Task Developer')) {
        turns++;
        await dev(this.options!.cwd);
      } else if (
        prompt.includes('Current input intent: discuss') ||
        prompt.includes('没有可交付的实现差异')
      ) {
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
  await engine.start();
  // These fixtures drive scheduler ticks explicitly; leave the production interval out of the
  // long Git-history setup so it cannot claim a Dev Run before a scenario's legacy state is ready.
  clearInterval((engine as any).timer);
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
    prIdentity,
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

test('legacy target base in MERGE_HEAD is resolved by editing only before installation', async (t) => {
  const f = await fixture(t, async (cwd) => {
    assert.match((await command('git', ['status', '--porcelain'], cwd)).stdout, /UU value.txt/);
    await writeFile(join(cwd, 'value.txt'), 'after');
  });
  await writeFile(join(f.path, 'value.txt'), 'task implementation');
  await f.git(f.path, ['add', '.']);
  await f.git(f.path, ['commit', '-m', 'Original implementation']);
  const oldHead = (await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(f.source, 'value.txt'), 'default implementation');
  await writeFile(join(f.source, 'retained.txt'), 'default feature');
  await f.git(f.source, ['add', '.']);
  await f.git(f.source, ['commit', '-m', 'Default changes']);
  await f.git(f.source, ['push', 'origin', 'main']);
  await f.ws.mirror(f.store.repo(f.repo.id));
  const target = (await f.git(f.source, ['rev-parse', 'HEAD'])).stdout.trim();
  await command('git', ['merge', '--no-edit', target], f.path, undefined, 120000, false);
  f.store.patchRepo(f.repo.id, {
    commands: {
      install:
        "node -e \"const c=require('node:child_process');if(c.spawnSync('git',['rev-parse','--verify','MERGE_HEAD']).status===0)process.exit(9)\"",
      build: '',
      test: 'node verify.cjs',
      start: '',
      port: 3000,
    },
  });
  f.store.updateTask(f.task().id, {
    stage: 'developing',
    control: 'paused',
    devPhase: 'finalize',
    base: target,
    head: oldHead,
    retries: 2,
  });
  await f.engine.resume(f.task().id);
  const result = await f.run();
  assert.equal(result.stage, 'reviewing', result.blocked);
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 1);
  assert.equal(
    (await f.git(f.path, ['show', '-s', '--format=%P', 'HEAD'])).stdout.trim(),
    `${oldHead} ${target}`,
  );
  assert.equal((await f.git(f.path, ['status', '--porcelain'])).stdout, '');
  assert.equal(await readFile(join(f.path, 'retained.txt'), 'utf8'), 'default feature');
  assert.equal(result.tests[0].head, result.head);
});

async function conflictingTask(
  t: TestContext,
  dev: (cwd: string) => Promise<void>,
  source: 'default' | 'task' = 'default',
  legacy = false,
  packages = false,
) {
  const manifests = packages ? ['package.json', 'package-lock.json'] : [];
  const f = await fixture(
    t,
    dev,
    Object.fromEntries(manifests.map((path) => [path, '{"name":"fixture"}\n'])),
  );
  await writeFile(join(f.path, 'value.txt'), 'original task');
  for (const path of manifests)
    await writeFile(join(f.path, path), '{"name":"fixture","taskFeature":true}\n');
  await f.git(f.path, ['add', '.']);
  await f.git(f.path, ['commit', '-m', 'Original task']);
  const oldHead = (await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim();
  if (source === 'task') {
    await f.git(f.source, ['checkout', '-b', f.task().branch!]);
    f.store.updateTask(f.task().id, { pr: 2 });
  }
  await writeFile(join(f.source, 'value.txt'), 'incoming feature');
  for (const path of manifests)
    await writeFile(join(f.source, path), '{"name":"fixture","defaultFeature":true}\n');
  await writeFile(join(f.source, 'incoming.txt'), 'preserved incoming feature');
  await f.git(f.source, ['add', '.']);
  await f.git(f.source, ['commit', '-m', 'Incoming changes']);
  await f.git(f.source, ['push', 'origin', source === 'task' ? f.task().branch! : 'main']);
  const incoming = (await f.git(f.source, ['rev-parse', 'HEAD'])).stdout.trim();
  if (source === 'task') {
    await f.git(f.source, ['checkout', 'main']);
    await writeFile(join(f.source, 'later.txt'), 'default branch must wait');
    await f.git(f.source, ['add', '.']);
    await f.git(f.source, ['commit', '-m', 'Later default']);
    await f.git(f.source, ['push', 'origin', 'main']);
  }
  if (legacy) {
    await f.ws.mirror(f.store.repo(f.repo.id));
    if (source === 'task')
      await f.git(f.path, [
        'fetch',
        'origin',
        `+refs/heads/${f.task().branch}:refs/remotes/origin/${f.task().branch}`,
      ]);
    await command('git', ['merge', '--no-edit', incoming], f.path, undefined, 120000, false);
  }
  f.store.updateTask(f.task().id, {
    stage: 'developing',
    head: oldHead,
    base: legacy ? incoming : f.base,
    devPhase: legacy ? 'finalize' : 'implement',
    retries: 2,
  });
  return { ...f, oldHead, incoming };
}

/**
 * Refresh the task worktree's tracking ref for one remote branch, so coordination sees the remote
 * move the way it would after a real push.
 */
async function trackRef(f: Awaited<ReturnType<typeof conflictingTask>>, branch: string) {
  const fetched = await f.git(f.path, [
    'fetch',
    'origin',
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
  assert.equal(fetched.code, 0, fetched.stderr);
}

/** Publish the source worktree's HEAD as a branch, then refresh its tracking ref. */
async function publishBranch(
  f: Awaited<ReturnType<typeof conflictingTask>>,
  branch: string,
  push: string[] = [],
) {
  const pushed = await f.git(f.source, ['push', ...push, 'origin', `HEAD:refs/heads/${branch}`]);
  assert.equal(pushed.code, 0, pushed.stderr);
  await trackRef(f, branch);
}

/**
 * The scene #32 was stuck in: a legacy in-progress merge whose tracked default branch moved on.
 * `conflictingTask` starts the merge the pre-finalization host started and stores the default-branch
 * tip it merged as `base`, exactly as that host did; this helper adds the durable coordination event
 * that host wrote and then advances the default branch past the commit the merge started from.
 */
async function advancedLegacyTask(
  t: TestContext,
  dev: (cwd: string) => Promise<void> = async () => {},
  options: { record?: boolean } = {},
) {
  const f = await conflictingTask(t, dev, 'default', true);
  if (options.record !== false)
    f.store.event('merge-conflict', '需要 Dev 按双方意图解决合并冲突', {
      projectId: f.task().projectId,
      taskId: f.task().id,
    });
  await writeFile(join(f.source, 'later.txt'), 'advanced default work');
  await f.git(f.source, ['add', '.']);
  await f.git(f.source, ['commit', '-m', 'Later default']);
  await publishBranch(f, 'main');
  const advanced = (await f.git(f.source, ['rev-parse', 'HEAD'])).stdout.trim();
  assert.notEqual(advanced, f.incoming);
  return { ...f, advanced };
}

/**
 * The scene ADR 0014 covers: the legacy host recorded a default-branch tip it had already moved
 * past, so the recorded baseline is a later commit than `MERGE_HEAD` instead of the commit the
 * merge started from. The default branch then advances once more after that record was written.
 */
async function advancedRecordedBaselineTask(
  t: TestContext,
  dev: (cwd: string) => Promise<void> = async () => {},
  options: { record?: boolean } = {},
) {
  const f = await conflictingTask(t, dev, 'default', true);
  if (options.record !== false)
    f.store.event('merge-conflict', '需要 Dev 按双方意图解决合并冲突', {
      projectId: f.task().projectId,
      taskId: f.task().id,
    });
  await writeFile(join(f.source, 'recorded.txt'), 'recorded default work');
  await f.git(f.source, ['add', '.']);
  await f.git(f.source, ['commit', '-m', 'Recorded default']);
  await publishBranch(f, 'main');
  const recorded = (await f.git(f.source, ['rev-parse', 'HEAD'])).stdout.trim();
  f.store.updateTask(f.task().id, { base: recorded });
  await writeFile(join(f.source, 'later.txt'), 'advanced default work');
  await f.git(f.source, ['add', '.']);
  await f.git(f.source, ['commit', '-m', 'Later default']);
  await publishBranch(f, 'main');
  const advanced = (await f.git(f.source, ['rev-parse', 'HEAD'])).stdout.trim();
  const fork = (await f.git(f.path, ['merge-base', 'HEAD', f.incoming])).stdout.trim();
  assert.notEqual(recorded, f.incoming);
  assert.notEqual(advanced, recorded);
  return { ...f, recorded, advanced, fork };
}

/**
 * Both accepted legacy scenes, so every behaviour that must hold for either is expressed once: a
 * recorded baseline that is `MERGE_HEAD` itself, and the later recorded tip ADR 0014 adds.
 */
const legacyBaselineScenes = [
  ['a MERGE_HEAD baseline', advancedLegacyTask],
  ['a later recorded baseline', advancedRecordedBaselineTask],
] as const;

/**
 * An install command that leaves a marker behind, so "a paused coordination never installs" is an
 * observable fact rather than a reading of the Engine's control flow.
 */
function installProbe(f: { root: string; store: Store; repo: { id: string } }) {
  const marker = join(f.root, 'installed.txt');
  f.store.patchRepo(f.repo.id, {
    commands: {
      ...f.store.repo(f.repo.id).commands,
      install: `node -e "require('node:fs').writeFileSync('${marker.replaceAll('\\', '/')}','installed')"`,
    },
  });
  return marker;
}

async function assertNoInstall(marker: string) {
  await assert.rejects(readFile(marker), /ENOENT/);
}

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

for (const source of ['default', 'task'] as const) {
  test(`${source} conflict stops installation and another merge; repeated resume does not repeat Dev`, async (t) => {
    const f = await conflictingTask(t, async () => {}, source);
    f.store.patchRepo(f.repo.id, {
      commands: {
        install: "node -e \"require('node:fs').writeFileSync('installed.txt','bad')\"",
        build: '',
        test: 'node verify.cjs',
        start: '',
        port: 3000,
      },
    });
    const result = await f.run();
    assert.equal(result.control, 'paused', result.blocked);
    assert.match(result.blocked!, /冲突.*value.txt/);
    assert.equal(result.retries, 2);
    assert.equal(f.turns(), 1);
    assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
    assert.equal((await f.git(f.path, ['rev-parse', 'MERGE_HEAD'])).stdout.trim(), f.incoming);
    await assert.rejects(readFile(join(f.path, 'installed.txt')), /ENOENT/);
    if (source === 'task') await assert.rejects(readFile(join(f.path, 'later.txt')), /ENOENT/);
    await f.engine.resume(result.id);
    const resumed = await f.run();
    assert.equal(resumed.control, 'paused');
    assert.equal(resumed.retries, 2);
    assert.equal(f.turns(), 1);
  });
}

test('successful remote task conflict preserves the PR and integrates default afterward', async (t) => {
  const f = await conflictingTask(
    t,
    async (cwd) => {
      await writeFile(join(cwd, 'value.txt'), 'after');
    },
    'task',
  );
  const result = await f.run();
  assert.equal(result.stage, 'reviewing', result.blocked);
  assert.equal(result.pr, 2);
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 1);
  assert.equal(await readFile(join(f.path, 'incoming.txt'), 'utf8'), 'preserved incoming feature');
  assert.equal(await readFile(join(f.path, 'later.txt'), 'utf8'), 'default branch must wait');
  assert.equal((await f.git(f.path, ['merge-base', '--is-ancestor', f.oldHead, 'HEAD'])).code, 0);
  assert.equal((await f.git(f.path, ['merge-base', '--is-ancestor', f.incoming, 'HEAD'])).code, 0);
  assert.equal(result.tests[0].head, result.head);
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

for (const resolution of ['valid', 'markers', 'invalid-json'] as const) {
  test(`legacy manifest and lockfile conflict with ${resolution} resolution is checked before install`, async (t) => {
    const f = await conflictingTask(
      t,
      async (cwd) => {
        await writeFile(join(cwd, 'value.txt'), 'after');
        if (resolution === 'markers') return;
        for (const path of ['package.json', 'package-lock.json'])
          await writeFile(
            join(cwd, path),
            resolution === 'valid'
              ? '{"name":"fixture","taskFeature":true,"defaultFeature":true}\n'
              : '{invalid json}',
          );
      },
      'default',
      true,
      true,
    );
    const installed = join(f.root, 'installed.txt');
    f.store.patchRepo(f.repo.id, {
      commands: {
        install: `node -e "const f=require('node:fs');const c=require('node:child_process');if(c.spawnSync('git',['rev-parse','--verify','MERGE_HEAD']).status===0)process.exit(9);JSON.parse(f.readFileSync('package.json'));JSON.parse(f.readFileSync('package-lock.json'));f.writeFileSync('${installed.replaceAll('\\', '/')}', 'installed');"`,
        build: '',
        test: 'node verify.cjs',
        start: '',
        port: 3000,
      },
    });
    const result = await f.run();
    assert.equal(result.retries, 2);
    if (resolution === 'valid') {
      assert.equal(result.stage, 'reviewing', result.blocked);
      assert.equal(await readFile(installed, 'utf8'), 'installed');
      assert.deepEqual(JSON.parse(await readFile(join(f.path, 'package-lock.json'), 'utf8')), {
        name: 'fixture',
        taskFeature: true,
        defaultFeature: true,
      });
    } else {
      assert.equal(result.control, 'paused');
      assert.match(
        result.blocked!,
        resolution === 'markers' ? /冲突标记.*package/ : /不可解析.*package/,
      );
      await assert.rejects(readFile(installed), /ENOENT/);
      assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
      assert.match((await f.git(f.path, ['status', '--porcelain'])).stdout, /UU package-lock.json/);
    }
  });
}

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

for (const field of ['headRepo', 'baseRepo', 'branch'] as const) {
  test(`remote Task merge requires the original PR ${field} identity`, async (t) => {
    const f = await conflictingTask(t, async () => {}, 'task');
    f.prIdentity[field] = 'unrelated';
    const result = await f.run();
    assert.equal(result.control, 'paused');
    assert.match(result.blocked!, /原 PR.*归属不匹配/);
    assert.equal(result.retries, 2);
    assert.equal(f.turns(), 0);
    assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
  });
}

test('PM guidance can authorize a new conflict editing attempt without product rework', async (t) => {
  let attempts = 0;
  const f = await conflictingTask(t, async (cwd) => {
    if (++attempts === 2) await writeFile(join(cwd, 'value.txt'), 'after');
  });
  const first = await f.run();
  assert.equal(first.control, 'paused');
  const previousRun = first.pendingMerge!.runId!;
  await f.engine.resume(first.id, {
    guidance: 'Preserve incoming.txt and implement the agreed value after in value.txt.',
    upgrade: false,
  });
  const result = await f.run();
  assert.equal(result.stage, 'reviewing', result.blocked);
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 2);
  assert.deepEqual(result.mergeHistory![0].previousRunIds, [previousRun]);
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

for (const failure of [
  'Error: spawn taskkill EPERM',
  'Error: EBUSY: resource busy or locked, unlink preview.log',
  'Error: EIO: i/o error, write',
  'Reason: Access is denied.',
]) {
  test(`host validation environment failure pauses with evidence: ${failure}`, async (t) => {
    const f = await fixture(t, async (cwd) => {
      await writeFile(join(cwd, 'value.txt'), 'after');
    });
    f.store.patchRepo(f.repo.id, {
      commands: {
        install: '',
        build: 'node -e "process.exit(0)"',
        test: `node -e "console.error('${failure}');process.exit(1)"`,
        start: '',
        port: 3000,
      },
    });
    const result = await f.run();
    assert.equal(result.control, 'paused', JSON.stringify(result));
    assert.equal(result.retries, 0);
    assert.match(result.blocked!, /宿主正式验证环境阻塞/);
    assert.ok(result.blocked!.includes(failure));
    assert.equal(result.tests.length, 2);
    assert.equal(result.tests[0].exitCode, 0);
    assert.equal(result.tests[0].head, result.head);
    assert.equal(result.tests[1].exitCode, 1);
    assert.equal(result.tests[1].head, result.head);
    assert.ok(result.tests[1].output.includes(failure));
    assert.equal(result.worktree, f.path);
    assert.equal((await f.git(f.path, ['status', '--porcelain'])).stdout, '');
    const runs = f.store.list('run').length;
    await f.engine.tick();
    assert.equal(f.store.list('run').length, runs);
    assert.equal(f.turns(), 1);
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

test('an assertion failure remains product rework', async (t) => {
  const f = await fixture(t, async (cwd) => {
    await writeFile(join(cwd, 'value.txt'), 'wrong');
  });
  const result = await f.run();
  assert.equal(result.control, 'active');
  assert.equal(result.retries, 1);
  assert.match(result.feedback[0], /AssertionError/);
});

for (const detail of ['EPERM', 'EBUSY', 'EIO', 'Reason: Access is denied.']) {
  test(`mentioning ${detail} in an assertion is not environment evidence`, async (t) => {
    const f = await fixture(t, async (cwd) => {
      await writeFile(join(cwd, 'value.txt'), 'after');
    });
    f.store.patchRepo(f.repo.id, {
      commands: {
        install: '',
        build: '',
        test: `node -e "console.error('AssertionError: expected ${detail} but got success');process.exit(1)"`,
        start: '',
        port: 3000,
      },
    });
    const result = await f.run();
    assert.equal(result.control, 'active');
    assert.equal(result.retries, 1);
  });
}

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
