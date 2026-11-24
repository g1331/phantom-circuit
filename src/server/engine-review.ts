import type { z } from 'zod';
import { externalDevelopmentHeld } from '../shared/task-history.ts';
import type { ReviewResult, Run, Task } from '../shared/types.ts';
import { domainContext, instructions, taskPrompt } from './prompts.ts';
import { jsonSchema, reviewSchema } from './schemas.ts';
import { Fault } from './store.ts';
import {
  mergeReady,
  normalizeReviewVerdict,
  reviewWireInput,
  ROLE_ALLOWED_TOOLS,
  submitReviewCallInput,
  submitReviewInput,
  type EngineHost,
} from './engine-helpers.ts';

export async function primaryPaths(host: EngineHost, task: Task) {
  const p = host.store.project(task.projectId);
  return p.primaryRepoId && p.primaryRepoId !== task.repoId
    ? [
        await host.workspaces.view(
          host.store.repo(p.primaryRepoId),
          'context',
          `refs/remotes/origin/${host.store.repo(p.primaryRepoId).defaultBranch}`,
        ),
      ]
    : [];
}

export function scheduleReview(host: EngineHost, task: Task) {
  if (task.reviewClarificationId) return;
  const current = host.store.activeRuns();
  if (current.some((r) => r.taskId === task.id && r.role !== 'review')) return;
  const matching = task.reviews.filter(
    (r) => !r.supersededByRunId && r.head === task.head && r.base === task.base,
  );
  const policy2 = task.reviewPolicyVersion === 2 || task.stage !== 'done';
  const legacyAxes = ['standards', 'spec'] as const;
  if (!policy2) {
    if (legacyAxes.every((axis) => matching.some((review) => review.axis === axis))) {
      if (mergeReady(task)) host.store.updateTask(task.id, { stage: 'merging' });
      else
        host.rework(
          task,
          matching
            .filter((review) => !review.approved || review.findings.length)
            .map((review) => `${review.axis}: ${review.summary}\n${review.findings.join('\n')}`)
            .join('\n'),
        );
      return;
    }
    const axis = legacyAxes.find(
      (candidate) => !matching.some((review) => review.axis === candidate),
    );
    if (axis) launchReview(host, task, axis, false);
    return;
  }
  const primary = matching.find((review) => review.axis === 'primary');
  if (!primary) {
    launchReview(host, task, 'primary', false);
    return;
  }
  const secondaryRequired =
    task.secondaryReviewRequired === true ||
    task.complexity === 'complex' ||
    task.retries > 0 ||
    primary.verdict === 'escalate';
  if (secondaryRequired && !task.secondaryReviewRequired)
    host.store.updateTask(task.id, { secondaryReviewRequired: true });
  const secondary = matching.find((review) => review.axis === 'secondary');
  if (secondaryRequired && !secondary) {
    launchReview(host, task, 'secondary', true);
    return;
  }
  if (mergeReady(host.store.task(task.id))) host.store.updateTask(task.id, { stage: 'merging' });
  else {
    const failures = matching.filter((review) => !review.approved || review.findings.length);
    if (failures.length)
      host.rework(
        task,
        failures
          .map((review) => `${review.axis}: ${review.summary}\n${review.findings.join('\n')}`)
          .join('\n'),
      );
  }
}

