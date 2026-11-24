import { z } from 'zod';
import type { Collaboration } from '../shared/collaboration.ts';
import { externalDevelopmentHeld } from '../shared/task-history.ts';
import type { Run, Task } from '../shared/types.ts';
import { collaborationAction, Collaborations, delegationInput } from './collaboration.ts';
import type { PullState } from './github.ts';
import { domainContext, instructions, taskPrompt } from './prompts.ts';
import { jsonSchema } from './schemas.ts';
import { Fault, redact } from './store.ts';
import { parseStructuredReply } from './structured.ts';
import {
  diagnosticDescriptor,
  FAILURE_LIMIT,
  ROLE_ALLOWED_TOOLS,
  tripOf,
  type EngineHost,
} from './engine-helpers.ts';

const deliveryTextInput = z.object({
  commitMessage: z
    .string()
    .trim()
    .min(1)
    .max(10_000)
    .regex(/^[^\0]*$/),
  pullRequestBody: z
    .string()
    .trim()
    .min(1)
    .max(60_000)
    .regex(/^[^\0]*$/),
});

const deliveryTextRequest = `
Write this delivery's commit message and pull request body following the repository conventions
in the team instructions (commit style, pull request template). End your report with exactly one
JSON block:
{
  "commitMessage": "subject line, blank line, optional body",
  "pullRequestBody": "the filled template"
}
The host commits with commitMessage, titles the pull request with its subject line,
and links any associated Issue itself.`;

/**
 * `spend: false` is host resynchronisation (a moved base), not a product rework round.
 * `finalize` keeps edits the Dev already made, so the next Run commits them without a Dev turn.
 */
export function rework(
  host: EngineHost,
  task: Task,
  reason: string,
  spend = true,
  phase: 'implement' | 'finalize' = 'implement',
) {
  if (externalDevelopmentHeld(host.store.task(task.id))) return;
  const retries = task.retries + (spend ? 1 : 0);
  const exhausted = spend && retries >= FAILURE_LIMIT;
  host.store.updateTaskControl(
    task.id,
    {
      stage: 'developing',
      devPhase: phase,
      retries,
      reviews: [],
      reviewClarificationId: undefined,
      // Passing evidence stays: it is bound to its head and is reused only if the head is unchanged.
      tests: task.tests.every((t) => t.exitCode === 0) ? task.tests : [],
      mergeApproval: undefined,
      feedback: [...task.feedback, redact(reason)],
      control: exhausted ? 'paused' : 'active',
      pausedByUser: false,
      blocked: exhausted ? '连续三轮未完成，PM 正在重评' : undefined,
      blockedDescriptor: exhausted
        ? diagnosticDescriptor('retries_exhausted', '连续三轮未完成，PM 正在重评')
        : undefined,
    },
    exhausted ? 'pause' : 'resume',
    { source: 'host', reason: 'rework' },
  );
  if (exhausted)
    void host.track(
      host.incidentForTask(host.store.task(task.id), reason, 'retries').catch((error) =>
        host.store.event('incident', String(error), {
          projectId: task.projectId,
          taskId: task.id,
        }),
      ),
    );
}

export function verifyMergeSource(host: EngineHost, task: Task, pr: PullState) {
  const repo = host.store.repo(task.repoId);
  if (
    pr.head.ref !== task.branch ||
    pr.head.repo?.full_name?.toLowerCase() !== repo.github.toLowerCase() ||
    pr.base.repo?.full_name?.toLowerCase() !== repo.github.toLowerCase()
  )
    throw new Fault('原 PR 仓库或 head 分支归属不匹配');
  return host.store.updateTask(task.id, { mergeSourceBranch: task.branch });
}

