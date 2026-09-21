import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { command } from '../src/server/process.ts';
import { Store } from '../src/server/store.ts';
import { Workspaces } from '../src/server/workspaces.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'phantom-cleanup-'));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  await command('git', ['init', '--bare', remote]);
  await command('git', ['init', '-b', 'main', source]);
  const git = (cwd: string, args: string[]) => command('git', args, cwd);
  await git(source, ['config', 'user.name', 'Phantom Test']);
  await git(source, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(source, 'value.txt'), 'original\n');
  await git(source, ['add', '.']);
  await git(source, ['commit', '-m', 'Fixture']);
  await git(source, ['remote', 'add', 'origin', remote]);
  await git(source, ['push', 'origin', 'main']);

  const store = new Store(join(root, 'db.sqlite'));
  const project = store.createProject('Cleanup fixture', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'source',
    path: source,
    github: 'fixture/source',
    defaultBranch: 'main',
    authorized: true,
  });
  const message = store.addMessage(project.id, 'user', 'Implement', 'implement');
  const task = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: message.id,
    title: 'Cleanup fixture',
    spec: 'Keep the original checkout.',
    acceptance: ['safe cleanup'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  const workspaces = new Workspaces(join(root, 'workspaces'), store);
  const prepared = await workspaces.prepare(task);
  const head = await workspaces.git(prepared.worktree!, ['rev-parse', 'HEAD']);
  store.updateTask(task.id, {
    stage: 'done',
    issue: 1,
    pr: 2,
    base: head,
    head,
    completionDeliveryPending: false,
  });
  store.put('operation', `merge:${task.id}:${head}`, {
    id: `merge:${task.id}:${head}`,
    kind: 'merge-pr',
    status: 'done',
    result: {
      number: 2,
      merged: true,
      head: { sha: head },
      base: { sha: head },
    },
  });
  store.put('operation', `complete-issue:${task.id}:${head}:${head}`, {
    id: `complete-issue:${task.id}:${head}:${head}`,
    kind: 'complete-issue',
    status: 'done',
    result: { number: 1, state: 'closed' },
  });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    source,
    remote,
    store,
    repo,
    task: () => store.task(task.id),
    workspaces,
    git,
    path: prepared.worktree!,
    head,
  };
}

test('cleanup removes only the registered task worktree and preserves source, mirror and branch', async (t) => {
  const f = await fixture(t);
  const before = await readFile(join(f.source, 'value.txt'), 'utf8');
  const result = await f.workspaces.cleanup(f.task());
  assert.equal(result.status, 'completed');
  await assert.rejects(readFile(join(f.path, 'value.txt'), 'utf8'), /ENOENT/);
  assert.equal(await readFile(join(f.source, 'value.txt'), 'utf8'), before);
  assert.equal(await f.workspaces.git(f.source, ['rev-parse', 'HEAD']), f.head);
  assert.equal(
    await f.workspaces.git(join(f.root, 'workspaces', f.repo.id, 'mirror.git'), [
      'rev-parse',
      `refs/heads/${f.task().branch!}`,
    ]),
    f.head,
  );
  assert.equal(
    (f.task() as unknown as { cleanup?: { status?: string } }).cleanup?.status,
    'completed',
  );

  const again = await f.workspaces.cleanup(f.task());
  assert.equal(again.status, 'completed');
  assert.equal(again.alreadyAbsent, true);
  await assert.rejects(f.workspaces.prepare(f.task()), /已清理/);
});

test('cleanup blocks dirty or unregistered scenes without changing completion evidence', async (t) => {
  const f = await fixture(t);
  const taskBefore = f.task();
  await writeFile(join(f.path, 'uncommitted.txt'), 'keep me\n');
  const result = await f.workspaces.cleanup(f.task());
  assert.equal(result.status, 'blocked');
  assert.match(result.reason!, /不干净/);
  assert.equal(f.task().stage, 'done');
  assert.equal(f.task().retries, taskBefore.retries);
  assert.equal(f.task().head, taskBefore.head);
  assert.equal(await readFile(join(f.path, 'uncommitted.txt'), 'utf8'), 'keep me\n');
  assert.equal(
    (f.task() as unknown as { cleanup?: { status?: string } }).cleanup?.status,
    'blocked',
  );
});

