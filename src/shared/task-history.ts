import type { Task } from './types.ts';

// Compatibility is deliberately limited to the one historical completion diagnostic.
// This is an explanation of a settled record, never evidence that authorizes a merge.
export const legacyCompletionGap =
  '历史 Task 完成同步缺少固定 revision 的测试、双轴 Review 或 PM 验收证据，需要 PM 核对';

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
  if (task.blocked === legacyCompletionGap || task.blocked === `Error: ${legacyCompletionGap}`)
    return task.blocked;
  return undefined;
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
