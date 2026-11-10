import type { Role, Run, Snapshot, Task } from './types.ts';
import { incidentAttention } from './task-history.ts';

/**
 * The team view (ADR 0013): what the team and each member are doing, in codes the interface
 * translates. Derived from the host snapshot, so every client reads the same projection.
 */
export type MemberActivity =
  | 'talking'
  | 'planning'
  | 'assessing'
  | 'coordinating'
  | 'building'
  | 'checking'
  | 'merging'
  | 'reviewing'
  | 'second_review'
  | 'diagnosing';
export type WorkStep = 'planned' | 'building' | 'reviewing' | 'delivering' | 'done' | 'cancelled';
export type WorkAttention = 'none' | 'paused' | 'blocked' | 'needs_user';

export interface TeamMember {
  /** The Run id. */
  id: string;
  role: Role;
  activity: MemberActivity;
  runId?: string;
  taskId?: string;
  taskTitle?: string;
  since?: string;
  model?: string;
}
export interface TeamWork {
  taskId: string;
  title: string;
  step: WorkStep;
  attention: WorkAttention;
  teamHold?: 'running' | 'queued' | 'blocked';
  teamNext?: 'registration' | 'validation' | 'diagnosis';
  /** Host-written reason when the work is held; shown as-is. */
  reason?: string;
  owners: Role[];
  rounds: number;
  updatedAt: string;
  /** Finished work only: when its last turn ended, which is when it was delivered or dropped. */
  settledAt?: string;
}
export interface TeamRequest {
  id: string;
  kind: 'clarification' | 'decision';
  taskId?: string;
  taskTitle?: string;
  text: string;
  at: string;
}
/** One finished turn: who did it, how it ended and how long it took. Live turns are members. */
export interface TeamFeedItem {
  id: string;
  /** When the turn ended. */
  at: string;
  role: Role;
  kind: 'finished' | 'failed' | 'paused';
  durationMs: number;
  runId: string;
  taskId?: string;
  taskTitle?: string;
}
export interface TeamView {
  members: TeamMember[];
  work: TeamWork[];
  waiting: TeamRequest[];
  feed: TeamFeedItem[];
}

/** A Task has an owner to talk with once a Dev opened its worktree, until the work finishes. */
export const hasOwner = (task: Task) =>
  !!task.worktree && task.stage !== 'done' && task.stage !== 'cancelled';

// A `waiting` Run is held on the user (a Clarification), which the room shows as a request.
const live = (run: Run) => run.status === 'running';

function activity(run: Run, task?: Task): MemberActivity {
  // A task-bound liaison turn (a Dev question, feedback, acceptance) is the team talking internally.
  if (run.role === 'pm')
    return run.incidentId
      ? 'assessing'
      : task
        ? 'coordinating'
        : run.sourceMessageId
          ? 'talking'
          : 'planning';
  if (run.ownerMessageId) return 'talking';
  if (run.role === 'oncall' || run.incidentPhase === 'validation') return 'diagnosing';
  if (run.role === 'review') return run.secondaryReview ? 'second_review' : 'reviewing';
  if (task?.pendingMerge) return 'merging';
  return task?.devPhase === 'finalize' ? 'checking' : 'building';
}

const steps: Record<Task['stage'], WorkStep> = {
  clarifying: 'planned',
  ready: 'planned',
  developing: 'building',
  reviewing: 'reviewing',
  merging: 'delivering',
  done: 'done',
  cancelled: 'cancelled',
};

