import type { Task } from '../shared/types.ts';

/** The engineering change kinds accepted by the host naming contract. */
export const changeTypes = ['feat', 'fix', 'refactor', 'docs', 'test', 'chore'] as const;
export type ChangeType = (typeof changeTypes)[number];

/** The optional fields a PM supplies for a new task's engineering delivery. */
type EngineeringFields = {
  changeType?: string;
  scope?: string;
  summaryEn?: string;
};
export type EngineeringTask = Pick<Task, 'id' | 'title' | 'issue' | 'spec' | 'tests'> &
  EngineeringFields;

const refPart = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const summaryPart = /[\u0000-\u001f\u007f]/;

function text(value: string | undefined) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validate and return the complete engineering metadata, or undefined for a legacy task.
 * A partially populated tuple is an error: silently falling back to a legacy branch would make
 * the stored engineering intent disappear from Git history.
 */
export function engineeringMetadata(task: EngineeringFields) {
  const values = [task.changeType, task.scope, task.summaryEn];
  if (values.every((value) => value === undefined || value === '')) return undefined;
  if (!changeTypes.includes(task.changeType as ChangeType))
    throw new Error('任务 changeType 必须是 feat、fix、refactor、docs、test 或 chore');
  const scope = text(task.scope);
  if (!refPart.test(scope) || scope.length > 40)
    throw new Error('任务 scope 必须是小写 ASCII kebab-case，长度不超过 40');
  const summaryEn = text(task.summaryEn);
  if (!summaryEn || summaryPart.test(summaryEn) || summaryEn.length > 160)
    throw new Error('任务 summaryEn 不能为空、不能包含控制字符，长度不超过 160');
  return { changeType: task.changeType as ChangeType, scope, summaryEn };
}

/** Whether the task has the new, complete engineering naming tuple. */
export function hasEngineeringMetadata(task: EngineeringFields) {
  return engineeringMetadata(task) !== undefined;
}

/** The short, stable suffix used in a new task branch. */
export function shortTaskId(taskId: string) {
  const compact = taskId.replaceAll('-', '');
  return compact.slice(0, 8) || taskId.slice(0, 8);
}

/** The branch assigned to a new task; legacy tasks retain phantom/<full task id>. */
export function taskBranch(task: Pick<Task, 'id'> & EngineeringFields) {
  const metadata = engineeringMetadata(task);
  return metadata
    ? `phantom/${metadata.changeType}/${metadata.scope}-${shortTaskId(task.id)}`
    : `phantom/${task.id}`;
}

/** The conventional engineering title shared by commits and new pull requests. */
export function engineeringTitle(task: Pick<Task, 'id' | 'title' | 'issue'> & EngineeringFields) {
  const metadata = engineeringMetadata(task);
  return metadata ? `${metadata.changeType}(${metadata.scope}): ${metadata.summaryEn}` : task.title;
}

/** The host commit message. Legacy tasks keep their established message format. */
export function commitMessage(task: Pick<Task, 'id' | 'title' | 'issue'> & EngineeringFields) {
  const subject = engineeringTitle(task);
  if (!engineeringMetadata(task))
    return `Implement task ${task.id}: ${subject.replace(/[\r\n]/g, ' ')}`;
  const issue = task.issue ? `\nIssue: #${task.issue}` : '';
  return `${subject}\n\nTask: ${task.id}${issue}`;
}

/**
 * Compact PR body for new engineering-named tasks. Legacy PRs retain their full historical spec
 * body so an already published delivery is never rewritten by an upgrade.
 */
export function pullRequestBody(
  task: Pick<Task, 'id' | 'title' | 'issue' | 'spec' | 'tests'> & EngineeringFields,
) {
  const marker = `<!-- phantom-task:${task.id} -->`;
  if (!engineeringMetadata(task)) {
    const evidence = task.tests.map((t) => `- ${t.command}: exit ${t.exitCode}`).join('\n');
    return `${marker}\n${task.spec}\n\n## Validation\n${evidence}\n\nCloses #${task.issue}`;
  }
  const metadata = engineeringMetadata(task)!;
  const evidence = task.tests.length
    ? task.tests.map((t) => `- ${t.command}: exit ${t.exitCode}`).join('\n')
    : '- Not run';
  return [
    marker,
    '## Problem',
    task.title.replace(/[\r\n]+/g, ' '),
    '',
    '## Result',
    metadata.summaryEn,
    '',
    '## Validation',
    evidence,
    '',
    '## Limitations',
    'None recorded.',
    '',
    `Closes #${task.issue}`,
  ].join('\n');
}

/** A strict expected branch check for persisted tasks. */
export function expectedTaskBranch(task: Pick<Task, 'id' | 'branch'> & EngineeringFields) {
  const expected = taskBranch(task);
  // Existing tasks may have an independently assigned legacy branch (the host must preserve it).
  // Once engineering metadata exists, the generated branch is the only accepted assignment.
  if (!engineeringMetadata(task)) return task.branch ?? expected;
  if (task.branch !== undefined && task.branch !== expected)
    throw new Error(`任务分支与命名契约不匹配：应为 ${expected}`);
  return expected;
}

// Explicit aliases keep the public helper vocabulary easy to discover at call sites.
export const branchForTask = taskBranch;
export const commitTitle = engineeringTitle;
export const pullRequestTitle = engineeringTitle;