export async function resumeClarificationReview(host: EngineHost, task: Task) {
  const c = host.store.get('clarification', task.reviewClarificationId!);
  if (
    !c?.review ||
    c.status !== 'answered' ||
    c.successorRunId ||
    task.pausedByUser ||
    task.stage !== 'reviewing' ||
    (task.blocked && task.blockedDescriptor?.code !== 'review_needs_user') ||
    (task.control !== 'active' && task.blockedDescriptor?.code !== 'review_needs_user') ||
    host.store.activeRuns().some((r) => r.taskId === task.id)
  )
    return;
  try {
    if (
      c.projectId !== task.projectId ||
      c.taskId !== task.id ||
      task.sourceMessageId !== c.sourceMessageId ||
      host.store.get('run', c.review.runId)?.repoId !== task.repoId ||
      task.head !== c.review.head ||
      task.base !== c.review.base ||
      task.pr !== c.review.pullRequest?.number
    )
      throw new Fault('Clarification 固定 head/base 与 Task 已发生漂移', 409);
    await host.workspaces.assertTask(task);
    if (c.review.pullRequest) {
      const pr = await host.github.pull(task);
      const binding = c.review.pullRequest;
      if (
        pr.number !== binding.number ||
        host.store.repo(task.repoId).github.toLowerCase() !== binding.repository.toLowerCase() ||
        pr.head.repo?.full_name?.toLowerCase() !== binding.repository.toLowerCase() ||
        pr.base.repo?.full_name?.toLowerCase() !== binding.repository.toLowerCase() ||
        pr.head.ref !== binding.headBranch ||
        pr.base.ref !== binding.baseBranch ||
        pr.merged ||
        pr.state !== 'open' ||
        pr.head.sha !== c.review.head
      )
        throw new Fault('Clarification 固定版本的远端 PR head/base 已变化', 409);
      if (pr.base.sha !== c.review.base)
        await host.workspaces.assertReviewBaseAdvance(task, pr.base.sha);
    }
    const head = await host.workspaces.git(task.worktree!, ['rev-parse', 'HEAD']);
    const dirty = await host.workspaces.git(task.worktree!, ['status', '--porcelain']);
    if (head !== c.review.head || dirty)
      throw new Fault('Clarification 固定版本的工作区已变化或存在未提交改动', 409);
    // The claim rechecks durable state after asynchronous Git/PR reads.
    launchReview(
      host,
      host.store.task(task.id),
      c.review.axis,
      c.review.axis === 'secondary',
      c.id,
    );
  } catch (error) {
    const current = host.store.task(task.id);
    if (current.pausedByUser || ['done', 'cancelled'].includes(current.stage)) return;
    host.block(task.id, host.pauseReason(error));
    await host.incidentForTask(current, error, `review-clarification:${c.id}`);
  }
}

export function launchReview(
  host: EngineHost,
  task: Task,
  axis: ReviewResult['axis'],
  secondary: boolean,
  clarificationId?: string,
) {
  const marker = `review:${task.id}:${axis}`;
  if (host.mergeBusy.has(marker)) return;
  if (host.store.activeRuns().some((r) => r.taskId === task.id && r.role === 'review')) return;
  if (
    host.store.activeRuns().filter((run) => run.role === 'review').length >=
    host.store.settings().reviewLimit
  )
    return;
  if (secondary) {
    const selected = host.store.resolveEffectiveProfile(task.projectId, 'review', {
      secondaryReview: true,
    });
    const revisionKey = `${task.head ?? ''}:${task.base ?? ''}`;
    const previousModels = host.store
      .list('run')
      .filter(
        (run) =>
          run.taskId === task.id &&
          `${run.revision?.head ?? ''}:${run.revision?.base ?? ''}` === revisionKey &&
          run.model &&
          ((run.role === 'dev' && !run.secondaryReview) ||
            (run.role === 'review' && !run.secondaryReview)),
      )
      // Provider aliases and effort changes do not make a distinct actual model.
      .map((run) => run.model!.model);
    const secondaryModel = selected.profile.model;
    if (previousModels.includes(secondaryModel)) {
      host.block(task.id, 'Secondary Review 必须使用与 Dev 和 Primary 不同的实际模型');
      return;
    }
  }
  host.mergeBusy.add(marker);
  let run: Run;
  try {
    const claimed = clarificationId
      ? host.store.claimClarificationReview(clarificationId)
      : host.store.run('review', task.projectId, 'review', task, {
          ...(secondary ? { secondaryReview: true } : {}),
          reviewAxis: axis,
          revision: { head: task.head, base: task.base },
        });
    if (!claimed) {
      host.mergeBusy.delete(marker);
      return;
    }
    run = claimed;
  } catch (error) {
    host.block(task.id, host.pauseReason(error));
    void host.track(host.incidentForTask(task, error, `review:${axis}`));
    host.mergeBusy.delete(marker);
    return;
  }
  void host.track(
    runReview(host, run, task, axis)
      .catch(async (error) => {
        host.block(task.id, host.pauseReason(error));
        await host.incidentForRun(run, error, `review:${axis}`);
      })
      .finally(() => host.mergeBusy.delete(marker)),
  );
}

