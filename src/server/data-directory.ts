import { createHash, randomUUID } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { command } from './process.ts';

/**
 * The host used to keep its data beside the checkout.  New hosts keep it in the
 * user's home directory, but these names stay deliberately explicit so tests and
 * recovery tooling can use temporary roots without touching the real home.
 */
export const DATA_DIRECTORY_NAME = '.phantom';
export const CONFIG_FILE_NAME = 'config.json';
export const DATABASE_FILE_NAME = 'phantom.sqlite';
export const MIGRATION_MARKER_NAME = 'migration.json';
export const INSTANCE_LOCK_NAME = '.instance.lock';
export const MIGRATION_LOCK_NAME = '.migration.lock';

type MigrationStatus = 'started' | 'blocked' | 'complete';

export interface MigrationMarker {
  version: 1;
  status: MigrationStatus;
  sourceDir?: string;
  targetDir: string;
  stageDir?: string;
  sourceFingerprint?: string;
  sourceSignature?: SourceSignature;
  workspaceRoot?: string;
  legacyWorkspaceRoot?: string;
  preservedWorkspaces?: PreservedWorkspace[];
  taskRoots?: Readonly<Record<string, string>>;
  startedAt: string;
  completedAt?: string;
  reason?: string;
  rollback?: {
    sourceDir: string;
    sourceFingerprint?: string;
    sourcePreserved: true;
    copied: string[];
    databaseBackup?: string;
  };
}

export interface PreservedWorkspace {
  repoId: string;
  taskIds: string[];
  sourceRoot: string;
  reason: string;
  validatedTaskIds?: string[];
}

export interface SourceSignature {
  files: { path: string; size: number; mtimeMs: number; ctimeMs: number }[];
}

export interface DataDirectoryOptions {
  /** Current checkout used by the legacy resolver. Defaults to process.cwd(). */
  cwd?: string;
  /** User home used by the new resolver. Defaults to os.homedir(). */
  homeDir?: string;
  /** Explicit legacy directory, primarily for tests and recovery tools. */
  legacyDir?: string;
  /** Explicit new directory, primarily for tests and recovery tools. */
  dataDir?: string;
  /** Injectable clock used for deterministic markers. */
  now?: () => string;
  /** Disable the localhost probe only for a test that cannot bind a socket. */
  probeLegacy?: boolean;
  /** Test seam: mutate an external source after its snapshot/copy to prove drift stops migration. */
  afterSourceSnapshot?: () => Promise<void>;
}

export interface DataDirectoryLease {
  /** The directory that must be passed to Store, Workspaces and Engine. */
  dataDir: string;
  /** Managed workspace root for new work, always under the home data directory. */
  workspaceRoot: string;
  /** Legacy workspace root retained for reconciliation when refs cannot move safely. */
  legacyWorkspaceRoot?: string;
  preservedWorkspaces: PreservedWorkspace[];
  /** Task-id to legacy root mapping used to keep preserved worktrees addressable. */
  taskRoots: Readonly<Record<string, string>>;
  migrated: boolean;
  migration: MigrationMarker;
  /** Releases the single-instance ownership lock. Idempotent. */
  release(): Promise<void>;
}

type JsonDocument = { kind: string; id: string; body: string };
type ProviderDocument = { id: string; hasKey?: boolean; kind?: string };
type ProjectDocument = { id: string };
type MessageDocument = {
  id: string;
  projectId: string;
  attachments?: { id: string; mediaType: string }[];
};
type RepoDocument = { id: string; projectId: string; preview?: { status?: string } };
type TaskDocument = {
  id: string;
  projectId: string;
  repoId: string;
  worktree?: string;
  branch?: string;
  head?: string;
};

interface References {
  projects: ProjectDocument[];
  providers: ProviderDocument[];
  messages: MessageDocument[];
  repos: RepoDocument[];
  tasks: TaskDocument[];
}

interface DirectoryState {
  exists: boolean;
  authoritative: boolean;
  unknownEntries: string[];
  marker?: MigrationMarker;
}

interface HeldLock {
  path: string;
  token: string;
  release(): Promise<void>;
}

const attachmentExtensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
};
const knownKinds = new Set([
  'activity',
  'provider',
  'project',
  'repo',
  'task',
  'run',
  'message',
  'operation',
  'settings',
  'document',
]);
const ignoredDirectoryEntries = new Set([
  INSTANCE_LOCK_NAME,
  MIGRATION_LOCK_NAME,
  MIGRATION_MARKER_NAME,
]);
const COORDINATOR_SUFFIX = '.coordinator.sqlite';
const safePathSegment = /^[a-zA-Z0-9-]+$/;

function isIgnoredDirectoryEntry(name: string) {
  return (
    ignoredDirectoryEntries.has(name) ||
    name.endsWith(COORDINATOR_SUFFIX) ||
    name.endsWith(`${COORDINATOR_SUFFIX}-wal`) ||
    name.endsWith(`${COORDINATOR_SUFFIX}-shm`) ||
    name.endsWith(`${COORDINATOR_SUFFIX}-journal`)
  );
}

function timestamp(now: () => string) {
  return now();
}

function samePath(a: string, b: string) {
  const left = resolve(a).replace(/[\\/]$/, '');
  const right = resolve(b).replace(/[\\/]$/, '');
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

interface PhysicalPath {
  lexical: string;
  canonical: string;
}

/**
 * Resolve all existing path components before touching either data root.  A junction is a
 * reparse point on Windows and is reported by lstat as a symbolic link.  Treating it as unsafe
 * is intentional: a lexical `target` can otherwise be an alias of the preserved source.
 */
async function physicalPath(path: string): Promise<PhysicalPath> {
  const lexical = resolve(path);
  let existing = lexical;
  const missing: string[] = [];
  while (true) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) break;
      missing.unshift(relative(parent, existing));
      existing = parent;
    }
  }

  const components: string[] = [];
  let cursor = existing;
  while (true) {
    components.unshift(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const component of components) {
    const info = await lstat(component);
    if (info.isSymbolicLink())
      throw new Error(`数据目录路径包含符号链接或 Windows 重解析点，拒绝继续：${component}`);
  }

  const canonicalExisting = await realpath(existing);
  return {
    lexical,
    canonical: missing.reduce((value, part) => join(value, part), canonicalExisting),
  };
}

