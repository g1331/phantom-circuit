import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { aggregateUsage } from './usage.ts';

interface Snapshot {
  file: string;
  readAt: string;
  documents: { kind: string; id: string; body: string }[];
  events: { id: number; body: string }[];
}

const kinds = [
  'project',
  'repo',
  'task',
  'run',
  'operation',
  'incident',
  'clarification',
  'recovery',
  'message',
];

/** No Store, host resolver, migration, ownership, logging or temporary files. */
export function readReportSnapshot(dataDir: string): Snapshot {
  const file = join(dataDir, 'phantom.sqlite');
  if (!statSync(dataDir).isDirectory() || !statSync(file).isFile())
    throw new Error('数据目录或 phantom.sqlite 不存在/不是常规文件');
  // SQLite manages WAL/SHM normally, including committed data still in the WAL.
  const db = new DatabaseSync(file, { readOnly: true, timeout: 0 });
  try {
    db.exec('BEGIN');
    const version = db.prepare('PRAGMA user_version').get();
    if (version?.user_version !== 0) throw new Error('未知 SQLite user_version；报告不执行迁移');
    const expected: Record<string, string[]> = {
      documents: ['kind:TEXT:1:1', 'id:TEXT:1:2', 'body:TEXT:1:0'],
      events: ['id:INTEGER:0:1', 'body:TEXT:1:0'],
      meta: ['key:TEXT:0:1', 'value:TEXT:1:0'],
    };
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','view','trigger') ORDER BY name",
      )
      .all();
    if (tables.map((row) => row.name).join(',') !== 'documents,events,meta')
      throw new Error('未知 SQLite 表结构；需要现行 documents/events/meta，报告不执行迁移');
    for (const [table, columns] of Object.entries(expected)) {
      const actual = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => `${row.name}:${row.type}:${row.notnull}:${row.pk}`);
      if (actual.join(',') !== columns.join(',')) throw new Error(`未知 SQLite 表结构：${table}`);
    }
    const documents = db
      .prepare(
        `SELECT kind,id,body FROM documents WHERE kind IN (${kinds.map(() => '?').join(',')})`,
      )
      .all(...kinds) as Snapshot['documents'];
    const events = db.prepare('SELECT id,body FROM events ORDER BY id').all() as Snapshot['events'];
    const readAt = new Date().toISOString();
    db.exec('COMMIT');
    return { file, readAt, documents, events };
  } finally {
    // close also rolls back a failed deferred read transaction. All JSON parsing and
    // aggregation happen after this connection has been closed.
    db.close();
  }
}

const id = z.string().min(1);
const counter = z.number().finite().nonnegative();
const scoped = z.object({ id, projectId: id });
const descriptor = z.object({ code: z.string(), detail: z.string().optional() });
const usage = z.object({
  totalTokens: counter.optional(),
  inputTokens: counter.optional(),
  outputTokens: counter.optional(),
  cachedInputTokens: counter.optional(),
  cacheWriteTokens: counter.optional(),
  reasoningOutputTokens: counter.optional(),
  final: z.boolean().optional(),
});
// These are read projections, not host input schemas: absent legacy evidence stays absent.
const schemas = {
  project: z.object({ id, name: z.string() }),
  repo: scoped.extend({ github: id }),
  task: scoped.extend({
    repoId: id,
    stage: id,
    sourceMessageId: id.optional(),
    createdAt: z.string().optional(),
    head: id.optional(),
    base: id.optional(),
    pr: z.number().int().positive().optional(),
    retries: counter.int().optional(),
  }),
  run: scoped.extend({
    taskId: id.optional(),
    role: z.enum(['pm', 'dev', 'review']),
    status: id,
    sourceMessageId: id.optional(),
    incidentId: id.optional(),
    recoveryItemId: id.optional(),
    usage: usage.optional(),
    error: z.string().optional(),
    errorDescriptor: descriptor.optional(),
  }),
  operation: z.object({ id, kind: id, status: id, result: z.unknown().optional() }),
  incident: scoped.extend({
    taskId: id.optional(),
    runId: id.optional(),
    phase: z.string().optional(),
    createdAt: z.string().optional(),
    message: z.string().optional(),
    descriptor: descriptor.optional(),
  }),
  clarification: scoped.extend({
    taskId: id.optional(),
    sourceMessageId: id.optional(),
    createdAt: z.string().optional(),
  }),
  recovery: scoped.extend({
    taskId: id.optional(),
    oldRunId: id.optional(),
    runId: id.optional(),
    successorRunId: id.optional(),
    policy: z.enum(['automatic', 'manual']).optional(),
    pauseProvenance: z.enum(['user', 'runtime', 'terminal']).optional(),
    createdAt: z.string().optional(),
  }),
  message: scoped.extend({ sourceMessageId: id.optional() }),
};
const eventSchema = z.object({
  at: z.string().optional(),
  type: id,
  projectId: id.optional(),
  taskId: id.optional(),
  runId: id.optional(),
  message: z.string(),
  descriptor: descriptor.optional(),
});