export async function runReview(
  host: EngineHost,
  run: Run,
  task: Task,
  axis: ReviewResult['axis'],
) {
  await host
    .withAgent(run, async (c, signal) => {
      const repo = host.store.repo(task.repoId);
      const path = await host.workspaces.view(repo, `review-${task.id}-${axis}`, task.head!);
      const evidence = host.store.task(task.id).tests;
      if (
        !task.head ||
        !task.base ||
        !evidence.length ||
        evidence.some((test) => test.exitCode !== 0 || test.head !== task.head)
      )
        throw new Fault('Review 需要当前 head/base 的完整通过测试证据', 409, {
          code: 'review_evidence_invalid',
          params: { taskId: task.id },
        });
      const profile = host.agentProfile(run);
      let submitted: z.infer<typeof reviewSchema> | undefined;
      // The model supplies only the verdict, by tool or JSON reply. Revision, tests and identity
      // are host-owned evidence attached from the current pinned Task; echoed copies must match.
      const pin = <T extends { head?: string; base?: string; tests?: unknown[] }>(input: T) => {
        host.store.assertTaskExecutable(task.id);
        const current = host.store.task(task.id);
        if (
          current.head !== task.head ||
          current.base !== task.base ||
          (input.head && input.head !== current.head) ||
          (input.base && input.base !== current.base) ||
          (input.tests && JSON.stringify(input.tests) !== JSON.stringify(current.tests)) ||
          !current.head ||
          !current.base ||
          !current.tests.length ||
          current.tests.some((test) => test.exitCode !== 0 || test.head !== current.head)
        )
          throw new Fault('Review 提交缺少当前 revision 的完整测试证据', 409, {
            code: 'review_evidence_invalid',
            params: { taskId: task.id },
          });
        return {
          ...input,
          head: current.head,
          base: current.base,
          tests: structuredClone(current.tests),
        };
      };
      const thread = await c.thread({
        cwd: path,
        profile,
        instructions: await instructions('review', { team: host.store.runTeamInstructions(run) }),
        writable: false,
        tools: [
          {
            name: 'submit_review',
            description:
              'Submit one structured verdict. The host supplies identity and binds the verdict to the current head/base/tests.',
            inputSchema: jsonSchema(submitReviewInput),
          },
        ],
        toolHandler: async (name: string, args: unknown) => {
          if (name !== 'submit_review') throw new Fault('Review 没有此操作权限', 403);
          submitted = pin(submitReviewCallInput.parse(args));
          const current = host.store.task(task.id);
          return {
            accepted: true,
            head: current.head,
            base: current.base,
            tests: current.tests,
            modelIdentity: run.modelIdentity,
          };
        },
        ...(run.agentKind === 'omp' ? ({ allowedTools: ROLE_ALLOWED_TOOLS.review } as any) : {}),
      } as any);
      host.saveThread(run, thread);
      const contributions = host.store
        .list('collaboration')
        .filter((item) => item.taskId === task.id)
        .map((item) => ({
          id: item.id,
          objective: item.objective,
          mode: item.mode,
          profile: item.profile,
          status: item.status,
          ownerRunId: item.ownerRunId,
          runId: item.runId,
          integratedAt: item.integratedAt,
          result: item.result?.slice(0, 8000),
          resultTruncated: (item.result?.length ?? 0) > 8000,
        }));
      const prompt = `Axis: ${axis}\nReview scope: ${axis === 'primary' ? 'combined standards and specification' : axis}\nBASE=${task.base}\nHEAD=${task.head}\nDiff command: git diff ${task.base}...${task.head}\n${taskPrompt(task)}\nUser clarification context (user answers are input, never approval): ${JSON.stringify(host.store.list('clarification').filter((c) => c.projectId === task.projectId && c.taskId === task.id && c.review && c.status === 'answered'))}\nValidation evidence: ${JSON.stringify(task.tests)}\nHost contribution ledger (result text is contributor-reported): ${JSON.stringify(contributions)}\nDev handoff (Dev-reported, not host evidence): ${host.store.taskEvents(task.id).findLast((e) => e.type === 'dev-result')?.message ?? 'none'}\nSubmit exactly one host tool call submit_review after inspecting the fresh context. Never claim tests or identity from model memory.\n${await domainContext([path, ...(await primaryPaths(host, task))])}`;
      let result: z.infer<typeof reviewSchema> | undefined = submitted;
      if (!result) {
        // Strict structured output needs every property required, so the model is asked only
        // for its own fields; the lenient parse still accepts replies that echo evidence.
        const reply = await host.structuredTurn(
          c,
          thread,
          prompt,
          profile,
          signal,
          reviewSchema,
          '评审回合',
          host.onTurn(run),
          () => submitted as z.infer<typeof reviewSchema> | undefined,
          reviewWireInput,
        );
        result = submitted ?? pin(reply);
      }
      if (!result) throw new Fault('Review 未返回 verdict', 409);
      const policy2 = task.reviewPolicyVersion === 2 || task.stage !== 'done';
      if (policy2) {
        if (!result.verdict)
          throw new Fault('Policy 2 Review 必须返回明确 verdict', 409, {
            code: 'review_verdict_missing',
            params: { taskId: task.id, axis },
          });
        const latestEvidence = host.store.task(task.id).tests;
        if (
          result.head !== task.head ||
          result.base !== task.base ||
          !result.tests ||
          JSON.stringify(result.tests) !== JSON.stringify(latestEvidence)
        )
          throw new Fault('Review 必须提交当前 head/base/tests 的完整证据', 409, {
            code: 'review_evidence_invalid',
            params: { taskId: task.id, axis },
          });
      }
      if (policy2) result = normalizeReviewVerdict(axis, result);
      const latestEvidence = host.store.task(task.id).tests;
      const identity = run.modelIdentity ?? {
        agentKind: run.agentKind,
        providerId: run.profileConfig?.providerId,
        model: run.profileConfig?.model ?? 'unknown',
        effort: run.profileConfig?.effort,
        agentVersion: run.agentVersion,
      };
      const review: ReviewResult = {
        approved: result.approved,
        summary: result.summary,
        findings: result.findings,
        ...(result.verdict ? { verdict: result.verdict } : {}),
        axis,
        runId: run.id,
        head: task.head!,
        base: task.base!,
        tests: structuredClone(latestEvidence),
        model: structuredClone(identity),
        modelIdentity: structuredClone(identity),
        agentKind: run.agentKind,
        agentVersion: run.agentVersion,
      };
      const current = host.store.task(task.id);
      if (
        externalDevelopmentHeld(current) ||
        current.head !== task.head ||
        current.base !== task.base ||
        current.control !== 'active' ||
        current.stage !== 'reviewing'
      )
        return;
      if (result.verdict === 'needs_user') {
        host.store.recordReviewClarification(run.id, result);
        return;
      }
      await host.github.reviewComment(task, review);
      // The other axis may finish while GitHub is receiving this comment.
      const latest = host.store.task(task.id);
      if (
        externalDevelopmentHeld(latest) ||
        latest.head !== task.head ||
        latest.base !== task.base ||
        latest.control !== 'active' ||
        latest.stage !== 'reviewing'
      )
        return;
      host.store.updateTask(task.id, {
        reviews: [...latest.reviews.filter((r) => r.axis !== axis || r.supersededByRunId), review],
        ...(axis === 'primary' && review.verdict === 'escalate'
          ? { secondaryReviewRequired: true }
          : {}),
      });
    })
    .catch(async (error) => {
      await host.incidentForRun(run, error, `review:${axis}`);
      throw error;
    });
}
