import { externalDevelopmentHeld } from '../shared/task-history.ts';
import type { ProfileName, RecoveryItem, RecoveryPolicy, Run, Task } from '../shared/types.ts';
import { Fault, id, now, type StoreContext } from './store-core.ts';

export function resumeRecovery(ctx: StoreContext, key: string) {
  const item = ctx.get('recovery', key);
  if (!item) throw new Fault('Recovery item 不存在', 404);
  if (item.taskId) ctx.assertTaskExecutable(item.taskId);
  if (item.status === 'resumed') return structuredClone(item);
  if (item.status === 'cancelled') throw new Fault('Recovery item 已取消', 409);
  // This is only a request marker. Worktree/remote reconciliation and successor creation happen
  // in Engine; marking resumed here would let the scheduler claim before that safe phase.
  ctx.event('recovery', '已请求恢复中断运行，等待宿主核对', {
    projectId: item.projectId,
    taskId: item.taskId,
    runId: item.oldRunId,
  });
  return structuredClone(item);
}

export function recoveryForProject(ctx: StoreContext, projectId: string, key?: string) {
  const items = ctx.list('recovery').filter((item) => item.projectId === projectId);
  if (!key) return items;
  const item = items.find((candidate) => candidate.id === key);
  if (!item) throw new Fault('Recovery item 不属于当前项目', 403);
  return item;
}