function json(body: string, label: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`损坏 JSON：${label}`);
  }
}

function records<T extends { id: string }>(
  snapshot: Snapshot,
  kind: string,
  schema: z.ZodType<T>,
): T[] {
  return snapshot.documents
    .filter((row) => row.kind === kind)
    .map((row) => {
      const parsed = schema.safeParse(json(row.body, `${kind}/${row.id}`));
      if (!parsed.success || parsed.data.id !== row.id)
        throw new Error(`损坏或不支持的数据字段：${kind}/${row.id}`);
      return parsed.data;
    });
}

function time(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : undefined;
}

function median(values: number[]): string {
  if (!values.length) return 'N/A';
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return String(values.length % 2 ? values[middle] : values[middle - 1] / 2 + values[middle] / 2);
}

type ReportTask = z.infer<typeof schemas.task>;
type ReportRun = z.infer<typeof schemas.run>;
type Sample = { state: 'complete' | 'unknown' | 'partial'; value?: number };

function runTokens(run: ReportRun): Sample {
  const normalized = aggregateUsage([run.usage]);
  const value =
    normalized.totalTokens ??
    (normalized.inputTokens !== undefined && normalized.outputTokens !== undefined
      ? normalized.inputTokens + normalized.outputTokens
      : undefined);
  if (value === undefined)
    return {
      state: Object.keys(run.usage ?? {}).some((key) => key.endsWith('Tokens'))
        ? 'partial'
        : 'unknown',
    };
  // Store freezes usage when a Run ends. Never re-add cache/reasoning subsets or
  // re-interpret the last provider mode as another cumulative/delta update.
  return { value, state: run.usage?.final === true ? 'complete' : 'partial' };
}

const pullEvidence = z.object({
  number: z.number().int().positive(),
  merged: z.literal(true),
  merged_at: z.string().nullable().optional(),
  head: z.object({ sha: id, repo: z.object({ full_name: id }).nullable().optional() }),
  base: z.object({ sha: id, repo: z.object({ full_name: id }).nullable().optional() }),
});

function mergeEvidence(
  task: ReportTask,
  repo: z.infer<typeof schemas.repo> | undefined,
  operations: z.infer<typeof schemas.operation>[],
): { merged: boolean; at?: number } {
  if (!repo || repo.projectId !== task.projectId || !task.head || !task.base || !task.pr)
    return { merged: false };
  const operation = operations.find((op) => op.id === `merge:${task.id}:${task.head}`);
  if (operation?.kind !== 'merge-pr' || operation.status !== 'done') return { merged: false };
  const parsed = pullEvidence.safeParse(operation.result);
  if (!parsed.success) return { merged: false };
  const pr = parsed.data;
  // The operation key pins the host's Task/revision, PR number and base repo pin
  // the remote identity. Missing repository evidence cannot prove Project scope.
  if (
    pr.number !== task.pr ||
    pr.head.sha !== task.head ||
    pr.base.sha !== task.base ||
    pr.base.repo?.full_name.toLowerCase() !== repo.github.toLowerCase()
  )
    return { merged: false };
  return { merged: true, at: time(pr.merged_at ?? undefined) };
}