export async function develop(host: EngineHost, run: Run) {
  const abort = new AbortController();
  const signal = abort.signal;
  host.active.set(run.id, { abort });
  const ensureExecutable = () => {
    host.store.assertTaskExecutable(run.taskId!);
    if (signal.aborted) throw new Fault('执行已暂停', 409);
  };
  try {
    ensureExecutable();
    let task = host.store.task(run.taskId!);
    const originalRevision = { head: task.head, base: task.base };
    const recoveringMerge = !!task.pendingMerge;
    if (task.devPhase !== 'finalize') task = await host.workspaces.prepare(task);
    ensureExecutable();
    if (!task.issue) await host.github.publishIssue(task);
    task = host.store.task(task.id);
    if (task.pr) {
      const pr = await host.github.pull(task);
      host.holdExternalMerge(task.id);
      ensureExecutable();
      task = verifyMergeSource(host, task, pr);
    }
    let coordinated = await host.workspaces.prepareBase(task, signal, task.devPhase !== 'finalize');
    let repaired = false;
    ensureExecutable();
    let rounds = 0;
    while (coordinated.status === 'conflicted') {
      // Each round merges the target ref once. Only a target ref that keeps moving can produce
      // another conflict, so this is bounded rather than repeated indefinitely.
      if (++rounds > 3) throw new Fault('基线协调连续 3 轮仍有新的冲突，已停止并保留现场');
      repaired = true;
      const merge = coordinated.merge;
      host.store.event(
        'merge-conflict',
        `待完成合并 ${merge.oldHead} + ${merge.sourceHead}；冲突文件：${merge.conflictPaths.join(', ')}`,
        { taskId: task.id, projectId: task.projectId },
      );
      if (!merge.runId && merge.conflictPaths.length) {
        await host.workspaces.claimConflict(task, merge.id, run.id);
        await editTask(
          host,
          run,
          host.store.task(task.id),
          abort,
          `Resolve only these actual conflict files: ${JSON.stringify(merge.conflictPaths)}. This is merge coordination, not product rework. Old HEAD: ${merge.oldHead}; incoming ${merge.sourceRef}: ${merge.sourceHead}; target base: ${merge.targetBase}. Read both histories and the Task requirements; preserve the existing implementation and all still-valid behavior from both sides. Do not choose ours/theirs wholesale. Edit files only in this worktree. Do not install dependencies, stage, commit, run merge, or access the shared mirror. The host will clear the unmerged index after checking your edits.`,
        );
        ensureExecutable();
        const current = host.store.task(task.id).pendingMerge!;
        host.store.updateTask(task.id, { pendingMerge: { ...current, phase: 'edited' } });
      } else if (
        merge.runId &&
        merge.runId !== run.id &&
        host.store.activeRuns().some((r) => r.id === merge.runId)
      ) {
        throw new Fault('原冲突 Dev Run 仍活跃，不能收尾');
      }
      await host.workspaces.finalize(host.store.task(task.id), signal);
      ensureExecutable();
      task = host.store.updateTask(task.id, { devPhase: 'finalize' });
      coordinated = await host.workspaces.prepareBase(task, signal);
      ensureExecutable();
    }
    if (coordinated.status === 'blocked')
      throw new Fault(`基线协调阻塞：${coordinated.reason}`, coordinated.code);
    task = host.store.task(task.id);
    if (task.devPhase !== 'finalize' && !repaired) {
      await host.workspaces.install(task, signal);
      ensureExecutable();
      await editTask(host, run, task, abort);
      ensureExecutable();
      host.store.updateTask(task.id, { devPhase: 'finalize' });
    }
    if (signal.aborted) throw new Fault('执行已暂停');
    const current = host.store.task(task.id);
    if (current.control !== 'active' || current.stage === 'cancelled') return;
    let base = current.base!;
    let finalized;
    for (let fixed = false; !finalized; fixed = true) {
      try {
        finalized = await host.workspaces.finalize(host.store.task(task.id), signal);
      } catch (e) {
        // The uncommitted change cannot become a rework round: base coordination refuses a dirty
        // tree, so the Dev fixes its own whitespace once inside this Run.
        if (fixed || !(e instanceof Fault && e.descriptor?.code === 'diff_check_failed'))
          throw new Fault(`宿主提交环境阻塞：${String(e)}`);
        await editTask(
          host,
          run,
          host.store.task(task.id),
          abort,
          undefined,
          `${e.message}\nThe host could not commit your change. Fix only these problems; delete files that do not belong in the repository, such as build logs or other verification output. Then stop.`,
        );
        if (signal.aborted) throw new Fault('执行已暂停');
      }
    }
    const { head, changed } = finalized;
    ensureExecutable();
    base = host.store.task(task.id).base!;
    host.store.updateTask(task.id, { head, base });
    host.store.pinRunRevision(run.id, { head, base });
    if (!changed) {
      if (repaired || recoveringMerge)
        throw new Fault('合并协调已完成，但相对目标基线没有可交付差异，已暂停等待 PM 核对');
      rework(host, current, '没有可交付的实现差异，请完成任务或向 PM 说明具体阻塞');
      return;
    }
    const previous = host.store.task(task.id);
    const { build, test } = host.store.repo(task.repoId).commands;
    const commands = [build, test].filter(Boolean);
    // A rework round that changed nothing (an evidence or wording gap) keeps the head; running the
    // same checks again only re-rolls flaky ones and sends a clean revision back to the Dev.
    const reusable =
      previous.tests.length === commands.length &&
      previous.tests.every(
        (t, i) => t.head === head && t.exitCode === 0 && t.command === commands[i],
      );
    if (!reusable && (previous.tests.length || previous.reviews.length)) {
      host.store.updateTask(task.id, {
        revisionHistory: [
          ...(previous.revisionHistory ?? []),
          {
            ...originalRevision,
            tests: previous.tests,
            reviews: previous.reviews,
          },
        ],
        tests: [],
        reviews: [],
        reviewClarificationId: undefined,
      });
    }
    let tests = previous.tests;
    if (!reusable) {
      await host.workspaces.install(host.store.task(task.id), signal);
      tests = await host.workspaces.verify(host.store.task(task.id), signal);
    }
    ensureExecutable();
    task = host.store.updateTask(task.id, { tests, head, base });
    const ensureActive = () => {
      ensureExecutable();
      const latest = host.store.task(task.id);
      if (signal.aborted || latest.control !== 'active' || latest.stage !== 'developing')
        throw new Fault('执行已暂停', 409);
    };
    ensureActive();
    if (tests.some((t) => t.exitCode !== 0)) {
      const failure = tests.map((t) => `${t.command}\nexit ${t.exitCode}\n${t.output}`).join('\n');
      // On-call diagnoses first, so a flaky or environmental failure does not spend a rework round.
      if (!host.startOncall(task, failure)) rework(host, task, failure);
      return;
    }
    await host.workspaces.push(task, signal);
    ensureActive();
    await host.github.publishPR(task);
    ensureActive();
    host.store.updateTask(task.id, {
      stage: 'reviewing',
      reviews: [],
      reviewClarificationId: undefined,
    });
    host.store.finishRun(run.id, 'completed');
  } catch (caught) {
    const e = tripOf(signal) ?? caught;
    const paused = signal.aborted && !tripOf(signal);
    host.store.finishRun(run.id, paused ? 'paused' : 'failed', String(e), {
      descriptor: diagnosticDescriptor('dev_failed', String(e)),
    });
    if (paused || externalDevelopmentHeld(host.store.task(run.taskId!))) return;
    host.block(run.taskId!, String(e), {
      source: 'host',
      reason: 'task_blocked',
      runId: run.id,
    });
    const expectedRecoveryBlock = /外部操作结果不明|核对结论与当前任务版本不一致/.test(String(e));
    if (!expectedRecoveryBlock) await host.incidentForRun(run, e, 'dev');
  } finally {
    if (host.store.get('run', run.id)?.status === 'running')
      host.store.finishRun(run.id, 'completed');
    host.active.delete(run.id);
  }
}

