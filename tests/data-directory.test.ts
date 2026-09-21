import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { command } from '../src/server/process.ts';
import { resolveDataDirectory } from '../src/server/data-directory.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'phantom-data-directory-'));
  const legacy = join(root, 'checkout', '.phantom');
  const home = join(root, 'home');
  await writeFile(
    join(await mkdirLegacy(legacy), 'config.json'),
    '{"port": 4391, "fixture": true}\n',
  );
  const store = new Store(join(legacy, 'phantom.sqlite'));
  const project = store.createProject('Referenced', 'kept');
  const message = store.addMessage(project.id, 'user', 'with image', 'discuss', [
    { id: 'attachment-one', name: 'one', mediaType: 'image/png', size: 3, width: 1, height: 1 },
  ]);
  store.close();
  await mkdir(join(legacy, 'messages', project.id, message.id), { recursive: true });
  await writeFile(
    join(legacy, 'messages', project.id, message.id, 'attachment-one.png'),
    'png-fixture',
  );
  await mkdir(join(legacy, 'messages', 'unreferenced'), { recursive: true });
  await writeFile(join(legacy, 'messages', 'unreferenced', 'debug.bin'), 'ignore');
  await mkdir(join(legacy, 'secrets'), { recursive: true });
  await writeFile(join(legacy, 'secrets', 'unreferenced-provider'), 'ignore');
  await mkdir(join(legacy, 'projects', project.id), { recursive: true });
  await writeFile(join(legacy, 'projects', project.id, 'session.json'), '{"kept":true}');
  await mkdir(join(legacy, 'projects', 'unreferenced'), { recursive: true });
  await writeFile(join(legacy, 'projects', 'unreferenced', 'debug.json'), '{}');
  return { root, legacy, home, dataDir: join(home, '.phantom'), project, message };
}

async function mkdirLegacy(path: string) {
  await mkdir(path, { recursive: true });
  return path;
}

async function cleanup(root: string) {
  if (process.platform === 'win32')
    await command('icacls.exe', [root, '/reset', '/T', '/C'], undefined, undefined, 15000, false);
  await rm(root, { recursive: true, force: true });
}

