import { z } from 'zod';
import type { Snapshot } from './report.ts';
type ReportTask = z.infer<typeof schemas.task>;
type ReportRun = z.infer<typeof schemas.run>;
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
export const schemas = {
  project: z.object({ id, name: z.string() }),
  repo: scoped.extend({ github: id }),
  task: scoped.extend({
    repoId: id,
    title: z.string().optional(),
    issue: z.number().int().positive().optional(),
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
    role: z.enum(['pm', 'dev', 'review', 'oncall']),
    status: id,
    sourceMessageId: id.optional(),
    incidentId: id.optional(),
    recoveryItemId: id.optional(),
    usage: usage.optional(),
    error: z.string().optional(),
    errorDescriptor: descriptor.optional(),
    startedAt: z.string().optional(),
    // Absent on Runs created before team instructions were versioned (ADR 0016).
    teamInstructionsVersion: counter.int().optional(),
    purpose: z.string().optional(),
  }),
  operation: z.object({ id, kind: id, status: id, result: z.unknown().optional() }),
  incident: scoped.extend({
    taskId: id.optional(),
    runId: id.optional(),
    phase: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    message: z.string().optional(),
    descriptor: descriptor.optional(),
    status: z.string().optional(),
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
  message: scoped.extend({
    sourceMessageId: id.optional(),
    runId: id.optional(),
    role: z.string().optional(),
    intent: z.string().optional(),
    content: z.string().optional(),
    createdAt: z.string().optional(),
  }),
};
export const eventSchema = z.object({
  at: z.string().optional(),
  type: id,
  projectId: id.optional(),
  taskId: id.optional(),
  runId: id.optional(),
  message: z.string(),
  descriptor: descriptor.optional(),
  // Invalid/newer provenance is an evidence gap, not a reason to reject readable history.
  control: z.unknown().optional(),
});
const controlSchema = z.object({
  action: z.enum(['pause', 'resume', 'cancel']),
  source: z.enum(['user', 'host', 'pm']),
  reason: z.string().trim().min(1),
  incidentId: id.optional(),
  recoveryItemId: id.optional(),
});

export function controlSource(
  event: z.infer<typeof eventSchema>,
): 'user' | 'host' | 'pm' | 'unknown' {
  const parsed = controlSchema.safeParse(event.control);
  return parsed.success && event.type === 'task' && event.message === `任务 ${parsed.data.action}`
    ? parsed.data.source
    : 'unknown';
}

export function json(body: string, label: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`损坏 JSON：${label}`);
  }
}

