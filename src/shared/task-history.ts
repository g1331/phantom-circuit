import type { Incident, Task } from './types.ts';

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
    actionable: incident.status !== 'resolved' && !historical,
  };
}

/** Current attention state; the durable blocker and control remain available for audit. */
export function taskAttention(task: Task) {
  const historicalReason = historicalCompletionReason(task);
  return {
    historicalReason,
    blocked: historicalReason ? undefined : task.blocked,
    paused: !historicalReason && task.control === 'paused',
  };
}