async function assertSafeDataRoots(source: string, target: string) {
  const [sourcePath, targetPath] = await Promise.all([physicalPath(source), physicalPath(target)]);
  if (!samePath(source, target) && samePath(sourcePath.canonical, targetPath.canonical))
    throw new Error(`旧版与新版数据目录物理路径相同，拒绝继续：${source} -> ${target}`);
}

function pathWithin(root: string, candidate: string) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readStats(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readMarker(path: string): Promise<MigrationMarker | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as MigrationMarker;
    if (
      value?.version !== 1 ||
      !['started', 'blocked', 'complete'].includes(value.status) ||
      typeof value.targetDir !== 'string'
    )
      throw new Error('迁移 marker 格式未知');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function durableJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function processIsAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

interface LockRecord {
  pid?: number;
  token?: string;
  known: boolean;
}

async function lockPid(path: string): Promise<LockRecord> {
  try {
    const text = await readFile(path, 'utf8');
    try {
      const value = JSON.parse(text) as { pid?: unknown; token?: unknown };
      return {
        pid: typeof value.pid === 'number' ? value.pid : undefined,
        token: typeof value.token === 'string' ? value.token : undefined,
        // Tokens were added after the original marker format.  A legacy marker with a valid PID
        // is still actionable for crash recovery; an absent PID remains explicitly unknown.
        known: typeof value.pid === 'number',
      };
    } catch {
      return { known: false };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { known: true };
    throw error;
  }
}

function coordinatorPath(path: string) {
  return `${path}${COORDINATOR_SUFFIX}`;
}

function sqliteBusy(error: unknown) {
  return /(?:SQLITE_BUSY|database is locked|database table is locked)/i.test(String(error));
}

async function acquireCoordinator(path: string, role: string) {
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(coordinatorPath(path), { timeout: 250 });
  try {
    // Keep this transaction open for the entire lease.  SQLite releases the OS-level file lock
    // when a crashed process loses the DatabaseSync handle, so stale PID markers never need an
    // unsafe unlink race.
    db.exec('BEGIN EXCLUSIVE');
    return db;
  } catch (error) {
    db.close();
    if (sqliteBusy(error)) throw new Error(`${role} 已被另一 Phantom Circuit 实例占用：${path}`);
    throw error;
  }
}

function closeCoordinator(db: DatabaseSync) {
  try {
    db.exec('ROLLBACK');
  } catch {
    // The transaction may already have been rolled back by SQLite during shutdown.
  }
  try {
    db.close();
  } catch {
    // The OS still owns the descriptor; there is no safe marker unlink to attempt here.
  }
}

async function writeDiagnosticLock(path: string, role: string, token: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await exists(path)) {
      const current = await lockPid(path);
      if (!current.known || current.pid === undefined)
        throw new Error(`${role} 已被另一 Phantom Circuit 实例占用：${path}`);
      if (processIsAlive(current.pid))
        throw new Error(`${role} 已被另一 Phantom Circuit 实例占用：${path}`);
      // The coordinator transaction is held by this caller.  Only now is retiring a dead
      // diagnostic marker safe; no other new host can have acquired the same coordinator.
      await unlink(path);
    }
    try {
      const handle = await open(path, 'wx');
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, token, role, startedAt: new Date().toISOString() }) +
            '\n',
          'utf8',
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === 1) throw error;
      // A non-cooperating legacy process may have written the marker between our read and open.
      // Re-read it under the still-held coordinator before deciding whether it is safe to retire.
    }
  }
}

async function acquireLock(path: string, role: string): Promise<HeldLock> {
  const coordinator = await acquireCoordinator(path, role);
  const token = randomUUID();
  try {
    await writeDiagnosticLock(path, role, token);
  } catch (error) {
    closeCoordinator(coordinator);
    throw error;
  }
  let released = false;
  return {
    path,
    token,
    async release() {
      if (released) return;
      released = true;
      try {
        const current = await lockPid(path);
        if (current.token === token) await unlink(path).catch(() => {});
      } catch {
        // The coordinator must still be released if diagnostic metadata was damaged.
      } finally {
        closeCoordinator(coordinator);
      }
    },
  };
}

async function assertLegacyLockInactive(directory: string, ownToken?: string) {
  for (const name of [INSTANCE_LOCK_NAME, MIGRATION_LOCK_NAME]) {
    const path = join(directory, name);
    if (!(await exists(path))) continue;
    const current = await lockPid(path);
    if (name === INSTANCE_LOCK_NAME && current.token === ownToken) continue;
    const probe = await acquireLock(path, `旧版数据目录 ${name}`);
    await probe.release();
  }
}

async function readConfig(path: string) {
  try {
    const raw = await readFile(path, 'utf8');
    const value = JSON.parse(raw) as { port?: unknown };
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.port !== 'number' ||
      !Number.isInteger(value.port) ||
      value.port < 1024 ||
      value.port > 65535
    )
      throw new Error(`配置无效：${path}`);
    return { raw, value };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new Error(`配置不是有效 JSON：${path}`);
    throw error;
  }
}

