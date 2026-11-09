import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  schemas,
  eventSchema,
  json,
  records,
  time,
  projectAttribution,
  taskInterruptions,
  controlSource,
} from './interruption-attribution.ts';
import { aggregateUsage } from './usage.ts';

export interface Snapshot {
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

function median(values: number[]): string {
  if (!values.length) return 'N/A';
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return String(values.length % 2 ? values[middle] : values[middle - 1] / 2 + values[middle] / 2);
}

function duration(milliseconds: number): string {
  if (milliseconds === 0) return '0秒';
  if (milliseconds < 1000) return '不足1秒';
  if (milliseconds < 60_000) return `${milliseconds / 1000}秒`;
  const minutes = Math.floor(milliseconds / 60_000);
  return minutes < 60 ? `${minutes}分` : `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
}

function tokens(value: number | string): string {
  const [integer, fraction] = String(value).split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

type ReportTask = z.infer<typeof schemas.task>;

function taskLabel(task: ReportTask): string {
  const identity =
    task.issue === undefined ? Array.from(task.id).slice(0, 8).join('') : `#${task.issue}`;
  const title = Array.from(task.title ?? '');
  const shortened = title.length > 40 ? title.slice(0, 39).join('') + '…' : title.join('');
  return shortened ? `${identity} ${shortened}` : identity;
}
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

export function renderReport(snapshot: Snapshot, options: { explain?: boolean } = {}): string {
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
  const messageProjects = new Map(data.messages.map((message) => [message.id, message.projectId]));
  const lines = [
    'Project 运行评测报告',
    `读取时间：${snapshot.readAt}`,
    `数据来源：${snapshot.file}`,
    '口径：全部持久记录；确认合并按 Task ID；token 先汇总 Task 全部归属 Run，再取中位数；墙钟=createdAt→merged_at。',
    '合并证据：done merge-pr operation + Task/revision/PR/Project Repo 身份；普通 done/聊天/交接时间不证明合并。',
    '干预覆盖：Task“无”仅表示未发现已确认干预证据，历史完整性仍为 unknown；无干预率仅为保守下界。',
    'watchdog 证据：type=watchdog Event 或宿主 Watchdog：/Error: Watchdog：前缀；按 Run ID 去重，一般失败不计。',
    '干预归因：用户讨论/反馈仅按同 Project 持久关联或完整 Task ID/唯一 #Issue/精确 Issue URL；共享来源不扩散，原始实施请求排除。Task.createdAt 为本地发布边界，createdAt≤证据时间≤实际 merged_at，消息和 Task 时间缺失不用 updatedAt 补齐；Clarification 保留发布前来源关联。',
    '来源计数：消息按 ID；事故按 Incident ID，采用明确 user/http_incident 或最终 waiting_user 且 Task.createdAt≤Incident.createdAt≤Incident.updatedAt≤merged_at；Incident.updatedAt 仅为最终状态成立的时间上界，晚于合并或缺失/矛盾时间保留缺口。独立用户暂停/恢复/取消按 Event ID，host/pm 不计用户动作，后续内部处置不抹去用户证据；recovery.pauseProvenance=user 无原动作 ID 时仅作用户暂停记录，已有用户暂停则补充证据、不增加次数，无法判定是否另一次暂停。',
  ];
  if (!options.explain) lines.splice(3, 6, '加 --explain 查看统计口径');
  if (!data.projects.length) lines.push('暂无 Project');
  for (const project of data.projects) {
    const attribution = projectAttribution(data, events, project);
    const {
      tasks,
      runs,
      incidents,
      clarifications,
      recoveries,
      projectEvents,
      messages,
      rootSource,
      byId,
      byRun,
      sources,
      linkedTask,
      taskRuns,
      ambiguous,
      unassignedPM,
      merged,
      waitingWindows,
      messageEvidence,
      unassignedMessages,
      messageTimeGaps,
      controls,
      controlTask,
    } = attribution;
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
    const rework = (subset: ReportTask[]) => {
      const known = subset.filter((task) => task.retries !== undefined);
      return `已知合计=${known.length ? known.reduce((sum, task) => sum + task.retries!, 0) : subset.length ? 'N/A' : 0}；覆盖=${known.length}/${subset.length}；unknown=${subset.length - known.length}`;
    };
    const tokenSamples: number[] = [];
    const wallSamples: number[] = [];
    let tokenUnknown = 0;
    let tokenPartial = 0;
    let intervened = 0;
    const confirmedIncidents = new Set<string>();
    const details: { at?: number; line: string }[] = [];
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
      const evidence = taskInterruptions(attribution, task, at);
      for (const id of evidence.get('事故') ?? []) confirmedIncidents.add(id);
      const categories = ['消息', '事故', '暂停', '恢复', '取消', '澄清', '用户暂停记录']
        .filter((category) => evidence.get(category)?.size)
        .map((category) => `${category}${evidence.get(category)!.size}`);
      const count = [...evidence.values()].reduce((sum, ids) => sum + ids.size, 0);
      const hasIntervention = count > 0;
      if (hasIntervention) intervened++;
      details.push({
        at,
        line: `  Task ${taskLabel(task)}：token=${complete ? tokens(observed) : partial ? `partial(已知=${known.length ? tokens(observed) : 'N/A'})` : 'unknown'}；墙钟=${wall === undefined ? 'unknown' : duration(wall)}；干预=${hasIntervention ? `${count}（${categories.join('、')}）` : '无'}；返工=${task.retries ?? 'unknown'}`,
      });
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
      `未归属干预：Incident=${incidents.filter((incident) => !linkedTask(incident)).length}；暂停/恢复/取消=${controls.filter((event) => !controlTask(event)).length}；Clarification=${unassignedClarifications.length}`,
      `消息未归属=${unassignedMessages}；消息时间证据不足=${messageTimeGaps}`,
      `Incident 等待用户时间证据不足=${incidents.filter((item) => waitingWindows.get(item.id) === 'unknown' && !confirmedIncidents.has(item.id)).length}（最后写入晚于合并、缺失或矛盾时间均保留缺口）；明确用户处置另按持久 control 证据`,
      `控制事件来源：${(['user', 'host', 'pm', 'unknown'] as const).map((source) => `${source}=${controls.filter((event) => controlSource(event) === source).length}`).join('；')}；明确用户暂停恢复记录：${recoveries.filter((item) => item.pauseProvenance === 'user').length}`,
      `Incident（全部状态，原始 phase）：${
        [...incidentPhases]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([phase, count]) => `${phase}=${count}`)
          .join('；') || '无 (0)'
      }`,
      `watchdog 触发次数：${watchdogRuns.size}（按 Run ID）；缺少 Run ID、无法去重的触发证据=${unlinkedWatchdog}（不假定彼此独立）`,
      `返工轮数（Project 全部 Task）：${rework(tasks)}`,
      `合并任务返工：${rework(merged.map((item) => item.task))}`,
      `token 中位数：${tokens(median(tokenSamples))}；n=${tokenSamples.length}/${merged.length}；unknown=${tokenUnknown}；partial=${tokenPartial}`,
      `墙钟交付耗时中位数：${wallSamples.length ? duration(Number(median(wallSamples))) : 'N/A'}；n=${wallSamples.length}/${merged.length}；unknown=${merged.length - wallSamples.length}`,
      `PM 未分配：Run=${unassignedPM.length}；已知 token=${pmKnown.length ? tokens(pmKnown.reduce((sum, sample) => sum + sample.value!, 0)) : 'N/A'}；usage unknown=${pmSamples.filter((sample) => sample.state === 'unknown').length}；partial=${pmSamples.filter((sample) => sample.state === 'partial').length}；歧义影响 Task=${[...ambiguous].join(',') || '无'}`,
      ...details
        .sort((a, b) =>
          a.at === b.at ? 0 : a.at === undefined ? 1 : b.at === undefined ? -1 : a.at - b.at,
        )
        .map((detail) => detail.line),
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
  const orphanedControls = events.filter(
    (event) =>
      event.type === 'task' &&
      (/^任务 (pause|resume|cancel)$/.test(event.message) || event.control !== undefined) &&
      !data.projects.some((project) => project.id === event.projectId),
  ).length;
  if (orphanedControls)
    lines.push(`未归属 Project 的控制事件：${orphanedControls}（未摊入任何 Project）`);
  return lines.join('\n') + '\n';
}
