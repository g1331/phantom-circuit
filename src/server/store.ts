import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  Project,
  Repo,
  Task,
  Run,
  Message,
  Settings,
  Snapshot,
  Event,
  Operation,
  ProfileName,
} from '../shared/types.ts';

export class Fault extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export function redact(value: string): string {
  return value
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g,
      '<REDACTED>',
    )
    .replace(
      /((?:authorization|api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)([^\s,;]+)/gi,
      '$1<REDACTED>',
    );
}
export const defaults: Settings = {
  globalDevLimit: 4,
  reviewLimit: 2,
  profiles: {
    backend: { model: 'gpt-5.6-luna', effort: 'max' },
    frontend: { model: 'gpt-6-astra', effort: 'low' },
    fullstack: { model: 'gpt-6-astra', effort: 'low' },
    complex: { model: 'gpt-6-astra', effort: 'medium' },
    pm: { model: 'gpt-6-astra', effort: 'medium' },
    review: { model: 'gpt-6-astra', effort: 'medium' },
  },
};
type Entities = {
  project: Project;
  repo: Repo;
  task: Task;
  run: Run;
  message: Message;
  operation: Operation;
  settings: Settings;
};
export class Store {
  private db: DatabaseSync;
  readonly changes = new EventEmitter();
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    if (!this.get('settings', 'global')) this.put('settings', 'global', structuredClone(defaults));
  }
  close() {
    this.db.close();
  }
  get<K extends keyof Entities>(kind: K, key: string): Entities[K] | undefined {
    const row = this.db
      .prepare('SELECT body FROM documents WHERE kind=? AND id=?')
      .get(kind, key) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  list<K extends keyof Entities>(kind: K): Entities[K][] {
    return (
      this.db.prepare('SELECT body FROM documents WHERE kind=? ORDER BY rowid').all(kind) as {
        body: string;
      }[]
    ).map((x) => JSON.parse(x.body));
  }
  put<K extends keyof Entities>(kind: K, key: string, value: Entities[K]) {
    this.db
      .prepare(
        'INSERT INTO documents VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body',
      )
      .run(kind, key, JSON.stringify(value));
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      this.changes.emit('change');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  project(key: string) {
    const x = this.get('project', key);
    if (!x) throw new Fault('项目不存在', 404);
    return x;
  }
  repo(key: string) {
    const x = this.get('repo', key);
    if (!x) throw new Fault('仓库不存在', 404);
    return x;
  }
  task(key: string) {
    const x = this.get('task', key);
    if (!x) throw new Fault('任务不存在', 404);
    return x;
  }
  settings() {
    return this.get('settings', 'global')!;
  }
  saveSettings(settings: Settings) {
    this.put('settings', 'global', settings);
    this.event('settings', '运行配置已更新');
    return settings;
  }
  event(
    type: string,
    message: string,
    refs: Partial<Pick<Event, 'projectId' | 'taskId' | 'runId'>> = {},
  ) {
    const event = { at: now(), type, message: redact(message).slice(-16000), ...refs };
    const result = this.db
      .prepare('INSERT INTO events(body) VALUES (?)')
      .run(JSON.stringify(event));
    this.changes.emit('event', { ...event, id: Number(result.lastInsertRowid) });
  }
  events(): Event[] {
    return (
      this.db.prepare('SELECT id,body FROM events ORDER BY id DESC LIMIT 200').all() as {
        id: number;
        body: string;
      }[]
    ).map((x) => ({ ...JSON.parse(x.body), id: x.id }));
  }
  snapshot(): Snapshot {
    return {
      projects: this.list('project'),
      repos: this.list('repo'),
      tasks: this.list('task'),
      runs: this.list('run'),
      messages: this.list('message'),
      events: this.events(),
      settings: this.settings(),
    };
  }
  createProject(name: string, description: string) {
    const p: Project = { id: id(), name, description, devLimit: 4, createdAt: now() };
    this.put('project', p.id, p);
    this.event('project', '项目已创建', { projectId: p.id });
    return p;
  }
  createRepo(
    input: Pick<Repo, 'projectId' | 'name' | 'path' | 'github' | 'defaultBranch' | 'authorized'>,
  ) {
    const p = this.project(input.projectId);
    if (
      this.list('repo').some(
        (r) =>
          r.path.toLowerCase() === input.path.toLowerCase() ||
          r.github.toLowerCase() === input.github.toLowerCase(),
      )
    )
      throw new Fault('该仓库已经接入');
    const r: Repo = {
      ...input,
      id: id(),
      enabled: false,
      devLimit: 2,
      commands: { install: '', build: '', test: '', start: '', port: 3000 },
      requiredChecks: [],
    };
    this.put('repo', r.id, r);
    if (!p.primaryRepoId) {
      p.primaryRepoId = r.id;
      this.put('project', p.id, p);
    }
    this.event('repo', '仓库已接入，默认停止新认领', { projectId: p.id });
    return r;
  }
  patchRepo(
    key: string,
    patch: Partial<
      Pick<
        Repo,
        | 'enabled'
        | 'authorized'
        | 'devLimit'
        | 'commands'
        | 'requiredChecks'
        | 'blocked'
        | 'milestone'
        | 'preview'
      >
    >,
  ) {
    const r = this.repo(key);
    if (patch.enabled && !(patch.authorized ?? r.authorized))
      throw new Fault('先授权此仓库的任务、PR、分支及合并操作');
    Object.assign(r, patch);
    this.put('repo', key, r);
    this.event('repo', '仓库配置已更新', { projectId: r.projectId });
    return r;
  }
  addMessage(
    projectId: string,
    role: Message['role'],
    content: string,
    intent?: Message['intent'],
  ) {
    this.project(projectId);
    const m: Message = {
      id: id(),
      projectId,
      role,
      content: redact(content),
      intent,
      createdAt: now(),
    };
    this.put('message', m.id, m);
    this.event('message', role === 'user' ? '收到你的消息' : 'PM 更新了对话', { projectId });
    return m;
  }
  createTask(
    input: Pick<
      Task,
      | 'projectId'
      | 'repoId'
      | 'sourceMessageId'
      | 'title'
      | 'spec'
      | 'acceptance'
      | 'dependencies'
      | 'kind'
      | 'complexity'
      | 'priority'
    >,
  ) {
    if (this.repo(input.repoId).projectId !== input.projectId)
      throw new Fault('任务仓库不属于当前项目');
    const source = this.get('message', input.sourceMessageId);
    if (
      !source ||
      source.projectId !== input.projectId ||
      source.role !== 'user' ||
      !['implement', 'feedback'].includes(source.intent ?? '')
    )
      throw new Fault('只有明确实施的用户需求可以派生任务');
    const existing = this.list('task').find(
      (t) =>
        t.sourceMessageId === input.sourceMessageId &&
        t.repoId === input.repoId &&
        t.title.trim().toLowerCase() === input.title.trim().toLowerCase(),
    );
    if (existing) return existing;
    for (const dep of input.dependencies) {
      if (this.task(dep).projectId !== input.projectId) throw new Fault('依赖必须属于当前项目');
    }
    const profile: ProfileName = input.complexity === 'complex' ? 'complex' : input.kind;
    const task: Task = {
      ...input,
      id: id(),
      profile,
      routingReason:
        input.complexity === 'complex' ? '复杂任务使用 Astra medium' : `${input.kind} 类型默认档位`,
      stage: 'ready',
      control: 'active',
      reviews: [],
      tests: [],
      retries: 0,
      feedback: [],
      createdAt: now(),
      updatedAt: now(),
    };
    this.put('task', task.id, task);
    this.event('task', `任务已准备：${task.title}`, { projectId: task.projectId, taskId: task.id });
    return task;
  }
  updateTask(key: string, patch: Partial<Task>) {
    const t = { ...this.task(key), ...patch, updatedAt: now() };
    this.put('task', key, t);
    this.changes.emit('change');
    return t;
  }
  run(role: Run['role'], projectId: string, profile: ProfileName, task?: Task): Run {
    const r: Run = {
      id: id(),
      projectId,
      role,
      profile,
      status: 'running',
      startedAt: now(),
      taskId: task?.id,
      repoId: task?.repoId,
    };
    this.put('run', r.id, r);
    return r;
  }
  finishRun(key: string, status: Run['status'], error?: string) {
    const r = this.get('run', key);
    if (!r) return;
    Object.assign(r, { status, error: error ? redact(error) : undefined, endedAt: now() });
    this.put('run', key, r);
    this.event('run', error ?? `${r.role} ${status}`, {
      projectId: r.projectId,
      taskId: r.taskId,
      runId: r.id,
    });
  }
  activeRuns() {
    return this.list('run').filter((r) => r.status === 'running' || r.status === 'waiting');
  }
  claimNext(): Run | undefined {
    return this.transaction(() => {
      const active = this.activeRuns().filter((r) => r.role === 'dev');
      const settings = this.settings();
      if (active.length >= settings.globalDevLimit) return;
      const projects = this.list('project');
      const cursor = (
        this.db.prepare("SELECT value FROM meta WHERE key='cursor'").get() as
          { value: string } | undefined
      )?.value;
      const start = cursor ? Math.max(0, projects.findIndex((p) => p.id === cursor) + 1) : 0;
      const tasks = this.list('task').sort(
        (a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt),
      );
      for (let offset = 0; offset < projects.length; offset++) {
        const p = projects[(start + offset) % projects.length];
        if (active.filter((r) => r.projectId === p.id).length >= p.devLimit) continue;
        for (const t of tasks.filter((t) => t.projectId === p.id)) {
          if (t.control !== 'active' || t.blocked || !['ready', 'developing'].includes(t.stage))
            continue;
          const repo = this.repo(t.repoId);
          if (!repo.authorized || repo.blocked || (t.stage === 'ready' && !repo.enabled)) continue;
          if (this.activeRuns().some((r) => r.taskId === t.id)) continue;
          if (active.filter((r) => r.repoId === repo.id).length >= repo.devLimit) continue;
          if (t.dependencies.some((key) => this.task(key).stage !== 'done')) continue;
          t.stage = 'developing';
          this.put('task', t.id, t);
          const r = this.run('dev', p.id, t.profile, t);
          this.db
            .prepare(
              "INSERT INTO meta VALUES ('cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            )
            .run(p.id);
          return r;
        }
      }
    });
  }
  control(key: string, action: 'pause' | 'resume' | 'cancel') {
    const t = this.task(key);
    if (['done', 'cancelled'].includes(t.stage)) throw new Fault('任务已经结束');
    if (action === 'cancel') this.updateTask(key, { stage: 'cancelled', control: 'paused' });
    else
      this.updateTask(key, {
        control: action === 'pause' ? 'paused' : 'active',
        blocked: action === 'resume' ? undefined : t.blocked,
      });
    this.event('task', `任务 ${action}`, { projectId: t.projectId, taskId: key });
  }
  recover() {
    for (const r of this.activeRuns()) {
      this.finishRun(r.id, 'interrupted', '服务重启；保留工作区，等待恢复核对');
      if (r.taskId)
        this.updateTask(r.taskId, {
          control: 'paused',
          blocked: '运行中断：恢复前需核对工作区和远端状态',
        });
    }
    for (const r of this.list('repo'))
      if (r.preview?.status === 'running' || r.preview?.status === 'starting')
        this.patchRepo(r.id, {
          preview: { status: 'stopped', error: '服务重启，体验环境需重新启动' },
        });
  }
}