async function assertLegacyInactive(directory: string, probe: boolean, ownToken?: string) {
  if (!(await exists(directory))) return;
  await assertLegacyLockInactive(directory, ownToken);
  if (!probe) return;
  const config = await readConfig(join(directory, CONFIG_FILE_NAME));
  if (!config) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 350);
  try {
    const response = await fetch(`http://127.0.0.1:${config.value.port}/api/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    throw new Error(`旧版 Phantom Circuit 仍在端口 ${config.value.port} 运行`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('旧版 Phantom Circuit')) throw error;
    // Connection refused/aborted is the expected inactive result.  A response was handled above.
    const code =
      (error as NodeJS.ErrnoException).code ??
      ((error as { cause?: NodeJS.ErrnoException }).cause?.code as string | undefined);
    if (code && !['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(code))
      throw new Error(`无法确认旧版 Phantom Circuit 是否停止：${String(error)}`);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function acquireLegacyLock(directory: string, probe: boolean): Promise<HeldLock> {
  const ownership = await acquireLock(join(directory, INSTANCE_LOCK_NAME), '旧版数据目录');
  try {
    await assertLegacyInactive(directory, probe, ownership.token);
    return ownership;
  } catch (error) {
    await ownership.release().catch(() => {});
    throw error;
  }
}

async function listEntries(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function directoryState(path: string): Promise<DirectoryState> {
  const info = await readStats(path);
  if (!info) return { exists: false, authoritative: false, unknownEntries: [] };
  if (!info.isDirectory()) throw new Error(`数据目录路径不是目录：${path}`);
  const entries = await listEntries(path);
  const unknownEntries = entries
    .filter((entry) => !isIgnoredDirectoryEntry(entry.name))
    .map((entry) => entry.name);
  const authoritative = unknownEntries.length > 0;
  return {
    exists: true,
    authoritative,
    unknownEntries,
    marker: await readMarker(join(path, MIGRATION_MARKER_NAME)),
  };
}

async function loadReferences(path: string): Promise<References> {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    const rows = db
      .prepare('SELECT kind,id,body FROM documents ORDER BY rowid')
      .all() as JsonDocument[];
    for (const row of rows) {
      if (!knownKinds.has(row.kind)) throw new Error(`数据库包含未知实体类型：${row.kind}`);
      if (typeof row.id !== 'string' || typeof row.body !== 'string')
        throw new Error('数据库实体格式未知');
      try {
        JSON.parse(row.body);
      } catch {
        throw new Error(`数据库实体 JSON 无法解析：${row.kind}/${row.id}`);
      }
    }
    const byKind = (kind: string) =>
      rows.filter((row) => row.kind === kind).map((row) => JSON.parse(row.body) as never);
    return {
      projects: byKind('project') as ProjectDocument[],
      providers: byKind('provider') as ProviderDocument[],
      messages: byKind('message') as MessageDocument[],
      repos: byKind('repo') as RepoDocument[],
      tasks: byKind('task') as TaskDocument[],
    };
  } finally {
    db.close();
  }
}

async function canonicalDatabase(path: string, temporaryRoot: string) {
  const output = join(temporaryRoot, `${randomUUID()}.sqlite`);
  const source = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    await backup(source, output);
  } finally {
    source.close();
  }
  try {
    const db = new DatabaseSync(output, { readOnly: true, timeout: 5000 });
    try {
      const rows = db.prepare('SELECT kind,id,body FROM documents ORDER BY kind,id').all();
      return JSON.stringify(rows);
    } finally {
      db.close();
    }
  } finally {
    await Promise.all([
      unlink(output).catch(() => {}),
      unlink(`${output}-wal`).catch(() => {}),
      unlink(`${output}-shm`).catch(() => {}),
    ]);
  }
}

async function hashFile(path: string) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

async function hashTree(path: string): Promise<[string, string][]> {
  const info = await readStats(path);
  if (!info) return [];
  if (!info.isDirectory()) return [[path, await hashFile(path)]];
  const output: [string, string][] = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`迁移拒绝符号链接：${child}`);
    output.push(...(await hashTree(child)));
  }
  return output;
}

async function referencedFiles(directory: string, refs: References) {
  const paths: string[] = [];
  const add = (path: string) => {
    if (!pathWithin(directory, path)) throw new Error(`引用路径超出数据目录：${path}`);
    paths.push(path);
  };
  const config = join(directory, CONFIG_FILE_NAME);
  if (await exists(config)) add(config);
  const dbPath = join(directory, DATABASE_FILE_NAME);
  if (await exists(dbPath)) add(dbPath);
  for (const project of refs.projects) {
    if (typeof project.id !== 'string' || !safePathSegment.test(project.id))
      throw new Error(`项目 ID 无效：${project.id}`);
    const projectDir = join(directory, 'projects', project.id);
    if (await exists(projectDir)) add(projectDir);
  }
  for (const provider of refs.providers) {
    if (provider.kind === 'custom' || provider.hasKey) {
      if (typeof provider.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(provider.id))
        throw new Error(`Provider ID 无效：${provider.id}`);
      const secret = join(directory, 'secrets', provider.id);
      if (!(await exists(secret)))
        throw new Error(`数据库引用的 Provider 密钥缺失：${provider.id}`);
      add(secret);
    }
  }
  for (const message of refs.messages) {
    if (
      typeof message.id !== 'string' ||
      typeof message.projectId !== 'string' ||
      !safePathSegment.test(message.id) ||
      !safePathSegment.test(message.projectId)
    )
      throw new Error('消息引用无效');
    for (const attachment of message.attachments ?? []) {
      const extension = attachmentExtensions[attachment.mediaType];
      if (!extension || !safePathSegment.test(attachment.id))
        throw new Error(`消息附件引用无效：${message.id}/${attachment.id}`);
      const path = join(
        directory,
        'messages',
        message.projectId,
        message.id,
        `${attachment.id}.${extension}`,
      );
      if (!(await exists(path))) throw new Error(`数据库引用的消息附件缺失：${path}`);
      add(path);
    }
  }
  return paths;
}

async function fingerprint(directory: string, temporaryRoot: string) {
  const dbPath = join(directory, DATABASE_FILE_NAME);
  if (!(await exists(dbPath))) {
    const config = join(directory, CONFIG_FILE_NAME);
    if (!(await exists(config))) return undefined;
    return createHash('sha256')
      .update(await readFile(config))
      .digest('hex');
  }
  const refs = await loadReferences(dbPath);
  const files = await referencedFiles(directory, refs);
  const fileHashes: [string, string][] = [];
  for (const path of files) {
    if (path === dbPath) continue;
    const info = await readStats(path);
    if (!info) continue;
    if (info.isDirectory()) fileHashes.push(...(await hashTree(path)));
    else fileHashes.push([path, await hashFile(path)]);
  }
  const canonical = await canonicalDatabase(dbPath, temporaryRoot);
  const digest = createHash('sha256');
  digest.update(canonical);
  digest.update(
    JSON.stringify(fileHashes.map(([path, hash]) => [relative(directory, path), hash])),
  );
  return digest.digest('hex');
}

async function signatureTree(
  path: string,
  root: string,
  output: SourceSignature['files'],
): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`迁移拒绝符号链接：${path}`);
  output.push({
    path: relative(root, path),
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  });
  if (!info.isDirectory()) return;
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  ))
    await signatureTree(join(path, entry.name), root, output);
}

async function sourceSignature(directory: string): Promise<SourceSignature | undefined> {
  const dbPath = join(directory, DATABASE_FILE_NAME);
  const files: string[] = [];
  if (await exists(dbPath)) {
    const refs = await loadReferences(dbPath);
    files.push(...(await referencedFiles(directory, refs)));
    // `-shm` is reader coordination state and can be created/retimestamped by our own read-only
    // snapshot.  The WAL itself is authoritative and is included so an external writer cannot
    // slip a transaction through with an unchanged main-db stat.
    if (await exists(`${dbPath}-wal`)) files.push(`${dbPath}-wal`);
  } else if (await exists(join(directory, CONFIG_FILE_NAME)))
    files.push(join(directory, CONFIG_FILE_NAME));
  if (!files.length) return undefined;
  const output: SourceSignature['files'] = [];
  for (const path of [...new Set(files)]) await signatureTree(path, directory, output);
  output.sort((a, b) => a.path.localeCompare(b.path));
  return { files: output };
}

function signaturesEqual(left: SourceSignature | undefined, right: SourceSignature | undefined) {
  return JSON.stringify(left ?? undefined) === JSON.stringify(right ?? undefined);
}

interface AuthoritySnapshot {
  fingerprint?: string;
  signature?: SourceSignature;
}

async function authoritySnapshot(
  directory: string,
  temporaryRoot: string,
): Promise<AuthoritySnapshot> {
  return {
    fingerprint: await fingerprint(directory, temporaryRoot),
    signature: await sourceSignature(directory),
  };
}

function authoritySnapshotsEqual(left: AuthoritySnapshot, right: AuthoritySnapshot) {
  return left.fingerprint === right.fingerprint && signaturesEqual(left.signature, right.signature);
}

async function copyOne(source: string, destination: string) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`迁移拒绝符号链接：${source}`);
  if (info.isDirectory()) await assertNoSymlinks(source);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: info.isDirectory(),
    force: false,
    errorOnExist: true,
  });
  if (!info.isDirectory()) await chmod(destination, 0o600).catch(() => {});
}

async function verifyDatabase(path: string) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    db.prepare('SELECT kind,id,body FROM documents ORDER BY rowid').all();
  } finally {
    db.close();
  }
}

async function copyVerifiedDatabaseSnapshot(sourceSnapshot: string, destination: string) {
  try {
    await copyOne(sourceSnapshot, destination);
    await verifyDatabase(destination);
    const [sourceCanonical, destinationCanonical] = await Promise.all([
      canonicalDatabase(sourceSnapshot, dirname(destination)),
      canonicalDatabase(destination, dirname(destination)),
    ]);
    if (sourceCanonical !== destinationCanonical)
      throw new Error(`SQLite rollback 备份与在线快照不一致：${destination}`);
  } finally {
    await removeSQLiteSidecars(destination);
  }
}

/** Take one online SQLite snapshot, then use that immutable file for all rollback copies. */
async function snapshotDatabase(source: string, destination: string) {
  await mkdir(dirname(destination), { recursive: true });
  const snapshot = join(dirname(destination), `.sqlite-snapshot-${randomUUID()}.sqlite`);
  const db = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
  try {
    await backup(db, snapshot);
  } finally {
    db.close();
  }
  try {
    await verifyDatabase(snapshot);
    await copyVerifiedDatabaseSnapshot(snapshot, destination);
  } finally {
    await removeSQLiteSidecars(snapshot);
    await unlink(snapshot).catch(() => {});
  }
}

async function removeSQLiteSidecars(path: string) {
  await Promise.all([unlink(`${path}-wal`).catch(() => {}), unlink(`${path}-shm`).catch(() => {})]);
}

async function cleanupSQLiteArtifacts(path: string): Promise<void> {
  for (const entry of await listEntries(path)) {
    const child = join(path, entry.name);
    if (entry.name === 'backups' && entry.isDirectory()) await cleanupSQLiteArtifacts(child);
    else if (
      !entry.isDirectory() &&
      (entry.name === `${DATABASE_FILE_NAME}-wal` || entry.name === `${DATABASE_FILE_NAME}-shm`)
    )
      await unlink(child).catch(() => {});
  }
}

async function assertNoSymlinks(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`迁移拒绝符号链接：${path}`);
  if (!info.isDirectory()) return;
  for (const entry of await readdir(path, { withFileTypes: true }))
    await assertNoSymlinks(join(path, entry.name));
}

async function copyReferencedFiles(source: string, stage: string, refs: References) {
  const files = await referencedFiles(source, refs);
  const copied: string[] = [];
  for (const path of files) {
    if (path === join(source, DATABASE_FILE_NAME) || path === join(source, CONFIG_FILE_NAME))
      continue;
    const rel = relative(source, path);
    await copyOne(path, join(stage, rel));
    copied.push(rel);
  }
  return copied;
}

async function gitText(cwd: string, args: string[]) {
  const result = await command('git', args, cwd, undefined, 120000, false);
  if (result.code !== 0) throw new Error(`无法核验 Git 工作区：${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

interface WorkspacePlan {
  workspaceRoot: string;
  legacyWorkspaceRoot?: string;
  preserved: PreservedWorkspace[];
  taskRoots: Readonly<Record<string, string>>;
}

async function inspectWorkspaces(
  source: string,
  target: string,
  refs: References,
): Promise<WorkspacePlan> {
  const sourceRoot = join(source, 'workspaces');
  const defaultRoot = join(target, 'workspaces');
  if (!(await exists(sourceRoot)))
    return { workspaceRoot: defaultRoot, preserved: [], taskRoots: {} };
  const preserved: PreservedWorkspace[] = [];
  for (const repo of refs.repos) {
    if (!/^[a-zA-Z0-9-]+$/.test(repo.id)) throw new Error(`仓库 ID 无效：${repo.id}`);
    const sourceRepo = join(sourceRoot, repo.id);
    if (!(await exists(sourceRepo))) continue;
    const mirror = join(sourceRepo, 'mirror.git');
    const tasks = refs.tasks.filter((item) => item.repoId === repo.id && item.worktree);
    if (!tasks.length) continue;
    const taskIds = tasks.map((task) => task.id);
    const validatedTaskIds: string[] = [];
    const reasons: string[] = [];
    if (!(await exists(mirror))) reasons.push('mirror.git 缺失');
    else {
      try {
        if ((await gitText(mirror, ['rev-parse', '--is-bare-repository'])) !== 'true')
          reasons.push('mirror.git 不是 bare repository');
      } catch (error) {
        reasons.push(
          `mirror.git 无法核验：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    for (const task of tasks) {
      const expected = join(sourceRoot, repo.id, `task-${task.id}`);
      if (!samePath(task.worktree!, expected)) {
        reasons.push(`任务 ${task.id} 工作区引用不在旧 workspace 根`);
        continue;
      }
      if (!(await exists(task.worktree!))) {
        reasons.push(`任务 ${task.id} 工作区不存在`);
        continue;
      }
      const taskReasons: string[] = [];
      try {
        const common = resolve(
          task.worktree!,
          await gitText(task.worktree!, ['rev-parse', '--git-common-dir']),
        );
        if (!samePath(common, mirror)) taskReasons.push('Git common dir 不匹配');
        const branch = await gitText(task.worktree!, ['branch', '--show-current']);
        if (task.branch && branch !== task.branch) taskReasons.push('分支与 DB 不匹配');
        const head = await gitText(task.worktree!, ['rev-parse', 'HEAD']);
        if (task.head && task.head !== head) taskReasons.push('HEAD 与 DB 不匹配');
        if (await gitText(task.worktree!, ['status', '--porcelain=v1', '--untracked-files=all']))
          taskReasons.push('工作区存在未提交修改');
      } catch (error) {
        taskReasons.push(error instanceof Error ? error.message : String(error));
      }
      if (taskReasons.length) reasons.push(`任务 ${task.id}：${taskReasons.join('、')}`);
      else validatedTaskIds.push(task.id);
    }
    if (['running', 'starting'].includes(repo.preview?.status ?? ''))
      reasons.push('预览进程仍在活动');
    // A registered workspace remains at its original absolute root.  We do not copy the mirror or
    // edit Git's worktree metadata as ordinary files; a later reconciliation can use native Git
    // worktree move/repair once the exact process, branch and HEAD state are user-confirmed.
    preserved.push({
      repoId: repo.id,
      taskIds,
      sourceRoot,
      reason: reasons.length
        ? reasons.join('；')
        : '保留旧 workspace 根，等待宿主使用 native git worktree move/repair 协调',
      ...(validatedTaskIds.length ? { validatedTaskIds } : {}),
    });
  }
  const taskRoots = Object.fromEntries(
    preserved.flatMap((workspace) => workspace.taskIds.map((taskId) => [taskId, sourceRoot])),
  );
  return {
    workspaceRoot: defaultRoot,
    ...(preserved.length ? { legacyWorkspaceRoot: sourceRoot } : {}),
    preserved,
    taskRoots,
  };
}

export async function protectPrivateDirectory(path: string) {
  if (!(await exists(path))) return;
  if (process.platform !== 'win32') {
    await secureTree(path);
    return;
  }
  const identity = await command(
    'whoami.exe',
    ['/user', '/fo', 'csv', '/nh'],
    undefined,
    undefined,
    15000,
    false,
  );
  const sid = identity.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid || identity.code !== 0) throw new Error('无法确认宿主账户 SID');
  const acl = await command(
    'icacls.exe',
    [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/T', '/C'],
    undefined,
    undefined,
    15000,
    false,
  );
  if (acl.code !== 0) throw new Error('无法限制秘密与会话目录 ACL');
  const files = await command(
    'icacls.exe',
    [path, '/grant:r', `*${sid}:F`, '/T', '/C'],
    undefined,
    undefined,
    15000,
    false,
  );
  if (files.code !== 0) throw new Error('无法为秘密与会话文件设置 ACL');
  const literal = path.replaceAll("'", "''");
  const verified = await command(
    'pwsh.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$a = Get-Acl -LiteralPath '${literal}'; if (-not $a.AreAccessRulesProtected) { exit 1 }; $rules = $a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]); foreach ($r in $rules) { if ($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -ne '${sid}') { exit 1 } }; if (-not ($rules | Where-Object { $_.IdentityReference.Value -eq '${sid}' -and $_.AccessControlType -eq 'Allow' })) { exit 1 }`,
    ],
    undefined,
    undefined,
    15000,
    false,
  );
  if (verified.code !== 0) throw new Error('秘密与会话目录 ACL 校验失败');
}

async function secureTree(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`迁移拒绝秘密目录中的符号链接：${path}`);
  if (info.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path, { withFileTypes: true }))
      await secureTree(join(path, entry.name));
  } else await chmod(path, 0o600);
}

async function migrateLegacy(
  source: string,
  target: string,
  now: () => string,
  afterSourceSnapshot?: () => Promise<void>,
) {
  const stage = `${target}.migration-${randomUUID()}`;
  await mkdir(stage, { recursive: true });
  const started: MigrationMarker = {
    version: 1,
    status: 'started',
    sourceDir: source,
    targetDir: target,
    stageDir: stage,
    startedAt: timestamp(now),
  };
  await durableJson(join(stage, MIGRATION_MARKER_NAME), started);
  let sourceBefore: AuthoritySnapshot | undefined;
  try {
    sourceBefore = await authoritySnapshot(source, dirname(stage));
    const config = await readConfig(join(source, CONFIG_FILE_NAME));
    if (config) await writeFile(join(stage, CONFIG_FILE_NAME), config.raw, { flag: 'wx' });
    const sourceDb = join(source, DATABASE_FILE_NAME);
    const targetDb = join(stage, DATABASE_FILE_NAME);
    if (await exists(sourceDb)) {
      const backupName = `legacy-${randomUUID()}.sqlite`;
      const backupPath = join(stage, 'backups', backupName);
      // One online SQLite backup becomes the immutable application snapshot.  Rollback evidence
      // is copied from that snapshot, never produced by a second source backup or raw WAL copy.
      await snapshotDatabase(sourceDb, targetDb);
      await copyVerifiedDatabaseSnapshot(targetDb, backupPath);
      const refs = await loadReferences(targetDb);
      const copied = await copyReferencedFiles(source, stage, refs);
      const workspacePlan = await inspectWorkspaces(source, target, refs);
      await protectPrivateDirectory(join(stage, 'secrets'));
      await protectPrivateDirectory(join(stage, 'projects'));
      await protectPrivateDirectory(join(stage, 'agents'));
      await afterSourceSnapshot?.();
      const sourceAfter = await authoritySnapshot(source, dirname(stage));
      const stageFingerprint = await fingerprint(stage, dirname(stage));
      if (
        !authoritySnapshotsEqual(sourceBefore, sourceAfter) ||
        stageFingerprint !== sourceBefore.fingerprint
      )
        throw new Error(
          `旧版数据在迁移期间发生变化，或 staging 与源快照不一致，已保留源目录并停止迁移（before=${sourceBefore.fingerprint ?? 'none'}, after=${sourceAfter.fingerprint ?? 'none'}, stage=${stageFingerprint ?? 'none'}, signaturesEqual=${signaturesEqual(sourceBefore.signature, sourceAfter.signature)}）`,
        );
      await cleanupSQLiteArtifacts(stage);
      const rollback = {
        sourceDir: source,
        sourceFingerprint: sourceBefore.fingerprint,
        sourcePreserved: true as const,
        copied,
        databaseBackup: join('backups', backupName),
      };
      const complete: MigrationMarker = {
        ...started,
        status: 'complete',
        completedAt: timestamp(now),
        sourceFingerprint: sourceBefore.fingerprint,
        sourceSignature: sourceBefore.signature,
        workspaceRoot: workspacePlan.workspaceRoot,
        legacyWorkspaceRoot: workspacePlan.legacyWorkspaceRoot,
        preservedWorkspaces: workspacePlan.preserved,
        taskRoots: workspacePlan.taskRoots,
        rollback,
      };
      await durableJson(join(stage, MIGRATION_MARKER_NAME), complete);
      await rename(stage, target);
      return complete;
    }
    const complete: MigrationMarker = {
      ...started,
      status: 'complete',
      completedAt: timestamp(now),
      sourceFingerprint: sourceBefore.fingerprint,
      sourceSignature: sourceBefore.signature,
      workspaceRoot: join(target, 'workspaces'),
      preservedWorkspaces: [],
      taskRoots: {},
      rollback: {
        sourceDir: source,
        sourceFingerprint: sourceBefore.fingerprint,
        sourcePreserved: true,
        copied: config ? [CONFIG_FILE_NAME] : [],
      },
    };
    await afterSourceSnapshot?.();
    const sourceAfter = await authoritySnapshot(source, dirname(stage));
    const stageFingerprint = await fingerprint(stage, dirname(stage));
    if (
      !authoritySnapshotsEqual(sourceBefore, sourceAfter) ||
      stageFingerprint !== sourceBefore.fingerprint
    )
      throw new Error(
        `旧版数据在迁移期间发生变化，或 staging 与源快照不一致，已保留源目录并停止迁移（before=${sourceBefore.fingerprint ?? 'none'}, after=${sourceAfter.fingerprint ?? 'none'}, stage=${stageFingerprint ?? 'none'}, signaturesEqual=${signaturesEqual(sourceBefore.signature, sourceAfter.signature)}）`,
      );
    await durableJson(join(stage, MIGRATION_MARKER_NAME), complete);
    await rename(stage, target);
    return complete;
  } catch (error) {
    const blocked: MigrationMarker = {
      ...started,
      status: 'blocked',
      ...(sourceBefore
        ? { sourceFingerprint: sourceBefore.fingerprint, sourceSignature: sourceBefore.signature }
        : {}),
      reason: error instanceof Error ? error.message : String(error),
    };
    await durableJson(join(stage, MIGRATION_MARKER_NAME), blocked).catch(() => {});
    throw new Error(`${blocked.reason}；迁移 staging 已保留：${stage}`);
  }
}

async function ensureMarker(target: string, source: string | undefined, now: () => string) {
  const current = await readMarker(join(target, MIGRATION_MARKER_NAME));
  if (current?.status === 'complete') return current;
  if (current)
    throw new Error(`数据目录存在未完成迁移 marker：${join(target, MIGRATION_MARKER_NAME)}`);
  const marker: MigrationMarker = {
    version: 1,
    status: 'complete',
    sourceDir: source,
    targetDir: target,
    workspaceRoot: join(target, 'workspaces'),
    preservedWorkspaces: [],
    taskRoots: {},
    startedAt: timestamp(now),
    completedAt: timestamp(now),
    rollback: source ? { sourceDir: source, sourcePreserved: true, copied: [] } : undefined,
  };
  await durableJson(join(target, MIGRATION_MARKER_NAME), marker);
  return marker;
}

function workspaceFields(marker: MigrationMarker, target: string) {
  const workspaceRoot = join(target, 'workspaces');
  const preserved = marker.preservedWorkspaces ?? [];
  const legacyWorkspaceRoot =
    marker.legacyWorkspaceRoot ??
    (marker.workspaceRoot && !samePath(marker.workspaceRoot, workspaceRoot)
      ? marker.workspaceRoot
      : undefined);
  const taskRoots =
    marker.taskRoots ??
    Object.fromEntries(
      preserved.flatMap((workspace) =>
        workspace.taskIds.map((taskId) => [taskId, workspace.sourceRoot]),
      ),
    );
  return {
    workspaceRoot,
    legacyWorkspaceRoot,
    preservedWorkspaces: preserved,
    taskRoots,
  };
}

async function recordBlockedMarker(
  target: string,
  source: string,
  reason: string,
  now: () => string,
) {
  const path = join(target, MIGRATION_MARKER_NAME);
  if (await exists(path)) return;
  await durableJson(path, {
    version: 1,
    status: 'blocked',
    sourceDir: source,
    targetDir: target,
    startedAt: timestamp(now),
    reason,
  } satisfies MigrationMarker);
}

async function verifyRecordedSource(
  target: string,
  source: string,
  marker: MigrationMarker,
  probeLegacy: boolean,
  now: () => string,
) {
  const state = await directoryState(source);
  if (!state.authoritative) return marker;
  const sourceOwnership = await acquireLegacyLock(source, probeLegacy);
  try {
    const currentSnapshot = await authoritySnapshot(source, dirname(target));
    if (signaturesEqual(marker.sourceSignature, currentSnapshot.signature)) return marker;
    if (marker.sourceFingerprint !== currentSnapshot.fingerprint) {
      const reason = `旧版数据目录在迁移完成后发生变化，拒绝继续使用新目录（recorded=${marker.sourceFingerprint ?? 'none'}, current=${currentSnapshot.fingerprint ?? 'none'}）`;
      const blocked: MigrationMarker = { ...marker, status: 'blocked', reason };
      await durableJson(join(target, MIGRATION_MARKER_NAME), blocked);
      throw new Error(reason);
    }
    const refreshed: MigrationMarker = {
      ...marker,
      sourceFingerprint: currentSnapshot.fingerprint,
      sourceSignature: currentSnapshot.signature,
    };
    await durableJson(join(target, MIGRATION_MARKER_NAME), refreshed);
    return refreshed;
  } finally {
    await sourceOwnership.release();
  }
}

async function targetHasUnknownDrift(target: string) {
  const entries = await listEntries(target);
  return entries
    .filter((entry) => !isIgnoredDirectoryEntry(entry.name))
    .map((entry) => entry.name)
    .filter(
      (name) =>
        ![
          CONFIG_FILE_NAME,
          DATABASE_FILE_NAME,
          `${DATABASE_FILE_NAME}-wal`,
          `${DATABASE_FILE_NAME}-shm`,
          'backups',
          'messages',
          'secrets',
          'projects',
          'agents',
          'workspaces',
        ].includes(name) &&
        !isIgnoredDirectoryEntry(name) &&
        !name.endsWith('-wal') &&
        !name.endsWith('-shm') &&
        !name.endsWith('-journal'),
    );
}

async function existingWorkspaceMapping(target: string, source: string) {
  const dbPath = join(target, DATABASE_FILE_NAME);
  if (await exists(dbPath)) {
    const refs = await loadReferences(dbPath);
    const legacyRoot = join(source, 'workspaces');
    const taskRoots = Object.fromEntries(
      refs.tasks
        .filter((task) => task.worktree && pathWithin(legacyRoot, task.worktree))
        .map((task) => [task.id, legacyRoot]),
    );
    if (Object.keys(taskRoots).length)
      return {
        workspaceRoot: join(target, 'workspaces'),
        legacyWorkspaceRoot: legacyRoot,
        preservedWorkspaces: [],
        taskRoots,
      };
  }
  return { workspaceRoot: join(target, 'workspaces'), preservedWorkspaces: [], taskRoots: {} };
}

async function adoptExistingTarget(
  target: string,
  source: string,
  now: () => string,
): Promise<MigrationMarker> {
  const sourceSnapshot = await authoritySnapshot(source, dirname(target));
  const workspace = await existingWorkspaceMapping(target, source);
  let databaseBackup: string | undefined;
  const targetDb = join(target, DATABASE_FILE_NAME);
  if (await exists(targetDb)) {
    const backupName = `legacy-${randomUUID()}.sqlite`;
    const backupPath = join(target, 'backups', backupName);
    // Snapshot the already-present target exactly once, then verify the material rollback file.
    await snapshotDatabase(targetDb, backupPath);
    databaseBackup = join('backups', backupName);
  }
  const targetAfterFingerprint = await fingerprint(target, dirname(target));
  if (targetAfterFingerprint !== sourceSnapshot.fingerprint)
    throw new Error('已有新目录在采用期间发生变化，已保留 rollback 备份并停止采用');
  const afterSnapshot = await authoritySnapshot(source, dirname(target));
  if (!authoritySnapshotsEqual(sourceSnapshot, afterSnapshot))
    throw new Error('旧版数据在采用已有新目录期间发生变化，已保留源目录并停止采用');
  const marker: MigrationMarker = {
    version: 1,
    status: 'complete',
    sourceDir: source,
    targetDir: target,
    sourceFingerprint: sourceSnapshot.fingerprint,
    sourceSignature: sourceSnapshot.signature,
    workspaceRoot: workspace.workspaceRoot,
    legacyWorkspaceRoot: workspace.legacyWorkspaceRoot,
    preservedWorkspaces: workspace.preservedWorkspaces,
    taskRoots: workspace.taskRoots,
    startedAt: timestamp(now),
    completedAt: timestamp(now),
    rollback: {
      sourceDir: source,
      sourceFingerprint: sourceSnapshot.fingerprint,
      sourcePreserved: true,
      copied: [],
      ...(databaseBackup ? { databaseBackup } : {}),
    },
  };
  await durableJson(join(target, MIGRATION_MARKER_NAME), marker);
  return marker;
}

/**
 * Resolve and, on first startup, migrate the old checkout-local data directory.
 *
 * Safety properties are intentionally stronger than convenience: the source is never moved or
 * deleted, an existing target is never overwritten, and any unknown Git/SQLite drift leaves a
 * durable staging marker for manual recovery.
 */
export async function resolveDataDirectory(
  options: DataDirectoryOptions = {},
): Promise<DataDirectoryLease> {
  const now = options.now ?? (() => new Date().toISOString());
  const source = resolve(
    options.legacyDir ?? join(options.cwd ?? process.cwd(), DATA_DIRECTORY_NAME),
  );
  const target = resolve(
    options.dataDir ?? join(options.homeDir ?? homedir(), DATA_DIRECTORY_NAME),
  );
  // Reject aliases before creating either migration or instance lock.
  await assertSafeDataRoots(source, target);
  const existingMarker = await readMarker(join(target, MIGRATION_MARKER_NAME));
  if (existingMarker?.sourceDir)
    await assertSafeDataRoots(resolve(existingMarker.sourceDir), target);

  if (samePath(source, target)) {
    const ownership = await acquireLock(join(target, INSTANCE_LOCK_NAME), '数据目录');
    try {
      const marker = await ensureMarker(target, undefined, now);
      return {
        dataDir: target,
        ...workspaceFields(marker, target),
        migrated: false,
        migration: marker,
        release: ownership.release,
      };
    } catch (error) {
      await ownership.release();
      throw error;
    }
  }

  const migrationLock = await acquireLock(
    join(dirname(target), `${DATA_DIRECTORY_NAME}.migration.lock`),
    '迁移',
  );
  let ownership: HeldLock | undefined;
  let sourceOwnership: HeldLock | undefined;
  let keepOwnership = false;
  try {
    const targetState = await directoryState(target);
    if (targetState.exists)
      ownership = await acquireLock(join(target, INSTANCE_LOCK_NAME), '数据目录');
    const sourceState = await directoryState(source);
    let marker = targetState.marker;

    if (marker?.status === 'complete') {
      const recordedSource = marker.sourceDir ? resolve(marker.sourceDir) : undefined;
      if (recordedSource) {
        const recordedState = await directoryState(recordedSource);
        if (!samePath(recordedSource, source) && sourceState.authoritative)
          throw new Error(
            `新数据目录 marker 记录的旧目录与当前 checkout 不同，且当前旧目录包含数据，拒绝自动选择来源：${source}`,
          );
        if (recordedState.authoritative)
          marker = await verifyRecordedSource(
            target,
            recordedSource,
            marker,
            options.probeLegacy ?? true,
            now,
          );
      } else if (sourceState.authoritative) {
        throw new Error(
          `新数据目录已有完成 marker，但当前 checkout 包含未记录的旧版数据：${source}`,
        );
      }
      keepOwnership = true;
      return {
        dataDir: target,
        ...workspaceFields(marker, target),
        migrated: false,
        migration: marker,
        release: ownership?.release ?? (async () => {}),
      };
    }
    if (marker)
      throw new Error(`数据目录存在未完成迁移 marker：${join(target, MIGRATION_MARKER_NAME)}`);
    if (targetState.exists) {
      const unknown = await targetHasUnknownDrift(target);
      if (unknown.length)
        throw new Error(`新数据目录包含未知文件，拒绝覆盖：${unknown.join(', ')}`);
    }

    if (sourceState.authoritative) {
      // Hold the legacy ownership lock from the first source read through staging commit.  Hosts
      // that honor this lock are therefore stopped before SQLite opens; external writers are
      // caught by the authority snapshot comparison in migrateLegacy.
      sourceOwnership = await acquireLegacyLock(source, options.probeLegacy ?? true);
      if (!targetState.authoritative) {
        if (ownership) {
          await ownership.release();
          ownership = undefined;
        }
        if (targetState.exists) {
          const remaining = (await listEntries(target)).filter(
            (entry) => !isIgnoredDirectoryEntry(entry.name),
          );
          if (remaining.length)
            throw new Error(
              `新数据目录虽无应用数据但包含未知内容：${remaining.map((entry) => entry.name).join(', ')}`,
            );
          await rm(target, { recursive: false });
        }
        const complete = await migrateLegacy(source, target, now, options.afterSourceSnapshot);
        ownership = await acquireLock(join(target, INSTANCE_LOCK_NAME), '数据目录');
        keepOwnership = true;
        return {
          dataDir: target,
          ...workspaceFields(complete, target),
          migrated: true,
          migration: complete,
          release: ownership.release,
        };
      }

      const sourceSnapshot = await authoritySnapshot(source, dirname(target));
      const targetFingerprint = await fingerprint(target, dirname(target));
      if (
        sourceSnapshot.fingerprint !== undefined &&
        sourceSnapshot.fingerprint === targetFingerprint
      ) {
        const complete = await adoptExistingTarget(target, source, now);
        keepOwnership = true;
        return {
          dataDir: target,
          ...workspaceFields(complete, target),
          migrated: false,
          migration: complete,
          release: ownership?.release ?? (async () => {}),
        };
      }
      const reason = `旧版与新数据目录内容不一致，拒绝自动合并（source=${sourceSnapshot.fingerprint ?? 'none'}, target=${targetFingerprint ?? 'none'}）`;
      await recordBlockedMarker(target, source, reason, now);
      throw new Error(reason);
    }

    if (!targetState.exists) await mkdir(target, { recursive: true });
    const complete = await ensureMarker(target, undefined, now);
    if (!ownership) ownership = await acquireLock(join(target, INSTANCE_LOCK_NAME), '数据目录');
    keepOwnership = true;
    return {
      dataDir: target,
      ...workspaceFields(complete, target),
      migrated: false,
      migration: complete,
      release: ownership.release,
    };
  } finally {
    await sourceOwnership?.release().catch(() => {});
    await migrationLock.release().catch(() => {});
    if (!keepOwnership) await ownership?.release().catch(() => {});
  }
}

/** Short alias for callers that use the path-oriented name. */
export const resolveDataDir = resolveDataDirectory;