export async function editTask(
  host: EngineHost,
  run: Run,
  task: Task,
  abort: AbortController,
  conflict?: string,
  fix?: string,
) {
  const repo = host.store.repo(task.repoId);
  const profile = host.agentProfile(run);
  await host.withAgent(
    run,
    async (c, signal) => {
      const thread = await c.thread({
        cwd: task.worktree!,
        profile,
        instructions: await instructions('dev', {
          team: host.store.runTeamInstructions(run),
        }),
        threadId: run.resumeThreadId,
        writable: true,
        tools: [
          {
            name: 'delegate_work',
            description:
              'Delegate a bounded contribution in a private workspace. Choose a capability profile. Returns its result; you remain responsible for integration and delivery. Reuse requestKey after recovery.',
            inputSchema: jsonSchema(delegationInput),
          },
          {
            name: 'collaboration',
            description: 'Read, integrate, cancel or retry one of your task-scoped contributions.',
            inputSchema: jsonSchema(collaborationAction),
          },
          {
            name: 'ask_pm',
            description:
              'Ask the liaison about the scope or acceptance of this Task. Technical choices are yours: read the code and follow the repository and its ADRs.',
            inputSchema: jsonSchema(z.object({ question: z.string().min(1) }).strict()),
          },
        ],
        toolHandler: async (name: string, args: unknown) => {
          const collaborations = new Collaborations(host.store, host.workspaces.root);
          if (name === 'delegate_work') {
            const assignment = await collaborations.create(run, args);
            return assignment.status === 'queued'
              ? executeCollaboration(host, run, assignment, signal)
              : assignment;
          }
          if (name === 'collaboration') {
            const action = collaborationAction.parse(args);
            const assignment = collaborations.get(run, action.id);
            if (action.action === 'result') return assignment;
            if (action.action === 'integrate') return collaborations.integrate(run, action.id);
            if (action.action === 'cancel') {
              if (assignment.runId) host.active.get(assignment.runId)?.abort.abort();
              return collaborations.update(action.id, { status: 'cancelled' });
            }
            return executeCollaboration(host, run, collaborations.retry(run, action.id), signal);
          }
          if (name !== 'ask_pm') throw new Fault('负责人没有此操作权限', 403);
          const { question } = z.object({ question: z.string() }).parse(args);
          return {
            answer: await host.technical(task, question, '宿主事件：Dev 技术提问', true),
          };
        },
        ...(run.agentKind === 'omp' ? ({ allowedTools: ROLE_ALLOWED_TOOLS.dev } as any) : {}),
      } as any);
      host.saveThread(run, thread);
      const conventions = !!host.store.runTeamInstructions(run).sections.repository.trim();
      const reply = await c.turn(
        thread,
        `${taskPrompt(task)}\n${conflict ?? fix ?? ''}\nConfigured commands: ${JSON.stringify(repo.commands)}\n${await domainContext([task.worktree!, ...(await host.primaryPaths(task))])}\nFinish implementation, targeted checks and local self-review. Leave changes in this worktree. Do not stage, commit or push; the host owns finalization and formal validation.${conventions ? deliveryTextRequest : ''}`,
        profile,
        signal,
        undefined,
        host.onTurn(run),
      );
      host.store.event('dev-result', reply, {
        projectId: task.projectId,
        taskId: task.id,
        runId: run.id,
      });
      // Without a reply block the previous text, or the host's default format, still applies.
      const deliveryText = conventions && parseStructuredReply(deliveryTextInput, reply);
      if (deliveryText && !externalDevelopmentHeld(host.store.task(task.id)))
        host.store.updateTask(task.id, { deliveryText });
    },
    abort,
  );
}