test('cleanup treats an already missing registered directory as an idempotent prune', async (t) => {
  const f = await fixture(t);
  await rm(f.path, { recursive: true, force: true });
  const result = await f.workspaces.cleanup(f.task());
  assert.equal(result.status, 'completed');
  assert.equal(result.alreadyAbsent, true);
  assert.equal(
    await f.workspaces.git(join(f.root, 'workspaces', f.repo.id, 'mirror.git'), [
      'rev-parse',
      `refs/heads/${f.task().branch!}`,
    ]),
    f.head,
  );
});

test('cleanup removes only the target stale registration and preserves another stale registration', async (t) => {
  const f = await fixture(t);
  const mirror = join(f.root, 'workspaces', f.repo.id, 'mirror.git');
  const other = join(f.root, 'stale-other');
  await f.git(mirror, ['worktree', 'add', '--detach', other, 'HEAD']);
  await rm(f.path, { recursive: true, force: true });
  await rm(other, { recursive: true, force: true });

  const result = await f.workspaces.cleanup(f.task());
  assert.equal(result.status, 'completed');
  const registrations = await f.workspaces.git(mirror, ['worktree', 'list', '--porcelain']);
  assert.ok(
    registrations.toLowerCase().includes(other.replaceAll('\\', '/').toLowerCase()),
    registrations,
  );
});

test('cleanup reports unknown when the post-remove registration read fails', async (t) => {
  const f = await fixture(t);
  const originalGit = f.workspaces.git.bind(f.workspaces);
  let registrationReads = 0;
  (f.workspaces as unknown as { git: typeof f.workspaces.git }).git = async (cwd, args, signal) => {
    if (args[0] === 'worktree' && args[1] === 'list') {
      registrationReads++;
      if (registrationReads === 2) throw new Error('injected registration read failure');
    }
    return originalGit(cwd, args, signal);
  };

  const result = await f.workspaces.cleanup(f.task());
  assert.equal(result.status, 'unknown');
  assert.match(result.reason!, /registration 核对失败/);
  assert.equal(
    (f.task() as unknown as { cleanup?: { status?: string } }).cleanup?.status,
    'unknown',
  );
});

test('an unmapped legacy root is rejected while an explicitly mapped task root is accepted', async (t) => {
  const f = await fixture(t);
  const legacyRoot = join(f.root, 'legacy-workspaces');
  const legacyPath = join(legacyRoot, f.repo.id, `task-${f.task().id}`);
  await mkdir(legacyPath, { recursive: true });
  const withLegacyRoot = new Workspaces(join(f.root, 'workspaces'), f.store, {
    legacyRoots: [legacyRoot],
  });
  await assert.rejects(
    withLegacyRoot.assertTask({ ...f.task(), worktree: legacyPath }),
    /工作区不属于当前任务/,
  );

  const legacyMirror = join(legacyRoot, f.repo.id, 'mirror.git');
  await rm(legacyPath, { recursive: true, force: true });
  await mkdir(join(legacyRoot, f.repo.id), { recursive: true });
  await f.git(f.source, ['clone', '--bare', '--no-hardlinks', f.source, legacyMirror]);
  await f.git(legacyMirror, ['worktree', 'add', '-b', f.task().branch!, legacyPath, 'HEAD']);
  const mapped = new Workspaces(join(f.root, 'workspaces'), f.store, {
    legacyRoots: [legacyRoot],
    taskRoots: { [f.task().id]: legacyRoot },
  });
  await mapped.assertTask({ ...f.task(), worktree: legacyPath });
});
