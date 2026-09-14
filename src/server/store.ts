import {
  comparePriority,
  priorityValues,
  type PriorityLevel,
  type PriorityChange,
} from '../shared/priority.ts';
import { creationPriorityInput, priorityUpdateInput, settingsSchema } from './schemas.ts';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { officialProvider, type Provider } from '../shared/types.ts';
import type {
  SchedulingExplanation,
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
  DesignDocument,
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
    backend: { providerId: 'codex', model: 'gpt-5.6-luna', effort: 'max' },
    frontend: { providerId: 'codex', model: 'gpt-6-astra', effort: 'low' },
    fullstack: { providerId: 'codex', model: 'gpt-6-astra', effort: 'low' },
    complex: { providerId: 'codex', model: 'gpt-6-astra', effort: 'medium' },
    pm: { providerId: 'codex', model: 'gpt-6-astra', effort: 'medium' },
    review: { providerId: 'codex', model: 'gpt-6-astra', effort: 'medium' },
  },
};
type Entities = {
  provider: Provider;
  project: Project;
  repo: Repo;
  task: Task;
  run: Run;
  message: Message;
  operation: Operation;
  settings: Settings;
  document: DesignDocument;
};
export class Store {
  private db: DatabaseSync;
  readonly changes = new EventEmitter();
  constructor(readonly file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.transaction(() => {
      if (!this.db.prepare("SELECT value FROM meta WHERE key='priority-contract-v1'").get()) {
        // Legacy claimNext used list('task') ORDER BY rowid for exact ties.
        this.list('task').forEach((task, index) =>
          this.put('task', task.id, { ...task, legacyPriorityOrder: index }),
        );
        this.db.prepare("INSERT INTO meta VALUES ('priority-contract-v1','1')").run();
      }
    });
    if (!this.get('settings', 'global')) this.put('settings', 'global', structuredClone(defaults));
    this.transaction(() => {
      const settings = this.settings();
      for (const profile of Object.values(settings.profiles)) profile.providerId ??= 'codex';
      this.put('settings', 'global', settings);
      for (const project of this.list('project')) {
        if (!project.profiles) {
          project.profiles = structuredClone(settings.profiles);
          this.put('project', project.id, project);
        }
      }
    });
  }
  close() {
    this.db.close();
  }
  deleteProvider(key: string) {
    this.assertProviderUnused(key);
    this.db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run('provider', key);
    this.changes.emit('change');
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
    settings = settingsSchema.parse(settings);
    this.validateProfiles(settings.profiles);
    this.put('settings', 'global', settings);
    this.event('settings', '运行配置已更新');
    return settings;
  }
  private validateProfiles(profiles: Settings['profiles']) {
    settingsSchema.shape.profiles.parse(profiles);
    for (const [role, profile] of Object.entries(profiles)) {
      if (profile.providerId !== 'codex' && !this.get('provider', profile.providerId))
        throw new Fault(`${role}: Provider 不存在：${profile.providerId}`, 409);
    }
  }
  assertProviderUnused(providerId: string) {
    const references: string[] = [];
    const inspect = (name: string, profiles: Settings['profiles']) => {
      for (const [role, profile] of Object.entries(profiles))
        if (profile.providerId === providerId) references.push(`${name} / ${role}`);
    };
    inspect('全局默认值', this.settings().profiles);
    for (const project of this.list('project'))
      inspect(`Project ${project.name} (${project.id})`, project.profiles);
    for (const run of this.activeRuns())
      if (run.profileConfig?.providerId === providerId)
        references.push(`进行中的 Run ${run.id} / ${run.role}`);
    if (references.length) throw new Fault(`Provider 仍被引用：${references.join('；')}`, 409);
  }
  saveProjectProfiles(projectId: string, profiles: Settings['profiles']) {
    this.validateProfiles(profiles);
    return this.transaction(() => {
      const project = this.project(projectId);
      const changed = (Object.keys(profiles) as ProfileName[]).filter(
        (role) => profiles[role].providerId !== project.profiles[role].providerId,
      );
      if (changed.length) project.profileVersion = (project.profileVersion ?? 0) + 1;
      if (changed.includes('pm')) {
        delete project.pmThreadId;
        delete project.pmThreadProviderId;
      }
      for (const task of this.list('task')) {
        if (task.projectId === projectId && changed.includes(task.profile)) {
          delete task.devThreadId;
          delete task.devThreadProviderId;
          this.put('task', task.id, task);
        }
      }
      project.profiles = structuredClone(profiles);
      this.put('project', projectId, project);
      this.event('project', '项目模型分配已更新', { projectId });
      return project;
    });
  }
  bindRunThread(run: Run, threadId: string) {
    this.put('run', run.id, { ...this.get('run', run.id)!, threadId });
    const project = this.project(run.projectId);
    // A late reply must not restore a binding invalidated while this Run was in flight.
    if ((project.profileVersion ?? 0) !== (run.profileVersion ?? 0)) return;
    if (run.role === 'pm')
      this.put('project', project.id, {
        ...project,
        pmThreadId: threadId,
        pmThreadProviderId: run.profileConfig?.providerId ?? 'codex',
      });
    if (run.role === 'dev' && run.taskId)
      this.updateTask(run.taskId, {
        devThreadId: threadId,
        devThreadProviderId: run.profileConfig?.providerId ?? 'codex',
      });
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
  /**
   * Every durable event recorded against one task, oldest first.
   *
   * `events()` above is a bounded feed for the UI, so it stops answering "did the host ever
   * coordinate a merge for this task?" once unrelated events have accumulated. That question must
   * stay answerable for as long as the task exists: it is one of the host records a legacy
   * in-progress merge is verified against when its source branch has moved on.
   */
  taskEvents(taskId: string): Event[] {
    const pattern = `%"taskId":"${taskId.replace(/[\\%_]/g, '\\$&')}"%`;
    return (
      this.db
        .prepare("SELECT id,body FROM events WHERE body LIKE ? ESCAPE '\\' ORDER BY id")
        .all(pattern) as { id: number; body: string }[]
    )
      .map((row) => ({ ...(JSON.parse(row.body) as Omit<Event, 'id'>), id: row.id }))
      .filter((event) => event.taskId === taskId);
  }
  snapshot(): Snapshot {
    return {
      providers: [{ ...officialProvider }, ...this.list('provider')],
      projects: this.list('project'),
      repos: this.list('repo'),
      tasks: this.list('task'),
      runs: this.list('run'),
      messages: this.list('message'),
      events: this.events(),
      settings: this.settings(),
      documents: this.list('document'),
    };
  }
  createProject(name: string, description: string) {
    return this.transaction(() => {
      const p: Project = {
        id: id(),
        name,
        description,
        devLimit: 4,
        createdAt: now(),
        profiles: this.settings().profiles,
      };
      this.put('project', p.id, p);
      this.event('project', '项目已创建', { projectId: p.id });
      return p;
    });
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
    attachments?: Message['attachments'],
    messageId = id(),
  ) {
    this.project(projectId);
    const m: Message = {
      id: messageId,
      projectId,
      role,
      content: redact(content),
      intent,
      ...(attachments?.length ? { attachments } : {}),
      createdAt: now(),
      ...(role === 'user' ? { status: 'queued' as const } : {}),
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
    > &
      Pick<Task, 'documentChanges'> & { priority: number | PriorityLevel; priorityReason?: string },
    prioritySource?: Pick<PriorityChange, 'actor' | 'runId'>,
  ) {
    const priorityInput = creationPriorityInput.parse(input);
    const priority =
      typeof priorityInput.priority === 'number'
        ? priorityInput.priority
        : priorityValues[priorityInput.priority];
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
      priority,
      priorityVersion: 0,
      priorityReason: priorityInput.priorityReason,
      priorityHistory: priorityInput.priorityReason
        ? [
            {
              requestId: `create:${input.sourceMessageId}:${input.title}`,
              expectedVersion: 0,
              oldValue: null,
              newValue: priority,
              reason: priorityInput.priorityReason,
              actor: prioritySource?.actor ?? 'pm',
              runId: prioritySource?.runId,
              sourceMessageId: input.sourceMessageId,
              at: now(),
            },
          ]
        : [],
      id: id(),
      profile,
      routingReason:
        input.complexity === 'complex'
          ? '复杂任务使用项目 complex 档位'
          : `${input.kind} 类型项目档位`,
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
  setTaskPriority(
    projectId: string,
    request: unknown,
    source: Pick<PriorityChange, 'actor' | 'sourceMessageId' | 'runId'>,
  ) {
    const input = priorityUpdateInput.parse(request);
    return this.transaction(() => {
      const task = this.task(input.taskId);
      if (task.projectId !== projectId) throw new Fault('跨项目操作被拒绝', 403);
      const previous = task.priorityHistory?.find((entry) => entry.requestId === input.requestId);
      if (previous) {
        if (
          previous.newValue !== priorityValues[input.level] ||
          previous.reason !== input.reason ||
          previous.actor !== source.actor ||
          previous.expectedVersion !== input.expectedVersion
        )
          throw new Fault('Request ID already used with different input', 409);
        return task;
      }
      if (['done', 'cancelled'].includes(task.stage)) throw new Fault('任务已经结束', 409);
      if ((task.priorityVersion ?? 0) !== input.expectedVersion)
        throw new Fault('Priority version conflict; refresh and retry', 409);
      const at = now();
      const entry: PriorityChange = {
        ...source,
        requestId: input.requestId,
        expectedVersion: input.expectedVersion,
        oldValue: task.priority,
        newValue: priorityValues[input.level],
        reason: input.reason,
        at,
      };
      const updated: Task = {
        ...task,
        priority: entry.newValue,
        priorityReason: entry.reason,
        priorityVersion: input.expectedVersion + 1,
        priorityHistory: [...(task.priorityHistory ?? []), entry],
        updatedAt: at,
      };
      this.put('task', task.id, updated);
      return updated;
    });
  }
  recordDocument(
    projectId: string,
    input: Pick<DesignDocument, 'repoId' | 'path' | 'content' | 'accepted'>,
  ) {
    if (this.repo(input.repoId).projectId !== projectId) throw new Fault('文档仓库不属于项目');
    if (!/^(CONTEXT\.md|CONTEXT-MAP\.md|docs\/adr\/\d{4}-[a-z0-9-]+\.md)$/.test(input.path))
      throw new Fault('领域文档路径必须使用已约定的词汇表或 ADR 格式');
    const old = this.list('document').find(
      (d) => d.repoId === input.repoId && d.path === input.path,
    );
    const doc: DesignDocument = {
      ...input,
      projectId,
      id: old?.id ?? id(),
      content: redact(input.content),
      version: (old?.version ?? 0) + 1,
      updatedAt: now(),
    };
    this.put('document', doc.id, doc);
    this.event('design', `PM 已记录${doc.accepted ? '接受的设计' : '设计草案'}：${doc.path}`, {
      projectId,
    });
    return doc;
  }
  updateTask(key: string, patch: Partial<Task>) {
    const t = { ...this.task(key), ...patch, updatedAt: now() };
    this.put('task', key, t);
    this.changes.emit('change');
    return t;
  }
  run(role: Run['role'], projectId: string, profile: ProfileName, task?: Task): Run {
    const project = this.project(projectId);
    const profileConfig = project.profiles[profile];
    const provider =
      profileConfig.providerId === 'codex'
        ? officialProvider
        : this.get('provider', profileConfig.providerId);
    if (!provider) throw new Fault(`Provider 不存在：${profileConfig.providerId}`, 409);
    const r: Run = {
      id: id(),
      projectId,
      role,
      profile,
      profileConfig: { ...profileConfig },
      provider: {
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
      },
      profileVersion: project.profileVersion ?? 0,
      resumeThreadId:
        role === 'pm' && (project.pmThreadProviderId ?? 'codex') === profileConfig.providerId
          ? project.pmThreadId
          : role === 'dev' && (task?.devThreadProviderId ?? 'codex') === profileConfig.providerId
            ? task?.devThreadId
            : undefined,
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
  private schedulingSnapshot() {
    const snapshot = {
      projects: this.list('project'),
      repos: this.list('repo'),
      tasks: this.list('task'),
      runs: this.list('run'),
      settings: this.settings(),
    };
    const cursor = (
      this.db.prepare("SELECT value FROM meta WHERE key='cursor'").get() as
        { value: string } | undefined
    )?.value;
    const start = cursor ? Math.max(0, snapshot.projects.findIndex((p) => p.id === cursor) + 1) : 0;
    const projects = [...snapshot.projects.slice(start), ...snapshot.projects.slice(0, start)];
    const active = snapshot.runs.filter((r) => ['running', 'waiting'].includes(r.status));
    const dev = active.filter((r) => r.role === 'dev');
    const at = now();
    return projects.map((project) => {
      const tasks = snapshot.tasks
        .filter((t) => t.projectId === project.id)
        .sort(comparePriority)
        .map((task) => {
          const reasons: SchedulingExplanation['tasks'][number]['reasons'] = [];
          const repo = snapshot.repos.find((r) => r.id === task.repoId)!;
          if (task.control !== 'active') reasons.push({ code: 'paused' });
          if (task.blocked) reasons.push({ code: 'blocked', detail: task.blocked });
          if (task.pendingFeedback?.length) reasons.push({ code: 'feedback' });
          if (!['ready', 'developing'].includes(task.stage))
            reasons.push({ code: 'stage', detail: task.stage });
          if (!repo.authorized) reasons.push({ code: 'unauthorized' });
          if (repo.blocked) reasons.push({ code: 'repositoryBlocked', detail: repo.blocked });
          if (task.stage === 'ready' && !repo.enabled) reasons.push({ code: 'workSwitch' });
          for (const run of active.filter((r) => r.taskId === task.id))
            reasons.push({ code: 'activeRun', detail: run.id });
          for (const key of task.dependencies) {
            const dependency = snapshot.tasks.find((t) => t.id === key);
            if (dependency?.stage !== 'done')
              reasons.push({ code: 'dependency', detail: dependency?.title ?? key });
          }
          if (dev.length >= snapshot.settings.globalDevLimit)
            reasons.push({ code: 'globalCapacity' });
          if (dev.filter((r) => r.projectId === project.id).length >= project.devLimit)
            reasons.push({ code: 'projectCapacity' });
          if (dev.filter((r) => r.repoId === repo.id).length >= repo.devLimit)
            reasons.push({ code: 'repositoryCapacity' });
          return {
            taskId: task.id,
            title: task.title,
            priority: task.priority,
            stage: task.stage,
            reasons,
          };
        });
      return {
        projectId: project.id,
        at,
        projectOrder: projects.map((p) => p.id),
        tasks,
        candidates: tasks.filter((t) => !t.reasons.length).map((t) => t.taskId),
      };
    });
  }
  explainScheduling(projectId: string): SchedulingExplanation {
    this.project(projectId);
    this.db.exec('BEGIN');
    try {
      const result = this.schedulingSnapshot().find((p) => p.projectId === projectId)!;
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  claimNext(): Run | undefined {
    return this.transaction(() => {
      const candidate = this.schedulingSnapshot().find((p) => p.candidates.length)?.candidates[0];
      if (!candidate) return;
      const task = this.task(candidate);
      task.stage = 'developing';
      this.put('task', task.id, task);
      const run = this.run('dev', task.projectId, task.profile, task);
      this.db
        .prepare(
          "INSERT INTO meta VALUES ('cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(task.projectId);
      return run;
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
    for (const m of this.list('message'))
      if (m.role === 'user' && m.status === 'running') {
        this.put('message', m.id, { ...m, status: 'failed' });
        this.addMessage(
          m.projectId,
          'system',
          '上次 PM 响应被中断，已保留会话和已创建的任务；可重新发送该消息继续。',
        );
      }
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
