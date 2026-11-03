import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
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
export const environmentBlock =
  'node -e "console.error(\'Error: EACCES: permission denied\');process.exit(1)"';

export async function fixture(
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
      if (prompt.includes('## 正式验证失败')) {
        // The Dev fixes the product defect the host validation found in its own work.
        await writeFile(join(this.options!.cwd, 'validation-fix.txt'), `fix ${Date.now()}\n`);
        await this.options!.toolHandler!('settle', { action: 'fixed', diagnosis: 'Product defect.' });
      } else if (this.options!.instructions.includes('Task Developer')) {
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
      for (let i = 0; i < 1500 && store.activeRuns().length; i++)
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(store.activeRuns().length, 0, 'lifecycle must finish its run');
      return store.task(created.id);
    },
    async resolve() {
      await engine.chat(store.addMessage(project.id, 'user', 'Resume the task', 'discuss'));
    },
  };
}

export async function conflictingTask(
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
export async function trackRef(f: Awaited<ReturnType<typeof conflictingTask>>, branch: string) {
  const fetched = await f.git(f.path, [
    'fetch',
    'origin',
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
  assert.equal(fetched.code, 0, fetched.stderr);
}

/** Publish the source worktree's HEAD as a branch, then refresh its tracking ref. */
export async function publishBranch(
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
export async function advancedLegacyTask(
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
export async function advancedRecordedBaselineTask(
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
export const legacyBaselineScenes = [
  ['a MERGE_HEAD baseline', advancedLegacyTask],
  ['a later recorded baseline', advancedRecordedBaselineTask],
] as const;

/**
 * An install command that leaves a marker behind, so "a paused coordination never installs" is an
 * observable fact rather than a reading of the Engine's control flow.
 */
export function installProbe(f: { root: string; store: Store; repo: { id: string } }) {
  const marker = join(f.root, 'installed.txt');
  f.store.patchRepo(f.repo.id, {
    commands: {
      ...f.store.repo(f.repo.id).commands,
      install: `node -e "require('node:fs').writeFileSync('${marker.replaceAll('\\', '/')}','installed')"`,
    },
  });
  return marker;
}

export async function assertNoInstall(marker: string) {
  await assert.rejects(readFile(marker), /ENOENT/);
}