export async function executeCollaboration(
  host: EngineHost,
  owner: Run,
  assignment: Collaboration,
  parent: AbortSignal,
) {
  const collaborations = new Collaborations(host.store, host.workspaces.root);
  const current = collaborations.get(owner, assignment.id);
  if (current.status === 'running') return current;
  assignment = collaborations.update(assignment.id, { status: 'running', error: undefined });
  try {
    assignment = await collaborations.prepare(assignment);
    if (parent.aborted) throw new Fault('负责人已经暂停', 409);
    collaborations.get(owner, assignment.id);
    const task = host.store.task(assignment.taskId);
    const run = host.store.run('dev', task.projectId, assignment.profile, task, {
      purpose: 'collaboration',
      collaborationId: assignment.id,
      workspacePath: assignment.worktree,
    });
    const previous = assignment.runId ? host.store.get('run', assignment.runId) : undefined;
    if (previous?.threadId) {
      Object.assign(run, {
        resumeThreadId: previous.threadId,
        profileConfig: previous.profileConfig,
        agentKind: previous.agentKind,
        provider: previous.provider,
        model: previous.model,
        modelIdentity: previous.modelIdentity,
      });
      host.store.put('run', run.id, run);
    }
    collaborations.update(assignment.id, { status: 'running', runId: run.id, error: undefined });
    const cancel = () => host.active.get(run.id)?.abort.abort();
    parent.addEventListener('abort', cancel, { once: true });
    try {
      const result = await host.track(
        host.withAgent(run, async (agent, signal) => {
          if (parent.aborted) throw new Fault('负责人已经暂停', 409);
          const profile = run.profileConfig!;
          const thread = await agent.thread({
            cwd: assignment.worktree!,
            profile,
            threadId: run.resumeThreadId,
            writable: assignment.mode === 'write',
            instructions: `${await instructions('dev', { team: host.store.runTeamInstructions(run) })}\nYou are a temporary contributor. Complete only the delegated objective below. Return findings, changes and verification to the owner. You cannot delegate, change scope, commit, push, publish or merge.`,
            tools: [],
            ...(run.agentKind === 'omp'
              ? {
                  allowedTools:
                    assignment.mode === 'write'
                      ? ROLE_ALLOWED_TOOLS.dev
                      : ['read', 'grep', 'glob'],
                }
              : {}),
          });
          host.saveThread(run, thread);
          return agent.turn(
            thread,
            `${taskPrompt(task)}\nDelegated objective:\n${assignment.objective}\n` +
              `Mode: ${assignment.mode}. Leave code changes in this private worktree.\n` +
              (await domainContext([assignment.worktree!])),
            profile,
            signal,
            undefined,
            host.onTurn(run),
          );
        }),
      );
      if (host.store.get('collaboration', assignment.id)?.status === 'cancelled')
        return collaborations.update(assignment.id, { status: 'cancelled' });
      if (parent.aborted) throw new Fault('负责人已中断，协作保留等待重试', 409);
      collaborations.get(owner, assignment.id);
      return collaborations.update(assignment.id, {
        status: 'completed',
        result: redact(result),
      });
    } finally {
      parent.removeEventListener('abort', cancel);
    }
  } catch (error) {
    if (host.store.get('collaboration', assignment.id)?.status === 'cancelled')
      return collaborations.update(assignment.id, { status: 'cancelled' });
    return collaborations.fail(assignment.id, error);
  }
}
