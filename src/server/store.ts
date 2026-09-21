import {
  comparePriority,
  priorityValues,
  type PriorityLevel,
  type PriorityChange,
} from '../shared/priority.ts';
import {
  clarificationInput,
  creationPriorityInput,
  incidentInput,
  priorityUpdateInput,
  profileSetSchema,
  settingsSchema,
} from './schemas.ts';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { redact, bounded } from './redaction.ts';
export { redact } from './redaction.ts';
import { aggregateCosts, costForUsage, normalizeUsage, type UsageMode } from './usage.ts';
import { officialProvider, type Provider } from '../shared/types.ts';
import type {
  AccountAllowance,
  AgentKind,
  AgentSelection,
  Clarification,
  ClarificationAnswer,
  ClarificationQuestion,
  CostEstimate,
  Incident,
  ModelIdentity,
  OmpProfileInitialization,
  OmpRoleDefault,
  Profile,
  ProfileMode,
  RecoveryItem,
  RecoveryPolicy,
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
  PMActivity,
  PriceSnapshot,
  RunUsage,
  UsageAggregate,
  MessageDescriptor,
} from '../shared/types.ts';

export class Fault extends Error {
  constructor(
    message: string,
    public status = 400,
    public descriptor?: MessageDescriptor,
  ) {
    super(message);
  }
}
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
const profileNames = ['backend', 'frontend', 'fullstack', 'complex', 'pm', 'review'] as const;
type ProfileMap = Record<(typeof profileNames)[number], Profile>;

const codexProfiles: ProfileMap = {
  backend: { providerId: 'codex', model: 'gpt-5.6-luna', effort: 'max' },
  frontend: { providerId: 'codex', model: 'gpt-6-astra', effort: 'low' },
  fullstack: { providerId: 'codex', model: 'gpt-6-astra', effort: 'low' },
  complex: { providerId: 'codex', model: 'gpt-6-astra', effort: 'medium' },
  pm: { providerId: 'codex', model: 'gpt-6-astra', effort: 'medium' },
  review: { providerId: 'codex', model: 'gpt-6-astra', effort: 'medium' },
};

// Role names are a one-time snapshot of OMP's modelRoles config. The actual model IDs are loaded
// by agent-settings.ts from OMP at startup; Store must not invent or persist a user model seed.
export const ompProfileInitialization: OmpProfileInitialization = {
  source: 'omp.modelRoles',
  roleDefaults: {
    backend: 'default',
    frontend: 'default',
    fullstack: 'default',
    complex: 'slow',
    pm: 'slow',
    review: 'slow',
  },
};

const ompConfigRequired: Profile = {
  providerId: 'config-required',
  model: 'config-required',
  effort: 'config-required',
};
const ompRoleProfiles: Record<OmpRoleDefault, Profile> = {
  default: ompConfigRequired,
  slow: ompConfigRequired,
  advisor: ompConfigRequired,
};
const ompSecondaryReviewProfile: Profile = structuredClone(ompConfigRequired);

/** Shape an OMP role mapping; model IDs are replaced by agent-settings bootstrap. */
export function initializeOmpProfiles(
  roleDefaults: Partial<Record<ProfileName, OmpRoleDefault>> = {},
): ProfileMap {
  return Object.fromEntries(
    profileNames.map((role) => {
      const roleDefault = roleDefaults[role] ?? ompProfileInitialization.roleDefaults[role];
      return [role, structuredClone(ompRoleProfiles[roleDefault])];
    }),
  ) as ProfileMap;
}

export const defaults: Settings = {
  globalDevLimit: 4,
  reviewLimit: 2,
  defaultAgent: 'omp',
  profiles: structuredClone(codexProfiles),
  ompProfiles: initializeOmpProfiles(),
  ompProfileInitialization: structuredClone(ompProfileInitialization),
  secondaryReviewProfiles: { omp: structuredClone(ompSecondaryReviewProfile) },
};
type Entities = {
  event: Event;
  activity: PMActivity;
  provider: Provider;
  project: Project;
  repo: Repo;
  task: Task;
  run: Run;
  message: Message;
  operation: Operation;
  incident: Incident;
  clarification: Clarification;
  recovery: RecoveryItem;
  allowance: AccountAllowance;
  settings: Settings;
  document: DesignDocument;
};

const pmRunTitles: Partial<Record<Run['status'], string>> = {
  completed: 'PM 运行完成',
  failed: 'PM 运行失败',
  interrupted: 'PM 运行中断',
  paused: 'PM 运行暂停',
};

function pinnedModes(): Record<ProfileName, ProfileMode> {
  return Object.fromEntries(profileNames.map((name) => [name, 'pinned'])) as Record<
    ProfileName,
    ProfileMode
  >;
}

function inheritedModes(): Record<ProfileName, ProfileMode> {
  return Object.fromEntries(profileNames.map((name) => [name, 'inherit'])) as Record<
    ProfileName,
    ProfileMode
  >;
}

function normalizeProfileMap(
  value: Partial<ProfileMap> | undefined,
  fallback: ProfileMap,
): ProfileMap {
  return Object.fromEntries(
    profileNames.map((name) => [name, structuredClone({ ...fallback[name], ...value?.[name] })]),
  ) as ProfileMap;
}

function normalizeSettings(value: Settings): Settings {
  return {
    ...value,
    profiles: normalizeProfileMap(value.profiles, codexProfiles),
    ompProfiles: normalizeProfileMap(value.ompProfiles, initializeOmpProfiles()),
    ompProfileInitialization: value.ompProfileInitialization
      ? structuredClone(value.ompProfileInitialization)
      : structuredClone(ompProfileInitialization),
    defaultAgent: value.defaultAgent ?? 'omp',
    secondaryReviewProfiles: {
      ...(value.secondaryReviewProfiles ? structuredClone(value.secondaryReviewProfiles) : {}),
      ...(value.secondaryReviewProfile && !value.secondaryReviewProfiles?.codex
        ? { codex: structuredClone(value.secondaryReviewProfile) }
        : {}),
      ...(value.secondaryReviewProfiles?.omp
        ? {}
        : { omp: structuredClone(ompSecondaryReviewProfile) }),
    },
  };
}

export interface RunOptions {
  profile?: ProfileName;
  secondaryReview?: boolean;
  secondaryProfile?: Profile;
  secondaryReviewProfile?: Profile;
  sourceMessageId?: string;
  suppressSource?: boolean;
  source?: { messageId?: string } | string;
  recoveryItemId?: string;
  recovery?: RecoveryItem | string;
  agentVersion?: string;
  priceSnapshot?: PriceSnapshot;
  usage?: RunUsage;
  revision?: { head?: string; base?: string };
  reviewAxis?: Run['reviewAxis'];
  incidentId?: string;
  incidentPhase?: string;
  incidentEvidence?: string;
}

