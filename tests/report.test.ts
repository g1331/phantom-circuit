import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readdir, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const exec = promisify(execFile);
const cli = resolve('scripts/report.ts');
const createdAt = '2026-01-01T00:00:00.000Z';

function put(db: DatabaseSync, kind: string, value: { id: string; [key: string]: unknown }) {
  db.prepare('INSERT OR REPLACE INTO documents VALUES (?,?,?)').run(
    kind,
    value.id,
    JSON.stringify(value),
  );
}

function task(db: DatabaseSync, id: string, projectId = 'p', extra: Record<string, unknown> = {}) {
  put(db, 'task', {
    id,
    projectId,
    repoId: `repo-${projectId}`,
    title: id,
    sourceMessageId: `source-${id}`,
    stage: 'done',
    createdAt,
    head: `head-${id}`,
    base: 'base',
    pr: 1,
    retries: 0,
    ...extra,
  });
}

function merged(
  db: DatabaseSync,
  id: string,
  projectId = 'p',
  mergedAt: string | null = '2026-01-01T00:00:10.000Z',
) {
  put(db, 'operation', {
    id: `merge:${id}:head-${id}`,
    kind: 'merge-pr',
    status: 'done',
    result: {
      number: 1,
      merged: true,
      ...(mergedAt ? { merged_at: mergedAt } : {}),
      head: { sha: `head-${id}` },
      base: { sha: 'base', repo: { full_name: `owner/${projectId}` } },
    },
  });
}

function project(db: DatabaseSync, id = 'p', name = 'Alpha') {
  put(db, 'project', { id, name });
  put(db, 'repo', { id: `repo-${id}`, projectId: id, github: `owner/${id}` });
}

function run(
  db: DatabaseSync,
  id: string,
  taskId: string | undefined,
  total: number | undefined,
  extra: Record<string, unknown> = {},
) {
  put(db, 'run', {
    id,
    projectId: 'p',
    taskId,
    role: 'dev',
    status: 'completed',
    startedAt: createdAt,
    ...(total !== undefined ? { usage: { totalTokens: total, final: true } } : {}),
    ...extra,
  });
}