export function renderReport(snapshot: Snapshot): string {
  const data = {
    projects: records(snapshot, 'project', schemas.project),
    repos: records(snapshot, 'repo', schemas.repo),
    tasks: records(snapshot, 'task', schemas.task),
    runs: records(snapshot, 'run', schemas.run),
    operations: records(snapshot, 'operation', schemas.operation),
    incidents: records(snapshot, 'incident', schemas.incident),
    clarifications: records(snapshot, 'clarification', schemas.clarification),
    recoveries: records(snapshot, 'recovery', schemas.recovery),
    messages: records(snapshot, 'message', schemas.message),
  };
  const events = snapshot.events.map((row) => {
    const parsed = eventSchema.safeParse(json(row.body, `event/${row.id}`));
    if (!parsed.success) throw new Error(`损坏或不支持的数据字段：event/${row.id}`);
    return { ...parsed.data, id: row.id };
  });
  const runProjects = new Map(data.runs.map((run) => [run.id, run.projectId]));
  const lines = [
    'Project 运行评测报告',
    `读取时间：${snapshot.readAt}`,
    `数据来源：${snapshot.file}`,
    '口径：全部持久记录；确认合并按 Task ID；token 先汇总 Task 全部归属 Run，再取中位数；墙钟=createdAt→merged_at。',
    '合并证据：done merge-pr operation + Task/revision/PR/Project Repo 身份；普通 done/聊天/交接时间不证明合并。',
    '干预覆盖：现行数据无历史完整性标记，未发现干预仍为 unknown；无干预率仅为保守下界。',
    'watchdog 证据：type=watchdog Event 或宿主 Watchdog：/Error: Watchdog：前缀；按 Run ID 去重，一般失败不计。',
    '暂停/恢复口径：无 actor 的动作来源为 unknown；仅明确用户来源（如 recovery.pauseProvenance=user）确认为用户干预。',
  ];
  if (!data.projects.length) lines.push('暂无 Project');
  for (const project of data.projects) {
    const tasks = data.tasks.filter((task) => task.projectId === project.id);
    const runs = data.runs.filter((run) => run.projectId === project.id);
    const incidents = data.incidents.filter((incident) => incident.projectId === project.id);
    const clarifications = data.clarifications.filter((item) => item.projectId === project.id);
    const recoveries = data.recoveries.filter((item) => item.projectId === project.id);
    const projectEvents = events.filter((event) => event.projectId === project.id);
    const messages = new Map(
      data.messages
        .filter((message) => message.projectId === project.id)
        .map((message) => [message.id, message]),
    );
    const rootSource = (source: string | undefined): string | undefined => {
      const seen = new Set<string>();
      while (source) {
        if (seen.has(source)) return undefined;
        seen.add(source);
        const parent = messages.get(source)?.sourceMessageId;
        if (!parent) return source;
        source = parent;
      }
      return undefined;
    };
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const byRun = new Map(runs.map((run) => [run.id, run]));
    const sources = new Map<string, ReportTask[]>();
    for (const task of tasks) {
      const source = rootSource(task.sourceMessageId);
      if (source) sources.set(source, [...(sources.get(source) ?? []), task]);
    }
    const linkedTask = (item: { taskId?: string; runId?: string }): string | undefined => {
      if (item.runId && runProjects.has(item.runId) && runProjects.get(item.runId) !== project.id)
        return undefined;
      const fromRun = item.runId ? byRun.get(item.runId)?.taskId : undefined;
      if (item.taskId && fromRun && item.taskId !== fromRun) return undefined;
      const taskId = item.taskId ?? fromRun;
      return taskId && byId.has(taskId) ? taskId : undefined;
    };
    const taskRuns = new Map<string, ReportRun[]>();
    const ambiguous = new Set<string>();
    const unassignedPM: ReportRun[] = [];
    for (const run of runs) {
      let owner = run.taskId && byId.has(run.taskId) ? run.taskId : undefined;
      if (!run.taskId && run.role === 'pm') {
        const incident = incidents.find((item) => item.id === run.incidentId);
        owner = incident ? linkedTask(incident) : undefined;
        if (!owner) {
          const source = rootSource(run.sourceMessageId);
          const candidates = source ? (sources.get(source) ?? []) : [];
          if (candidates.length === 1) owner = candidates[0].id;
          else for (const task of candidates) ambiguous.add(task.id);
        }
      }
      if (owner) taskRuns.set(owner, [...(taskRuns.get(owner) ?? []), run]);
      else if (run.role === 'pm') unassignedPM.push(run);
    }
    const merged = tasks
      .map((task) => ({
        task,
        ...mergeEvidence(
          task,
          data.repos.find((repo) => repo.id === task.repoId),
          data.operations,
        ),
      }))
      .filter((item) => item.merged);
    const incidentPhases = new Map<string, number>();
    for (const incident of incidents) {
      const phase = incident.phase || 'unknown';
      incidentPhases.set(phase, (incidentPhases.get(phase) ?? 0) + 1);
    }
    const watchdogRuns = new Set<string>();
    let unlinkedWatchdog = 0;
    const isWatchdog = (value: string | undefined) => /^(?:Error: )?Watchdog：/.test(value ?? '');
    for (const event of projectEvents)
      if (event.type === 'watchdog') {
        if (
          event.runId &&
          (!runProjects.has(event.runId) || runProjects.get(event.runId) === project.id)
        )
          watchdogRuns.add(event.runId);
        else unlinkedWatchdog++;
      }
    for (const run of runs)
      if (isWatchdog(run.error) || isWatchdog(run.errorDescriptor?.detail))
        watchdogRuns.add(run.id);
    for (const incident of incidents)
      if (isWatchdog(incident.message) || isWatchdog(incident.descriptor?.detail)) {
        if (
          incident.runId &&
          (!runProjects.has(incident.runId) || runProjects.get(incident.runId) === project.id)
        )
          watchdogRuns.add(incident.runId);
        else unlinkedWatchdog++;
      }
    const controls = projectEvents.filter(
      (event) => event.type === 'task' && /^任务 (pause|resume)$/.test(event.message),
    );
    const rework = (subset: ReportTask[]) => {
      const known = subset.filter((task) => task.retries !== undefined);
      return `已知合计=${known.length ? known.reduce((sum, task) => sum + task.retries!, 0) : subset.length ? 'N/A' : 0}；覆盖=${known.length}/${subset.length}；unknown=${subset.length - known.length}`;
    };
    const tokenSamples: number[] = [];
    const wallSamples: number[] = [];
    let tokenUnknown = 0;
    let tokenPartial = 0;
    let intervened = 0;
    const details: string[] = [];
    for (const { task, at } of merged) {
      const assignedRuns = taskRuns.get(task.id) ?? [];
      const samples = assignedRuns.map(runTokens);
      const known = samples.filter((sample) => sample.value !== undefined);
      const observed = known.reduce((sum, sample) => sum + sample.value!, 0);
      const complete =
        samples.length > 0 &&
        samples.every((sample) => sample.state === 'complete') &&
        !ambiguous.has(task.id);
      const partial =
        !complete &&
        (known.length > 0 ||
          samples.some((sample) => sample.state === 'partial') ||
          ambiguous.has(task.id));
      if (complete) tokenSamples.push(observed);
      else if (partial) tokenPartial++;
      else tokenUnknown++;
      const start = time(task.createdAt);
      const wall = start !== undefined && at !== undefined && at >= start ? at - start : undefined;
      if (wall !== undefined) wallSamples.push(wall);
      const beforeMerge = (date: string | undefined) => {
        const value = time(date);
        // A clarification can predate Task publication. Without merged_at only
        // records already present at creation are provably before its merge.
        return value !== undefined && value <= (at ?? start ?? -Infinity);
      };
      const hasIntervention =
        incidents.some(
          (incident) => linkedTask(incident) === task.id && beforeMerge(incident.createdAt),
        ) ||
        clarifications.some(
          (item) =>
            (item.taskId === task.id ||
              (!!rootSource(item.sourceMessageId) &&
                rootSource(item.sourceMessageId) === rootSource(task.sourceMessageId))) &&
            beforeMerge(item.createdAt),
        ) ||
        recoveries.some(
          (item) =>
            linkedTask(item) === task.id &&
            item.pauseProvenance === 'user' &&
            beforeMerge(item.createdAt),
        );
      if (hasIntervention) intervened++;
      details.push(
        `  Task ${task.id}：token=${complete ? observed : partial ? `partial(已知=${known.length ? observed : 'N/A'})` : 'unknown'}；墙钟=${wall === undefined ? 'unknown' : `${wall} ms`}；干预=${hasIntervention ? '有' : 'unknown'}；返工=${task.retries ?? 'unknown'}`,
      );
    }
    const unassignedClarifications = clarifications.filter(
      (item) =>
        !byId.has(item.taskId ?? '') &&
        !sources.get(rootSource(item.sourceMessageId) ?? '')?.length,
    );
    const pmSamples = unassignedPM.map(runTokens);
    const pmKnown = pmSamples.filter((sample) => sample.value !== undefined);
    lines.push(
      '',
      `Project：${project.name} [${project.id}]`,
      `确认合并任务：${merged.length}；历史 done 未确认：${tasks.filter((task) => task.stage === 'done' && !merged.some((item) => item.task.id === task.id)).length}`,
      `无干预合并率（保守下界）：${merged.length ? `0/${merged.length} (0%)` : 'N/A'}；确认无干预：0；确认有干预：${intervened}；未知：${merged.length - intervened}`,
      `未归属干预：Incident=${incidents.filter((incident) => !linkedTask(incident)).length}；暂停/恢复=${controls.filter((event) => !linkedTask(event)).length}；Clarification=${unassignedClarifications.length}`,
      `暂停/恢复事件（缺少 actor，不能确认为用户操作）：${controls.length}；明确用户暂停恢复记录：${recoveries.filter((item) => item.pauseProvenance === 'user').length}`,
      `Incident（全部状态，原始 phase）：${
        [...incidentPhases]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([phase, count]) => `${phase}=${count}`)
          .join('；') || '无 (0)'
      }`,
      `watchdog 触发次数：${watchdogRuns.size}（按 Run ID）；缺少 Run ID、无法去重的触发证据=${unlinkedWatchdog}（不假定彼此独立）`,
      `返工轮数（Project 全部 Task）：${rework(tasks)}`,
      `合并任务返工：${rework(merged.map((item) => item.task))}`,
      `token 中位数：${median(tokenSamples)}；n=${tokenSamples.length}/${merged.length}；unknown=${tokenUnknown}；partial=${tokenPartial}`,
      `墙钟交付耗时中位数：${wallSamples.length ? `${median(wallSamples)} ms` : 'N/A'}；n=${wallSamples.length}/${merged.length}；unknown=${merged.length - wallSamples.length}`,
      `PM 未分配：Run=${unassignedPM.length}；已知 token=${pmKnown.length ? pmKnown.reduce((sum, sample) => sum + sample.value!, 0) : 'N/A'}；usage unknown=${pmSamples.filter((sample) => sample.state === 'unknown').length}；partial=${pmSamples.filter((sample) => sample.state === 'partial').length}；歧义影响 Task=${[...ambiguous].join(',') || '无'}`,
      ...details,
    );
  }
  const orphaned = [
    ...data.repos,
    ...data.tasks,
    ...data.runs,
    ...data.incidents,
    ...data.clarifications,
    ...data.recoveries,
    ...data.messages,
  ].filter((value) => !data.projects.some((project) => project.id === value.projectId)).length;
  if (orphaned) lines.push(`\n未归属 Project 的持久记录：${orphaned}（未摊入任何 Project）`);
  return lines.join('\n') + '\n';
}