export interface MessageOptions {
  deliveryMode?: Message['deliveryMode'];
  runId?: string;
  sourceMessageId?: string;
  draftId?: string;
  draftStatus?: Message['draftStatus'];
}

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
    this.transaction(() => {
      const storedSettings = this.get('settings', 'global');
      const settings = normalizeSettings(storedSettings ?? structuredClone(defaults));
      this.put('settings', 'global', settings);
      for (const project of this.list('project')) {
        let changed = false;
        const hadProfiles = !!project.profiles;
        if (!project.profiles) {
          project.profiles = structuredClone(settings.profiles);
          changed = true;
        }
        if (!project.ompProfiles) {
          project.ompProfiles = structuredClone(settings.ompProfiles);
          changed = true;
        }
        if (!hadProfiles || !project.agentSelection) {
          // A persisted Project predates agent inheritance. Keep its historical Codex behavior.
          project.agentSelection = { mode: 'override', agent: 'codex' };
          changed = true;
        }
        if (!hadProfiles || !project.profileModes) {
          project.profileModes = pinnedModes();
          changed = true;
        }
        if (!hadProfiles || !project.recoveryPolicy) {
          project.recoveryPolicy = 'automatic';
          changed = true;
        }
        project.profileVersion ??= 0;
        if (changed) this.put('project', project.id, project);
      }
      for (const task of this.list('task')) {
        if (task.reviewPolicyVersion === undefined && task.stage !== 'done') {
          this.put('task', task.id, { ...task, reviewPolicyVersion: 2 });
        }
      }
      for (const message of this.list('message')) {
        const next = {
          ...message,
          deliveryMode: message.deliveryMode ?? 'queue',
          draftId: message.draftId ?? message.id,
          draftStatus:
            message.draftStatus ??
            (message.status === 'queued'
              ? 'queued'
              : message.status === 'running'
                ? 'running'
                : message.status === 'completed'
                  ? 'completed'
                  : message.status === 'failed'
                    ? 'failed'
                    : message.role === 'user'
                      ? 'draft'
                      : undefined),
        };
        if (
          next.deliveryMode !== message.deliveryMode ||
          next.draftId !== message.draftId ||
          next.draftStatus !== message.draftStatus
        )
          this.put('message', message.id, next);
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
    if (kind === 'event') return this.events() as Entities[K][];
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
    const previous = this.settings();
    settings = normalizeSettings(settingsSchema.parse(settings) as Settings);
    this.validateProfiles(settings.profiles, 'codex');
    // OMP profile provider IDs are resolved by OMP and are deliberately not required to exist in
    // the local Provider table. Validate the shape, but never ask Providers for credentials here.
    profileSetSchema.parse(settings.ompProfiles);
    this.transaction(() => {
      this.put('settings', 'global', settings);
      this.invalidateInheritedThreads(previous, settings);
    });
    this.event('settings', '运行配置已更新');
    return settings;
  }
  private validateProfiles(profiles: Settings['profiles'], agent: AgentKind = 'codex') {
    profileSetSchema.parse(profiles);
    if (agent === 'omp') return;
    for (const [role, profile] of Object.entries(profiles)) {
      if (profile.providerId !== 'codex' && !this.get('provider', profile.providerId))
        throw new Fault(`${role}: Provider 不存在：${profile.providerId}`, 409);
    }
  }

  private effectiveAgent(project: Project, settings = this.settings()): AgentKind {
    return project.agentSelection?.mode === 'override'
      ? project.agentSelection.agent
      : (settings.defaultAgent ?? 'codex');
  }

  private invalidateInheritedThreads(previous: Settings, next: Settings) {
    for (const project of this.list('project')) {
      const selection = project.agentSelection ?? { mode: 'override', agent: 'codex' as const };
      const beforeAgent =
        selection.mode === 'override' ? selection.agent : (previous.defaultAgent ?? 'codex');
      const afterAgent =
        selection.mode === 'override' ? selection.agent : (next.defaultAgent ?? 'codex');
      const modes = project.profileModes ?? pinnedModes();
      const changedRoles = profileNames.filter((role) => {
        if (modes[role] !== 'inherit') return false;
        const before =
          beforeAgent === 'omp' ? previous.ompProfiles?.[role] : previous.profiles[role];
        const after = afterAgent === 'omp' ? next.ompProfiles?.[role] : next.profiles[role];
        return beforeAgent !== afterAgent || JSON.stringify(before) !== JSON.stringify(after);
      });
      if (!changedRoles.length) continue;
      project.profileVersion = (project.profileVersion ?? 0) + 1;
      if (changedRoles.includes('pm')) {
        delete project.pmThreadId;
        delete project.pmThreadProviderId;
        delete project.pmThreadAgentKind;
        delete project.pmThreadProfileVersion;
        delete project.pmThreadProfile;
      }
      if (
        changedRoles.some((role) => ['backend', 'frontend', 'fullstack', 'complex'].includes(role))
      ) {
        for (const task of this.list('task')) {
          if (task.projectId !== project.id) continue;
          const mode = modes[task.profile];
          if (mode !== 'inherit') continue;
          delete task.devThreadId;
          delete task.devThreadProviderId;
          delete task.devThreadAgentKind;
          delete task.devThreadProfileVersion;
          delete task.devThreadProfile;
          this.put('task', task.id, task);
        }
      }
      this.put('project', project.id, project);
    }
  }
  assertProviderUnused(providerId: string) {
    const references: string[] = [];
    const inspect = (name: string, profiles: Settings['profiles']) => {
      for (const [role, profile] of Object.entries(profiles))
        if (profile.providerId === providerId) references.push(`${name} / ${role}`);
    };
    inspect('全局默认值', this.settings().profiles);
    if (this.settings().secondaryReviewProfile?.providerId === providerId)
      references.push('全局默认值 / secondaryReview');
    if (this.settings().secondaryReviewProfiles?.codex?.providerId === providerId)
      references.push('全局默认值 / secondaryReviewProfiles.codex');
    for (const project of this.list('project')) {
      inspect(`Project ${project.name} (${project.id})`, project.profiles);
      if (project.secondaryReviewProfile?.providerId === providerId)
        references.push(`Project ${project.name} (${project.id}) / secondaryReview`);
      if (project.secondaryReviewProfiles?.codex?.providerId === providerId)
        references.push(`Project ${project.name} (${project.id}) / secondaryReviewProfiles.codex`);
    }
    for (const run of this.activeRuns())
      if (run.profileConfig?.providerId === providerId)
        references.push(`进行中的 Run ${run.id} / ${run.role}`);
    if (references.length) throw new Fault(`Provider 仍被引用：${references.join('；')}`, 409);
  }
  saveProjectProfiles(projectId: string, profiles: Settings['profiles']) {
    this.validateProfiles(profiles, 'codex');
    return this.transaction(() => {
      const project = this.project(projectId);
      const changed = profileNames.filter(
        (role) => JSON.stringify(profiles[role]) !== JSON.stringify(project.profiles[role]),
      );
      if (changed.length) project.profileVersion = (project.profileVersion ?? 0) + 1;
      if (changed.includes('pm')) {
        delete project.pmThreadId;
        delete project.pmThreadProviderId;
        delete project.pmThreadAgentKind;
        delete project.pmThreadProfileVersion;
        delete project.pmThreadProfile;
      }
      for (const task of this.list('task')) {
        if (task.projectId === projectId && changed.includes(task.profile)) {
          delete task.devThreadId;
          delete task.devThreadProviderId;
          delete task.devThreadAgentKind;
          delete task.devThreadProfileVersion;
          delete task.devThreadProfile;
          this.put('task', task.id, task);
        }
      }
      project.profiles = structuredClone(profiles);
      project.profileModes = {
        ...(project.profileModes ?? pinnedModes()),
        ...Object.fromEntries(changed.map((role) => [role, 'pinned'])),
      } as Record<ProfileName, ProfileMode>;
      this.put('project', projectId, project);
      this.event('project', '项目模型分配已更新', { projectId });
      return project;
    });
  }

  saveProjectOmpProfiles(projectId: string, profiles: NonNullable<Settings['ompProfiles']>) {
    profileSetSchema.parse(profiles);
    return this.transaction(() => {
      const project = this.project(projectId);
      const changed = profileNames.filter(
        (role) => JSON.stringify(profiles[role]) !== JSON.stringify(project.ompProfiles?.[role]),
      );
      if (changed.length) project.profileVersion = (project.profileVersion ?? 0) + 1;
      if (changed.includes('pm')) {
        delete project.pmThreadId;
        delete project.pmThreadProviderId;
        delete project.pmThreadAgentKind;
        delete project.pmThreadProfileVersion;
        delete project.pmThreadProfile;
      }
      for (const task of this.list('task')) {
        if (task.projectId === projectId && changed.includes(task.profile)) {
          delete task.devThreadId;
          delete task.devThreadProviderId;
          delete task.devThreadAgentKind;
          delete task.devThreadProfileVersion;
          delete task.devThreadProfile;
          this.put('task', task.id, task);
        }
      }
      project.ompProfiles = structuredClone(profiles);
      project.profileModes = {
        ...(project.profileModes ?? pinnedModes()),
        ...Object.fromEntries(changed.map((role) => [role, 'pinned'])),
      } as Record<ProfileName, ProfileMode>;
      this.put('project', projectId, project);
      this.event('project', '项目 OMP 模型分配已更新', { projectId });
      return project;
    });
  }

  saveProjectAgentSelection(projectId: string, selection: AgentSelection) {
    if (selection.mode === 'override' && !['omp', 'codex'].includes(selection.agent))
      throw new Fault('Agent 类型无效');
    return this.transaction(() => {
      const project = this.project(projectId);
      if (JSON.stringify(project.agentSelection) === JSON.stringify(selection)) return project;
      project.agentSelection = structuredClone(selection);
      project.profileVersion = (project.profileVersion ?? 0) + 1;
      delete project.pmThreadId;
      delete project.pmThreadProviderId;
      delete project.pmThreadAgentKind;
      delete project.pmThreadProfileVersion;
      delete project.pmThreadProfile;
      for (const task of this.list('task')) {
        if (task.projectId !== projectId) continue;
        delete task.devThreadId;
        delete task.devThreadProviderId;
        delete task.devThreadAgentKind;
        delete task.devThreadProfileVersion;
        delete task.devThreadProfile;
        this.put('task', task.id, task);
      }
      this.put('project', projectId, project);
      this.event('project', '项目 Agent 分配已更新', { projectId });
      return project;
    });
  }

  saveProjectProfileModes(projectId: string, modes: Record<ProfileName, ProfileMode>) {
    for (const role of profileNames)
      if (!['inherit', 'pinned'].includes(modes[role])) throw new Fault('Profile 模式无效');
    return this.transaction(() => {
      const project = this.project(projectId);
      const old = project.profileModes ?? pinnedModes();
      const changed = profileNames.filter((role) => old[role] !== modes[role]);
      if (changed.length) project.profileVersion = (project.profileVersion ?? 0) + 1;
      if (changed.includes('pm')) {
        delete project.pmThreadId;
        delete project.pmThreadProviderId;
        delete project.pmThreadAgentKind;
        delete project.pmThreadProfileVersion;
        delete project.pmThreadProfile;
      }
      if (changed.some((role) => ['backend', 'frontend', 'fullstack', 'complex'].includes(role)))
        for (const task of this.list('task')) {
          if (task.projectId !== projectId || !changed.includes(task.profile)) continue;
          delete task.devThreadId;
          delete task.devThreadProviderId;
          delete task.devThreadAgentKind;
          delete task.devThreadProfileVersion;
          delete task.devThreadProfile;
          this.put('task', task.id, task);
        }
      project.profileModes = structuredClone(modes);
      this.put('project', projectId, project);
      return project;
    });
  }

  saveProjectRuntimeConfig(
    projectId: string,
    patch: Partial<
      Pick<
        Project,
        | 'agentSelection'
        | 'profileModes'
        | 'secondaryReviewProfile'
        | 'secondaryReviewProfiles'
        | 'recoveryPolicy'
      >
    >,
  ) {
    let project = this.project(projectId);
    if (patch.agentSelection)
      project = this.saveProjectAgentSelection(projectId, patch.agentSelection);
    if (patch.profileModes) project = this.saveProjectProfileModes(projectId, patch.profileModes);
    return this.transaction(() => {
      const current = this.project(projectId);
      if (patch.secondaryReviewProfile !== undefined)
        current.secondaryReviewProfile = structuredClone(patch.secondaryReviewProfile);
      if (patch.secondaryReviewProfiles !== undefined)
        current.secondaryReviewProfiles = structuredClone(patch.secondaryReviewProfiles);
      if (patch.recoveryPolicy !== undefined) current.recoveryPolicy = patch.recoveryPolicy;
      this.put('project', projectId, current);
      return current;
    });
  }

  saveProjectSecondaryReviewProfile(projectId: string, profile: Profile) {
    return this.saveProjectRuntimeConfig(projectId, { secondaryReviewProfile: profile });
  }
  saveProjectSecondaryReviewProfiles(
    projectId: string,
    profiles: Partial<Record<AgentKind, Profile>>,
  ) {
    return this.saveProjectRuntimeConfig(projectId, { secondaryReviewProfiles: profiles });
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
        pmThreadProviderId: run.profileConfig?.providerId ?? run.model?.providerId ?? 'codex',
        pmThreadAgentKind: run.agentKind,
        pmThreadProfileVersion: run.profileVersion ?? project.profileVersion ?? 0,
        pmThreadProfile: run.profileConfig ? structuredClone(run.profileConfig) : undefined,
      });
    if (run.role === 'dev' && run.taskId)
      this.updateTask(run.taskId, {
        devThreadId: threadId,
        devThreadProviderId: run.profileConfig?.providerId ?? run.model?.providerId ?? 'codex',
        devThreadAgentKind: run.agentKind,
        devThreadProfileVersion: run.profileVersion ?? project.profileVersion ?? 0,
        devThreadProfile: run.profileConfig ? structuredClone(run.profileConfig) : undefined,
      });
  }
  event(
    type: string,
    message: string,
    refs: Partial<Pick<Event, 'projectId' | 'taskId' | 'runId'>> = {},
    descriptor?: MessageDescriptor,
  ) {
    const event = {
      at: now(),
      type,
      message: redact(message).slice(-16000),
      ...(descriptor ? { descriptor: structuredClone(descriptor) } : {}),
      ...refs,
    };
    const result = this.db
      .prepare('INSERT INTO events(body) VALUES (?)')
      .run(JSON.stringify(event));
    this.changes.emit('event', { ...event, id: Number(result.lastInsertRowid) });
    return Number(result.lastInsertRowid);
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

  createIncident(
    inputOrProject:
      | (Pick<Incident, 'projectId' | 'phase' | 'message'> &
          Partial<Pick<Incident, 'taskId' | 'runId' | 'evidence' | 'descriptor'>>)
      | string,
    runId?: string,
    phase?: string,
    message?: string,
    evidence?: string,
  ): Incident {
    const input =
      typeof inputOrProject === 'string'
        ? { projectId: inputOrProject, runId, phase: phase!, message: message ?? '', evidence }
        : inputOrProject;
    const parsed = incidentInput.parse(input);
    this.project(parsed.projectId);
    if (parsed.taskId && this.task(parsed.taskId).projectId !== parsed.projectId)
      throw new Fault('Incident 任务不属于当前项目', 403);
    if (parsed.runId) {
      const run = this.get('run', parsed.runId);
      if (!run || run.projectId !== parsed.projectId)
        throw new Fault('Incident Run 不属于当前项目', 403);
    }
    const existing = this.list('incident').find(
      (incident) =>
        incident.projectId === parsed.projectId &&
        incident.phase === parsed.phase &&
        (parsed.runId ? incident.runId === parsed.runId : incident.taskId === parsed.taskId),
    );
    if (existing) return structuredClone(existing);
    const at = now();
    const incident: Incident = {
      id: id(),
      projectId: parsed.projectId,
      ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
      ...(parsed.runId ? { runId: parsed.runId } : {}),
      phase: parsed.phase,
      status: 'open',
      message: redact(parsed.message).slice(0, 16000),
      ...(parsed.descriptor ? { descriptor: structuredClone(parsed.descriptor) } : {}),
      ...(parsed.evidence ? { evidence: redact(parsed.evidence).slice(0, 32000) } : {}),
      createdAt: at,
      updatedAt: at,
    };
    this.put('incident', incident.id, incident);
    this.event('incident', `发生运行事件：${incident.phase}`, {
      projectId: incident.projectId,
      taskId: incident.taskId,
      runId: incident.runId,
    });
    return structuredClone(incident);
  }

  updateIncident(
    keyOrProject: string,
    patchOrKey:
      | string
      | Partial<
          Pick<
            Incident,
            'status' | 'message' | 'evidence' | 'descriptor' | 'assessmentRunId' | 'assessmentAt'
          >
        >,
    maybePatch?: Partial<
      Pick<
        Incident,
        'status' | 'message' | 'evidence' | 'descriptor' | 'assessmentRunId' | 'assessmentAt'
      >
    >,
  ) {
    const projectId = maybePatch ? keyOrProject : undefined;
    const key = maybePatch ? String(patchOrKey) : keyOrProject;
    const patch = (maybePatch ?? patchOrKey) as Partial<
      Pick<
        Incident,
        'status' | 'message' | 'evidence' | 'descriptor' | 'assessmentRunId' | 'assessmentAt'
      >
    >;
    const incident = this.get('incident', key);
    if (!incident) throw new Fault('Incident 不存在', 404);
    if (projectId && incident.projectId !== projectId) throw new Fault('跨项目操作被拒绝', 403);
    if (
      patch.assessmentRunId &&
      incident.assessmentRunId &&
      patch.assessmentRunId !== incident.assessmentRunId
    )
      throw new Fault('Incident 已由另一个 Run 评估', 409);
    const next: Incident = {
      ...incident,
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.message !== undefined ? { message: redact(patch.message).slice(0, 16000) } : {}),
      ...(patch.descriptor !== undefined ? { descriptor: structuredClone(patch.descriptor) } : {}),
      ...(patch.evidence !== undefined ? { evidence: redact(patch.evidence).slice(0, 32000) } : {}),
      ...(patch.assessmentRunId ? { assessmentRunId: patch.assessmentRunId } : {}),
      ...(patch.assessmentAt ? { assessmentAt: patch.assessmentAt } : {}),
      updatedAt: now(),
    };
    this.put('incident', key, next);
    return structuredClone(next);
  }

  claimIncidentAssessment(key: string, assessmentRunId: string) {
    const incident = this.get('incident', key);
    if (!incident) throw new Fault('Incident 不存在', 404);
    if (incident.assessmentRunId && incident.assessmentRunId !== assessmentRunId)
      return structuredClone(incident);
    return this.updateIncident(key, {
      assessmentRunId,
      assessmentAt: now(),
      status: incident.status === 'open' ? 'assessing' : incident.status,
    });
  }

  assessIncident(key: string, assessmentRunId: string) {
    return this.claimIncidentAssessment(key, assessmentRunId);
  }

  createClarification(input: unknown): Clarification {
    const parsed = clarificationInput.parse(input);
    const source = this.get('message', parsed.sourceMessageId);
    if (!source || source.projectId !== parsed.projectId)
      throw new Fault('Clarification 来源消息不属于当前项目', 403);
    if (parsed.taskId && this.task(parsed.taskId).projectId !== parsed.projectId)
      throw new Fault('Clarification 任务不属于当前项目', 403);
    const sourceIntent = parsed.sourceIntent ?? source.intent;
    if (
      !sourceIntent ||
      (source.intent && parsed.sourceIntent && source.intent !== parsed.sourceIntent)
    )
      throw new Fault('Clarification 必须保留原始消息意图', 409);
    const existing = this.list('clarification').find(
      (clarification) =>
        clarification.projectId === parsed.projectId &&
        clarification.sourceMessageId === parsed.sourceMessageId &&
        clarification.status === 'open',
    );
    if (existing) return structuredClone(existing);
    const cancelled = this.list('clarification').find(
      (clarification) =>
        clarification.projectId === parsed.projectId &&
        clarification.sourceMessageId === parsed.sourceMessageId &&
        clarification.status === 'cancelled',
    );
    if (cancelled)
      throw new Fault('原始用户消息的 Clarification 已取消，不能重新开启', 409, {
        code: 'clarification_cancelled',
        params: { sourceMessageId: parsed.sourceMessageId },
      });
    const questions: ClarificationQuestion[] = parsed.questions.map((question, index) => ({
      id: question.id ?? `q${index + 1}`,
      question: question.question ?? question.prompt!,
      ...(question.recommendation ? { recommendation: question.recommendation } : {}),
      ...(question.options?.length
        ? { options: question.options.map((option) => ({ ...option })) }
        : {}),
    }));
    const at = now();
    const clarification: Clarification = {
      id: id(),
      projectId: parsed.projectId,
      sourceMessageId: parsed.sourceMessageId,
      ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
      sourceIntent,
      questions,
      status: 'open',
      createdAt: at,
      updatedAt: at,
    };
    this.put('clarification', clarification.id, clarification);
    this.event('clarification', '等待用户产品澄清', { projectId: parsed.projectId });
    return structuredClone(clarification);
  }

  answerClarification(
    keyOrProject: string,
    answersOrKey: ClarificationAnswer[] | Record<string, string | string[]> | string,
    maybeAnswers?: ClarificationAnswer[] | Record<string, string | string[]>,
  ) {
    const projectId = maybeAnswers === undefined ? undefined : keyOrProject;
    const key = maybeAnswers === undefined ? keyOrProject : String(answersOrKey);
    const rawAnswers = (maybeAnswers ?? answersOrKey) as
      ClarificationAnswer[] | Record<string, string | string[]>;
    const clarification = this.get('clarification', key);
    if (!clarification) throw new Fault('Clarification 不存在', 404);
    if (projectId && clarification.projectId !== projectId)
      throw new Fault('跨项目操作被拒绝', 403);
    if (clarification.status === 'cancelled') throw new Fault('Clarification 已取消', 409);
    if (clarification.status === 'answered') return structuredClone(clarification);
    const answers: ClarificationAnswer[] = Array.isArray(rawAnswers)
      ? rawAnswers.map((answer) => ({ questionId: answer.questionId, value: answer.value }))
      : Object.entries(rawAnswers).map(([questionId, value]) => ({ questionId, value }));
    const questionIds = new Set(clarification.questions.map((question) => question.id));
    if (answers.some((answer) => !questionIds.has(answer.questionId)))
      throw new Fault('Clarification 问题编号无效', 400);
    const merged = new Map(
      (clarification.answers ?? []).map((answer) => [answer.questionId, answer]),
    );
    for (const answer of answers) merged.set(answer.questionId, answer);
    const normalizedAnswers = [...merged.values()];
    const complete = clarification.questions.every((question) => merged.has(question.id));
    const at = now();
    const next: Clarification = {
      ...clarification,
      status: complete ? 'answered' : 'open',
      answers: normalizedAnswers,
      ...(complete ? { answeredAt: at } : { answeredAt: undefined }),
      updatedAt: at,
    };
    this.put('clarification', key, next);
    this.event('clarification', '用户已回答产品澄清', { projectId: next.projectId });
    return structuredClone(next);
  }

  cancelClarification(keyOrProject: string, maybeKey?: string) {
    const projectId = maybeKey === undefined ? undefined : keyOrProject;
    const key = maybeKey ?? keyOrProject;
    const clarification = this.get('clarification', key);
    if (!clarification) throw new Fault('Clarification 不存在', 404);
    if (projectId && clarification.projectId !== projectId)
      throw new Fault('跨项目操作被拒绝', 403);
    if (clarification.status === 'cancelled') return structuredClone(clarification);
    if (clarification.status === 'answered') throw new Fault('Clarification 已回答', 409);
    const next = { ...clarification, status: 'cancelled' as const, updatedAt: now() };
    this.put('clarification', key, next);
    this.event('clarification', '产品澄清已取消', { projectId: next.projectId });
    return structuredClone(next);
  }
  clarificationGate(sourceMessageId: string) {
    return this.list('clarification').find(
      (clarification) =>
        clarification.sourceMessageId === sourceMessageId &&
        ['open', 'cancelled'].includes(clarification.status),
    );
  }
  snapshot(): Snapshot {
    return {
      activities: this.list('activity'),
      providers: [{ ...officialProvider }, ...this.list('provider')],
      projects: this.list('project'),
      repos: this.list('repo'),
      tasks: this.list('task'),
      runs: this.list('run'),
      messages: this.list('message'),
      events: this.events(),
      settings: this.settings(),
      documents: this.list('document'),
      incidents: this.list('incident'),
      clarifications: this.list('clarification'),
      recoveryItems: this.list('recovery'),
      accountAllowances: this.list('allowance'),
    };
  }
  private timelineOrder() {
    return Number(
      (
        this.db.prepare('SELECT COALESCE(MAX(rowid),0)+1 AS next FROM documents').get() as {
          next: number;
        }
      ).next,
    );
  }
  activity(
    run: Run,
    key: string,
    patch: Pick<PMActivity, 'kind' | 'title' | 'status'> & Partial<PMActivity>,
  ) {
    const activityId = `${run.id}:${key}`;
    const previous = this.get('activity', activityId);
    const at = now();
    const value: PMActivity = {
      timelineOrder: this.timelineOrder(),
      id: activityId,
      projectId: run.projectId,
      runId: run.id,
      taskId: run.taskId,
      startedAt: at,
      ...previous,
      ...patch,
      updatedAt: at,
      details: {
        ...previous?.details,
        ...Object.fromEntries(
          Object.entries(patch.details ?? {}).filter(([, value]) => value !== undefined),
        ),
      },
    };
    if (!['running', 'waiting', 'queued'].includes(value.status)) value.endedAt ??= at;
    value.title = bounded(value.title, 240);
    value.details = Object.fromEntries(
      Object.entries(value.details)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, ['command', 'cwd', 'paths'].includes(k) ? redact(v!) : bounded(v!)]),
    );
    this.put('activity', activityId, value);
    if (['command', 'tool'].includes(value.kind)) {
      const current = this.get('run', run.id)!;
      if (['running', 'waiting'].includes(current.status)) {
        current.status = this.list('activity').some(
          (a) =>
            a.runId === run.id &&
            ['command', 'tool'].includes(a.kind) &&
            ['running', 'waiting'].includes(a.status),
        )
          ? 'waiting'
          : 'running';
        this.put('run', current.id, current);
      }
    }
    this.changes.emit('change');
    return value;
  }
  createProject(name: string, description: string) {
    return this.transaction(() => {
      const p: Project = {
        id: id(),
        name,
        description,
        devLimit: 4,
        createdAt: now(),
        profiles: structuredClone(this.settings().profiles),
        ompProfiles: structuredClone(this.settings().ompProfiles),
        agentSelection: { mode: 'inherit' },
        profileModes: inheritedModes(),
        secondaryReviewProfile: this.settings().secondaryReviewProfile
          ? structuredClone(this.settings().secondaryReviewProfile)
          : undefined,
        secondaryReviewProfiles: this.settings().secondaryReviewProfiles
          ? structuredClone(this.settings().secondaryReviewProfiles)
          : undefined,
        recoveryPolicy: 'automatic',
        profileVersion: 0,
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
    messageId: string | MessageOptions = id(),
    options: MessageOptions = {},
  ) {
    // Accept the options object in the historical messageId position as well. This keeps the
    // public seam usable by queue/steer callers without changing existing six-argument callers.
    if (typeof messageId !== 'string') {
      options = (messageId ?? options) as MessageOptions;
      messageId = id();
    }
    this.project(projectId);
    const m: Message = {
      timelineOrder: this.timelineOrder(),
      id: messageId,
      projectId,
      role,
      content: redact(content),
      intent,
      ...(attachments?.length ? { attachments } : {}),
      createdAt: now(),
      ...(role === 'user' ? { status: 'queued' as const } : {}),
      deliveryMode: options.deliveryMode ?? 'queue',
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.sourceMessageId ? { sourceMessageId: options.sourceMessageId } : {}),
      draftId: options.draftId ?? messageId,
      draftStatus:
        options.draftStatus ?? (role === 'user' ? ('queued' as const) : ('completed' as const)),
    };
    this.put('message', m.id, m);
    this.event('message', role === 'user' ? '收到你的消息' : 'PM 更新了对话', { projectId });
    return m;
  }
  updateMessage(key: string, patch: Partial<Message>) {
    const previous = this.get('message', key);
    if (!previous) throw new Fault('消息不存在', 404);
    const next: Message = {
      ...previous,
      ...patch,
      ...(patch.content !== undefined ? { content: redact(patch.content) } : {}),
    };
    this.put('message', key, next);
    this.changes.emit('change');
    return structuredClone(next);
  }
  /** Atomically accepts the newest user source for an active PM Run. */
  acceptRunSource(runId: string, messageId: string) {
    return this.transaction(() => this.acceptRunSourceUnsafe(runId, messageId));
  }
  private acceptRunSourceUnsafe(runId: string, messageId: string, allowEnded = false) {
    const run = this.get('run', runId);
    const message = this.get('message', messageId);
    if (!run || !message || run.projectId !== message.projectId)
      throw new Fault('Steer 来源消息不属于当前 Run', 403);
    if (run.role !== 'pm' || (!allowEnded && !['running', 'waiting'].includes(run.status)))
      throw new Fault('当前 PM Run 已不能接收 Steer', 409);
    this.put('run', run.id, {
      ...run,
      sourceMessageId: message.id,
      sourceIntent: message.intent,
      clientUserMessageId: message.id,
    });
    if (run.taskId) {
      const task = this.get('task', run.taskId);
      if (task)
        this.put('task', task.id, {
          ...task,
          sourceMessageId: message.id,
          updatedAt: now(),
        });
    }
    return this.get('run', run.id)!;
  }
  /** Begin one durable steer operation; callers must reconcile uncertain records before retrying. */
  beginSteer(runId: string, messageId: string) {
    return this.transaction(() => {
      const run = this.get('run', runId);
      const message = this.get('message', messageId);
      if (!run || !message || run.projectId !== message.projectId)
        throw new Fault('Steer 来源消息不属于当前 Run', 403);
      const key = `steer:${runId}:${messageId}`;
      const existing = this.get('operation', key);
      if (existing) return structuredClone(existing);
      if (!run.threadId) throw new Fault('当前 PM Run 尚未建立会话', 409);
      const operation: Operation = {
        id: key,
        kind: 'steer',
        status: 'pending',
        runId,
        sessionId: run.threadId,
        ...(run.turnId ? { turnId: run.turnId } : {}),
        clientUserMessageId: messageId,
        attempt: 1,
      };
      this.put('operation', key, operation);
      this.updateMessage(messageId, {
        status: 'running',
        draftStatus: 'running',
        runId,
        sourceMessageId: messageId,
      });
      return structuredClone(operation);
    });
  }
  finishSteer(
    operationId: string,
    status: Extract<Operation['status'], 'done' | 'uncertain' | 'failed'>,
    error?: string,
    accepted = status === 'done',
    queue = false,
  ) {
    return this.transaction(() => {
      const operation = this.get('operation', operationId);
      if (!operation) throw new Fault('Steer operation 不存在', 404);
      const next: Operation = {
        ...operation,
        status,
        ...(status === 'done' ? { result: { accepted, queued: queue } } : {}),
        ...(error ? { error: redact(error) } : {}),
      };
      if (status === 'done' && accepted && operation.runId && operation.clientUserMessageId)
        this.acceptRunSourceUnsafe(operation.runId, operation.clientUserMessageId, true);
      this.put('operation', operationId, next);
      if (operation.clientUserMessageId) {
        const message = this.get('message', operation.clientUserMessageId);
        if (message)
          this.put('message', message.id, {
            ...message,
            ...(queue
              ? {
                  deliveryMode: 'queue' as const,
                  status: 'queued' as const,
                  draftStatus: 'queued' as const,
                }
              : {
                  status: status === 'done' ? ('completed' as const) : ('failed' as const),
                  draftStatus: status === 'done' ? ('completed' as const) : ('failed' as const),
                }),
            ...(status === 'uncertain'
              ? {
                  descriptor: {
                    code: 'steer_uncertain',
                    detail: redact(error ?? 'Steer 结果未知'),
                  },
                }
              : {}),
          });
      }
      return structuredClone(next);
    });
  }
  unresolvedSteers() {
    return this.list('operation').filter(
      (operation) =>
        operation.kind === 'steer' && ['pending', 'uncertain'].includes(operation.status),
    );
  }
  rebindIncidentAssessment(incidentId: string, previousRunId: string, successorRunId: string) {
    return this.transaction(() => {
      const incident = this.get('incident', incidentId);
      if (!incident) throw new Fault('Incident 不存在', 404);
      if (incident.assessmentRunId && incident.assessmentRunId !== previousRunId) {
        if (incident.assessmentRunId === successorRunId) return structuredClone(incident);
        throw new Fault('Incident 已由另一个 Run 评估', 409);
      }
      return this.updateIncident(incidentId, {
        assessmentRunId: successorRunId,
        assessmentAt: now(),
        status: incident.status === 'open' ? 'assessing' : incident.status,
      });
    });
  }
  assistantDraft(projectId: string, runId: string, draftId = runId, content = ''): Message {
    const existing = this.list('message').find(
      (message) =>
        message.projectId === projectId &&
        message.role === 'assistant' &&
        (message.runId === runId || message.draftId === draftId),
    );
    if (existing) {
      const next = this.updateMessage(existing.id, {
        runId,
        draftId,
        status: 'running',
        draftStatus: 'running',
      });
      return next;
    }
    return this.addMessage(projectId, 'assistant', content, undefined, undefined, {
      runId,
      draftId,
      draftStatus: 'draft',
    });
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
      Pick<Task, 'documentChanges'> &
      Partial<Pick<Task, 'changeType' | 'scope' | 'summaryEn' | 'cleanup'>> & {
        priority: number | PriorityLevel;
        priorityReason?: string;
      },
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
    const sourceClarification = this.list('clarification').find(
      (clarification) =>
        clarification.sourceMessageId === input.sourceMessageId &&
        ['open', 'cancelled'].includes(clarification.status),
    );
    if (sourceClarification)
      throw new Fault(
        sourceClarification.status === 'cancelled'
          ? '源消息的产品澄清已取消，不能重新发布任务'
          : '源消息仍等待产品澄清，不能发布任务',
        409,
        {
          code:
            sourceClarification.status === 'cancelled'
              ? 'clarification_cancelled'
              : 'clarification_open',
          params: { sourceMessageId: input.sourceMessageId },
        },
      );
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
      reviewPolicyVersion: 2,
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
  /** Return immutable copies of the accepted/draft document revision records for a Project. */
  documentSnapshot(projectId: string, repoId?: string): DesignDocument[] {
    this.project(projectId);
    return this.list('document')
      .filter(
        (document) => document.projectId === projectId && (!repoId || document.repoId === repoId),
      )
      .map((document) => structuredClone(document));
  }
  documentsSnapshot(projectId: string, repoId?: string) {
    return this.documentSnapshot(projectId, repoId);
  }
  updateTask(key: string, patch: Partial<Task>) {
    const previous = this.task(key);
    const t = { ...previous, ...patch, updatedAt: now() };
    if (patch.profile && patch.profile !== previous.profile) {
      delete t.devThreadId;
      delete t.devThreadProviderId;
      delete t.devThreadAgentKind;
      delete t.devThreadProfileVersion;
    }
    this.put('task', key, t);
    this.changes.emit('change');
    return t;
  }
  resolveEffectiveProfile(
    projectId: string,
    profile: ProfileName,
    options: Pick<
      RunOptions,
      'secondaryReview' | 'secondaryProfile' | 'secondaryReviewProfile'
    > = {},
  ): { agentKind: AgentKind; profile: Profile } {
    const project = this.project(projectId);
    const settings = this.settings();
    const agentKind = this.effectiveAgent(project, settings);
    const secondaryProfile =
      options.secondaryProfile ??
      options.secondaryReviewProfile ??
      project.secondaryReviewProfiles?.[agentKind] ??
      settings.secondaryReviewProfiles?.[agentKind] ??
      project.secondaryReviewProfile ??
      settings.secondaryReviewProfile;
    if (options.secondaryReview && secondaryProfile)
      return {
        agentKind,
        profile: structuredClone(secondaryProfile),
      };
    const mode = project.profileModes?.[profile] ?? 'pinned';
    const profiles =
      mode === 'inherit'
        ? agentKind === 'omp'
          ? settings.ompProfiles
          : settings.profiles
        : agentKind === 'omp'
          ? project.ompProfiles
          : project.profiles;
    const selected = profiles?.[profile];
    if (!selected) throw new Fault(`缺少 ${agentKind} / ${profile} 模型配置`, 409);
    return { agentKind, profile: structuredClone(selected) };
  }

  effectiveAgentForProject(projectId: string): AgentKind {
    return this.effectiveAgent(this.project(projectId));
  }

  run(
    role: Run['role'],
    projectId: string,
    profile: ProfileName,
    task?: Task | RunOptions,
    options: RunOptions = {},
  ): Run {
    if (task && !('id' in task)) {
      options = { ...(task as RunOptions), ...options };
      task = undefined;
    }
    const taskRecord = task as Task | undefined;
    const project = this.project(projectId);
    const selected = this.resolveEffectiveProfile(projectId, options.profile ?? profile, options);
    const profileConfig = selected.profile;
    const provider =
      selected.agentKind === 'codex'
        ? profileConfig.providerId === 'codex'
          ? officialProvider
          : this.get('provider', profileConfig.providerId)
        : undefined;
    if (selected.agentKind === 'codex' && !provider)
      throw new Fault(`Provider 不存在：${profileConfig.providerId}`, 409);
    const version = project.profileVersion ?? 0;
    const profileMatches = (left: Profile | undefined, right: Profile) =>
      !!left &&
      left.providerId === right.providerId &&
      left.model === right.model &&
      left.effort === right.effort;
    const pmThreadMatches =
      role === 'pm' &&
      project.pmThreadId &&
      (project.pmThreadProviderId ?? 'codex') === profileConfig.providerId &&
      (project.pmThreadAgentKind === undefined ||
        project.pmThreadAgentKind === selected.agentKind) &&
      (project.pmThreadProfileVersion === undefined ||
        project.pmThreadProfileVersion === version) &&
      profileMatches(project.pmThreadProfile, profileConfig);
    const devThreadMatches =
      role === 'dev' &&
      taskRecord?.devThreadId &&
      (taskRecord.devThreadProviderId ?? 'codex') === profileConfig.providerId &&
      (taskRecord.devThreadAgentKind === undefined ||
        taskRecord.devThreadAgentKind === selected.agentKind) &&
      (taskRecord.devThreadProfileVersion === undefined ||
        taskRecord.devThreadProfileVersion === version) &&
      profileMatches(taskRecord.devThreadProfile, profileConfig);
    const model: ModelIdentity = {
      agentKind: selected.agentKind,
      providerId: profileConfig.providerId,
      model: profileConfig.model,
      effort: profileConfig.effort,
      ...(options.agentVersion ? { agentVersion: options.agentVersion } : {}),
    };
    const providerPrice = provider
      ? ((provider as Provider & { prices?: Record<string, PriceSnapshot> }).prices?.[
          profileConfig.model
        ] ?? provider.price)
      : undefined;
    const suppliedPrice =
      selected.agentKind === 'codex' && profileConfig.providerId === 'codex'
        ? undefined
        : (options.priceSnapshot ?? profileConfig.price ?? providerPrice);
    const priceSnapshot = suppliedPrice
      ? structuredClone({
          ...suppliedPrice,
          capturedAt: (suppliedPrice as PriceSnapshot).capturedAt ?? now(),
        })
      : undefined;
    const r: Run = {
      id: id(),
      projectId,
      role,
      profile: options.profile ?? profile,
      profileConfig: structuredClone(profileConfig),
      agentKind: selected.agentKind,
      ...(options.agentVersion ? { agentVersion: options.agentVersion } : {}),
      ...(provider
        ? {
            provider: {
              id: provider.id,
              name: provider.name,
              kind: provider.kind,
              baseUrl: provider.baseUrl,
            },
          }
        : {}),
      model,
      modelIdentity: structuredClone(model),
      profileVersion: version,
      resumeThreadId: pmThreadMatches
        ? project.pmThreadId
        : devThreadMatches
          ? taskRecord?.devThreadId
          : undefined,
      status: 'running',
      startedAt: now(),
      taskId: taskRecord?.id,
      repoId: taskRecord?.repoId,
      ...(!options.suppressSource
        ? {
            sourceMessageId:
              options.sourceMessageId ??
              (typeof options.source === 'string' ? options.source : options.source?.messageId) ??
              taskRecord?.sourceMessageId,
          }
        : {}),
      ...(!options.suppressSource && (options.sourceMessageId || options.source)
        ? {
            sourceIntent: this.get(
              'message',
              options.sourceMessageId ??
                (typeof options.source === 'string' ? options.source : options.source?.messageId)!,
            )?.intent,
          }
        : !options.suppressSource && taskRecord?.sourceMessageId
          ? { sourceIntent: this.get('message', taskRecord.sourceMessageId)?.intent }
          : {}),
      ...(options.revision
        ? { revision: structuredClone(options.revision) }
        : taskRecord
          ? { revision: { head: taskRecord.head, base: taskRecord.base } }
          : {}),
      ...(options.reviewAxis ? { reviewAxis: options.reviewAxis } : {}),
      ...(options.incidentId ? { incidentId: options.incidentId } : {}),
      ...(options.incidentPhase ? { incidentPhase: options.incidentPhase } : {}),
      ...(options.incidentEvidence ? { incidentEvidence: redact(options.incidentEvidence) } : {}),
      reviewPolicyVersion: taskRecord?.reviewPolicyVersion,
      ...(options.secondaryReview ? { secondaryReview: true } : {}),
      ...(options.usage ? { usage: structuredClone(options.usage) } : {}),
      ...(priceSnapshot
        ? {
            priceSnapshot,
            price: structuredClone(priceSnapshot),
          }
        : {}),
      ...(options.recoveryItemId || options.recovery
        ? {
            recoveryItemId:
              options.recoveryItemId ??
              (typeof options.recovery === 'string' ? options.recovery : options.recovery?.id),
          }
        : {}),
    };
    this.put('run', r.id, r);
    return r;
  }
  updateRunUsage(key: string, usage: RunUsage, mode: UsageMode = 'cumulative') {
    const run = this.get('run', key);
    if (!run) throw new Fault('Run 不存在', 404);
    if (run.usage?.final || ['completed', 'failed', 'interrupted', 'paused'].includes(run.status))
      return structuredClone(run);
    const previous = run.usage;
    const merged = normalizeUsage(previous, usage, mode);
    run.usage = {
      ...merged,
      mode: mode === 'delta' ? 'per-run' : mode,
      ...(previous?.final ? { final: true } : {}),
    };
    this.put('run', key, run);
    this.changes.emit('change');
    return structuredClone(run);
  }

  recordRunUsage(key: string, usage: RunUsage, mode: UsageMode = 'cumulative') {
    return this.updateRunUsage(key, usage, mode);
  }

  recordRunDiagnostic(key: string, diagnostic: string) {
    const run = this.get('run', key);
    if (!run) throw new Fault('Run 不存在', 404);
    const value = redact(String(diagnostic)).slice(-3000);
    const diagnostics = [...new Set([...(run.diagnostics ?? []), value])].slice(-20);
    run.diagnostics = diagnostics;
    run.diagnostic = diagnostics.at(-1);
    this.put('run', key, run);
    this.changes.emit('change');
    return structuredClone(run);
  }
  pinRunRevision(key: string, revision: { head?: string; base?: string }) {
    const run = this.get('run', key);
    if (!run) throw new Fault('Run 不存在', 404);
    const next = { ...run, revision: structuredClone(revision) };
    this.put('run', key, next);
    this.changes.emit('change');
    return structuredClone(next);
  }

  private freezeRun(run: Run, endedAt: string, priceSnapshot?: PriceSnapshot) {
    run.endedAt ??= endedAt;
    const duration = Date.parse(run.endedAt) - Date.parse(run.startedAt);
    if (Number.isFinite(duration) && duration >= 0) run.durationMs ??= duration;
    if (run.usage) run.usage = { ...run.usage, final: true };
    const officialCodex = run.agentKind === 'codex' && run.profileConfig?.providerId === 'codex';
    if (priceSnapshot && !run.priceSnapshot && !officialCodex) {
      const snapshot = structuredClone({
        ...priceSnapshot,
        capturedAt: priceSnapshot.capturedAt ?? endedAt,
      });
      run.priceSnapshot = snapshot;
      run.price = structuredClone(snapshot);
    }
    return run;
  }

  finishRun(
    key: string,
    status: Run['status'],
    error?: string,
    options: {
      usage?: RunUsage;
      usageMode?: UsageMode;
      durationMs?: number;
      priceSnapshot?: PriceSnapshot;
      descriptor?: MessageDescriptor;
    } = {},
  ) {
    const r = this.get('run', key);
    if (!r) return;
    if (
      options.usage &&
      !r.usage?.final &&
      !['completed', 'failed', 'interrupted', 'paused'].includes(r.status)
    )
      r.usage = {
        ...normalizeUsage(r.usage, options.usage, options.usageMode ?? 'cumulative'),
        mode: options.usageMode === 'delta' ? 'per-run' : (options.usageMode ?? 'cumulative'),
      };
    const endedAt = r.endedAt ?? now();
    if (!r.endedAt) r.endedAt = endedAt;
    if (!['completed', 'failed', 'interrupted', 'paused'].includes(r.status)) r.status = status;
    else if (r.status === 'interrupted' && status === 'interrupted') r.status = status;
    if (error && !r.error) r.error = redact(error);
    if (options.descriptor) r.errorDescriptor = structuredClone(options.descriptor);
    if (options.durationMs !== undefined && r.durationMs === undefined)
      r.durationMs = options.durationMs;
    this.freezeRun(r, endedAt, options.priceSnapshot);
    this.put('run', key, r);
    if (r.taskId) {
      const task = this.get('task', r.taskId);
      if (task) {
        const usage = this.taskUsage(r.taskId);
        const cost = this.taskCost(r.taskId);
        this.put('task', task.id, {
          ...task,
          ...(Object.keys(usage).length ? { usage } : {}),
          ...(cost ? { cost } : { cost: undefined }),
          updatedAt: now(),
        });
      }
    }
    if (r.role === 'pm') {
      for (const a of this.list('activity').filter(
        (a) => a.runId === key && ['running', 'waiting', 'queued'].includes(a.status),
      ))
        this.activity(r, a.id.slice(key.length + 1), {
          ...a,
          status: r.status,
          details: { ...a.details, ...(error ? { error } : {}) },
        });
      this.activity(r, 'result', {
        kind: 'phase',
        title: pmRunTitles[status] ?? 'PM 运行结束',
        status: r.status,
        details: error ? { error } : {},
      });
    }
    this.event('run', error ?? `${r.role} ${r.status}`, {
      projectId: r.projectId,
      taskId: r.taskId,
      runId: r.id,
    });
    return structuredClone(r);
  }

  runUsage(key: string): RunUsage | undefined {
    return structuredClone(this.get('run', key)?.usage);
  }

  taskUsage(taskId: string): UsageAggregate {
    const runs = this.list('run').filter((run) => run.taskId === taskId);
    const usage = runs.reduce((result, run) => {
      if (!run.usage) return result;
      const { contextWindow: _contextWindow, ...tokens } = run.usage;
      return normalizeUsage(result, tokens, 'per-run');
    }, {} as RunUsage);
    if (!runs.length) return usage;
    return {
      ...usage,
      runs: runs.length,
      complete: runs.every((run) => run.usage !== undefined),
    };
  }

  runCost(key: string): CostEstimate | undefined {
    const run = this.get('run', key);
    if (!run) return undefined;
    if (run.agentKind === 'codex' && run.profileConfig?.providerId === 'codex') return undefined;
    const price = run.priceSnapshot ?? run.price;
    return price ? costForUsage(run.usage, price) : undefined;
  }

  taskCosts(taskId: string): CostEstimate[] {
    const runs = this.list('run').filter((run) => run.taskId === taskId);
    const costs = aggregateCosts(runs.map((run) => this.runCost(run.id)));
    if (!costs.length) return costs;
    if (runs.some((run) => this.runCost(run.id) === undefined))
      for (const cost of costs) cost.partial = true;
    return costs;
  }

  taskCost(taskId: string): CostEstimate | undefined {
    const costs = this.taskCosts(taskId);
    return costs.length === 1 ? costs[0] : undefined;
  }

  saveAccountAllowance(allowance: AccountAllowance) {
    const value = structuredClone(allowance);
    this.put('allowance', `${allowance.agentKind}:${allowance.providerId}`, value);
    return value;
  }

  accountAllowance(agentKind: AgentKind, providerId: string) {
    return this.get('allowance', `${agentKind}:${providerId}`);
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
      const recovery = this.list('recovery').find(
        (item) =>
          item.taskId === task.id &&
          item.status === 'resumed' &&
          (item.role === 'dev' || this.get('run', item.oldRunId)?.role === 'dev'),
      );
      const run = this.run('dev', task.projectId, task.profile, task, {
        ...(recovery ? { recoveryItemId: recovery.id } : {}),
      });
      if (recovery && !recovery.successorRunId)
        this.put('recovery', recovery.id, {
          ...recovery,
          status: 'resumed',
          successorRunId: run.id,
          updatedAt: now(),
        });
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
        pausedByUser: action === 'pause' ? true : false,
        blocked: action === 'resume' ? undefined : t.blocked,
        blockedDescriptor: action === 'resume' ? undefined : t.blockedDescriptor,
      });
    this.event('task', `任务 ${action}`, { projectId: t.projectId, taskId: key });
  }
  resumeRecovery(key: string) {
    const item = this.get('recovery', key);
    if (!item) throw new Fault('Recovery item 不存在', 404);
    if (item.status === 'resumed') return structuredClone(item);
    if (item.status === 'cancelled') throw new Fault('Recovery item 已取消', 409);
    // This is only a request marker. Worktree/remote reconciliation and successor creation happen
    // in Engine; marking resumed here would let the scheduler claim before that safe phase.
    this.event('recovery', '已请求恢复中断运行，等待宿主核对', {
      projectId: item.projectId,
      taskId: item.taskId,
      runId: item.oldRunId,
    });
    return structuredClone(item);
  }

  recoveryForProject(projectId: string, key?: string) {
    const items = this.list('recovery').filter((item) => item.projectId === projectId);
    if (!key) return items;
    const item = items.find((candidate) => candidate.id === key);
    if (!item) throw new Fault('Recovery item 不属于当前项目', 403);
    return item;
  }

  cancelRecovery(key: string) {
    const item = this.get('recovery', key);
    if (!item) throw new Fault('Recovery item 不存在', 404);
    if (item.status === 'cancelled') return structuredClone(item);
    if (item.status === 'resumed') throw new Fault('Recovery item 已恢复', 409);
    const next = { ...item, status: 'cancelled' as const, updatedAt: now() };
    this.put('recovery', key, next);
    this.event('recovery', '中断运行恢复已取消', {
      projectId: next.projectId,
      taskId: next.taskId,
      runId: next.oldRunId,
    });
    return structuredClone(next);
  }

  /**
   * Create exactly one successor Run for a recovered Run. The recovery row and its successor
   * pointer are committed together, so repeated startup/manual recovery cannot duplicate work.
   */
  ensureRecoverySuccessor(
    recoveryId: string,
    options: {
      role: Run['role'];
      profile: ProfileName;
      taskId?: string;
      task?: Task;
      secondaryReview?: boolean;
      reviewAxis?: Run['reviewAxis'];
      sourceMessageId?: string;
      incidentId?: string;
      incidentPhase?: string;
      incidentEvidence?: string;
      recoveryPrompt?: string;
    },
  ) {
    return this.transaction(() => {
      const item = this.get('recovery', recoveryId);
      if (!item) throw new Fault('Recovery item 不存在', 404);
      if (item.successorRunId) {
        const successor = this.get('run', item.successorRunId);
        if (successor) return structuredClone(successor);
        throw new Fault('Recovery successor Run 丢失，拒绝重复创建', 409);
      }
      const task = options.task ?? (options.taskId ? this.task(options.taskId) : undefined);
      const run = this.run(options.role, item.projectId, options.profile, task, {
        recoveryItemId: item.id,
        ...(options.secondaryReview ? { secondaryReview: true } : {}),
        ...(options.reviewAxis ? { reviewAxis: options.reviewAxis } : {}),
        ...(options.sourceMessageId ? { sourceMessageId: options.sourceMessageId } : {}),
        ...(options.incidentId ? { suppressSource: true } : {}),
        ...(options.incidentId ? { incidentId: options.incidentId } : {}),
        ...(options.incidentPhase ? { incidentPhase: options.incidentPhase } : {}),
        ...(options.incidentEvidence ? { incidentEvidence: options.incidentEvidence } : {}),
        ...(item.revision ? { revision: item.revision } : {}),
      });
      const next: RecoveryItem = {
        ...item,
        status: 'resumed',
        successorRunId: run.id,
        ...(options.reviewAxis ? { reviewAxis: options.reviewAxis } : {}),
        ...(options.incidentId ? { incidentId: options.incidentId } : {}),
        ...(options.recoveryPrompt ? { recoveryPrompt: options.recoveryPrompt } : {}),
        updatedAt: now(),
      };
      this.put('recovery', item.id, next);
      return structuredClone(run);
    });
  }
  finishRecovery(key: string, status: Extract<RecoveryItem['status'], 'cancelled' | 'resumed'>) {
    const item = this.get('recovery', key);
    if (!item) throw new Fault('Recovery item 不存在', 404);
    if (item.successorRunId && status === 'cancelled')
      throw new Fault('Recovery item 已创建 successor Run', 409);
    const next = { ...item, status, updatedAt: now() };
    this.put('recovery', key, next);
    return structuredClone(next);
  }

  recover(): RecoveryItem[] {
    for (const operation of this.list('operation'))
      if (operation.kind === 'steer' && operation.status === 'pending')
        this.put('operation', operation.id, {
          ...operation,
          status: 'uncertain',
          error: operation.error ?? '服务重启时 Steer 结果未知，必须先核对后重试',
        });
    for (const m of this.list('message'))
      if (m.role === 'user' && m.status === 'running') {
        this.put('message', m.id, { ...m, status: 'failed', draftStatus: 'failed' });
        this.addMessage(
          m.projectId,
          'system',
          '上次 PM 响应被中断，已保留会话和已创建的任务；可重新发送该消息继续。',
          undefined,
          undefined,
          undefined,
          { sourceMessageId: m.id },
        );
      }
    const recovered: RecoveryItem[] = this.list('recovery').map((item) => structuredClone(item));
    for (const r of this.activeRuns()) {
      const existing = this.list('recovery').find(
        (item) => item.oldRunId === r.id || item.successorRunId === r.id,
      );
      if (existing) {
        if (!recovered.some((item) => item.id === existing.id))
          recovered.push(structuredClone(existing));
        continue;
      }
      const task = r.taskId ? this.get('task', r.taskId) : undefined;
      const draft = this.list('message').find(
        (message) =>
          message.role === 'assistant' &&
          message.runId === r.id &&
          message.draftStatus !== 'completed',
      );
      const project = this.project(r.projectId);
      const policy: RecoveryPolicy = project.recoveryPolicy ?? 'automatic';
      if (r.role === 'pm')
        this.activity(r, `recovery:${r.id}`, {
          kind: 'trigger',
          title: '服务重启恢复',
          status: 'interrupted',
          details: {
            source: '服务重启恢复',
            summary:
              policy === 'automatic'
                ? '上次运行中断，将从最后持久化阶段继续。'
                : '上次运行中断，等待用户恢复核对。',
          },
        });
      const reason = '服务重启；保留工作区和已有证据，等待恢复核对';
      this.finishRun(r.id, 'interrupted', reason);
      if (draft)
        this.updateMessage(draft.id, {
          status: 'queued',
          draftStatus: 'draft',
        });
      const preserveTask =
        !!task && (task.pausedByUser === true || ['done', 'cancelled'].includes(task.stage));
      if (task && !preserveTask)
        this.updateTask(task.id, {
          control: 'paused',
          pausedByUser: false,
          blocked: `运行中断：${reason}`,
          blockedDescriptor: { code: 'run_interrupted', params: { runId: r.id }, detail: reason },
        });
      const at = now();
      const item: RecoveryItem = {
        id: id(),
        projectId: r.projectId,
        oldRunId: r.id,
        runId: r.id,
        ...(r.taskId ? { taskId: r.taskId } : {}),
        role: r.role,
        ...(r.threadId ? { threadId: r.threadId } : {}),
        ...(task ? { revision: { head: task.head, base: task.base } } : {}),
        ...(draft?.draftId ? { draftId: draft.draftId } : {}),
        ...(r.sourceMessageId
          ? { messageId: r.sourceMessageId, sourceMessageId: r.sourceMessageId }
          : {}),
        ...(r.reviewAxis ? { reviewAxis: r.reviewAxis } : {}),
        ...(r.incidentId ? { incidentId: r.incidentId } : {}),
        ...(r.incidentId
          ? {
              recoveryPrompt: `Incident ${r.incidentId}（${r.incidentPhase ?? 'unknown'}）评估：${r.incidentEvidence ?? r.error ?? reason}`,
            }
          : {}),
        ...(task ? { stage: task.stage } : {}),
        status: policy === 'automatic' && !preserveTask ? 'pending' : 'recoverable',
        policy,
        pauseProvenance: preserveTask
          ? task?.stage === 'done' || task?.stage === 'cancelled'
            ? 'terminal'
            : 'user'
          : 'runtime',
        pausedByUser: preserveTask && task?.control === 'paused',
        reason,
        reasonDescriptor: {
          code:
            preserveTask && task?.control === 'paused' ? 'recovery_user_paused' : 'run_interrupted',
          params: { runId: r.id },
          detail: reason,
        },
        createdAt: at,
        updatedAt: at,
      };
      this.put('recovery', item.id, item);
      this.event('recovery', policy === 'automatic' ? '已排队自动恢复' : '等待手动恢复', {
        projectId: item.projectId,
        taskId: item.taskId,
        runId: item.oldRunId,
      });
      recovered.push(structuredClone(item));
    }
    for (const r of this.list('repo'))
      if (r.preview?.status === 'running' || r.preview?.status === 'starting')
        this.patchRepo(r.id, {
          preview: { status: 'stopped', error: '服务重启，体验环境需重新启动' },
        });
    return recovered;
  }
}