test('first startup migrates only authoritative data and keeps the old directory as rollback source', async () => {
  const f = await fixture();
  let lease: Awaited<ReturnType<typeof resolveDataDirectory>> | undefined;
  try {
    lease = await resolveDataDirectory({
      legacyDir: f.legacy,
      dataDir: f.dataDir,
      probeLegacy: false,
      now: () => '2026-09-21T00:00:00.000Z',
    });
    assert.equal(lease.dataDir, f.dataDir);
    assert.equal(lease.migrated, true);
    assert.equal(lease.migration.status, 'complete');
    assert.equal(JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8')).fixture, true);
    assert.equal(
      await readFile(
        join(f.dataDir, 'messages', f.project.id, f.message.id, 'attachment-one.png'),
        'utf8',
      ),
      'png-fixture',
    );
    assert.equal(
      await readFile(join(f.dataDir, 'projects', f.project.id, 'session.json'), 'utf8'),
      '{"kept":true}',
    );
    await assert.rejects(() => readFile(join(f.dataDir, 'messages', 'unreferenced', 'debug.bin')));
    await assert.rejects(() => readFile(join(f.dataDir, 'secrets', 'unreferenced-provider')));
    await assert.rejects(() => readFile(join(f.dataDir, 'projects', 'unreferenced', 'debug.json')));
    assert.equal(
      await readFile(join(f.legacy, 'config.json'), 'utf8'),
      '{"port": 4391, "fixture": true}\n',
    );
    assert.ok((await readdir(f.legacy)).includes('phantom.sqlite'));
    assert.equal(
      JSON.parse(await readFile(join(f.dataDir, 'migration.json'), 'utf8')).rollback
        .sourcePreserved,
      true,
    );
    const marker = JSON.parse(await readFile(join(f.dataDir, 'migration.json'), 'utf8'));
    assert.match(marker.rollback.databaseBackup, /^backups[\\/]legacy-.*\.sqlite$/);
    assert.ok((await readFile(join(f.dataDir, marker.rollback.databaseBackup))).length > 0);
    const migratedDb = new DatabaseSync(join(f.dataDir, 'phantom.sqlite'), { readOnly: true });
    const rollbackDb = new DatabaseSync(join(f.dataDir, marker.rollback.databaseBackup), {
      readOnly: true,
    });
    try {
      assert.deepEqual(
        migratedDb.prepare('SELECT kind,id,body FROM documents ORDER BY kind,id').all(),
        rollbackDb.prepare('SELECT kind,id,body FROM documents ORDER BY kind,id').all(),
      );
    } finally {
      migratedDb.close();
      rollbackDb.close();
    }
    assert.equal(lease.migration.rollback?.sourcePreserved, true);
  } finally {
    await lease?.release();
    await cleanup(f.root);
  }
});

test('a target with different authoritative state is never overwritten', async () => {
  const f = await fixture();
  let lease: Awaited<ReturnType<typeof resolveDataDirectory>> | undefined;
  try {
    await mkdirLegacy(f.dataDir);
    await writeFile(join(f.dataDir, 'config.json'), '{"port": 4392}\n');
    const target = new Store(join(f.dataDir, 'phantom.sqlite'));
    target.createProject('Different', 'must survive');
    target.close();
    await assert.rejects(
      () => resolveDataDirectory({ legacyDir: f.legacy, dataDir: f.dataDir, probeLegacy: false }),
      /不一致|拒绝自动合并/,
    );
    assert.equal(await readFile(join(f.dataDir, 'config.json'), 'utf8'), '{"port": 4392}\n');
    assert.equal(
      await readFile(join(f.legacy, 'config.json'), 'utf8'),
      '{"port": 4391, "fixture": true}\n',
    );
    assert.equal(
      JSON.parse(await readFile(join(f.dataDir, 'migration.json'), 'utf8')).status,
      'blocked',
    );
  } finally {
    await lease?.release();
    await cleanup(f.root);
  }
});

test('a completed migration blocks later writes to the preserved legacy source', async () => {
  const f = await fixture();
  let lease: Awaited<ReturnType<typeof resolveDataDirectory>> | undefined;
  try {
    lease = await resolveDataDirectory({
      legacyDir: f.legacy,
      dataDir: f.dataDir,
      probeLegacy: false,
    });
    await lease.release();
    lease = undefined;
    await writeFile(join(f.dataDir, 'config.json'), '{"port": 4395, "fixture": true}\n');
    lease = await resolveDataDirectory({
      legacyDir: f.legacy,
      dataDir: f.dataDir,
      probeLegacy: false,
    });
    assert.equal(lease.migration.status, 'complete');
    await lease.release();
    lease = undefined;
    await writeFile(join(f.legacy, 'config.json'), '{"port": 4394, "fixture": true}\n');
    await assert.rejects(
      () => resolveDataDirectory({ legacyDir: f.legacy, dataDir: f.dataDir, probeLegacy: false }),
      /旧版数据目录在迁移完成后发生变化/,
    );
    assert.equal(
      JSON.parse(await readFile(join(f.dataDir, 'migration.json'), 'utf8')).status,
      'blocked',
    );
  } finally {
    await lease?.release();
    await cleanup(f.root);
  }
});

test('only-new startup creates a durable marker and the lease prevents a second writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-data-only-new-'));
  const dataDir = join(root, 'home', '.phantom');
  let lease: Awaited<ReturnType<typeof resolveDataDirectory>> | undefined;
  try {
    await mkdirLegacy(dataDir);
    await writeFile(join(dataDir, 'config.json'), '{"port": 4393}\n');
    lease = await resolveDataDirectory({
      dataDir,
      legacyDir: join(root, 'missing', '.phantom'),
      probeLegacy: false,
    });
    assert.equal(lease.migrated, false);
    assert.equal(
      JSON.parse(await readFile(join(dataDir, 'migration.json'), 'utf8')).status,
      'complete',
    );
    await assert.rejects(
      () =>
        resolveDataDirectory({
          dataDir,
          legacyDir: join(root, 'missing', '.phantom'),
          probeLegacy: false,
        }),
      /已被另一 Phantom Circuit 实例占用/,
    );
  } finally {
    await lease?.release();
    await cleanup(root);
  }
});

test('failed migration leaves the source untouched and a blocked staging marker for recovery', async () => {
  const f = await fixture();
  const attachment = join(f.legacy, 'messages', f.project.id, f.message.id, 'attachment-one.png');
  await rm(attachment);
  try {
    const error = await resolveDataDirectory({
      legacyDir: f.legacy,
      dataDir: f.dataDir,
      probeLegacy: false,
    }).catch((reason) => reason);
    const message = String(error);
    assert.match(message, /迁移 staging 已保留/);
    const stage = message.match(/迁移 staging 已保留：(.+)$/)?.[1];
    assert.ok(stage);
    assert.equal(
      JSON.parse(await readFile(join(stage!, 'migration.json'), 'utf8')).status,
      'blocked',
    );
    await assert.rejects(() => readFile(f.dataDir));
    assert.equal(
      await readFile(join(f.legacy, 'config.json'), 'utf8'),
      '{"port": 4391, "fixture": true}\n',
    );
  } finally {
    await cleanup(f.root);
  }
});

