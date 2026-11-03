import type { Role, Run, Snapshot, Task } from './types.ts';

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
  /** Host-written reason when the work is held; shown as-is. */
  reason?: string;
  owners: Role[];
  rounds: number;
  updatedAt: string;
}
export interface TeamRequest {
  id: string;
  kind: 'clarification' | 'decision' | 'blocked';
  taskId?: string;
  taskTitle?: string;
  text: string;
  at: string;
}
export interface TeamFeedItem {
  id: string;
  at: string;
  role: Role;
  kind: 'started' | 'finished' | 'failed' | 'paused';
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

// A `waiting` Run is held on the user (a Clarification), which the room shows as a request.
const live = (run: Run) => run.status === 'running';

function activity(run: Run, task?: Task): MemberActivity {
  // A task-bound liaison turn (a Dev question, feedback, acceptance) is the team talking internally.
  if (run.role === 'pm')
    return run.incidentId ? 'assessing' : task ? 'coordinating' : run.sourceMessageId ? 'talking' : 'planning';
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
    (c) => c.projectId === projectId && c.status === 'open',
  );
  const decisions = (state.incidents ?? []).filter(
    (i) => i.projectId === projectId && i.status === 'waiting_user',
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

  const work: TeamWork[] = [];
  for (const task of tasks.values()) {
    const owners = [...new Set(active.filter((r) => r.taskId === task.id).map((r) => r.role))];
    const held = task.control === 'paused' && !['done', 'cancelled'].includes(task.stage);
    const attention: WorkAttention = !held
      ? 'none'
      : task.pausedByUser
        ? 'paused'
        : asked.has(task.id)
          ? 'needs_user'
          : owners.length
            ? 'none'
            : 'blocked';
    if (attention === 'blocked')
      waiting.push({
        id: `blocked:${task.id}`,
        kind: 'blocked',
        taskId: task.id,
        taskTitle: task.title,
        text: task.blocked ?? '',
        at: task.updatedAt,
      });
    work.push({
      taskId: task.id,
      title: task.title,
      step: steps[task.stage],
      attention,
      ...(held && task.blocked ? { reason: task.blocked } : {}),
      owners,
      rounds: task.retries,
      updatedAt: task.updatedAt,
    });
  }
  // Live and held work first, then most recently touched.
  const rank = (w: TeamWork) => (w.step === 'done' || w.step === 'cancelled' ? 1 : 0);
  work.sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
  waiting.sort((a, b) => a.at.localeCompare(b.at));

  const feed: TeamFeedItem[] = [];
  for (const run of runs) {
    const task = run.taskId ? tasks.get(run.taskId) : undefined;
    const base = {
      role: run.role,
      runId: run.id,
      ...(task ? { taskId: task.id, taskTitle: task.title } : {}),
    };
    feed.push({ id: `${run.id}:start`, at: run.startedAt, kind: 'started', ...base });
    if (run.endedAt && run.status !== 'running' && run.status !== 'waiting')
      feed.push({
        id: `${run.id}:end`,
        at: run.endedAt,
        kind:
          run.status === 'completed'
            ? 'finished'
            : run.status === 'failed'
              ? 'failed'
              : 'paused',
        ...base,
      });
  }
  feed.sort((a, b) => b.at.localeCompare(a.at));
  return { members, work, waiting, feed: feed.slice(0, feedLimit) };
}