export function teamView(state: Snapshot, projectId: string, feedLimit = 30): TeamView {
  const tasks = new Map(state.tasks.filter((t) => t.projectId === projectId).map((t) => [t.id, t]));
  const runs = state.runs.filter((r) => r.projectId === projectId);
  const active = runs.filter(live);
  const members: TeamMember[] = active.map((run) => {
    const task = run.taskId ? tasks.get(run.taskId) : undefined;
    return {
      id: run.id,
      role: run.role,
      activity: activity(run, task),
      runId: run.id,
      ...(task ? { taskId: task.id, taskTitle: task.title } : {}),
      since: run.startedAt,
      ...(run.modelIdentity?.model ? { model: run.modelIdentity.model } : {}),
    };
  });
  // Only working members are listed: an idle seat costs attention and tells the user nothing.
  const order: Role[] = ['pm', 'dev', 'review', 'oncall'];
  members.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));

  const clarifications = (state.clarifications ?? []).filter(
    (c) => c.projectId === projectId && c.status === 'open' && c.questions.length > 0,
  );
  const decisions = (state.incidents ?? []).filter(
    (i) =>
      i.projectId === projectId &&
      i.status === 'waiting_user' &&
      i.descriptor?.code === 'incident_waiting_user' &&
      !!i.message.trim() &&
      incidentAttention(i, i.taskId ? tasks.get(i.taskId) : undefined).actionable,
  );
  const waiting: TeamRequest[] = [];
  for (const c of clarifications)
    waiting.push({
      id: c.id,
      kind: 'clarification',
      ...(c.taskId ? { taskId: c.taskId, taskTitle: tasks.get(c.taskId)?.title } : {}),
      text: c.questions.map((q) => q.question).join('\n'),
      at: c.createdAt,
    });
  const asked = new Set(waiting.map((w) => w.taskId).filter(Boolean));
  for (const i of decisions)
    if (!i.taskId || !asked.has(i.taskId)) {
      waiting.push({
        id: i.id,
        kind: 'decision',
        ...(i.taskId ? { taskId: i.taskId, taskTitle: tasks.get(i.taskId)?.title } : {}),
        text: i.message,
        at: i.updatedAt,
      });
      if (i.taskId) asked.add(i.taskId);
    }

  // Later bookkeeping (Issue sync, cleanup) touches `updatedAt`; the last turn's end does not move.
  const settled = (taskId: string) =>
    runs
      .filter((r) => r.taskId === taskId && r.endedAt)
      .map((r) => r.endedAt!)
      .sort()
      .at(-1);
  const work: TeamWork[] = [];
  for (const task of tasks.values()) {
    const owners = [...new Set(active.filter((r) => r.taskId === task.id).map((r) => r.role))];
    const held = task.control === 'paused' && !['done', 'cancelled'].includes(task.stage);
    const attention: WorkAttention =
      held && task.pausedByUser
        ? 'paused'
        : asked.has(task.id)
          ? 'needs_user'
          : held
            ? 'blocked'
            : 'none';
    const executing = active.some((r) => r.taskId === task.id && !r.ownerMessageId && !r.purpose);
    const pending = state.recoveryItems?.some(
      (r) =>
        r.projectId === projectId &&
        r.taskId === task.id &&
        r.status === 'pending' &&
        r.policy === 'automatic' &&
        r.pauseProvenance !== 'user' &&
        r.pauseProvenance !== 'terminal' &&
        !r.pausedByUser,
    );
    const incident = state.incidents?.findLast(
      (i) => i.projectId === projectId && i.taskId === task.id && i.status !== 'resolved',
    );
    const teamNext: TeamWork['teamNext'] =
      incident?.phase === 'sync'
        ? 'registration'
        : incident?.phase === 'validation'
          ? 'validation'
          : 'diagnosis';
    work.push({
      taskId: task.id,
      title: task.title,
      step: steps[task.stage],
      attention,
      ...(attention === 'blocked'
        ? {
            teamNext,
            teamHold: executing
              ? ('running' as const)
              : pending
                ? ('queued' as const)
                : ('blocked' as const),
          }
        : {}),
      ...(held && task.blocked ? { reason: task.blocked } : {}),
      owners,
      rounds: task.retries,
      updatedAt: task.updatedAt,
      ...(task.stage === 'done' || task.stage === 'cancelled'
        ? { settledAt: settled(task.id) ?? task.updatedAt }
        : {}),
    });
  }
  // Live and held work first, then most recently touched.
  const rank = (w: TeamWork) => (w.step === 'done' || w.step === 'cancelled' ? 1 : 0);
  const at = (w: TeamWork) => w.settledAt ?? w.updatedAt;
  work.sort((a, b) => rank(a) - rank(b) || at(b).localeCompare(at(a)));
  waiting.sort((a, b) => a.at.localeCompare(b.at));

  const feed: TeamFeedItem[] = [];
  for (const run of runs) {
    if (!run.endedAt || run.status === 'running' || run.status === 'waiting') continue;
    const task = run.taskId ? tasks.get(run.taskId) : undefined;
    feed.push({
      id: run.id,
      at: run.endedAt,
      role: run.role,
      kind: run.status === 'completed' ? 'finished' : run.status === 'failed' ? 'failed' : 'paused',
      durationMs: Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt)),
      runId: run.id,
      ...(task ? { taskId: task.id, taskTitle: task.title } : {}),
    });
  }
  feed.sort((a, b) => b.at.localeCompare(a.at));
  return { members, work, waiting, feed: feed.slice(0, feedLimit) };
}

/** Where a piece of work sits from the user's side: what they act on, watch, or can forget. */
export type WorkGroup = 'needs_you' | 'moving' | 'paused' | 'queued' | 'delivered' | 'cancelled';
export const workGroups: WorkGroup[] = [
  'needs_you',
  'moving',
  'paused',
  'queued',
  'delivered',
  'cancelled',
];
export function workGroup(work: TeamWork): WorkGroup {
  if (work.step === 'cancelled') return 'cancelled';
  if (work.step === 'done') return 'delivered';
  if (work.attention === 'needs_user') return 'needs_you';
  if (work.attention === 'paused') return 'paused';
  if (work.attention === 'blocked') return 'moving';
  return work.step === 'planned' && !work.owners.length ? 'queued' : 'moving';
}
/** Reworks the host allows before it stops the work and asks (engine `rework`). */
export const maxReworks = 3;