function database(root: string) {
  const db = new DatabaseSync(join(root, 'phantom.sqlite'));
  db.exec(`CREATE TABLE documents (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL);
    CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  return db;
}

async function report(root: string) {
  return exec(process.execPath, ['--import', 'tsx', cli, '--data-dir', root], {
    timeout: 15_000,
    encoding: 'utf8',
  });
}

test('report CLI reads an empty existing database without requiring a host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-'));
  try {
    database(root).close();
    const result = await report(root);
    assert.match(result.stdout, /读取时间：/);
    assert.match(result.stdout, /数据来源：.*phantom.sqlite/);
    assert.match(result.stdout, /暂无 Project/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI reports hand-calculated Task totals, even/odd medians, evidence gaps and Project isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-metrics-'));
  try {
    const db = database(root);
    project(db);
    project(db, 'q', 'Beta');
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      task(db, id);
      merged(db, id);
    }
    task(db, 'ordinary', 'p', { completionDeliveryPending: false, completionSyncedAt: createdAt });
    put(db, 'message', {
      id: 'fake-completion',
      projectId: 'p',
      role: 'assistant',
      content: '已完成「ordinary」，实现已合并。https://github.com/owner/p/pull/1',
      createdAt,
    });
    task(db, 'unfinished', 'p', { stage: 'developing', retries: 3 });
    task(db, 'a', 'p', { retries: 2 });
    task(db, 'f', 'p', { retries: undefined });
    merged(db, 'f', 'p', null);
    run(db, 'failed-a', 'a', 10, { status: 'failed' });
    run(db, 'recovered-a', 'a', 20, { recoveryItemId: 'recovery-a' });
    run(db, 'review-a', 'a', 70, { role: 'review' });
    run(db, 'pm-a', undefined, 20, { role: 'pm', sourceMessageId: 'source-a' });
    run(db, 'b-zero', 'b', 0);
    run(db, 'c-inclusive', 'c', undefined, {
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 40,
        cacheWriteTokens: 10,
        reasoningOutputTokens: 10,
        final: true,
      },
    });
    run(db, 'd-partial', 'd', 999);
    run(db, 'd-missing', 'd', undefined, { status: 'failed' });
    run(db, 'e-input-only', 'e', undefined, { usage: { inputTokens: 20, final: true } });
    run(db, 'f-missing', 'f', undefined);
    merged(db, 'b', 'p', '2026-01-01T00:00:00.000Z');
    merged(db, 'c', 'p', '2026-01-01T00:00:20.000Z');
    merged(db, 'd', 'p', '2026-01-01T00:00:30.000Z');
    merged(db, 'e', 'p', '2026-01-01T00:00:40.000Z');
    put(db, 'clarification', {
      id: 'before-task',
      projectId: 'p',
      sourceMessageId: 'source-a',
      status: 'answered',
      createdAt: '2025-12-31T23:59:00Z',
    });
    put(db, 'incident', {
      id: 'resolved',
      projectId: 'p',
      taskId: 'c',
      phase: 'review',
      status: 'resolved',
      createdAt: '2026-01-01T00:00:05Z',
      message: 'ordinary failure',
    });
    put(db, 'incident', { id: 'unassigned', projectId: 'p', status: 'resolved', createdAt });
    task(db, 'q-one', 'q');
    merged(db, 'q-one', 'q');
    task(db, 'q-two', 'q');
    merged(db, 'q-two', 'q');
    run(db, 'q-run1', 'q-one', 10, { projectId: 'q' });
    run(db, 'q-run2', 'q-two', 30, { projectId: 'q' });
    // A foreign Project's reference to Alpha must never affect Alpha's samples.
    put(db, 'incident', {
      id: 'foreign',
      projectId: 'q',
      taskId: 'a',
      phase: 'dev',
      status: 'resolved',
      createdAt,
    });
    db.close();
    const { stdout } = await report(root);
    const [alpha, beta] = stdout.split('Project：Beta [q]');
    assert.match(alpha, /Project：Alpha \[p\]/);
    assert.match(alpha, /确认合并任务：6；历史 done 未确认：1/);
    assert.match(alpha, /确认无干预：0；确认有干预：2；未知：4/);
    assert.match(alpha, /保守下界.*0\/6/);
    assert.match(alpha, /Incident.*review=1.*unknown=1/);
    assert.match(alpha, /未归属干预：Incident=1/);
    assert.match(alpha, /返工轮数.*已知合计=5.*覆盖=7\/8/);
    assert.match(alpha, /合并任务返工.*已知合计=2.*覆盖=5\/6/);
    assert.match(alpha, /token 中位数：120；n=3\/6；unknown=1；partial=2/);
    assert.match(alpha, /墙钟交付耗时中位数：20000 ms；n=5\/6；unknown=1/);
    assert.match(alpha, /Task a：.*token=120/);
    assert.match(beta, /确认合并任务：2；历史 done 未确认：0/);
    assert.match(beta, /token 中位数：20；n=2\/2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function event(db: DatabaseSync, value: Record<string, unknown>) {
  db.prepare('INSERT INTO events(body) VALUES (?)').run(
    JSON.stringify({ at: '2026-01-01T00:00:05Z', ...value }),
  );
}

test('CLI retains resolved interventions and ambiguous PM usage without confusing automatic recovery or ordinary failures with watchdog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-history-'));
  try {
    const db = database(root);
    project(db);
    for (const id of ['user', 'automatic', 'shared1', 'shared2', 'no-time', 'after']) {
      task(db, id, 'p', { sourceMessageId: id.startsWith('shared') ? 'shared' : `source-${id}` });
      merged(db, id);
      run(db, `run-${id}`, id, 10);
    }
    merged(db, 'no-time', 'p', null);
    put(db, 'recovery', {
      id: 'user-history',
      projectId: 'p',
      taskId: 'user',
      oldRunId: 'run-user',
      pauseProvenance: 'user',
      policy: 'manual',
      createdAt: '2026-01-01T00:00:02Z',
    });
    event(db, { projectId: 'p', taskId: 'user', type: 'task', message: '任务 pause' });
    event(db, { projectId: 'p', taskId: 'user', type: 'task', message: '任务 resume' });
    put(db, 'recovery', {
      id: 'automatic-history',
      projectId: 'p',
      taskId: 'automatic',
      oldRunId: 'run-automatic',
      successorRunId: 'successor',
      pauseProvenance: 'runtime',
      policy: 'automatic',
      createdAt,
    });
    event(db, { projectId: 'p', taskId: 'automatic', type: 'task', message: '任务 resume' });
    event(db, { projectId: 'p', taskId: 'automatic', type: 'recovery', message: '已排队自动恢复' });
    event(db, { projectId: 'p', type: 'task', message: '任务 pause' });
    put(db, 'clarification', {
      id: 'cancelled-before',
      projectId: 'p',
      sourceMessageId: 'source-user',
      status: 'cancelled',
      createdAt: '2025-12-31T23:59:00Z',
    });
    put(db, 'incident', {
      id: 'after',
      projectId: 'p',
      taskId: 'after',
      phase: 'cleanup',
      status: 'resolved',
      createdAt: '2026-01-01T00:01:00Z',
    });
    put(db, 'incident', {
      id: 'no-time',
      projectId: 'p',
      taskId: 'no-time',
      phase: 'merge',
      status: 'resolved',
      createdAt: '2026-01-01T00:00:01Z',
    });
    // Watchdog appears in all three stores for the same Run, and twice as an Event.
    run(db, 'watchdog', 'shared1', 5, {
      status: 'failed',
      error: 'Error: Watchdog：Run 20 分钟无事件，判定为停滞并已停止',
    });
    put(db, 'incident', {
      id: 'watchdog-incident',
      projectId: 'p',
      taskId: 'shared1',
      runId: 'watchdog',
      phase: 'dev',
      status: 'resolved',
      message: 'Error: Watchdog：Run 20 分钟无事件，判定为停滞并已停止',
      createdAt,
    });
    for (let i = 0; i < 2; i++)
      event(db, {
        type: 'watchdog',
        projectId: 'p',
        taskId: 'shared1',
        runId: 'watchdog',
        message: 'Watchdog：same trip',
      });
    run(db, 'ordinary-failure', 'shared2', 5, { status: 'failed', error: 'npm failed' });
    run(db, 'pm-shared', undefined, 100, { role: 'pm', sourceMessageId: 'shared' });
    run(db, 'pm-unrelated', undefined, undefined, { role: 'pm' });
    // Full history must not use Store.events()'s 200-row UI limit.
    for (let i = 0; i < 205; i++)
      event(db, { type: 'unrelated', projectId: 'p', message: 'noise' });
    db.close();
    const { stdout } = await report(root);
    assert.match(stdout, /确认无干预：0；确认有干预：2；未知：4/);
    assert.match(stdout, /未归属干预：Incident=0；暂停\/恢复=1/);
    assert.match(stdout, /watchdog 触发次数：1/);
    assert.match(
      stdout,
      /PM 未分配：Run=2；已知 token=100；usage unknown=1；partial=0；歧义影响 Task=shared1,shared2/,
    );
    assert.match(stdout, /token 中位数：10；n=4\/6；unknown=0；partial=2/);
    assert.match(stdout, /墙钟交付耗时中位数：10000 ms；n=5\/6；unknown=1/);
    assert.match(stdout, /Task automatic：.*干预=unknown/);
    assert.match(stdout, /Task no-time：.*墙钟=unknown；干预=unknown/);
    assert.match(stdout, /Task after：.*干预=unknown/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fileState(root: string) {
  const result: Record<string, { bytes: string; size: number; mtime: number }> = {};
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    const info = await stat(path);
    if (info.isFile())
      result[name] = {
        bytes: (await readFile(path)).toString('base64'),
        size: info.size,
        mtime: info.mtimeMs,
      };
  }
  return result;
}

test('CLI preserves all source files and logical database contents and does not acquire ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-readonly-'));
  try {
    const db = database(root);
    project(db);
    task(db, 'a');
    merged(db, 'a');
    run(db, 'a-run', 'a', 0);
    db.close();
    await writeFile(join(root, '.instance.lock'), 'existing-host-ownership');
    await writeFile(join(root, 'config.json'), '{"user":"unchanged"}');
    const before = await fileState(root);
    const logical = () => {
      const check = new DatabaseSync(join(root, 'phantom.sqlite'), { readOnly: true });
      try {
        return ['documents', 'events', 'meta'].map((table) =>
          check.prepare(`SELECT * FROM ${table}`).all(),
        );
      } finally {
        check.close();
      }
    };
    const contents = logical();
    const { stdout } = await report(root);
    assert.match(stdout, /token 中位数：0；n=1\/1/);
    assert.deepEqual(logical(), contents);
    assert.deepEqual(await fileState(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects missing paths, unknown schema, damaged JSON and corrupt SQLite without creating files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-invalid-'));
  try {
    const missing = join(root, 'missing');
    await assert.rejects(
      report(missing),
      (error: any) => error.code === 1 && /ENOENT|不存在/.test(error.stderr) && !error.stdout,
    );
    assert.deepEqual(await readdir(root), []);
    await mkdir(join(root, 'empty'));
    await assert.rejects(report(join(root, 'empty')));
    assert.deepEqual(await readdir(join(root, 'empty')), []);
    const db = database(root);
    db.exec('PRAGMA user_version=99');
    db.close();
    const before = await fileState(root);
    await assert.rejects(
      report(root),
      (error: any) => error.code === 1 && /未知 SQLite user_version/.test(error.stderr),
    );
    assert.deepEqual(await fileState(root), before);
    const wrong = new DatabaseSync(join(root, 'phantom.sqlite'));
    wrong.exec('PRAGMA user_version=0; ALTER TABLE documents ADD COLUMN surprise TEXT');
    wrong.close();
    await assert.rejects(report(root), (error: any) => /未知 SQLite 表结构/.test(error.stderr));
    await rm(join(root, 'phantom.sqlite'));
    const damaged = database(root);
    damaged.prepare('INSERT INTO documents VALUES (?,?,?)').run('project', 'broken', '{');
    damaged.close();
    await assert.rejects(
      report(root),
      (error: any) => /损坏 JSON：project\/broken/.test(error.stderr) && !error.stdout,
    );
    await writeFile(join(root, 'phantom.sqlite'), 'not a database');
    await assert.rejects(
      report(root),
      (error: any) => /not a database|malformed/.test(error.stderr) && !error.stdout,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI fails immediately on an exclusive writer rather than waiting for the host to stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-busy-'));
  const writer = database(root);
  try {
    writer.exec('BEGIN EXCLUSIVE');
    const before = await fileState(root);
    await assert.rejects(
      report(root),
      (error: any) => error.code === 1 && /locked|busy/i.test(error.stderr) && !error.stdout,
    );
    // Writer still owns its transaction, and can commit without report coordination.
    put(writer, 'project', { id: 'after', name: 'still running' });
    writer.exec('COMMIT');
    assert.ok(before['phantom.sqlite']);
  } finally {
    writer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects mismatched PR/revision/Repo evidence and preserves unknown sample counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-evidence-'));
  try {
    const db = database(root);
    project(db);
    project(db, 'empty', 'Empty');
    for (const id of ['revision', 'pr', 'repo', 'uncertain', 'missing-repo', 'good', 'bad-date']) {
      task(db, id, 'p', { retries: undefined });
      merged(db, id);
    }
    task(db, 'revision', 'p', { head: 'different', retries: undefined });
    task(db, 'pr', 'p', { pr: 99, retries: undefined });
    task(db, 'repo', 'p', { repoId: 'repo-empty', retries: undefined });
    task(db, 'missing-repo', 'p', { repoId: 'absent', retries: undefined });
    put(db, 'operation', {
      id: 'merge:uncertain:head-uncertain',
      kind: 'merge-pr',
      status: 'uncertain',
    });
    task(db, 'bad-date', 'p', { createdAt: '2027-01-01', retries: undefined });
    run(db, 'zero', 'good', 0);
    run(db, 'unknown', 'bad-date', undefined);
    run(db, 'no-event-watchdog', undefined, undefined, {
      role: 'pm',
      status: 'failed',
      error: 'Error: Watchdog：same command repeated',
    });
    db.close();
    const { stdout } = await report(root);
    assert.match(stdout, /确认合并任务：2；历史 done 未确认：5/);
    assert.match(stdout, /返工轮数（Project 全部 Task）：已知合计=N\/A；覆盖=0\/7；unknown=7/);
    assert.match(stdout, /token 中位数：0；n=1\/2；unknown=1；partial=0/);
    assert.match(stdout, /墙钟交付耗时中位数：10000 ms；n=1\/2；unknown=1/);
    assert.match(stdout, /watchdog 触发次数：1/);
    const empty = stdout.split('Project：Empty [empty]')[1];
    assert.match(empty, /无干预合并率（保守下界）：N\/A/);
    assert.match(empty, /token 中位数：N\/A；n=0\/0；unknown=0；partial=0/);
    assert.match(empty, /墙钟交付耗时中位数：N\/A；n=0\/0；unknown=0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI uses the home authority by default and accepts only the documented data directory option', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-home-'));
  try {
    const home = join(root, 'home');
    const data = join(home, '.phantom');
    const checkout = join(root, 'checkout');
    await mkdir(data, { recursive: true });
    await mkdir(join(checkout, '.phantom'), { recursive: true });
    const homeDb = database(data);
    project(homeDb, 'authority', 'Home authority');
    homeDb.close();
    const legacy = database(join(checkout, '.phantom'));
    project(legacy, 'legacy', 'Legacy checkout');
    legacy.close();
    const env = { ...process.env, USERPROFILE: home, HOME: home };
    const loader = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
    const result = await exec(process.execPath, ['--import', loader, cli], { cwd: checkout, env });
    assert.match(result.stdout, /Home authority/);
    assert.doesNotMatch(result.stdout, /Legacy checkout/);
    await rm(join(data, 'phantom.sqlite'));
    await assert.rejects(
      exec(process.execPath, ['--import', loader, cli], { cwd: checkout, env }),
      (error: any) => error.code === 1 && !error.stdout,
    );
    assert.deepEqual(await readdir(data), []);
    await assert.rejects(
      exec(process.execPath, ['--import', 'tsx', cli, '--unknown']),
      (error: any) => /用法/.test(error.stderr),
    );
    const help = await exec(process.execPath, ['--import', 'tsx', cli, '--help']);
    assert.match(help.stdout, /Usage: npm run report/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('WAL safety guard refuses online input without touching sidecars or blocking the writer (online acceptance remains pending)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-wal-guard-'));
  const writer = database(root);
  try {
    writer.exec('PRAGMA journal_mode=WAL');
    project(writer);
    const before = await fileState(root);
    await assert.rejects(
      report(root),
      (error: any) =>
        error.code === 1 && /WAL 在线读取.*禁用直连/.test(error.stderr) && !error.stdout,
    );
    assert.deepEqual(await fileState(root), before);
    writer.exec('BEGIN IMMEDIATE');
    project(writer, 'after', 'writer continued');
    writer.exec('COMMIT');
    assert.ok(writer.prepare("SELECT id FROM documents WHERE kind='project' AND id='after'").get());
    writer.close();
    assert.deepEqual(await readdir(root), ['phantom.sqlite']);
    const closedBefore = await fileState(root);
    await assert.rejects(report(root), (error: any) => /WAL 在线读取.*禁用直连/.test(error.stderr));
    assert.deepEqual(await fileState(root), closedBefore);
  } finally {
    if (writer.isOpen) writer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('regression evidence: native readOnly SQLite recreates WAL sidecars after the last writer closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-wal-race-'));
  try {
    const writer = database(root);
    writer.exec('PRAGMA journal_mode=WAL');
    project(writer);
    assert.ok((await readdir(root)).includes('phantom.sqlite-shm'));
    // Deterministic last-writer shutdown between a successful sidecar check and read.
    writer.close();
    assert.deepEqual(await readdir(root), ['phantom.sqlite']);
    const reader = new DatabaseSync(join(root, 'phantom.sqlite'), { readOnly: true, timeout: 0 });
    try {
      assert.equal(reader.prepare('SELECT count(*) AS n FROM documents').get()?.n, 2);
      assert.ok((await readdir(root)).includes('phantom.sqlite-wal'));
      assert.ok((await readdir(root)).includes('phantom.sqlite-shm'));
    } finally {
      reader.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
