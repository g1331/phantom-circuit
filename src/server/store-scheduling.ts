import { comparePriority } from '../shared/priority.ts';
import {
  externalDeliveryHoldReason,
  externalDevelopmentHeld,
  taskAttention,
} from '../shared/task-history.ts';
import type {
  CostEstimate,
  MessageDescriptor,
  PriceSnapshot,
  Run,
  RunUsage,
  SchedulingExplanation,
  UsageAggregate,
} from '../shared/types.ts';
import { Fault, now, redact, type StoreContext } from './store-core.ts';
import { aggregateCosts, costForUsage, normalizeUsage, type UsageMode } from './usage.ts';

const pmRunTitles: Partial<Record<Run['status'], string>> = {
  completed: 'PM 运行完成',
  failed: 'PM 运行失败',
  interrupted: 'PM 运行中断',
  paused: 'PM 运行暂停',
};

export function updateRunUsage(
  ctx: StoreContext,
  key: string,
  usage: RunUsage,
  mode: UsageMode = 'cumulative',
) {
  const run = ctx.get('run', key);
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
  ctx.put('run', key, run);
  ctx.emitChange();
  return structuredClone(run);
}

export function recordRunDiagnostic(ctx: StoreContext, key: string, diagnostic: string) {
  const run = ctx.get('run', key);
  if (!run) throw new Fault('Run 不存在', 404);
  const value = redact(String(diagnostic)).slice(-3000);
  const diagnostics = [...new Set([...(run.diagnostics ?? []), value])].slice(-20);
  run.diagnostics = diagnostics;
  run.diagnostic = diagnostics.at(-1);
  ctx.put('run', key, run);
  ctx.emitChange();
  return structuredClone(run);
}

export function pinRunRevision(
  ctx: StoreContext,
  key: string,
  revision: { head?: string; base?: string },
) {
  const run = ctx.get('run', key);
  if (!run) throw new Fault('Run 不存在', 404);
  const next = { ...run, revision: structuredClone(revision) };
  ctx.put('run', key, next);
  ctx.emitChange();
  return structuredClone(next);
}

