import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.ts';

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

async function report(root: string, args: string[] = []) {
  return exec(process.execPath, ['--import', 'tsx', cli, '--data-dir', root, ...args], {
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
    assert.match(result.stdout, /加 --explain 查看统计口径/);
    assert.doesNotMatch(result.stdout, /口径：全部持久记录/);
    const explained = await report(root, ['--explain']);
    assert.deepEqual(explained.stdout.split('\n').slice(3, 9), [
      '口径：全部持久记录；确认合并按 Task ID；token 先汇总 Task 全部归属 Run，再取中位数；墙钟=createdAt→merged_at。',
      '合并证据：done merge-pr operation + Task/revision/PR/Project Repo 身份；普通 done/聊天/交接时间不证明合并。',
      '干预覆盖：现行数据无历史完整性标记，未发现干预仍为 unknown；无干预率仅为保守下界。',
      'watchdog 证据：type=watchdog Event 或宿主 Watchdog：/Error: Watchdog：前缀；按 Run ID 去重，一般失败不计。',
      '暂停/恢复/取消口径：有效 control.action/source/reason 且动作一致才采用来源；user 计干预，host/pm 仅排除该条用户直接操作，关联 Incident 仍计入。',
      '缺失、未知或不一致来源仍为 unknown；后续自动动作不覆盖早先用户/未知证据；兼容 recovery.pauseProvenance=user，不据此证明历史完整。',
    ]);
    assert.doesNotMatch(explained.stdout, /加 --explain/);
    const combined = await exec(process.execPath, [
      '--import',
      'tsx',
      cli,
      '--explain',
      `--data-dir=${root}`,
    ]);
    assert.equal(
      combined.stdout.split('\n').slice(2).join('\n'),
      explained.stdout.split('\n').slice(2).join('\n'),
    );
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
    assert.match(alpha, /墙钟交付耗时中位数：20秒；n=5\/6；unknown=1/);
    assert.match(alpha, /Task a a：.*token=120/);
    assert.match(beta, /确认合并任务：2；历史 done 未确认：0/);
    assert.match(beta, /token 中位数：20；n=2\/2/);
    const explained = await report(root, ['--explain']);
    assert.equal(
      explained.stdout.slice(explained.stdout.indexOf('\nProject：')),
      stdout.slice(stdout.indexOf('\nProject：')),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function event(db: DatabaseSync, value: Record<string, unknown>) {
  db.prepare('INSERT INTO events(body) VALUES (?)').run(
    JSON.stringify({ at: '2026-01-01T00:00:05Z', ...value }),
  );
}

test('CLI identifies Tasks by Issue/title or short ID and stably orders actual merges with unknowns last', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-labels-'));
  try {
    const db = database(root);
    project(db);
    const fixtures: [string, number | undefined, string, string | null][] = [
      ['a-unknown', 90, '缺失时间', null],
      ['b-late', 63, '长'.repeat(38) + '🚀尾超长标题', '2026-01-01T09:55:00Z'],
      ['c-first', 10, '最早合并', '2026-01-01T00:01:00Z'],
      ['d-tied-123456789', undefined, '没有 Issue 的标题', '2026-01-01T00:01:00Z'],
      ['e-invalid', 91, '无效时间', 'invalid'],
    ];
    for (const [id, issue, title, at] of fixtures) {
      task(db, id, 'p', { issue, title, updatedAt: '2020-01-01T00:00:00Z' });
      merged(db, id, 'p', at);
      run(db, `run-${id}`, id, 1000);
    }
    db.close();
    const { stdout } = await report(root);
    const labels = stdout
      .split('\n')
      .filter((line) => line.startsWith('  Task '))
      .map((line) => line.split('：')[0]);
    assert.deepEqual(labels, [
      '  Task #10 最早合并',
      '  Task d-tied-1 没有 Issue 的标题',
      '  Task #63 ' + '长'.repeat(38) + '🚀…',
      '  Task #90 缺失时间',
      '  Task #91 无效时间',
    ]);
    assert.match(stdout, /Task #90 缺失时间：.*墙钟=unknown/);
    assert.match(stdout, /Task #91 无效时间：.*墙钟=unknown/);
    assert.match(stdout, /确认合并任务：5；历史 done 未确认：0/);
    assert.match(stdout, /token 中位数：1,000；n=5\/5；unknown=0；partial=0/);
    assert.match(stdout, /墙钟交付耗时中位数：1分；n=3\/5；unknown=2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI groups exact token totals and fractional medians while retaining partial and zero usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-tokens-'));
  try {
    const db = database(root);
    project(db);
    for (const id of ['a', 'b', 'partial', 'zero']) {
      task(db, id);
      merged(db, id);
    }
    run(db, 'a1', 'a', 1234567);
    run(db, 'a2', 'a', 1);
    run(db, 'b', 'b', 1234569);
    run(db, 'partial', 'partial', 9876543, { usage: { totalTokens: 9876543 } });
    run(db, 'zero', 'zero', 0, { usage: { totalTokens: 0 } });
    run(db, 'pm1', undefined, 1234567, { role: 'pm' });
    run(db, 'pm2', undefined, 2, { role: 'pm' });
    db.close();
    const { stdout } = await report(root);
    assert.match(stdout, /token 中位数：1,234,568.5；n=2\/4；unknown=0；partial=2/);
    assert.match(stdout, /Task a a：token=1,234,568；/);
    assert.match(stdout, /Task b b：token=1,234,569；/);
    assert.match(stdout, /Task partial partial：token=partial\(已知=9,876,543\)/);
    assert.match(stdout, /Task zero zero：token=partial\(已知=0\)/);
    assert.match(stdout, /PM 未分配：Run=2；已知 token=1,234,569；/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI renders wall durations in Chinese without changing median samples', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-duration-'));
  try {
    const db = database(root);
    project(db);
    const fixtures: [string, string | null, string][] = [
      ['hours', '2026-01-01T09:55:59Z', '9小时55分'],
      ['hour', '2026-01-01T01:05:00Z', '1小时5分'],
      ['minutes', '2026-01-01T00:42:00Z', '42分'],
      ['seconds', '2026-01-01T00:00:42.125Z', '42.125秒'],
      ['subsecond', '2026-01-01T00:00:00.999Z', '不足1秒'],
      ['zero', createdAt, '0秒'],
      ['unknown', null, 'unknown'],
    ];
    for (const [id, at] of fixtures) {
      task(db, id);
      merged(db, id, 'p', at);
    }
    db.close();
    const { stdout } = await report(root);
    for (const [id, , display] of fixtures)
      assert.match(stdout, new RegExp(`Task ${id.slice(0, 8)} ${id}：.*墙钟=${display}；`));
    // Median of 0, 999, 42125, 2520000, 3900000, 35759000 is 1281062.5 ms.
    assert.match(stdout, /墙钟交付耗时中位数：21分；n=6\/7；unknown=1/);
    assert.doesNotMatch(stdout, /\d+(?:\.\d+)? ms/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI attributes persisted control sources per event without treating explicit sources as full history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-controls-'));
  const store = new Store(join(root, 'phantom.sqlite'));
  const p = store.createProject('Controls', '');
  const repo = store.createRepo({
    projectId: p.id,
    name: 'r',
    path: root,
    github: 'owner/p',
    defaultBranch: 'main',
    authorized: true,
  });
  const names = [
    'user',
    'host',
    'pm',
    'legacy',
    'future',
    'malformed',
    'after',
    'cancel',
    'recovery-conflict',
  ];
  const ids = new Map<string, string>();
  for (const name of names) {
    const source = store.addMessage(p.id, 'user', name, 'implement');
    const t = store.createTask({
      projectId: p.id,
      repoId: repo.id,
      sourceMessageId: source.id,
      title: name,
      spec: name,
      acceptance: ['works'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    ids.set(name, t.id);
  }
  const key = (name: string) => ids.get(name)!;
  store.control(key('user'), 'pause', { source: 'user', reason: 'http_task_control' });
  store.control(key('user'), 'resume', { source: 'host', reason: 'startup_recovery' });
  store.control(key('host'), 'pause', { source: 'host', reason: 'sync_issue_changed' });
  store.control(key('host'), 'resume', { source: 'host', reason: 'startup_recovery' });
  store.control(key('pm'), 'pause', { source: 'pm', reason: 'resolve_incident' });
  store.control(key('pm'), 'resume', { source: 'pm', reason: 'resolve_incident' });
  store.control(key('legacy'), 'pause');
  store.control(key('legacy'), 'resume', { source: 'host', reason: 'startup_recovery' });
  store.control(key('cancel'), 'cancel', { source: 'user', reason: 'http_task_control' });
  assert.throws(() => store.control(key('cancel'), 'resume'), /任务已经结束/);
  store.control(key('recovery-conflict'), 'pause', { source: 'user', reason: 'http_task_control' });
  store.control(key('recovery-conflict'), 'resume', { source: 'host', reason: 'startup_recovery' });
  store.close();
  try {
    const db = new DatabaseSync(join(root, 'phantom.sqlite'));
    // Synthetic report history only: remote merge evidence and a preceding cancellation.
    // This does not claim the host supports cancelled -> resumed -> done transitions.
    for (const id of ids.values()) {
      const row = db.prepare("SELECT body FROM documents WHERE kind='task' AND id=?").get(id)!;
      put(db, 'task', {
        ...JSON.parse(String(row.body)),
        stage: 'done',
        head: `head-${id}`,
        base: 'base',
        pr: 1,
        createdAt,
      });
      merged(db, id, 'p', '2099-01-01T00:00:10Z');
      run(db, `run-${id}`, id, 10, { projectId: p.id });
    }
    const control = (name: string, value: unknown, extra: Record<string, unknown> = {}) =>
      event(db, {
        projectId: p.id,
        taskId: key(name),
        type: 'task',
        message: '任务 pause',
        control: value,
        ...extra,
      });
    control('future', { action: 'pause', source: 'robot', reason: 'future' });
    control('malformed', { action: 'resume', source: 'host', reason: 'mismatch' });
    control('malformed', { action: 'pause', source: 'host' });
    control(
      'after',
      { action: 'cancel', source: 'user', reason: 'http_task_control' },
      { at: '2099-01-01T00:00:11Z', message: '任务 cancel' },
    );
    control(
      'host',
      { action: 'pause', source: 'user', reason: 'http_task_control' },
      { projectId: 'foreign' },
    );
    control(
      'host',
      { action: 'pause', source: 'user', reason: 'http_task_control' },
      { runId: `run-${key('user')}` },
    );
    control('host', {
      action: 'pause',
      source: 'user',
      reason: 'http_incident',
      incidentId: 'resolved-pm',
    });
    put(db, 'incident', {
      id: 'resolved-pm',
      projectId: p.id,
      taskId: key('pm'),
      phase: 'dev',
      status: 'resolved',
      createdAt,
    });
    put(db, 'recovery', {
      id: 'runtime-conflict',
      projectId: p.id,
      taskId: key('recovery-conflict'),
      pauseProvenance: 'runtime',
      createdAt,
    });
    db.close();
    const { stdout } = await report(root);
    assert.match(stdout, /确认合并任务：9/);
    assert.match(stdout, /确认无干预：0；确认有干预：4；未知：5/);
    assert.match(stdout, /保守下界.*0\/9/);
    for (const name of ['user', 'pm', 'cancel', 'recovery-conflict'])
      assert.match(stdout, new RegExp(`Task ${key(name).slice(0, 8)} ${name}：.*干预=有`));
    for (const name of ['host', 'legacy', 'future', 'malformed', 'after'])
      assert.match(stdout, new RegExp(`Task ${key(name).slice(0, 8)} ${name}：.*干预=unknown`));
    assert.match(stdout, /控制事件来源：user=6；host=5；pm=2；unknown=4/);
    assert.match(stdout, /暂停\/恢复\/取消=2/);
    assert.match(stdout, /未归属 Project 的控制事件：1/);
    assert.match(stdout, /token 中位数：10；n=9\/9/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    assert.match(stdout, /未归属干预：Incident=0；暂停\/恢复\/取消=1/);
    assert.match(stdout, /watchdog 触发次数：1/);
    assert.match(
      stdout,
      /PM 未分配：Run=2；已知 token=100；usage unknown=1；partial=0；歧义影响 Task=shared1,shared2/,
    );
    assert.match(stdout, /token 中位数：10；n=4\/6；unknown=0；partial=2/);
    assert.match(stdout, /墙钟交付耗时中位数：10秒；n=5\/6；unknown=1/);
    assert.match(stdout, /Task automati automatic：.*干预=unknown/);
    assert.match(stdout, /Task no-time no-time：.*墙钟=unknown；干预=unknown/);
    assert.match(stdout, /Task after after：.*干预=unknown/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function databaseState(db: DatabaseSync) {
  return {
    schema: db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),
    data: ['documents', 'events', 'meta'].map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ),
    version: db.prepare('PRAGMA user_version').get(),
    journal: db.prepare('PRAGMA journal_mode').get(),
  };
}

test('CLI preserves WAL business data, schema and ownership without requiring a host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-readonly-'));
  const db = database(root);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    project(db);
    task(db, 'a');
    merged(db, 'a');
    run(db, 'a-run', 'a', 0);
    await writeFile(join(root, '.instance.lock'), 'existing-host-ownership');
    await writeFile(join(root, 'config.json'), '{"user":"unchanged"}');
    const before = databaseState(db);
    const { stdout } = await report(root);
    assert.match(stdout, /token 中位数：0；n=1\/1/);
    assert.deepEqual(databaseState(db), before);
    assert.equal(await readFile(join(root, '.instance.lock'), 'utf8'), 'existing-host-ownership');
    assert.equal(await readFile(join(root, 'config.json'), 'utf8'), '{"user":"unchanged"}');
  } finally {
    db.close();
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
    const before = databaseState(db);
    db.close();
    await assert.rejects(
      report(root),
      (error: any) => error.code === 1 && /未知 SQLite user_version/.test(error.stderr),
    );
    const wrong = new DatabaseSync(join(root, 'phantom.sqlite'));
    assert.deepEqual(databaseState(wrong), before);
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
    const before = databaseState(writer);
    await assert.rejects(
      report(root),
      (error: any) => error.code === 1 && /locked|busy/i.test(error.stderr) && !error.stdout,
    );
    assert.deepEqual(databaseState(writer), before);
    // Writer still owns its transaction, and can commit without report coordination.
    put(writer, 'project', { id: 'after', name: 'still running' });
    writer.exec('COMMIT');
    assert.ok(writer.prepare("SELECT id FROM documents WHERE id='after'").get());
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
    assert.match(stdout, /墙钟交付耗时中位数：10秒；n=1\/2；unknown=1/);
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
    assert.match(help.stdout, /\[--data-dir <directory>\] \[--explain\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI reads committed WAL data consistently while an independent writer continues committing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-wal-'));
  const writer = database(root);
  try {
    writer.exec('PRAGMA journal_mode=WAL');
    project(writer, 'p', 'Version 0');
    task(writer, 'a');
    merged(writer, 'a');
    run(writer, 'a-run', 'a', 20);
    // A report must read the last committed state without waiting for this writer.
    writer.exec('BEGIN IMMEDIATE');
    project(writer, 'p', 'Uncommitted');
    const { stdout: committed } = await report(root);
    assert.match(committed, /Project：Version 0 \[p\]/);
    assert.doesNotMatch(committed, /Uncommitted/);
    writer.exec('COMMIT');
    let finished = false;
    let commits = 0;
    const reading = report(root).finally(() => {
      finished = true;
    });
    // Every committed version has matching Project and Task values. No sleeps or
    // assumption about where the read snapshot falls within concurrent commits.
    while (!finished) {
      writer.exec('BEGIN IMMEDIATE');
      project(writer, 'p', `Version ${++commits}`);
      task(writer, 'a', 'p', { retries: commits });
      event(writer, {
        type: 'watchdog',
        projectId: 'p',
        runId: `trip-${commits}`,
        message: 'Watchdog：fixture trip',
      });
      writer.exec('COMMIT');
      await new Promise<void>((done) => setImmediate(done));
    }
    const { stdout } = await reading;
    const version = stdout.match(/Project：Version (\d+) \[p\]/)?.[1];
    assert.ok(version, stdout);
    assert.ok(commits > 0);
    assert.match(
      stdout,
      new RegExp(`返工轮数（Project 全部 Task）：已知合计=${version}；覆盖=1/1`),
    );
    assert.match(stdout, /token 中位数：20；n=1\/1/);
    assert.match(stdout, /墙钟交付耗时中位数：10秒；n=1\/1/);
    // Events are read by a separate SQL query; their count must belong to the
    // same committed version as the documents, even as the writer advances.
    assert.match(stdout, new RegExp(`watchdog 触发次数：${version}（按 Run ID）`));
    writer.exec('BEGIN IMMEDIATE');
    project(writer, 'after', 'writer continued');
    writer.exec('COMMIT');
    assert.ok(writer.prepare("SELECT id FROM documents WHERE kind='project' AND id='after'").get());
  } finally {
    if (writer.isOpen) writer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI leaves conflicting Project and Run associations unassigned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-associations-'));
  try {
    const db = database(root);
    project(db);
    project(db, 'q', 'Beta');
    task(db, 'a');
    merged(db, 'a');
    run(db, 'a-run', 'a', 10);
    run(db, 'foreign-run', undefined, 100, { projectId: 'q', role: 'pm' });
    put(db, 'incident', {
      id: 'conflicting',
      projectId: 'p',
      taskId: 'a',
      runId: 'foreign-run',
      phase: 'dev',
      createdAt,
      message: 'Error: Watchdog：stalled',
      status: 'resolved',
    });
    event(db, {
      projectId: 'p',
      taskId: 'a',
      runId: 'foreign-run',
      type: 'watchdog',
      message: 'Watchdog：stalled',
    });
    db.close();
    const { stdout } = await report(root);
    const alpha = stdout.split('Project：Beta [q]')[0];
    assert.match(alpha, /确认无干预：0；确认有干预：0；未知：1/);
    assert.match(alpha, /未归属干预：Incident=1/);
    assert.match(alpha, /watchdog 触发次数：0.*无法去重的触发证据=2/);
    assert.match(alpha, /token 中位数：10；n=1\/1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI attributes pre-publication Clarification and exclusive PM usage through a self-referencing steer source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-steer-source-'));
  try {
    const db = database(root);
    project(db);
    // Store.beginSteer persists this legitimate sourceMessageId === id shape.
    put(db, 'message', { id: 'steer', projectId: 'p', sourceMessageId: 'steer' });
    put(db, 'message', { id: 'reply', projectId: 'p', sourceMessageId: 'steer' });
    task(db, 'a', 'p', { sourceMessageId: 'reply' });
    merged(db, 'a');
    run(db, 'dev-a', 'a', 10);
    run(db, 'pm-a', undefined, 100, { role: 'pm', sourceMessageId: 'steer' });
    put(db, 'clarification', {
      id: 'before-publication',
      projectId: 'p',
      sourceMessageId: 'steer',
      status: 'answered',
      createdAt: '2025-12-31T23:59:00Z',
    });
    db.close();

    const { stdout } = await report(root);
    assert.match(stdout, /确认无干预：0；确认有干预：1；未知：0/);
    assert.match(stdout, /未归属干预：Incident=0；暂停\/恢复\/取消=0；Clarification=0/);
    assert.match(stdout, /PM 未分配：Run=0/);
    assert.match(stdout, /Task a a：token=110；.*干预=有/);
    assert.match(stdout, /token 中位数：110；n=1\/1；unknown=0；partial=0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI keeps PM usage on a shared self-referencing source unallocated and marks both Task samples partial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-shared-steer-'));
  try {
    const db = database(root);
    project(db);
    put(db, 'message', { id: 'steer', projectId: 'p', sourceMessageId: 'steer' });
    put(db, 'message', { id: 'reply', projectId: 'p', sourceMessageId: 'steer' });
    task(db, 'a', 'p', { sourceMessageId: 'steer' });
    task(db, 'b', 'p', { sourceMessageId: 'reply' });
    merged(db, 'a');
    merged(db, 'b');
    run(db, 'dev-a', 'a', 10);
    run(db, 'dev-b', 'b', 20);
    run(db, 'shared-pm', undefined, 100, { role: 'pm', sourceMessageId: 'reply' });
    put(db, 'clarification', {
      id: 'before-publication',
      projectId: 'p',
      sourceMessageId: 'steer',
      status: 'cancelled',
      createdAt: '2025-12-31T23:59:00Z',
    });
    db.close();

    const { stdout } = await report(root);
    assert.match(stdout, /确认无干预：0；确认有干预：2；未知：0/);
    assert.match(stdout, /未归属干预：Incident=0；暂停\/恢复\/取消=0；Clarification=0/);
    assert.match(
      stdout,
      /PM 未分配：Run=1；已知 token=100；usage unknown=0；partial=0；歧义影响 Task=a,b/,
    );
    assert.match(stdout, /Task a a：token=partial\(已知=10\)/);
    assert.match(stdout, /Task b b：token=partial\(已知=20\)/);
    assert.match(stdout, /token 中位数：N\/A；n=0\/2；unknown=0；partial=2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI leaves a genuine multi-message source cycle unknown rather than assigning its Clarification or PM Run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-report-source-cycle-'));
  try {
    const db = database(root);
    project(db);
    put(db, 'message', { id: 'cycle-a', projectId: 'p', sourceMessageId: 'cycle-b' });
    put(db, 'message', { id: 'cycle-b', projectId: 'p', sourceMessageId: 'cycle-a' });
    task(db, 'a', 'p', { sourceMessageId: 'cycle-a' });
    merged(db, 'a');
    run(db, 'dev-a', 'a', 10);
    run(db, 'pm-a', undefined, 100, { role: 'pm', sourceMessageId: 'cycle-b' });
    put(db, 'clarification', {
      id: 'cycle-clarification',
      projectId: 'p',
      sourceMessageId: 'cycle-a',
      status: 'answered',
      createdAt: '2025-12-31T23:59:00Z',
    });
    db.close();

    const { stdout } = await report(root);
    assert.match(stdout, /确认无干预：0；确认有干预：0；未知：1/);
    assert.match(stdout, /未归属干预：Incident=0；暂停\/恢复\/取消=0；Clarification=1/);
    assert.match(stdout, /PM 未分配：Run=1；已知 token=100/);
    assert.match(stdout, /Task a a：.*干预=unknown/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