export function records<T extends { id: string }>(
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

export function time(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : undefined;
}

const pullEvidence = z.object({
  number: z.number().int().positive(),
  merged: z.literal(true),
  merged_at: z.string().nullable().optional(),
  head: z.object({ sha: id, repo: z.object({ full_name: id }).nullable().optional() }),
  base: z.object({ sha: id, repo: z.object({ full_name: id }).nullable().optional() }),
});

export function mergeEvidence(
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

function waitingWindow(
  incident: z.infer<typeof schemas.incident>,
  task: ReportTask | undefined,
  end: number | undefined,
): 'confirmed' | 'outside' | 'unknown' {
  const start = time(task?.createdAt);
  const created = time(incident.createdAt);
  const updated = time(incident.updatedAt);
  if (
    start === undefined ||
    end === undefined ||
    created === undefined ||
    updated === undefined ||
    end < start ||
    updated < created
  )
    return 'unknown';
  if (created > end || updated < start) return 'outside';
  // Store writes updatedAt with every Incident status change. It bounds when
  // the final state was established, without claiming an exact transition time.
  return created >= start && updated <= end ? 'confirmed' : 'unknown';
}

export type ReportData = {
  [K in keyof typeof schemas as K extends 'recovery' ? 'recoveries' : `${K}s`]: z.infer<
    (typeof schemas)[K]
  >[];
};
export type ReportEvent = z.infer<typeof eventSchema> & { id: number };
/** Stable source prefixes shared by retrospective provenance and recurrence reports. */
export const interruptionKinds: Record<string, string> = {
  消息: 'message',
  事故: 'incident',
  暂停: 'event',
  恢复: 'event',
  取消: 'event',
  澄清: 'clarification',
  用户暂停记录: 'recovery',
};

export function projectAttribution(
  data: ReportData,
  events: ReportEvent[],
  project: ReportData['projects'][number],
) {
  const runProjects = new Map(data.runs.map((run) => [run.id, run.projectId]));
  const messageProjects = new Map(data.messages.map((message) => [message.id, message.projectId]));
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
      if (messageProjects.has(source) && messageProjects.get(source) !== project.id)
        return undefined;
      const parent = messages.get(source)?.sourceMessageId;
      // A steered user message is its own original source (Store.beginSteer).
      if (!parent || parent === source) return source;
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
  const waitingWindows = new Map(
    incidents
      .filter((incident) => incident.status === 'waiting_user')
      .map((incident) => {
        const task = byId.get(linkedTask(incident) ?? '');
        return [
          incident.id,
          waitingWindow(incident, task, merged.find((item) => item.task.id === task?.id)?.at),
        ];
      }),
  );
  const messageEvidence = new Map<string, Set<string>>();
  let unassignedMessages = 0;
  let messageTimeGaps = 0;
  const uncertainTasks = new Set<string>();
  for (const message of messages.values()) {
    if (message.role !== 'user' || !['discuss', 'feedback'].includes(message.intent ?? ''))
      continue;
    const owners = new Set<string>();
    const source = rootSource(message.id);
    if (source) {
      const chain: string[] = [];
      let cursor: string | undefined = message.id;
      while (cursor && !chain.includes(cursor)) {
        chain.push(cursor);
        const parent: string | undefined = messages.get(cursor)?.sourceMessageId;
        if (!parent || parent === cursor) break;
        cursor = parent;
      }
      // Prefer the nearest durable Task binding; a shared ancestor cannot
      // assign all sibling Tasks. Run success is irrelevant to attribution.
      for (const sourceId of chain) {
        const bound = new Set(
          tasks.filter((task) => task.sourceMessageId === sourceId).map((task) => task.id),
        );
        for (const run of runs) {
          if (run.sourceMessageId !== sourceId) continue;
          const owner = linkedTask({ taskId: run.taskId, runId: run.id });
          if (owner) bound.add(owner);
        }
        if (bound.size) {
          if (bound.size === 1) owners.add([...bound][0]);
          break;
        }
      }
    }
    if (message.runId) {
      const owner = linkedTask({ runId: message.runId });
      if (owner) owners.add(owner);
    }
    const content = message.content ?? '';
    for (const task of tasks) {
      const literal = task.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?<![A-Za-z0-9_-])${literal}(?![A-Za-z0-9_-])`, 'u').test(content))
        owners.add(task.id);
    }
    const urls = [
      ...content.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\b/gi),
    ];
    for (const [, github, issue] of urls) {
      for (const task of tasks) {
        const repo = data.repos.find(
          (repo) => repo.id === task.repoId && repo.projectId === project.id,
        );
        if (repo?.github.toLowerCase() === github.toLowerCase() && task.issue === Number(issue))
          owners.add(task.id);
      }
    }
    // Resolve bare numbers against all Project Tasks, before applying any time window.
    for (const [, issue] of content.matchAll(/(?<![\w/])#(\d+)\b/g)) {
      const candidates = tasks.filter((task) => task.issue === Number(issue));
      if (candidates.length === 1) owners.add(candidates[0].id);
    }
    if (!owners.size) {
      unassignedMessages++;
      continue;
    }
    const date = time(message.createdAt);
    let gap = date === undefined;
    for (const owner of owners) {
      const task = byId.get(owner)!;
      if (task.sourceMessageId === message.id) continue;
      const start = time(task.createdAt);
      const end = merged.find((item) => item.task.id === owner)?.at;
      if (date === undefined || start === undefined || end === undefined) {
        gap = true;
        uncertainTasks.add(owner);
        continue;
      }
      if (date < start || date > end) continue;
      const ids = messageEvidence.get(owner) ?? new Set<string>();
      ids.add(message.id);
      messageEvidence.set(owner, ids);
    }
    if (gap) messageTimeGaps++;
  }
  const controls = projectEvents.filter(
    (event) =>
      event.type === 'task' &&
      (/^任务 (pause|resume|cancel)$/.test(event.message) || event.control !== undefined),
  );
  const controlTask = (event: (typeof controls)[number]) => {
    const taskId = linkedTask(event);
    const parsed = controlSchema.safeParse(event.control);
    if (!taskId || !parsed.success) return taskId;
    const { incidentId, recoveryItemId } = parsed.data;
    if (incidentId) {
      const incident = incidents.find((item) => item.id === incidentId);
      if (!incident || linkedTask(incident) !== taskId) return undefined;
    }
    if (recoveryItemId) {
      const recovery = recoveries.find((item) => item.id === recoveryItemId);
      if (
        !recovery ||
        linkedTask({ taskId: recovery.taskId, runId: recovery.runId ?? recovery.oldRunId }) !==
          taskId
      )
        return undefined;
    }
    return taskId;
  };
  for (const event of controls) {
    const taskId = controlTask(event);
    const task = taskId ? byId.get(taskId) : undefined;
    if (!task) continue;
    const start = time(task.createdAt);
    const end = merged.find((item) => item.task.id === task.id)?.at;
    const at = time(event.at);
    if (
      at !== undefined &&
      ((start !== undefined && at < start) || (end !== undefined && at > end))
    )
      continue;
    if (
      at === undefined ||
      start === undefined ||
      end === undefined ||
      controlSource(event) === 'unknown'
    )
      uncertainTasks.add(task.id);
  }
  for (const incident of incidents) {
    const taskId = linkedTask(incident);
    if (taskId && waitingWindows.get(incident.id) === 'unknown') uncertainTasks.add(taskId);
  }

  return {
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
    uncertainTasks,
    controls,
    controlTask,
  };
}

export function taskInterruptions(
  context: ReturnType<typeof projectAttribution>,
  task: ReportTask,
  at: number | undefined,
) {
  const {
    messageEvidence,
    controls,
    controlTask,
    incidents,
    linkedTask,
    waitingWindows,
    clarifications,
    rootSource,
    recoveries,
  } = context;
  const start = time(task.createdAt);
  const beforeMerge = (date: string | undefined) => {
    const value = time(date);
    // A clarification can predate Task publication. Without merged_at only
    // records already present at creation are provably before its merge.
    return value !== undefined && value <= (at ?? start ?? -Infinity);
  };
  const evidence = new Map<string, Set<string>>();
  const add = (category: string, id: string) => {
    const ids = evidence.get(category) ?? new Set<string>();
    ids.add(id);
    evidence.set(category, ids);
  };
  for (const id of messageEvidence.get(task.id) ?? []) add('消息', id);
  const inWindow = (date: string | undefined) => {
    const value = time(date);
    return (
      value !== undefined &&
      start !== undefined &&
      at !== undefined &&
      value >= start &&
      value <= at
    );
  };
  const taskControls = controls.filter(
    (event) => controlTask(event) === task.id && inWindow(event.at),
  );
  for (const incident of incidents) {
    if (linkedTask(incident) !== task.id) continue;
    const related = taskControls.filter((event) => {
      const parsed = controlSchema.safeParse(event.control);
      return parsed.success && parsed.data.incidentId === incident.id;
    });
    const userHandled = related.some((event) => {
      const parsed = controlSchema.parse(event.control);
      return controlSource(event) === 'user' && parsed.reason === 'http_incident';
    });
    if (userHandled || waitingWindows.get(incident.id) === 'confirmed') {
      add('事故', incident.id);
    }
  }
  const actionLabels = { pause: '暂停', resume: '恢复', cancel: '取消' };
  for (const event of taskControls) {
    if (controlSource(event) !== 'user') continue;
    const control = controlSchema.parse(event.control);
    if (
      control.incidentId &&
      control.reason === 'http_incident' &&
      evidence.get('事故')?.has(control.incidentId)
    )
      continue;
    add(actionLabels[control.action], String(event.id));
  }
  for (const item of clarifications) {
    if (
      (item.taskId === task.id ||
        (!item.taskId &&
          !!rootSource(item.sourceMessageId) &&
          rootSource(item.sourceMessageId) === rootSource(task.sourceMessageId))) &&
      beforeMerge(item.createdAt)
    )
      add('澄清', item.id);
  }
  for (const item of recoveries) {
    if (
      linkedTask(item) !== task.id ||
      item.pauseProvenance !== 'user' ||
      !inWindow(item.createdAt)
    )
      continue;
    // A recovery snapshot has no original action ID. It supplements an
    // observed pause; it cannot establish an additional pause action.
    if (!evidence.get('暂停')?.size) add('用户暂停记录', item.id);
  }

  return evidence;
}