test('an active legacy instance blocks migration before SQLite is opened', async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.legacy, '.instance.lock'),
      JSON.stringify({ pid: process.pid, role: 'legacy-test' }),
    );
    await assert.rejects(
      () => resolveDataDirectory({ legacyDir: f.legacy, dataDir: f.dataDir, probeLegacy: false }),
      /旧版数据目录的锁状态无法确认|另一 Phantom Circuit/,
    );
    await assert.rejects(() => readFile(f.dataDir));
  } finally {
    await cleanup(f.root);
  }
});

test('registered worktrees stay at the legacy root until native reconciliation and unregistered directories do not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-data-worktree-'));
  const legacy = join(root, 'checkout', '.phantom');
  const dataDir = join(root, 'home', '.phantom');
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  let lease: Awaited<ReturnType<typeof resolveDataDirectory>> | undefined;
  let store: Store | undefined;
  let migrated: Store | undefined;
  try {
    await mkdirLegacy(legacy);
    await command('git', ['init', '--bare', remote]);
    await command('git', ['init', '-b', 'main', source]);
    await command('git', ['config', 'user.name', 'Phantom Test'], source);
    await command('git', ['config', 'user.email', 'test@example.invalid'], source);
    await writeFile(join(source, 'README.md'), 'fixture\n');
    await command('git', ['add', '.'], source);
    await command('git', ['commit', '-m', 'fixture'], source);
    await command('git', ['remote', 'add', 'origin', remote], source);
    await command('git', ['push', '-u', 'origin', 'main'], source);
    store = new Store(join(legacy, 'phantom.sqlite'));
    const project = store.createProject('Git', '');
    const repo = store.createRepo({
      projectId: project.id,
      name: 'source',
      path: source,
      github: 'fixture/source',
      defaultBranch: 'main',
      authorized: false,
    });
    const message = store.addMessage(project.id, 'user', 'task', 'implement');
    const task = store.createTask({
      projectId: project.id,
      repoId: repo.id,
      sourceMessageId: message.id,
      title: 'Fixture task',
      spec: 'Keep fixture',
      acceptance: ['clean'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    const workspaces = new Workspaces(join(legacy, 'workspaces'), store);
    const prepared = await workspaces.prepare(task);
    await writeFile(join(prepared.worktree!, 'README.md'), 'dirty\n');
    store.updateTask(task.id, { control: 'paused' });
    store.run('pm', project.id, 'pm');
    await writeFile(join(legacy, 'workspaces', repo.id, 'debug-unregistered.txt'), 'ignore');
    store.close();
    store = undefined;
    lease = await resolveDataDirectory({ legacyDir: legacy, dataDir, probeLegacy: false });
    migrated = new Store(join(dataDir, 'phantom.sqlite'));
    const migratedTask = migrated.task(task.id);
    assert.equal(lease.workspaceRoot, join(dataDir, 'workspaces'));
    assert.equal(lease.legacyWorkspaceRoot, join(legacy, 'workspaces'));
    assert.equal(lease.taskRoots[task.id], join(legacy, 'workspaces'));
    assert.equal(migratedTask.worktree, join(legacy, 'workspaces', repo.id, `task-${task.id}`));
    assert.equal(
      (await readFile(join(migratedTask.worktree!, 'README.md'), 'utf8')).replaceAll('\r\n', '\n'),
      'dirty\n',
    );
    assert.match(
      (await command('git', ['status', '--porcelain'], migratedTask.worktree)).stdout,
      /README\.md/,
    );
    const worktreeList = await command(
      'git',
      ['worktree', 'list', '--porcelain'],
      join(legacy, 'workspaces', repo.id, 'mirror.git'),
    );
    assert.match(worktreeList.stdout, /task-/);
    const mappedWorkspaces = new Workspaces(lease.workspaceRoot, migrated, {
      legacyRoots: [lease.legacyWorkspaceRoot!],
      taskRoots: lease.taskRoots,
    });
    await mappedWorkspaces.assertTask(migratedTask);
    const newMessage = migrated.addMessage(project.id, 'user', 'new task', 'implement');
    const newTask = migrated.createTask({
      projectId: project.id,
      repoId: repo.id,
      sourceMessageId: newMessage.id,
      title: 'New home task',
      spec: 'Use the new managed root',
      acceptance: ['home'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    const preparedNew = await mappedWorkspaces.prepare(newTask);
    assert.equal(preparedNew.worktree, join(dataDir, 'workspaces', repo.id, `task-${newTask.id}`));
    assert.equal(lease.preservedWorkspaces.length, 1);
    assert.equal(lease.preservedWorkspaces[0].validatedTaskIds, undefined);
    await assert.rejects(() =>
      readFile(join(dataDir, 'workspaces', repo.id, 'debug-unregistered.txt')),
    );
  } finally {
    store?.close();
    migrated?.close();
    await lease?.release();
    await cleanup(root);
  }
});

test('source authority drift during copy keeps staging blocked and never commits the target', async () => {
  const f = await fixture();
  try {
    const error = await resolveDataDirectory({
      legacyDir: f.legacy,
      dataDir: f.dataDir,
      probeLegacy: false,
      afterSourceSnapshot: async () => {
        await writeFile(join(f.legacy, 'config.json'), '{"port": 4399, "fixture": true}\n');
      },
    }).catch((reason) => reason);
    assert.match(String(error), /迁移期间发生变化|staging 与源快照不一致/);
    const stage = String(error).match(/迁移 staging 已保留：(.+)$/)?.[1];
    assert.ok(stage);
    assert.equal(
      JSON.parse(await readFile(join(stage!, 'migration.json'), 'utf8')).status,
      'blocked',
    );
    await assert.rejects(() => readFile(join(f.dataDir, 'migration.json')));
    assert.equal(
      await readFile(join(f.legacy, 'config.json'), 'utf8'),
      '{"port": 4399, "fixture": true}\n',
    );
  } finally {
    await cleanup(f.root);
  }
});

test(
  'a Windows junction alias is rejected before migration lock or target writes',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'phantom-data-junction-'));
    const legacy = join(root, 'checkout', '.phantom');
    const dataDir = join(root, 'home', '.phantom');
    try {
      await mkdirLegacy(legacy);
      await writeFile(join(legacy, 'config.json'), '{"port": 4391}\n');
      await mkdir(join(root, 'home'), { recursive: true });
      await symlink(legacy, dataDir, 'junction');
      await assert.rejects(
        () => resolveDataDirectory({ legacyDir: legacy, dataDir, probeLegacy: false }),
        /符号链接|重解析|物理路径相同/,
      );
      assert.equal(
        (await readdir(join(root, 'home'))).filter((name) => name.includes('migration.lock'))
          .length,
        0,
      );
    } finally {
      await unlink(dataDir).catch(() => {});
      await cleanup(root);
    }
  },
);

test('an existing target with the same source is adopted with source metadata and a verified rollback DB', async () => {
  const f = await fixture();
  let lease: Awaited<ReturnType<typeof resolveDataDirectory>> | undefined;
  try {
    lease = await resolveDataDirectory({
      legacyDir: f.legacy,
      dataDir: f.dataDir,
      probeLegacy: false,
    });
    await lease.release();
    lease = undefined;
    await rm(join(f.dataDir, 'migration.json'));
    lease = await resolveDataDirectory({
      legacyDir: f.legacy,
      dataDir: f.dataDir,
      probeLegacy: false,
    });
    assert.equal(lease.migrated, false);
    assert.ok(lease.migration.sourceFingerprint);
    assert.ok(lease.migration.sourceSignature?.files.length);
    const databaseBackup = lease.migration.rollback?.databaseBackup;
    assert.ok(databaseBackup);
    const rollbackDb = new DatabaseSync(join(f.dataDir, databaseBackup!), { readOnly: true });
    try {
      const row = rollbackDb.prepare('SELECT count(*) AS count FROM documents').get() as {
        count: number;
      };
      assert.equal(row.count > 0, true);
    } finally {
      rollbackDb.close();
    }
  } finally {
    await lease?.release();
    await cleanup(f.root);
  }
});

test('a completed marker follows its recorded source when the checkout moves', async () => {
  const f = await fixture();
  let lease: Awaited<ReturnType<typeof resolveDataDirectory>> | undefined;
  try {
    lease = await resolveDataDirectory({
      legacyDir: f.legacy,
      dataDir: f.dataDir,
      probeLegacy: false,
    });
    await lease.release();
    lease = undefined;
    lease = await resolveDataDirectory({
      legacyDir: join(f.root, 'moved-checkout', '.phantom'),
      dataDir: f.dataDir,
      probeLegacy: false,
    });
    assert.equal(lease.migration.status, 'complete');
  } finally {
    await lease?.release();
    await cleanup(f.root);
  }
});

test('a stale diagnostic marker is reclaimed only after coordinator ownership is acquired', async () => {
  const f = await fixture();
  let lease: Awaited<ReturnType<typeof resolveDataDirectory>> | undefined;
  try {
    const lockPath = join(f.legacy, '.instance.lock');
    await writeFile(lockPath, JSON.stringify({ pid: 2147483647, token: 'stale', role: 'test' }));
    lease = await resolveDataDirectory({
      legacyDir: f.legacy,
      dataDir: f.dataDir,
      probeLegacy: false,
    });
    assert.equal(lease.migrated, true);
    await assert.rejects(() => readFile(lockPath));
  } finally {
    await lease?.release();
    await cleanup(f.root);
  }
});

test('a second process cannot acquire the target lease while the first process owns it', async () => {
  const f = await fixture();
  const script = `
    import { resolveDataDirectory } from './src/server/data-directory.ts';
    const lease = await resolveDataDirectory({ legacyDir: process.argv[1], dataDir: process.argv[2], probeLegacy: false });
    process.stdout.write('READY\\n');
    process.stdin.resume();
    process.stdin.once('data', async () => { await lease.release(); process.exit(0); });
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx/esm', '-e', script, f.legacy, f.dataDir],
    {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let errorOutput = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(
        () => rejectReady(new Error(`child lock timeout: ${errorOutput}`)),
        15000,
      );
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.includes('READY')) {
          clearTimeout(timer);
          resolveReady();
        }
      });
      child.stderr.on('data', (chunk: string) => (errorOutput += chunk));
      child.once('error', (error) => {
        clearTimeout(timer);
        rejectReady(error);
      });
      child.once('exit', (code) => {
        if (code !== 0) {
          clearTimeout(timer);
          rejectReady(new Error(`child exited ${code}: ${errorOutput}`));
        }
      });
    });
    await assert.rejects(
      () => resolveDataDirectory({ legacyDir: f.legacy, dataDir: f.dataDir, probeLegacy: false }),
      /另一 Phantom Circuit 实例占用/,
    );
    child.stdin.write('\n');
    await new Promise<void>((resolveExit, rejectExit) => {
      child.once('exit', (code) =>
        code === 0 ? resolveExit() : rejectExit(new Error(`child exited ${code}`)),
      );
    });
  } finally {
    if (!child.killed && child.exitCode === null) child.kill();
    await cleanup(f.root);
  }
});

test('a killed holder releases the SQLite coordinator and the next process recovers the target', async () => {
  const f = await fixture();
  const script = `
    import { resolveDataDirectory } from './src/server/data-directory.ts';
    await resolveDataDirectory({ legacyDir: process.argv[1], dataDir: process.argv[2], probeLegacy: false });
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx/esm', '-e', script, f.legacy, f.dataDir],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let output = '';
  let errorOutput = '';
  let lease: Awaited<ReturnType<typeof resolveDataDirectory>> | undefined;
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(
        () => rejectReady(new Error(`child coordinator timeout: ${errorOutput}`)),
        15000,
      );
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.includes('READY')) {
          clearTimeout(timer);
          resolveReady();
        }
      });
      child.stderr.on('data', (chunk: string) => (errorOutput += chunk));
      child.once('error', (error) => {
        clearTimeout(timer);
        rejectReady(error);
      });
      child.once('exit', (code) => {
        if (code !== 0) {
          clearTimeout(timer);
          rejectReady(new Error(`child exited ${code}: ${errorOutput}`));
        }
      });
    });
    child.kill();
    await new Promise<void>((resolveExit, rejectExit) => {
      child.once('exit', (code, signal) => {
        if (code === 0 || signal) resolveExit();
        else rejectExit(new Error(`child exited ${code}`));
      });
    });
    lease = await resolveDataDirectory({
      legacyDir: f.legacy,
      dataDir: f.dataDir,
      probeLegacy: false,
    });
    assert.equal(lease.migration.status, 'complete');
  } finally {
    if (!child.killed && child.exitCode === null) child.kill();
    await lease?.release();
    await cleanup(f.root);
  }
});

test('an old lease release never deletes a replacement diagnostic marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-data-release-race-'));
  const dataDir = join(root, 'home', '.phantom');
  const legacyDir = join(root, 'missing', '.phantom');
  let lease: Awaited<ReturnType<typeof resolveDataDirectory>> | undefined;
  try {
    lease = await resolveDataDirectory({ dataDir, legacyDir, probeLegacy: false });
    const lockPath = join(dataDir, '.instance.lock');
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 2147483647, token: 'replacement', role: 'new' }),
    );
    await lease.release();
    lease = undefined;
    assert.match(await readFile(lockPath, 'utf8'), /replacement/);
  } finally {
    await lease?.release();
    await cleanup(root);
  }
});
