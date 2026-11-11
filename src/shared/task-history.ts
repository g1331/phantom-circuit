import type { Evidence, Incident, Task } from './types.ts';

export function latestPerCommand(tests: Evidence[], head?: string) {
  const at = head ? tests.filter((evidence) => evidence.head === head) : tests;
  const byCommand = new Map<string, Evidence>();
  for (const evidence of at) {
    const seen = byCommand.get(evidence.command);
    if (!seen || seen.at <= evidence.at) byCommand.set(evidence.command, evidence);
  }
  return [...byCommand.values()];
}

export const externalMergeReason = '远端已合并 · 待团队核对';

export const isExternalDelivery = (task: Task) => task.completion?.source === 'external';
export const externalDeliveryHold = (task: Task) =>
  pendingExternalMerge(task) ||
  (!['done', 'cancelled'].includes(task.stage) &&
    !!task.issue &&
    !task.pr &&
    task.issueState === 'completed');
export const externalDeliveryHoldReason = (task: Task) =>
  pendingExternalMerge(task) ? externalMergeReason : 'Issue 已完成关闭 · 待团队核对远端交付';
export const externalDevelopmentHeld = (task: Task) =>
  externalDeliveryHold(task) || isExternalDelivery(task);

/** The delivered revision is independent of the original developer's local checkpoint. */
export function taskDeliveryHead(task: Task): string | undefined {
  return task.completion?.source === 'external' ? task.completion.primary.head : task.head;
}
export function taskDeliveryPR(task: Task): number | undefined {
  return task.completion?.source === 'external' ? task.completion.primary.pr : task.pr;
}
export function taskDeliveryRevision(task: Task) {
  if (task.completion?.source === 'external')
    return { head: task.completion.primary.head, commit: task.completion.primary.mergeCommit };
  return task.deliveryRevision?.head === task.head ? task.deliveryRevision : undefined;
}
export function taskDeliveryCommits(task: Task): string[] {
  if (task.completion?.source === 'external')
    return [...new Set([task.completion.primary.mergeCommit, task.completion.closing.mergeCommit])];
  const revision = taskDeliveryRevision(task)?.commit ?? task.head;
  return revision ? [revision] : [];
}
export function taskCompletionAt(task: Task): string | undefined {
  const completion = task.completion;
  if (completion?.source === 'host') return completion.completedAt;
  if (completion?.source === 'external')
    return [completion.primary.mergedAt, completion.closing.mergedAt]
      .sort((a, b) => Date.parse(a) - Date.parse(b))
      .at(-1);
  return undefined;
}

export function externalDeliveryNotice(task: Task) {
  if (task.completion?.source !== 'external')
    throw new Error('External completion evidence required');
  const { primary, closing, issue } = task.completion;
  const content =
    `「${task.title}」已按远端交付结案（PR #${primary.pr}；` +
    `Issue #${issue} 由 PR #${closing.pr} 关闭）。本机验证与评审保留原记录。`;
  return {
    content,
    descriptor: {
      code: 'delivery_external_completed',
      params: { title: task.title, pr: primary.pr, closingPR: closing.pr, issue },
      detail: content,
    },
  };
}

/** Old merged caches also hold work, even before a full remote observation is available. */
export function pendingExternalMerge(task: Task): boolean {
  return (
    !['done', 'cancelled'].includes(task.stage) &&
    ((!!task.pr && task.prState === 'merged') ||
      (task.remoteMerge?.repoId === task.repoId &&
        (task.remoteMerge.pr === task.pr || (!task.pr && !!task.issue))))
  );
}

// Compatibility is deliberately limited to the one historical completion diagnostic.
// This is an explanation of a settled record, never evidence that authorizes a merge.
export const legacyCompletionGap =
  '历史 Task 完成同步缺少固定 revision 的测试、双轴 Review 或 PM 验收证据，需要 PM 核对';

function isLegacyCompletionGap(reason: string | undefined) {
  return reason === legacyCompletionGap || reason === `Error: ${legacyCompletionGap}`;
}

export function historicalCompletionReason(task: Task): string | undefined {
  if (
    task.stage !== 'done' ||
    task.completionDeliveryPending !== false ||
    task.pausedByUser === true
  )
    return undefined;
  // Specific diagnostics win over legacy prose. Only the old generic host pause/block
  // descriptors can accompany this compatibility text; unknown codes stay actionable.
  const code = task.blockedDescriptor?.code;
  if (code && code !== 'task_blocked' && code !== 'incident_paused') return undefined;
  if (isLegacyCompletionGap(task.blocked)) return task.blocked;
  return undefined;
}

/** Presentation only: retain the Incident and its original status for historical inspection. */
export function incidentAttention(incident: Incident, task: Task | undefined) {
  // Limit compatibility to completion synchronization/finalization. incident_finalize is
  // the host's generic completion failure code; incident_paused is the PM pause result.
  const completionPhase = incident.phase === 'sync' || incident.phase === 'finalize';
  const code = incident.descriptor?.code;
  const legacyDiagnostic =
    !code ||
    code === 'incident_paused' ||
    (incident.phase === 'finalize' && code === 'incident_finalize');
  const historical =
    !!task &&
    incident.taskId === task.id &&
    incident.projectId === task.projectId &&
    !!historicalCompletionReason(task) &&
    completionPhase &&
    legacyDiagnostic &&
    isLegacyCompletionGap(incident.message);
  return {
    historicalReason: historical ? incident.message : undefined,
    actionable:
      incident.status !== 'resolved' && !historical && !incident.supersededByExternalCompletionAt,
  };
}

/** Current attention state; the durable blocker and control remain available for audit. */
export function taskAttention(task: Task) {
  const historicalReason = historicalCompletionReason(task);
  const externalMergePending = pendingExternalMerge(task);
  const externalDeliveryPending = externalDeliveryHold(task);
  const externalDelivered = isExternalDelivery(task);
  return {
    historicalReason,
    externalMergePending,
    externalDeliveryPending,
    blocked: externalDelivered
      ? undefined
      : externalDeliveryPending
        ? externalDeliveryHoldReason(task)
        : historicalReason
          ? undefined
          : task.blocked,
    paused:
      !externalDelivered &&
      !externalDeliveryPending &&
      !historicalReason &&
      task.control === 'paused',
  };
}
