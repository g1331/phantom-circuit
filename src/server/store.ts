import type { SourceInput, SourceReply } from '../shared/intake.ts';
import {
  priorityValues,
  type PriorityLevel,
  type PriorityChange,
} from '../shared/priority.ts';
import {
  creationPriorityInput,
  taskInput,
  priorityUpdateInput,
} from './schemas.ts';
import { DatabaseSync } from 'node:sqlite';
import {
  externalDeliveryNotice,
  issueFree,
  taskAttention,
} from '../shared/task-history.ts';
import { hasOwner } from '../shared/team.ts';
import { EventEmitter } from 'node:events';
import { redact, bounded } from './redaction.ts';
import { engineeringMetadata } from './task-naming.ts';
import { officialProvider, type Provider } from '../shared/types.ts';
import type { UsageMode } from './usage.ts';
import {
  Fault,
  id,
  now,
  type Entities,
  type MessageOptions,
  type RunOptions,
  type StoreContext,
} from './store-core.ts';
export { Fault, id, now, redact, type MessageOptions, type RunOptions } from './store-core.ts';
import * as storeProfiles from './store-profiles.ts';
import { defaults, initializeOmpProfiles, ompProfileInitialization } from './store-profiles.ts';
export { defaults, initializeOmpProfiles, ompProfileInitialization } from './store-profiles.ts';
import * as storeInstructions from './store-instructions.ts';
import * as storeIncidents from './store-incidents.ts';
import * as storeScheduling from './store-scheduling.ts';
import * as storeRecovery from './store-recovery.ts';
import type {
  InstructionSuggestion,
  ConversationPage,
  ConversationQuery,
  TeamInstructionSections,
  TeamInstructionsVersion,
  AccountAllowance,
  AgentKind,
  AgentSelection,
  Clarification,
  ClarificationAnswer,
  CostEstimate,
  Incident,
  ModelIdentity,
  Profile,
  ProfileMode,
  RecoveryItem,
  SchedulingExplanation,
  Project,
  Repo,
  Task,
  TaskControlContext,
  Run,
  Message,
  OwnerMessage,
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

export type OwnerSource = ReturnType<Store['ownerSource']>;

export class Store {
  private db: DatabaseSync;
  readonly changes = new EventEmitter();
  private readonly ctx: StoreContext;
  private createContext(): StoreContext {
    const self = this;
    return {
      get db() {
        return self.db;
      },
      get: (kind, key) => this.get(kind, key),
      put: (kind, key, value) => this.put(kind, key, value),
      list: (kind) => this.list(kind),
      transaction: (fn) => this.transaction(fn),
      emitChange: () => {
        this.changes.emit('change');
      },
      project: (key) => this.project(key),
      repo: (key) => this.repo(key),
      task: (key) => this.task(key),
      settings: () => this.settings(),
      event: (type, message, refs, descriptor) => this.event(type, message, refs, descriptor),
      activeRuns: () => this.activeRuns(),
      assertTaskExecutable: (key) => this.assertTaskExecutable(key),
      updateTask: (key, patch) => this.updateTask(key, patch),
      updateTaskControl: (key, patch, action, context) =>
        this.updateTaskControl(key, patch, action, context),
      taskControlEvent: (task, action, context) => this.taskControlEvent(task, action, context),
      run: (role, projectId, profile, task, options) =>
        this.run(role, projectId, profile, task, options),
      finishRun: (key, status, error, options) => this.finishRun(key, status, error, options),
      activity: (run, key, patch) => this.activity(run, key, patch),
      patchRepo: (key, patch) => this.patchRepo(key, patch),
      addMessage: (projectId, role, content, intent, attachments, messageId, options) =>
        this.addMessage(projectId, role, content, intent, attachments, messageId, options),
      updateMessage: (key, patch) => this.updateMessage(key, patch),
      sourceAuthority: (messageId, projectId, repoId) =>
        this.sourceAuthority(messageId, projectId, repoId),
      rebindIncidentAssessment: (incidentId, previousRunId, successorRunId) =>
        this.rebindIncidentAssessment(incidentId, previousRunId, successorRunId),
      updateIncident: (keyOrProject, patchOrKey, maybePatch) =>
        this.updateIncident(keyOrProject, patchOrKey, maybePatch),
      taskUsage: (taskId) => this.taskUsage(taskId),
      taskCost: (taskId) => this.taskCost(taskId),
      runCost: (key) => this.runCost(key),
    };
  }
  constructor(readonly file: string) {
    this.ctx = this.createContext();
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS conversation_timeline ON documents (
        json_extract(body, '$.projectId'),
        COALESCE(json_extract(body, '$.createdAt'), json_extract(body, '$.startedAt')),
        COALESCE(json_extract(body, '$.timelineOrder'), 0)
      ) WHERE kind IN ('message', 'activity');`);
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
      const settings = storeProfiles.normalizeSettings(storedSettings ?? structuredClone(defaults));
      this.put('settings', 'global', settings);
      for (const project of this.list('project')) {
        let changed = project.admissionPaused === undefined;
        project.admissionPaused ??= false;
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
          project.profileModes = storeProfiles.pinnedModes();
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
  teamInstructionsHistory(projectId: string) {
    return storeInstructions.teamInstructionsHistory(this.ctx, projectId);
  }
  currentTeamInstructions(projectId: string): TeamInstructionsVersion {
    return storeInstructions.currentTeamInstructions(this.ctx, projectId);
  }
  runTeamInstructions(run: Run): TeamInstructionsVersion {
    return storeInstructions.runTeamInstructions(this.ctx, run);
  }
  saveTeamInstructions(
    projectId: string,
    sections: TeamInstructionSections,
    provenance: {
      source: 'user' | 'team';
      baseVersion: number;
      taskId?: string;
      restoredFromVersion?: number;
      suggestionId?: string;
      interruptionIds?: string[];
      interruptionCategories?: string[];
    },
  ) {
    return storeInstructions.saveTeamInstructions(this.ctx, projectId, sections, provenance);
  }
  restoreTeamInstructions(projectId: string, version: number, baseVersion: number) {
    return storeInstructions.restoreTeamInstructions(this.ctx, projectId, version, baseVersion);
  }
  recordRetrospective(
    taskId: string,
    input: Pick<
      InstructionSuggestion,
      'baseVersion' | 'category' | 'interruptionIds' | 'reason' | 'sections'
    >,
    status?: InstructionSuggestion['status'],
  ) {
    return storeInstructions.recordRetrospective(this.ctx, taskId, input, status);
  }
  decideSuggestion(projectId: string, id: string, action: 'adopt' | 'ignore') {
    return storeInstructions.decideSuggestion(this.ctx, projectId, id, action);
  }
  setAutoAdoptInstructions(projectId: string, enabled: boolean) {
    return storeInstructions.setAutoAdoptInstructions(this.ctx, projectId, enabled);
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
    if (kind === 'sourceInput' || kind === 'inputIdentity') {
      const previous = this.get(kind, key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(value))
        throw new Fault('外部输入证据不可修改', 409);
    }
    this.db
      .prepare(
        'INSERT INTO documents VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body',
      )
      .run(kind, key, JSON.stringify(value));
  }
  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
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
    return storeProfiles.saveSettings(this.ctx, settings);
  }
  assertProviderUnused(providerId: string) {
    return storeProfiles.assertProviderUnused(this.ctx, providerId);
  }
  saveProjectProfiles(projectId: string, profiles: Settings['profiles']) {
    return storeProfiles.saveProjectProfiles(this.ctx, projectId, profiles);
  }
  saveProjectOmpProfiles(projectId: string, profiles: NonNullable<Settings['ompProfiles']>) {
    return storeProfiles.saveProjectOmpProfiles(this.ctx, projectId, profiles);
  }
  saveProjectAgentSelection(projectId: string, selection: AgentSelection) {
    return this.saveProjectRuntimeConfig(projectId, { agentSelection: selection });
  }
  saveProjectProfileModes(projectId: string, modes: Record<ProfileName, ProfileMode>) {
    return storeProfiles.saveProjectProfileModes(this.ctx, projectId, modes);
  }
  saveProjectRuntimeConfig(
    projectId: string,
    patch: storeProfiles.ProjectRuntimePatch,
  ) {
    return storeProfiles.saveProjectRuntimeConfig(this.ctx, projectId, patch);
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
    const bound = { ...this.get('run', run.id)!, threadId };
    this.put('run', run.id, bound);
    if (run.ownerMessageId || run.purpose) return;
    if (
      run.role === 'dev' &&
      run.taskId &&
      bound.status === 'running' &&
      hasOwner(this.task(run.taskId))
    )
      this.updateTask(run.taskId, { ownerRunId: run.id });
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
    refs: Partial<Pick<Event, 'projectId' | 'taskId' | 'runId' | 'control'>> = {},
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
  projectEvents(projectId: string): Event[] {
    this.project(projectId);
    return (
      this.db.prepare('SELECT id,body FROM events ORDER BY id').all() as {
        id: number;
        body: string;
      }[]
    )
      .map((row) => ({ ...JSON.parse(row.body), id: row.id }) as Event)
      .filter((event) => event.projectId === projectId);
  }
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
    return storeIncidents.createIncident(this.ctx, inputOrProject, runId, phase, message, evidence);
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
    return storeIncidents.updateIncident(this.ctx, keyOrProject, patchOrKey, maybePatch);
  }
  claimIncidentAssessment(key: string, assessmentRunId: string) {
    return storeIncidents.claimIncidentAssessment(this.ctx, key, assessmentRunId);
  }
  assessIncident(key: string, assessmentRunId: string) {
    return this.claimIncidentAssessment(key, assessmentRunId);
  }
  createClarification(input: unknown): Clarification {
    return storeIncidents.createClarification(this.ctx, input);
  }
  recordReviewClarification(runId: string, input: unknown): Clarification {
    return storeIncidents.recordReviewClarification(this.ctx, runId, input);
  }
  claimClarificationReview(clarificationId: string): Run | undefined {
    return storeIncidents.claimClarificationReview(this.ctx, clarificationId);
  }
  answerClarification(
    keyOrProject: string,
    answersOrKey: ClarificationAnswer[] | Record<string, string | string[]> | string,
    maybeAnswers?: ClarificationAnswer[] | Record<string, string | string[]>,
  ) {
    return storeIncidents.answerClarification(this.ctx, keyOrProject, answersOrKey, maybeAnswers);
  }
  cancelClarification(keyOrProject: string, maybeKey?: string) {
    return storeIncidents.cancelClarification(this.ctx, keyOrProject, maybeKey);
  }
  clarificationGate(sourceMessageId: string) {
    return storeIncidents.clarificationGate(this.ctx, sourceMessageId);
  }
  conversationPage(projectId: string, query: ConversationQuery = {}): ConversationPage {
    this.project(projectId);
    // Cursor subqueries must share the index without materializing every historical body.
    const timeline = `WITH timeline AS NOT MATERIALIZED (
      SELECT kind, id, body, rowid AS position,
        COALESCE(json_extract(body, '$.createdAt'), json_extract(body, '$.startedAt')) AS at,
        COALESCE(json_extract(body, '$.timelineOrder'), 0) AS ordinal
      FROM documents WHERE kind IN ('message', 'activity')
        AND json_extract(body, '$.projectId') = ?
    )`;
    const cursor = query.before ?? query.after;
    if (query.ids && query.ids.length > 50) throw new Fault('每批最多读取 50 项', 400);
    const requested = query.ids ?? (cursor ? [cursor] : []);
    if (
      requested.length &&
      this.db
        .prepare(
          `SELECT 1 FROM documents
      WHERE kind IN ('message', 'activity') AND id IN (${requested.map(() => '?').join(',')})
        AND json_extract(body, '$.projectId') <> ? LIMIT 1`,
        )
        .get(...requested, projectId)
    )
      throw new Fault('跨项目操作被拒绝', 403);
    if (
      cursor &&
      !this.db.prepare(`${timeline} SELECT id FROM timeline WHERE id = ?`).get(projectId, cursor)
    )
      throw new Fault('聊天游标无效', 400);
    const relation = query.before ? '<' : '>';
    const condition = query.ids
      ? `WHERE id IN (${query.ids.map(() => '?').join(',') || 'NULL'})`
      : cursor
        ? `WHERE (at, ordinal, position) ${relation}
          (SELECT at, ordinal, position FROM timeline WHERE id = ?)`
        : '';
    const direction = query.after || query.ids ? 'ASC' : 'DESC';
    const rows = this.db
      .prepare(
        `${timeline} SELECT kind, id, body FROM timeline
      ${condition} ORDER BY at ${direction}, ordinal ${direction}, position ${direction}
      LIMIT 50`,
      )
      .all(projectId, ...(query.ids ?? (cursor ? [cursor] : []))) as {
      kind: 'message' | 'activity';
      id: string;
      body: string;
    }[];
    if (direction === 'DESC') rows.reverse();
    const exists = (id: string | undefined, comparison: '<' | '>') =>
      !!id &&
      !!this.db
        .prepare(
          `${timeline} SELECT 1 FROM timeline WHERE (at, ordinal, position) ${comparison}
        (SELECT at, ordinal, position FROM timeline WHERE id = ?) LIMIT 1`,
        )
        .get(projectId, id);
    return {
      entries: rows.map((row) =>
        row.kind === 'message'
          ? { kind: 'message', cursor: row.id, value: JSON.parse(row.body) as Message }
          : { kind: 'activity', cursor: row.id, value: JSON.parse(row.body) as PMActivity },
      ),
      hasBefore: exists(rows[0]?.id, '<'),
      hasAfter: exists(rows.at(-1)?.id, '>'),
    };
  }
  snapshot(options?: { conversation: 'bounded' }): Snapshot {
    return {
      teamInstructions: this.list('teamInstructions'),
      suggestions: this.list('suggestion'),
      activities: options ? [] : this.list('activity'),
      providers: [{ ...officialProvider }, ...this.list('provider')],
      projects: this.list('project'),
      repos: this.list('repo'),
      tasks: this.list('task').map((task) =>
        task.issueOrigin ? { ...task, issueBody: undefined } : task,
      ),
      runs: this.list('run'),
      messages: options
        ? []
        : this.list('message').map((message) =>
            message.origin ? { ...message, content: '' } : message,
          ),
      events: this.events(),
      settings: this.settings(),
      documents: this.list('document'),
      incidents: this.list('incident'),
      clarifications: this.list('clarification'),
      recoveryItems: this.list('recovery'),
      accountAllowances: this.list('allowance'),
      ownerMessages: this.list('ownerMessage'),
    };
  }
  addOwnerMessage(taskId: string, content: string) {
    return this.transaction(() => {
      const task = this.task(taskId);
      if (!hasOwner(task)) throw new Fault('这项工作还没有负责人接手，请先和联络人沟通', 409);
      const m: OwnerMessage = {
        id: id(),
        projectId: task.projectId,
        taskId,
        role: 'user',
        content: redact(content),
        createdAt: now(),
        status: 'queued',
      };
      this.put('ownerMessage', m.id, m);
      return m;
    });
  }
  ownerReply(
    question: OwnerMessage,
    content: string,
    runId: string,
    context?: OwnerMessage['context'],
  ) {
    return this.transaction(() => {
      this.put('ownerMessage', question.id, { ...question, status: 'answered', runId });
      const m: OwnerMessage = {
        id: id(),
        projectId: question.projectId,
        taskId: question.taskId,
        role: 'owner',
        content: redact(content),
        createdAt: now(),
        runId,
        ...(context ? { context } : {}),
      };
      this.put('ownerMessage', m.id, m);
      return m;
    });
  }
  setOwnerMessage(key: string, patch: Pick<OwnerMessage, 'status'> & Partial<OwnerMessage>) {
    this.transaction(() => {
      const m = this.get('ownerMessage', key);
      if (m) this.put('ownerMessage', key, { ...m, ...patch });
    });
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
    this.changes.emit('activity', value);
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
        profileModes: storeProfiles.inheritedModes(),
        secondaryReviewProfile: this.settings().secondaryReviewProfile
          ? structuredClone(this.settings().secondaryReviewProfile)
          : undefined,
        secondaryReviewProfiles: this.settings().secondaryReviewProfiles
          ? structuredClone(this.settings().secondaryReviewProfiles)
          : undefined,
        admissionPaused: false,
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
        | 'followUpsEnabled'
        | 'blocked'
        | 'milestone'
        | 'preview'
      >
    >,
  ) {
    const r = this.repo(key);
    if ((patch.enabled || patch.followUpsEnabled) && !(patch.authorized ?? r.authorized))
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
    if (
      previous.origin &&
      ['origin', 'content', 'intent', 'role', 'projectId', 'id'].some((field) => field in patch)
    )
      throw new Fault('外部来源及原始正文不可修改', 409);
    if (!previous.origin && patch.origin) throw new Fault('不能伪造外部来源', 403);
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
    for (const item of this.list('recovery')) {
      if (
        item.oldRunId !== run.id ||
        item.incidentId ||
        item.successorRunId ||
        !['pending', 'recoverable'].includes(item.status)
      )
        continue;
      this.put('recovery', item.id, {
        ...item,
        sourceMessageId: message.id,
        messageId: message.id,
        recoveryPrompt: message.content,
        updatedAt: now(),
      });
    }
    if (run.taskId) {
      const task = this.get('task', run.taskId);
      if (task && !task.issueOrigin)
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
      if (existing) return { operation: structuredClone(existing), created: false };
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
      return { operation: structuredClone(operation), created: true };
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
                  runId: undefined,
                  sourceMessageId: undefined,
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
              : status === 'done'
                ? { descriptor: undefined }
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
      // Written directly: `updateIncident` refuses a change of assessor, which is the point here.
      const next: Incident = {
        ...incident,
        assessmentRunId: successorRunId,
        assessmentAt: now(),
        status: incident.status === 'open' ? 'assessing' : incident.status,
        updatedAt: now(),
      };
      this.put('incident', incidentId, next);
      return structuredClone(next);
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
  workflowInputs(projectId: string, before?: string, limit = 30) {
    const size = Math.max(1, Math.min(50, limit));
    const boundary = before
      ? (this.db
          .prepare(
            "SELECT rowid FROM documents WHERE kind='sourceInput' AND id=? AND json_extract(body,'$.projectId')=?",
          )
          .get(before, projectId) as { rowid: number } | undefined)
      : undefined;
    if (before && !boundary) throw new Fault('输入分页位置不存在', 400);
    const rows = this.db
      .prepare(
        "SELECT json_remove(body,'$.body') AS body FROM documents WHERE kind='sourceInput' AND json_extract(body,'$.projectId')=? AND rowid<? ORDER BY rowid DESC LIMIT ?",
      )
      .all(projectId, boundary?.rowid ?? Number.MAX_SAFE_INTEGER, size + 1) as { body: string }[];
    const inputs = rows
      .slice(0, size)
      .map((row) => JSON.parse(row.body) as Omit<SourceInput, 'body'>);
    return { inputs, ...(rows.length > size ? { next: inputs.at(-1)?.id } : {}) };
  }
  workflowInputSummaries(projectId: string, ids: string[]): Omit<SourceInput, 'body'>[] {
    const rows = this.db
      .prepare(
        "SELECT json_remove(body,'$.body') AS body FROM documents WHERE kind='sourceInput' " +
          `AND id IN (${ids.map(() => '?').join(',')}) ` +
          "AND json_extract(body,'$.projectId')=? ORDER BY rowid DESC",
      )
      .all(...ids, projectId) as { body: string }[];
    return rows.map((row) => JSON.parse(row.body));
  }
  workflowReplies(inputId: string): Omit<SourceReply, 'body'>[] {
    const rows = this.db
      .prepare(
        "SELECT json_remove(body,'$.body') AS body FROM documents WHERE kind='sourceReply' " +
          "AND json_extract(body,'$.inputId')=? ORDER BY rowid",
      )
      .all(inputId) as { body: string }[];
    return rows.map((row) => JSON.parse(row.body));
  }
  sourceAuthority(messageId: string, projectId: string, repoId?: string) {
    const message = this.get('message', messageId);
    if (!message || message.projectId !== projectId) throw new Fault('来源消息不属于当前项目', 403);
    if (!message.origin) {
      if (message.role !== 'user') throw new Fault('只有明确实施的用户需求可以派生任务', 403);
      return { message, external: undefined };
    }
    const origin = message.origin;
    const input = this.get('sourceInput', origin.inputId);
    const assessment = this.get('inputAssessment', origin.assessmentId);
    const grant = assessment?.admission;
    const source = input ? this.get('intakeSource', input.sourceId) : undefined;
    if (
      !source ||
      source.projectId !== projectId ||
      source.repoId !== input?.repoId ||
      !input ||
      !assessment ||
      !grant ||
      input.id !== assessment.inputId ||
      assessment.sourceId !== input.sourceId ||
      input.projectId !== projectId ||
      assessment.projectId !== projectId ||
      input.repoId !== assessment.repoId ||
      (repoId !== undefined && input.repoId !== repoId) ||
      this.repo(input.repoId).projectId !== projectId ||
      grant.inputId !== input.id ||
      grant.actorId !== input.actor.id ||
      grant.policyVersion !== assessment.policyVersion ||
      input.actor.kind !== 'user' ||
      !input.body.startsWith(grant.command) ||
      !/^(?:\s|$)/.test(input.body.slice(grant.command.length)) ||
      message.role !== 'system' ||
      message.intent !== 'implement' ||
      message.content !== input.body ||
      origin.issue !== input.number ||
      origin.url !== input.url ||
      origin.kind !== input.kind ||
      JSON.stringify(origin.actor) !== JSON.stringify(input.actor) ||
      !('messageId' in assessment.disposition) ||
      assessment.disposition.messageId !== message.id
    )
      throw new Fault('外部来源授权证据不完整或绑定不一致', 403);
    return { message, external: { input, assessment } };
  }
  sourceTask(messageId: string, projectId: string, taskId: string) {
    const task = this.task(taskId);
    const { external } = this.sourceAuthority(messageId, projectId, task.repoId);
    if (external && task.sourceMessageId !== messageId)
      throw new Fault('外部来源不能操作其他请求的任务', 403);
    return task;
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
        registrationDecision?: {
          mode: 'issue' | 'none';
          basis: 'source' | 'team';
          quote: string;
          section?: 'repository' | 'engineering' | 'delivery';
        };
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
    // The branch name needs the complete tuple; a partial one would only fail after the claim.
    try {
      engineeringMetadata(input);
    } catch (error) {
      throw new Fault(
        `${(error as Error).message}（changeType、scope、summaryEn 必须同时提供或都不提供）`,
      );
    }
    const authority = this.sourceAuthority(input.sourceMessageId, input.projectId, input.repoId);
    const source = authority.message;
    if (!['implement', 'feedback'].includes(source.intent ?? ''))
      throw new Fault('只有明确实施的用户需求可以派生任务');
    if (authority.external?.assessment.disposition.status === 'no_action')
      throw new Fault('已记录无需行动，不能再派生任务', 409);
    if (authority.external && this.project(input.projectId).admissionPaused)
      throw new Fault('团队已暂停接收工作', 409);
    const sourceClarification = this.list('clarification').find(
      (clarification) =>
        clarification.sourceMessageId === input.sourceMessageId &&
        !clarification.review &&
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
    const registration = taskInput.shape.registrationDecision.parse(input.registrationDecision);
    const instructions = prioritySource?.runId
      ? this.runTeamInstructions(this.get('run', prioritySource.runId)!)
      : this.currentTeamInstructions(input.projectId);
    if (registration && !authority.external) {
      const text =
        registration.basis === 'source'
          ? source.role === 'user' && !source.origin
            ? source.content
            : ''
          : registration.section
            ? instructions.sections[registration.section]
            : '';
      if (!text.includes(registration.quote))
        throw new Fault('Issue 登记决定必须引用当前请求或已采用团队说明的原文', 409);
    }
    if (authority.external) {
      const prior = this.list('task').find((task) => task.sourceMessageId === source.id);
      if (prior) {
        const clarification = this.createClarification({
          projectId: input.projectId,
          sourceMessageId: source.id,
          sourceIntent: source.intent,
          taskId: prior.id,
          questions: [
            { question: '此 Issue 请求需要多个独立交付，请先决定单项交付范围；现有任务已暂停。' },
          ],
        });
        this.updateTaskControl(
          prior.id,
          { control: 'paused', pausedByUser: false, blocked: '多个独立交付需要先确认范围' },
          'pause',
          { source: 'host', reason: 'intake_scope' },
        );
        this.put('inputAssessment', authority.external.assessment.id, {
          ...authority.external.assessment,
          updatedAt: now(),
          disposition: {
            status: 'awaiting_decision',
            messageId: source.id,
            clarificationId: clarification.id,
            reason: '多个独立交付需要先确认范围',
          },
        });
        throw new Fault('一个外部请求只允许一个独立交付，已暂停并请求范围决定', 409);
      }
    }
    for (const dep of input.dependencies) {
      if (this.task(dep).projectId !== input.projectId) throw new Fault('依赖必须属于当前项目');
    }
    const profile: ProfileName = input.complexity === 'complex' ? 'complex' : input.kind;
    const { registrationDecision: _decision, ...taskData } = input;
    const task: Task = {
      ...taskData,
      issueRegistration: {
        ...(authority.external
          ? { mode: 'issue' as const, basis: 'imported' as const }
          : (registration ?? { mode: 'issue' as const, basis: 'default' as const })),
        sourceMessageId: source.id,
        ...(registration?.basis === 'team'
          ? { teamInstructionsVersion: instructions.version }
          : {}),
      },
      ...(authority.external
        ? {
            issueOrigin: {
              kind: 'external' as const,
              inputId: authority.external.input.id,
              assessmentId: authority.external.assessment.id,
            },
            issue: authority.external.input.number,
            issueUrl: authority.external.input.url,
            issueNodeId: authority.external.input.nativeId,
            issueDatabaseId: this.get('inputIdentity', authority.external.input.id)?.databaseId,
            issueBody: authority.external.input.body,
            issueState: 'open' as const,
          }
        : {}),
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
    this.transaction(() => {
      this.put('task', task.id, task);
      if (authority.external)
        this.put('inputAssessment', authority.external.assessment.id, {
          ...authority.external.assessment,
          updatedAt: now(),
          disposition: { status: 'accepted', messageId: source.id, taskId: task.id },
        });
    });
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
      if (
        source.actor === 'pm' &&
        source.sourceMessageId &&
        this.get('message', source.sourceMessageId)?.origin
      )
        this.sourceTask(source.sourceMessageId, projectId, task.id);
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
    const parts = input.path.split(/[/\\]/);
    if (
      !input.path.trim() ||
      /^[/\\]/.test(input.path) ||
      /[:\0]/.test(input.path) ||
      parts.some((part) => part === '..' || part.replace(/[ .]+$/, '').toLowerCase() === '.git') ||
      !parts.at(-1)?.replace(/[ .]+$/, '')
    )
      throw new Fault('文档路径必须位于仓库内，且不得指向 Git 元数据');
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
    const at = now();
    const wasTerminal = ['done', 'cancelled'].includes(previous.stage);
    const isTerminal = ['done', 'cancelled'].includes(patch.stage ?? previous.stage);
    const endedAt =
      patch.endedAt !== undefined
        ? patch.endedAt
        : isTerminal && !wasTerminal && !previous.endedAt
          ? at
          : previous.endedAt;
    const t = {
      ...previous,
      ...patch,
      ...(endedAt !== undefined ? { endedAt } : {}),
      updatedAt: at,
    };
    const requirementsChanged =
      previous.spec !== t.spec ||
      JSON.stringify(previous.acceptance ?? []) !== JSON.stringify(t.acceptance ?? []);
    if (requirementsChanged && patch.requirementsVersion === undefined) {
      t.requirementsVersion = (previous.requirementsVersion ?? 0) + 1;
    }
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
    return storeProfiles.resolveEffectiveProfile(this.ctx, projectId, profile, options);
  }

  effectiveAgentForProject(projectId: string): AgentKind {
    return storeProfiles.effectiveAgent(this.ctx, this.project(projectId));
  }

  ownerSource(taskId: string) {
    const task = this.task(taskId);
    const source = task.ownerRunId
      ? this.get('run', task.ownerRunId)
      : task.devThreadId
        ? this.list('run').find(
            (run) =>
              run.taskId === task.id &&
              run.role === 'dev' &&
              !run.ownerMessageId &&
              run.threadId === task.devThreadId &&
              run.agentKind === task.devThreadAgentKind &&
              run.profileConfig?.providerId === task.devThreadProviderId &&
              run.profileConfig?.model === task.devThreadProfile?.model &&
              run.profileConfig?.effort === task.devThreadProfile?.effort,
          )
        : undefined;
    if (
      !source ||
      source.taskId !== task.id ||
      source.role !== 'dev' ||
      source.ownerMessageId ||
      !source.threadId ||
      !source.agentKind ||
      !source.profileConfig?.model ||
      !source.profileConfig.providerId ||
      !source.profileConfig.effort ||
      (source.agentKind === 'codex' && !source.provider)
    )
      throw new Fault('暂时取不到负责人的工作记录', 409);
    return {
      run: source,
      threadId: source.threadId,
      agentKind: source.agentKind,
      profileConfig: source.profileConfig,
    };
  }

  private ownerRun(task: Task, ownerMessageId?: string, options: RunOptions = {}): Run {
    const source = this.ownerSource(task.id);
    const fixed = source.run;
    const run: Run = {
      teamInstructionsVersion: this.currentTeamInstructions(task.projectId).version,
      id: id(),
      projectId: task.projectId,
      taskId: task.id,
      repoId: task.repoId,
      role: 'dev',
      profile: fixed.profile,
      profileConfig: structuredClone(source.profileConfig),
      agentKind: source.agentKind,
      agentVersion: fixed.agentVersion,
      provider: structuredClone(fixed.provider),
      model: structuredClone(fixed.model),
      modelIdentity: structuredClone(fixed.modelIdentity),
      profileVersion: fixed.profileVersion,
      priceSnapshot: structuredClone(fixed.priceSnapshot),
      price: structuredClone(fixed.price),
      status: 'running',
      startedAt: now(),
      ownerMessageId,
      ...(!ownerMessageId
        ? {
            resumeThreadId: source.threadId,
            purpose: options.purpose,
            sourceMessageId: task.sourceMessageId,
            sourceIntent: this.get('message', task.sourceMessageId)?.intent,
            revision: { head: task.head, base: task.base },
            recoveryItemId: options.recoveryItemId,
            incidentId: options.incidentId,
            incidentPhase: options.incidentPhase,
            incidentEvidence: options.incidentEvidence,
          }
        : {}),
    };
    this.put('run', run.id, run);
    this.changes.emit('run-start', run);
    return run;
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
    if (taskRecord && (role === 'dev' || role === 'review' || role === 'oncall'))
      this.assertTaskExecutable(taskRecord.id);
    if (options.ownerMessageId) {
      if (!taskRecord || role !== 'dev') throw new Fault('负责人对话需要已有工作', 409);
      return this.ownerRun(taskRecord, options.ownerMessageId);
    }
    if (role === 'dev' && taskRecord?.ownerRunId && options.purpose !== 'collaboration')
      return this.ownerRun(taskRecord, undefined, options);
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
      options.purpose !== 'collaboration' &&
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
      teamInstructionsVersion: this.currentTeamInstructions(projectId).version,
      id: id(),
      projectId,
      role,
      purpose: options.purpose,
      collaborationId: options.collaborationId,
      workspacePath: options.workspacePath,
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
      ...(options.ownerMessageId ? { ownerMessageId: options.ownerMessageId } : {}),
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
    this.changes.emit('run-start', r);
    return r;
  }
  updateRunUsage(key: string, usage: RunUsage, mode: UsageMode = 'cumulative') {
    return storeScheduling.updateRunUsage(this.ctx, key, usage, mode);
  }
  recordRunUsage(key: string, usage: RunUsage, mode: UsageMode = 'cumulative') {
    return this.updateRunUsage(key, usage, mode);
  }
  recordRunDiagnostic(key: string, diagnostic: string) {
    return storeScheduling.recordRunDiagnostic(this.ctx, key, diagnostic);
  }
  pinRunRevision(key: string, revision: { head?: string; base?: string }) {
    return storeScheduling.pinRunRevision(this.ctx, key, revision);
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
    return storeScheduling.finishRun(this.ctx, key, status, error, options);
  }
  runUsage(key: string): RunUsage | undefined {
    return structuredClone(this.get('run', key)?.usage);
  }
  taskUsage(taskId: string): UsageAggregate {
    return storeScheduling.taskUsage(this.ctx, taskId);
  }
  runCost(key: string): CostEstimate | undefined {
    return storeScheduling.runCost(this.ctx, key);
  }
  taskCosts(taskId: string): CostEstimate[] {
    return storeScheduling.taskCosts(this.ctx, taskId);
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
  explainScheduling(projectId: string): SchedulingExplanation {
    return storeScheduling.explainScheduling(this.ctx, projectId);
  }
  claimNext(): Run | undefined {
    return storeScheduling.claimNext(this.ctx);
  }
  assertTaskExecutable(key: string) {
    storeScheduling.assertTaskExecutable(this.ctx, key);
  }
  /** Local-only external settlement. Host merge evidence is neither invented nor modified. */
  completeExternalTask(
    key: string,
    evidence: Omit<
      Extract<NonNullable<Task['completion']>, { source: 'external' }>,
      'source' | 'localCheckpoint'
    >,
  ) {
    return this.transaction(() => {
      const task = this.task(key);
      if (task.completion?.source === 'external') return task;
      const repo = this.repo(task.repoId);
      if (
        ['done', 'cancelled'].includes(task.stage) ||
        !repo.authorized ||
        (task.pr ? task.pr !== evidence.primary.pr : evidence.primary.pr !== evidence.closing.pr) ||
        task.issue !== evidence.issue ||
        (issueFree(task)
          ? !task.pr ||
            !!evidence.issue ||
            !!evidence.relationship ||
            evidence.closing.pr !== evidence.primary.pr ||
            !!this.get('operation', `issue:${task.id}`)
          : task.issueState !== 'completed' ||
            !evidence.issue ||
            !evidence.relationship ||
            !evidence.closedAt) ||
        (!!task.pr && task.prState !== 'merged') ||
        task.prReadFailure ||
        evidence.primary.repoId !== repo.id ||
        evidence.primary.repository !== repo.github ||
        evidence.closing.repoId !== repo.id ||
        evidence.closing.repository !== repo.github ||
        evidence.primary.baseRef !== repo.defaultBranch ||
        evidence.closing.baseRef !== repo.defaultBranch ||
        task.remoteMerge?.head !== evidence.primary.head ||
        task.remoteMerge.base !== evidence.primary.base ||
        task.remoteMerge.mergeCommit !== evidence.primary.mergeCommit ||
        this.activeRuns().some((run) => run.taskId === key && run.role !== 'pm')
      )
        throw new Fault('远端交付证据或运行状态已变化，保留原任务等待团队核对', 409);
      const at = now();
      const completed = this.updateTask(key, {
        stage: 'done',
        completion: {
          ...evidence,
          source: 'external',
          localCheckpoint: {
            head: task.head,
            base: task.base,
            stage: task.stage,
            control: task.control,
            pausedByUser: task.pausedByUser,
            ownerRunId: task.ownerRunId,
          },
        },
        deliveryRevision: { head: evidence.primary.head, commit: evidence.primary.mergeCommit },
        externalCompletionPendingReason: undefined,
        completionDeliveryPending: !!task.issueOrigin,
        completionSyncedAt: at,
      });
      for (const incident of this.list('incident'))
        if (incident.taskId === key && incident.status !== 'resolved')
          this.put('incident', incident.id, { ...incident, supersededByExternalCompletionAt: at });
      for (const recovery of this.list('recovery'))
        if (recovery.taskId === key)
          this.put('recovery', recovery.id, { ...recovery, supersededByExternalCompletionAt: at });
      const notice = externalDeliveryNotice(completed);
      const message = this.addMessage(task.projectId, 'assistant', notice.content);
      this.updateMessage(message.id, { descriptor: notice.descriptor });
      this.event('external-completion', '已核实远端关联交付并结案；保留原本机工程记录', {
        projectId: task.projectId,
        taskId: key,
      });
      this.changes.emit('delivery', task.repoId);
      return completed;
    });
  }
  control(key: string, action: 'pause' | 'resume' | 'cancel', context?: TaskControlContext) {
    return this.transaction(() => {
      const t = this.task(key);
      if (action === 'resume') this.assertTaskExecutable(key);
      if (['done', 'cancelled'].includes(t.stage)) throw new Fault('任务已经结束');
      if (action === 'cancel') this.updateTask(key, { stage: 'cancelled', control: 'paused' });
      else
        this.updateTask(key, {
          control: action === 'pause' ? 'paused' : 'active',
          pausedByUser: action === 'pause' ? true : false,
          blocked: action === 'resume' ? undefined : t.blocked,
          blockedDescriptor: action === 'resume' ? undefined : t.blockedDescriptor,
        });
      this.taskControlEvent(t, action, context);
    });
  }
  /** Direct host/PM state patches retain their existing semantics, with atomic transition evidence. */
  updateTaskControl(
    key: string,
    patch: Partial<Task>,
    action: 'pause' | 'resume' | 'cancel',
    context?: TaskControlContext,
  ) {
    return this.transaction(() => {
      const previous = this.task(key);
      if (action === 'resume') this.assertTaskExecutable(key);
      const next = this.updateTask(key, patch);
      if (
        previous.control !== next.control ||
        (action === 'cancel' && previous.stage !== next.stage)
      )
        this.taskControlEvent(next, action, context);
      return next;
    });
  }
  private taskControlEvent(
    task: Task,
    action: 'pause' | 'resume' | 'cancel',
    context?: TaskControlContext,
  ) {
    const refs: Partial<Pick<Event, 'runId' | 'control'>> = {};
    if (context) {
      const { runId, ...provenance } = context;
      refs.runId = runId;
      refs.control = { ...provenance, action };
    }
    this.event('task', `任务 ${action}`, {
      projectId: task.projectId,
      taskId: task.id,
      ...refs,
    });
  }
  resumeRecovery(key: string) {
    return storeRecovery.resumeRecovery(this.ctx, key);
  }
  recoveryForProject(projectId: string, key?: string) {
    return storeRecovery.recoveryForProject(this.ctx, projectId, key);
  }
  cancelRecovery(key: string) {
    return storeRecovery.cancelRecovery(this.ctx, key);
  }
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
    return storeRecovery.ensureRecoverySuccessor(this.ctx, recoveryId, options);
  }
  finishRecovery(key: string, status: Extract<RecoveryItem['status'], 'cancelled' | 'resumed'>) {
    return storeRecovery.finishRecovery(this.ctx, key, status);
  }
  recover(): RecoveryItem[] {
    return storeRecovery.recover(this.ctx);
  }
}