export function freezeRun(run: Run, endedAt: string, priceSnapshot?: PriceSnapshot) {
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

export function finishRun(
  ctx: StoreContext,
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
  const r = ctx.get('run', key);
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
  freezeRun(r, endedAt, options.priceSnapshot);
  ctx.put('run', key, r);
  if (r.taskId) {
    const task = ctx.get('task', r.taskId);
    if (task) {
      const usage = ctx.taskUsage(r.taskId);
      const cost = ctx.taskCost(r.taskId);
      ctx.put('task', task.id, {
        ...task,
        ...(Object.keys(usage).length ? { usage } : {}),
        ...(cost ? { cost } : { cost: undefined }),
        updatedAt: now(),
      });
    }
    // A later clean Run of the same phase is the evidence that an operational Incident is over.
    const phase = r.role === 'dev' ? 'dev' : r.role === 'review' ? `review:${r.reviewAxis}` : '';
    if (r.status === 'completed' && phase && !r.ownerMessageId && !r.purpose)
      for (const incident of ctx
        .list('incident')
        .filter((i) => i.taskId === r.taskId && i.phase === phase && i.status !== 'resolved')) {
        const detail = `同阶段 Run ${r.id} 已成功完成，宿主自动结束此 Incident。原因：${incident.message}`;
        ctx.updateIncident(incident.id, {
          status: 'resolved',
          message: detail,
          descriptor: { code: 'incident_resolved', detail: redact(detail).slice(-3000) },
        });
      }
  }
  if (r.role === 'pm') {
    for (const a of ctx
      .list('activity')
      .filter((a) => a.runId === key && ['running', 'waiting', 'queued'].includes(a.status)))
      ctx.activity(r, a.id.slice(key.length + 1), {
        ...a,
        status: r.status,
        details: { ...a.details, ...(error ? { error } : {}) },
      });
    ctx.activity(r, 'result', {
      kind: 'phase',
      title: pmRunTitles[status] ?? 'PM 运行结束',
      status: r.status,
      details: error ? { error } : {},
    });
  }
  ctx.event('run', error ?? `${r.role} ${r.status}`, {
    projectId: r.projectId,
    taskId: r.taskId,
    runId: r.id,
  });
  return structuredClone(r);
}

export function taskUsage(ctx: StoreContext, taskId: string): UsageAggregate {
  const runs = ctx.list('run').filter((run) => run.taskId === taskId);
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

export function runCost(ctx: StoreContext, key: string): CostEstimate | undefined {
  const run = ctx.get('run', key);
  if (!run) return undefined;
  if (run.agentKind === 'codex' && run.profileConfig?.providerId === 'codex') return undefined;
  const price = run.priceSnapshot ?? run.price;
  return price ? costForUsage(run.usage, price) : undefined;
}

export function taskCosts(ctx: StoreContext, taskId: string): CostEstimate[] {
  const runs = ctx.list('run').filter((run) => run.taskId === taskId);
  const costs = aggregateCosts(runs.map((run) => ctx.runCost(run.id)));
  if (!costs.length) return costs;
  if (runs.some((run) => ctx.runCost(run.id) === undefined))
    for (const cost of costs) cost.partial = true;
  return costs;
}

export function schedulingSnapshot(ctx: StoreContext) {
  const snapshot = {
    projects: ctx.list('project'),
    repos: ctx.list('repo'),
    tasks: ctx.list('task'),
    runs: ctx.list('run'),
    settings: ctx.settings(),
  };
  const cursor = (
    ctx.db.prepare("SELECT value FROM meta WHERE key='cursor'").get() as
      | { value: string }
      | undefined
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
        const attention = taskAttention(task);
        if (task.issueOrigin) {
          const source = ctx.get('message', task.sourceMessageId);
          const assessment = ctx.get('inputAssessment', task.issueOrigin.assessmentId);
          if (
            project.admissionPaused ||
            source?.status !== 'completed' ||
            assessment?.disposition.status !== 'accepted'
          )
            reasons.push({ code: 'blocked', detail: '外部请求判断未完成或团队暂停' });
        }
        if (attention.paused) reasons.push({ code: 'paused' });
        if (attention.blocked) reasons.push({ code: 'blocked', detail: attention.blocked });
        if (
          !attention.historicalReason &&
          (task.pendingFeedback?.length ||
            ctx
              .list('followUp')
              .some(
                (input) => input.taskId === task.id && ['queued', 'processing'].includes(input.status),
              ))
        )
          reasons.push({ code: 'feedback' });
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
        if (dev.length >= snapshot.settings.globalDevLimit) reasons.push({ code: 'globalCapacity' });
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

export function explainScheduling(ctx: StoreContext, projectId: string): SchedulingExplanation {
  ctx.project(projectId);
  ctx.db.exec('BEGIN');
  try {
    const result = schedulingSnapshot(ctx).find((p) => p.projectId === projectId)!;
    ctx.db.exec('COMMIT');
    return result;
  } catch (error) {
    ctx.db.exec('ROLLBACK');
    throw error;
  }
}

export function claimNext(ctx: StoreContext): Run | undefined {
  return ctx.transaction(() => {
    const candidate = schedulingSnapshot(ctx).find((p) => p.candidates.length)?.candidates[0];
    if (!candidate) return;
    const task = ctx.task(candidate);
    task.stage = 'developing';
    ctx.put('task', task.id, task);
    const recovery = ctx
      .list('recovery')
      .find(
        (item) =>
          item.taskId === task.id &&
          item.status === 'resumed' &&
          !item.successorRunId &&
          (item.role === 'dev' || ctx.get('run', item.oldRunId)?.role === 'dev'),
      );
    const run = ctx.run('dev', task.projectId, task.profile, task, {
      ...(recovery ? { recoveryItemId: recovery.id } : {}),
    });
    if (recovery && !recovery.successorRunId)
      ctx.put('recovery', recovery.id, {
        ...recovery,
        status: 'resumed',
        successorRunId: run.id,
        updatedAt: now(),
      });
    ctx.db
      .prepare("INSERT INTO meta VALUES ('cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(task.projectId);
    return run;
  });
}

/** Shared execution gate; observing a remote merge never rewrites engineering history. */
export function assertTaskExecutable(ctx: StoreContext, key: string) {
  const task = ctx.task(key);
  if (task.issueOrigin) {
    const authority = ctx.sourceAuthority(task.sourceMessageId, task.projectId, task.repoId);
    if (
      !authority.external ||
      authority.external.input.id !== task.issueOrigin.inputId ||
      authority.external.assessment.id !== task.issueOrigin.assessmentId ||
      task.issue !== authority.external.input.number ||
      task.issueNodeId !== authority.external.input.nativeId ||
      task.issueUrl !== authority.external.input.url
    )
      throw new Fault('外部任务来源绑定不一致', 409);
    if (authority.external.assessment.disposition.status !== 'accepted')
      throw new Fault('外部请求等待判断或范围决定', 409);
    if (ctx.project(task.projectId).admissionPaused) throw new Fault('团队已暂停接收工作', 409);
  }
  if (externalDevelopmentHeld(task)) {
    const completed = task.completion?.source === 'external';
    const reason = completed
      ? '远端交付已经结案，原工程记录保留供查阅'
      : externalDeliveryHoldReason(task);
    throw new Fault(reason, 409, {
      code: completed ? 'external_delivery_completed' : 'external_merge_pending',
      detail: reason,
    });
  }
}