export function cancelRecovery(ctx: StoreContext, key: string) {
  const item = ctx.get('recovery', key);
  if (!item) throw new Fault('Recovery item 不存在', 404);
  if (item.status === 'cancelled') return structuredClone(item);
  if (item.status === 'resumed') throw new Fault('Recovery item 已恢复', 409);
  const next = { ...item, status: 'cancelled' as const, updatedAt: now() };
  ctx.put('recovery', key, next);
  ctx.event('recovery', '中断运行恢复已取消', {
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
export function ensureRecoverySuccessor(
  ctx: StoreContext,
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
  return ctx.transaction(() => {
    const item = ctx.get('recovery', recoveryId);
    if (!item) throw new Fault('Recovery item 不存在', 404);
    if (item.successorRunId) {
      const successor = ctx.get('run', item.successorRunId);
      if (successor) return structuredClone(successor);
      throw new Fault('Recovery successor Run 丢失，拒绝重复创建', 409);
    }
    const taskId = options.task?.id ?? options.taskId ?? item.taskId;
    const task = taskId ? ctx.task(taskId) : undefined;
    if (task && options.role !== 'pm') ctx.assertTaskExecutable(task.id);
    const run = ctx.run(options.role, item.projectId, options.profile, task, {
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
    if (options.incidentId)
      ctx.rebindIncidentAssessment(options.incidentId, item.oldRunId, run.id);
    const next: RecoveryItem = {
      ...item,
      status: 'resumed',
      successorRunId: run.id,
      ...(options.sourceMessageId
        ? { sourceMessageId: options.sourceMessageId, messageId: options.sourceMessageId }
        : {}),
      ...(options.reviewAxis ? { reviewAxis: options.reviewAxis } : {}),
      ...(options.incidentId ? { incidentId: options.incidentId } : {}),
      ...(options.recoveryPrompt ? { recoveryPrompt: options.recoveryPrompt } : {}),
      updatedAt: now(),
    };
    ctx.put('recovery', item.id, next);
    return structuredClone(run);
  });
}

export function finishRecovery(
  ctx: StoreContext,
  key: string,
  status: Extract<RecoveryItem['status'], 'cancelled' | 'resumed'>,
) {
  const item = ctx.get('recovery', key);
  if (!item) throw new Fault('Recovery item 不存在', 404);
  if (status === 'resumed' && item.taskId) ctx.assertTaskExecutable(item.taskId);
  if (item.successorRunId && status === 'cancelled')
    throw new Fault('Recovery item 已创建 successor Run', 409);
  const next = { ...item, status, updatedAt: now() };
  ctx.put('recovery', key, next);
  return structuredClone(next);
}

export function recover(ctx: StoreContext): RecoveryItem[] {
  for (const input of ctx.list('followUp'))
    if (input.status === 'processing')
      ctx.put('followUp', input.id, { ...input, status: 'queued', runId: undefined });
  for (const assignment of ctx.list('collaboration'))
    if (assignment.status === 'running')
      ctx.put('collaboration', assignment.id, {
        ...assignment,
        status: 'failed',
        error: '服务重启中断协作，保留工作区与结果供负责人恢复。',
        updatedAt: now(),
      });
  for (const suggestion of ctx.list('suggestion')) {
    if (suggestion.status === 'running')
      ctx.put('suggestion', suggestion.id, {
        ...suggestion,
        status: 'failed',
        reason: '服务重启中断复盘；保留记录，不重复模型调用。',
      });
  }
  const interruptedRuns = ctx
    .list('run')
    .filter((run) => ['running', 'waiting', 'interrupted'].includes(run.status));
  for (const operation of ctx.list('operation'))
    if (operation.kind === 'steer' && operation.status === 'pending')
      ctx.put('operation', operation.id, {
        ...operation,
        status: 'uncertain',
        error: operation.error ?? '服务重启时 Steer 结果未知，必须先核对后重试',
      });
  const steers = ctx.list('operation').filter((operation) => operation.kind === 'steer');
  for (const m of ctx.list('message'))
    if ((m.role === 'user' || m.origin) && m.status === 'running') {
      const operation = steers.find((op) => op.clientUserMessageId === m.id);
      if (operation && ['pending', 'uncertain'].includes(operation.status)) {
        ctx.updateMessage(m.id, {
          status: 'failed',
          draftStatus: 'failed',
          descriptor: { code: 'steer_uncertain', detail: '调整结果待核对' },
        });
        continue;
      }
      if (
        m.deliveryMode === 'steer' &&
        m.descriptor?.code === 'steer_waiting' &&
        m.runId &&
        !operation
      ) {
        ctx.updateMessage(m.id, {
          status: 'queued',
          draftStatus: 'queued',
          runId: undefined,
          sourceMessageId: undefined,
          descriptor: { code: 'steer_recovering', detail: '重启前调整尚未发送，等待继续处理' },
        });
        continue;
      }
      // Automatic recovery resumes this message's PM Run and settles the message itself.
      const resumes =
        (ctx.project(m.projectId).recoveryPolicy ?? 'automatic') === 'automatic' &&
        interruptedRuns.some((r) => r.role === 'pm' && r.sourceMessageId === m.id);
      if (resumes) continue;
      ctx.put('message', m.id, { ...m, status: 'failed', draftStatus: 'failed' });
      ctx.addMessage(
        m.projectId,
        'system',
        '上次 PM 响应被中断，已保留会话和已创建的任务；可重新发送该消息继续。',
        undefined,
        undefined,
        undefined,
        { sourceMessageId: m.id },
      );
    }
  const recovered: RecoveryItem[] = ctx.list('recovery').map((item) => structuredClone(item));
  for (const r of interruptedRuns) {
    if (r.purpose) {
      ctx.finishRun(
        r.id,
        'failed',
        r.purpose === 'retrospective'
          ? '复盘已中断，不重复模型调用'
          : '仓库约定学习已中断，可在项目页重新读取',
      );
      continue;
    }
    const existing = ctx.list('recovery').find((item) => item.oldRunId === r.id);
    if (existing) {
      if (!recovered.some((item) => item.id === existing.id))
        recovered.push(structuredClone(existing));
      continue;
    }
    if (r.ownerMessageId) {
      // A read-only answer holds no work: the question fails and the user may ask again.
      ctx.finishRun(r.id, 'interrupted', '服务重启，回答中断');
      const question = ctx.get('ownerMessage', r.ownerMessageId);
      if (question)
        ctx.put('ownerMessage', question.id, {
          ...question,
          status: 'failed',
          failureReason: 'answer_interrupted',
        });
      continue;
    }
    const task = r.taskId ? ctx.get('task', r.taskId) : undefined;
    if (r.incidentPhase === 'validation_recovery' && r.incidentId) {
      const incident = ctx.get('incident', r.incidentId);
      if (incident && ['waiting_user', 'resolved'].includes(incident.status)) {
        // A recorded disposition owns the next step even if its asking turn never returned.
        if (r.status !== 'interrupted')
          ctx.finishRun(r.id, 'interrupted', 'Incident 处置已记录，保留其等待或恢复决定');
        continue;
      }
    }
    const draft = ctx
      .list('message')
      .find(
        (message) =>
          message.role === 'assistant' &&
          message.runId === r.id &&
          message.draftStatus !== 'completed',
      );
    const project = ctx.project(r.projectId);
    const policy: RecoveryPolicy = project.recoveryPolicy ?? 'automatic';
    if (r.role === 'pm')
      ctx.activity(r, `recovery:${r.id}`, {
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
    ctx.finishRun(r.id, 'interrupted', reason);
    if (draft)
      ctx.updateMessage(draft.id, {
        status: 'queued',
        draftStatus: 'draft',
      });
    const preserveTask =
      !!task && (task.pausedByUser === true || ['done', 'cancelled'].includes(task.stage));
    if (task && !preserveTask && !externalDevelopmentHeld(task))
      ctx.updateTaskControl(
        task.id,
        {
          control: 'paused',
          pausedByUser: false,
          blocked: `运行中断：${reason}`,
          blockedDescriptor: { code: 'run_interrupted', params: { runId: r.id }, detail: reason },
        },
        'pause',
        { source: 'host', reason: 'startup_interrupted', runId: r.id },
      );
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
    ctx.put('recovery', item.id, item);
    ctx.event('recovery', policy === 'automatic' ? '已排队自动恢复' : '等待手动恢复', {
      projectId: item.projectId,
      taskId: item.taskId,
      runId: item.oldRunId,
    });
    recovered.push(structuredClone(item));
  }
  for (const r of ctx.list('repo'))
    if (r.preview?.status === 'running' || r.preview?.status === 'starting')
      ctx.patchRepo(r.id, {
        preview: { status: 'stopped', error: '服务重启，体验环境需重新启动' },
      });
  return recovered;
}
