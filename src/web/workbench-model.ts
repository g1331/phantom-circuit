import type { WorkflowPage } from '../shared/intake.ts';
import type { Snapshot, Task } from '../shared/types.ts';
import type { createLocale, StaticTranslationKey } from './locale/core.ts';
import {
  historicalCompletionReason,
  latestPerCommand,
  taskDeliveryPR,
} from '../shared/task-history.ts';
import { routeHref } from './route.ts';

export type FlowEntry = WorkflowPage['inputs'][number];
export type FlowTone = 'neutral' | 'progress' | 'delivery' | 'success' | 'warning';
export interface FlowNode {
  key: 'source' | 'judgment' | 'dev' | 'tests' | 'review' | 'outcome' | 'reply';
  label: StaticTranslationKey;
  detail: string;
  tone: FlowTone;
  href?: string;
}

export function inputTone(entry: FlowEntry): FlowTone {
  switch (entry.assessment.disposition.status) {
    case 'assessing':
      return 'progress';
    case 'accepted':
      return 'success';
    case 'awaiting_decision':
    case 'unavailable':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function workNodes(
  task: Task,
  state: Snapshot,
  copy: ReturnType<typeof createLocale>,
  entry?: FlowEntry,
): FlowNode[] {
  const { t } = copy;
  const external = task.completion?.source === 'external';
  const runs = state.runs.filter((run) => run.taskId === task.id);
  const latestDev = runs.findLast((run) => run.role === 'dev');
  const inputId = entry?.input.id ?? task.issueOrigin?.inputId;
  const issue = entry?.input.number ?? task.issue;
  const nodes: FlowNode[] = [
    {
      key: 'source',
      label: 'flow.source',
      detail: inputId ? `GitHub #${issue}` : t('flow.sourceWeb'),
      tone: 'neutral',
      href: inputId ? routeHref({ page: 'input', projectId: task.projectId, inputId }) : undefined,
    },
  ];
  if (entry)
    nodes.push({
      key: 'judgment',
      label: 'flow.admission',
      detail: t(`flow.${entry.assessment.disposition.status}`),
      tone: inputTone(entry),
    });
  if (latestDev && !external)
    nodes.push({
      key: 'dev',
      label: 'flow.execution',
      detail: t(`ui.${latestDev.status}`),
      tone: latestDev.status === 'running' ? 'progress' : 'neutral',
    });
  const tests = task.head ? latestPerCommand(task.tests, task.head) : [];
  if (!external && tests.length) {
    const failed = tests.filter((test) => test.exitCode !== 0).length;
    nodes.push({
      key: 'tests',
      label: 'flow.validation',
      detail: failed
        ? t('flow.failed', { count: failed })
        : t('flow.passed', { count: tests.length }),
      tone: failed ? 'warning' : 'success',
    });
  }
  const reviews = task.reviews.filter(
    (review) => review.head === task.head && review.base === task.base && !review.supersededByRunId,
  );
  if (!external && reviews.length)
    nodes.push({
      key: 'review',
      label: 'flow.review',
      detail: t('flow.approved', { count: reviews.filter((review) => review.approved).length }),
      tone: reviews.every((review) => review.approved) ? 'success' : 'warning',
    });
  if (task.stage === 'done') {
    const historical = !!historicalCompletionReason(task);
    nodes.push({
      key: 'outcome',
      label: external ? 'flow.external' : historical ? 'flow.historical' : 'flow.complete',
      detail: taskDeliveryPR(task) ? `PR #${taskDeliveryPR(task)}` : t('flow.historyMissing'),
      tone: historical ? 'warning' : 'delivery',
      href: routeHref({ page: 'task', projectId: task.projectId, taskId: task.id }),
    });
  }
  const reply = entry?.replies.findLast((value) => value.purpose.kind === 'outcome');
  if (reply)
    nodes.push({
      key: 'reply',
      label: 'flow.reply',
      detail: t(`flow.reply.${reply.state.status}`),
      tone:
        reply.state.status === 'sent'
          ? 'success'
          : reply.state.status === 'queued'
            ? 'neutral'
            : 'warning',
      href: reply.state.status === 'sent' ? reply.state.url : undefined,
    });
  return nodes;
}
