import type { Clarification, ClarificationAnswer, ClarificationQuestion, Incident, ReviewResult, Run } from '../shared/types.ts';
import { clarificationInput, incidentInput, reviewSchema } from './schemas.ts';
import { Fault, id, now, redact, type StoreContext } from './store-core.ts';

export function createIncident(
  ctx: StoreContext,
  inputOrProject:
    | (Pick<Incident, 'projectId' | 'phase' | 'message'> &
        Partial<Pick<Incident, 'taskId' | 'runId' | 'evidence' | 'descriptor'>>)
    | string,
  runId?: string,
  phase?: string,
  message?: string,
  evidence?: string,
): Incident {
  const input =
    typeof inputOrProject === 'string'
      ? { projectId: inputOrProject, runId, phase: phase!, message: message ?? '', evidence }
      : inputOrProject;
  // Bound host-made text before validation; the limits below are for storage, not a reason to lose the Incident.
  const parsed = incidentInput.parse({
    ...input,
    message: input.message.slice(0, 16000),
    ...(input.evidence !== undefined ? { evidence: input.evidence.slice(0, 32000) } : {}),
  });
  ctx.project(parsed.projectId);
  if (parsed.taskId && ctx.task(parsed.taskId).projectId !== parsed.projectId)
    throw new Fault('Incident 任务不属于当前项目', 403);
  if (parsed.runId) {
    const run = ctx.get('run', parsed.runId);
    if (!run || run.projectId !== parsed.projectId)
      throw new Fault('Incident Run 不属于当前项目', 403);
  }
  const existing = ctx
    .list('incident')
    .find(
      (incident) =>
        !incident.supersededByExternalCompletionAt &&
        incident.projectId === parsed.projectId &&
        incident.phase === parsed.phase &&
        (parsed.runId ? incident.runId === parsed.runId : incident.taskId === parsed.taskId),
    );
  if (existing) return structuredClone(existing);
  const at = now();
  const incident: Incident = {
    id: id(),
    projectId: parsed.projectId,
    ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
    ...(parsed.runId ? { runId: parsed.runId } : {}),
    phase: parsed.phase,
    status: 'open',
    message: redact(parsed.message).slice(0, 16000),
    ...(parsed.descriptor ? { descriptor: structuredClone(parsed.descriptor) } : {}),
    ...(parsed.evidence ? { evidence: redact(parsed.evidence).slice(0, 32000) } : {}),
    createdAt: at,
    updatedAt: at,
  };
  ctx.put('incident', incident.id, incident);
  ctx.event('incident', `发生运行事件：${incident.phase}`, {
    projectId: incident.projectId,
    taskId: incident.taskId,
    runId: incident.runId,
  });
  return structuredClone(incident);
}

export function updateIncident(
  ctx: StoreContext,
  keyOrProject: string,
  patchOrKey:
    | string
    | Partial<
        Pick<
          Incident,
          'status' | 'message' | 'evidence' | 'descriptor' | 'assessmentRunId' | 'assessmentAt'
        >
      >,
  maybePatch?: Partial<
    Pick<
      Incident,
      'status' | 'message' | 'evidence' | 'descriptor' | 'assessmentRunId' | 'assessmentAt'
    >
  >,
) {
  const projectId = maybePatch ? keyOrProject : undefined;
  const key = maybePatch ? String(patchOrKey) : keyOrProject;
  const patch = (maybePatch ?? patchOrKey) as Partial<
    Pick<
      Incident,
      'status' | 'message' | 'evidence' | 'descriptor' | 'assessmentRunId' | 'assessmentAt'
    >
  >;
  const incident = ctx.get('incident', key);
  if (!incident) throw new Fault('Incident 不存在', 404);
  if (projectId && incident.projectId !== projectId) throw new Fault('跨项目操作被拒绝', 403);
  if (
    patch.assessmentRunId &&
    incident.assessmentRunId &&
    patch.assessmentRunId !== incident.assessmentRunId
  )
    throw new Fault('Incident 已由另一个 Run 评估', 409);
  const next: Incident = {
    ...incident,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.message !== undefined ? { message: redact(patch.message).slice(0, 16000) } : {}),
    ...(patch.descriptor !== undefined ? { descriptor: structuredClone(patch.descriptor) } : {}),
    ...(patch.evidence !== undefined ? { evidence: redact(patch.evidence).slice(0, 32000) } : {}),
    ...(patch.assessmentRunId ? { assessmentRunId: patch.assessmentRunId } : {}),
    ...(patch.assessmentAt ? { assessmentAt: patch.assessmentAt } : {}),
    updatedAt: now(),
  };
  ctx.put('incident', key, next);
  return structuredClone(next);
}

export function claimIncidentAssessment(ctx: StoreContext, key: string, assessmentRunId: string) {
  const incident = ctx.get('incident', key);
  if (!incident) throw new Fault('Incident 不存在', 404);
  if (incident.assessmentRunId && incident.assessmentRunId !== assessmentRunId)
    return structuredClone(incident);
  return updateIncident(ctx, key, {
    assessmentRunId,
    assessmentAt: now(),
    status: incident.status === 'open' ? 'assessing' : incident.status,
  });
}

export function createClarification(ctx: StoreContext, input: unknown): Clarification {
  const parsed = clarificationInput.parse(input);
  const authority = ctx.sourceAuthority(parsed.sourceMessageId, parsed.projectId);
  if (authority.external?.assessment.disposition.status === 'no_action')
    throw new Fault('此请求已记录无需行动判断', 409);
  const source = authority.message;
  if (!source || source.projectId !== parsed.projectId)
    throw new Fault('Clarification 来源消息不属于当前项目', 403);
  if (parsed.taskId && ctx.task(parsed.taskId).projectId !== parsed.projectId)
    throw new Fault('Clarification 任务不属于当前项目', 403);
  if (parsed.review) {
    const run = ctx.get('run', parsed.review.runId);
    const task = parsed.taskId ? ctx.task(parsed.taskId) : undefined;
    if (
      !run ||
      !task ||
      run.role !== 'review' ||
      run.projectId !== parsed.projectId ||
      run.taskId !== task.id ||
      run.repoId !== task.repoId ||
      run.reviewAxis !== parsed.review.axis ||
      task.sourceMessageId !== parsed.sourceMessageId ||
      run.revision?.head !== parsed.review.head ||
      run.revision?.base !== parsed.review.base ||
      task.head !== parsed.review.head ||
      task.base !== parsed.review.base
    )
      throw new Fault('Review Clarification 绑定不匹配', 409);
    const pullRequest = parsed.review.pullRequest;
    if (
      task.pr !== pullRequest?.number ||
      (pullRequest &&
        (pullRequest.repository !== ctx.repo(task.repoId).github ||
          pullRequest.headBranch !== task.branch ||
          pullRequest.baseBranch !== ctx.repo(task.repoId).defaultBranch))
    )
      throw new Fault('Review Clarification PR 绑定不匹配', 409);
  }
  const sourceIntent = parsed.sourceIntent ?? source.intent;
  if (
    !sourceIntent ||
    (source.intent && parsed.sourceIntent && source.intent !== parsed.sourceIntent)
  )
    throw new Fault('Clarification 必须保留原始消息意图', 409);
  const existing = ctx
    .list('clarification')
    .find(
      (clarification) =>
        clarification.projectId === parsed.projectId &&
        clarification.sourceMessageId === parsed.sourceMessageId &&
        (parsed.review
          ? clarification.review?.runId === parsed.review.runId
          : !clarification.review) &&
        clarification.status === 'open',
    );
  if (existing) return structuredClone(existing);
  const cancelled = ctx
    .list('clarification')
    .find(
      (clarification) =>
        clarification.projectId === parsed.projectId &&
        clarification.sourceMessageId === parsed.sourceMessageId &&
        !parsed.review &&
        !clarification.review &&
        clarification.status === 'cancelled',
    );
  if (cancelled)
    throw new Fault('原始用户消息的 Clarification 已取消，不能重新开启', 409, {
      code: 'clarification_cancelled',
      params: { sourceMessageId: parsed.sourceMessageId },
    });
  const questions: ClarificationQuestion[] = parsed.questions.map((question, index) => ({
    id: question.id ?? `q${index + 1}`,
    question: question.question ?? question.prompt!,
    ...(question.recommendation ? { recommendation: question.recommendation } : {}),
    ...(question.options?.length
      ? { options: question.options.map((option) => ({ ...option })) }
      : {}),
  }));
  const at = now();
  const clarification: Clarification = {
    id: id(),
    projectId: parsed.projectId,
    sourceMessageId: parsed.sourceMessageId,
    ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
    sourceIntent,
    ...(parsed.review ? { review: parsed.review } : {}),
    questions,
    status: 'open',
    createdAt: at,
    updatedAt: at,
  };
  ctx.put('clarification', clarification.id, clarification);
  ctx.event('clarification', '等待用户产品澄清', { projectId: parsed.projectId });
  return structuredClone(clarification);
}

/** One host-accepted review result, its user wait and questions share one durable commit. */
export function recordReviewClarification(
  ctx: StoreContext,
  runId: string,
  input: unknown,
): Clarification {
  const parsed = reviewSchema.parse(input);
  if (parsed.verdict !== 'needs_user') throw new Fault('需要 needs_user 判定', 400);
  return ctx.transaction(() => {
    const run = ctx.get('run', runId);
    if (!run || run.role !== 'review' || !run.taskId || !run.reviewAxis)
      throw new Fault('Review Run 绑定无效', 409);
    const task = ctx.task(run.taskId);
    if (
      run.projectId !== task.projectId ||
      run.repoId !== task.repoId ||
      run.sourceMessageId !== task.sourceMessageId ||
      run.revision?.head !== parsed.head ||
      run.revision?.base !== parsed.base ||
      task.head !== parsed.head ||
      task.base !== parsed.base
    )
      throw new Fault('Review revision 绑定不匹配', 409);
    const existing = ctx.list('clarification').find((c) => c.review?.runId === runId);
    if (existing) return existing;
    ctx.assertTaskExecutable(task.id);
    if (!['running', 'waiting'].includes(run.status))
      throw new Fault('Review Run 已结束，不能接受新判定', 409);
    if (task.control !== 'active' || task.stage !== 'reviewing' || task.reviewClarificationId)
      throw new Fault('Task 当前不能接受 Review 提问', 409);
    const clarification = createClarification(ctx, {
      projectId: task.projectId,
      taskId: task.id,
      sourceMessageId: task.sourceMessageId,
      questions: parsed.questions,
      review: {
        runId,
        axis: run.reviewAxis,
        head: task.head!,
        base: task.base!,
        ...(task.pr
          ? {
              pullRequest: {
                number: task.pr,
                repository: ctx.repo(task.repoId).github,
                headBranch: task.branch!,
                baseBranch: ctx.repo(task.repoId).defaultBranch,
              },
            }
          : {}),
      },
    });
    const review: ReviewResult = {
      ...parsed,
      axis: run.reviewAxis,
      runId,
      head: task.head!,
      base: task.base!,
      questions: clarification.questions,
      tests: structuredClone(task.tests),
      model: run.modelIdentity,
      modelIdentity: run.modelIdentity,
      agentKind: run.agentKind,
      agentVersion: run.agentVersion,
    };
    ctx.updateTask(task.id, {
      reviews: [
        ...task.reviews.filter((r) => r.axis !== run.reviewAxis || r.supersededByRunId),
        review,
      ],
      reviewClarificationId: clarification.id,
      control: 'paused',
      pausedByUser: false,
      blocked: '评审需要用户补充',
      blockedDescriptor: {
        code: 'review_needs_user',
        params: { clarificationId: clarification.id },
      },
    });
    ctx.taskControlEvent(task, 'pause', { source: 'host', reason: 'review_needs_user', runId });
    // A crash after accepting the verdict must not recover the asking Run as unfinished work.
    ctx.finishRun(runId, 'completed');
    return clarification;
  });
}

/** Called only after Engine verifies the pinned local and remote revision. */
export function claimClarificationReview(
  ctx: StoreContext,
  clarificationId: string,
): Run | undefined {
  return ctx.transaction(() => {
    const c = ctx.get('clarification', clarificationId);
    if (!c?.review || !c.taskId || c.status !== 'answered' || c.successorRunId) return;
    const task = ctx.task(c.taskId);
    const original = ctx.get('run', c.review.runId);
    if (
      task.projectId !== c.projectId ||
      task.stage !== 'reviewing' ||
      task.pausedByUser ||
      task.sourceMessageId !== c.sourceMessageId ||
      original?.repoId !== task.repoId ||
      task.pr !== c.review.pullRequest?.number ||
      task.reviewClarificationId !== c.id ||
      task.head !== c.review.head ||
      task.base !== c.review.base ||
      (task.blocked && task.blockedDescriptor?.code !== 'review_needs_user') ||
      (task.control !== 'active' && task.blockedDescriptor?.code !== 'review_needs_user') ||
      ctx.activeRuns().some((r) => r.taskId === task.id)
    )
      return;
    const asking = task.reviews.find(
      (r) => r.runId === c.review!.runId && r.verdict === 'needs_user' && !r.supersededByRunId,
    );
    if (!asking) throw new Fault('Review Clarification 原判定丢失', 409);
    const run = ctx.run('review', task.projectId, 'review', task, {
      reviewAxis: c.review.axis,
      secondaryReview: c.review.axis === 'secondary',
      revision: { head: c.review.head, base: c.review.base },
    });
    ctx.put('clarification', c.id, { ...c, successorRunId: run.id, updatedAt: now() });
    ctx.updateTask(task.id, {
      reviews: task.reviews.map((r) => (r === asking ? { ...r, supersededByRunId: run.id } : r)),
      reviewClarificationId: undefined,
      control: 'active',
      blocked: undefined,
      blockedDescriptor: undefined,
    });
    ctx.taskControlEvent(task, 'resume', {
      source: 'host',
      reason: 'review_clarification_answered',
      runId: run.id,
    });
    return run;
  });
}

export function answerClarification(
  ctx: StoreContext,
  keyOrProject: string,
  answersOrKey: ClarificationAnswer[] | Record<string, string | string[]> | string,
  maybeAnswers?: ClarificationAnswer[] | Record<string, string | string[]>,
) {
  const projectId = maybeAnswers === undefined ? undefined : keyOrProject;
  const key = maybeAnswers === undefined ? keyOrProject : String(answersOrKey);
  const rawAnswers = (maybeAnswers ?? answersOrKey) as
    | ClarificationAnswer[]
    | Record<string, string | string[]>;
  const clarification = ctx.get('clarification', key);
  if (!clarification) throw new Fault('Clarification 不存在', 404);
  if (projectId && clarification.projectId !== projectId) throw new Fault('跨项目操作被拒绝', 403);
  if (clarification.status === 'cancelled') throw new Fault('Clarification 已取消', 409);
  if (clarification.status === 'answered') return structuredClone(clarification);
  const answers: ClarificationAnswer[] = Array.isArray(rawAnswers)
    ? rawAnswers.map((answer) => ({ questionId: answer.questionId, value: answer.value }))
    : Object.entries(rawAnswers).map(([questionId, value]) => ({ questionId, value }));
  const questionIds = new Set(clarification.questions.map((question) => question.id));
  if (
    answers.some((answer) =>
      typeof answer.value === 'string'
        ? !answer.value.trim()
        : !Array.isArray(answer.value) ||
          !answer.value.length ||
          answer.value.some((value) => typeof value !== 'string' || !value.trim()),
    )
  )
    throw new Fault('Clarification 回答不能为空', 400);
  if (answers.some((answer) => !questionIds.has(answer.questionId)))
    throw new Fault('Clarification 问题编号无效', 400);
  const merged = new Map(
    (clarification.answers ?? []).map((answer) => [answer.questionId, answer]),
  );
  for (const answer of answers) merged.set(answer.questionId, answer);
  const normalizedAnswers = [...merged.values()];
  const complete = clarification.questions.every((question) => merged.has(question.id));
  const at = now();
  const next: Clarification = {
    ...clarification,
    status: complete ? 'answered' : 'open',
    answers: normalizedAnswers,
    ...(complete ? { answeredAt: at } : { answeredAt: undefined }),
    updatedAt: at,
  };
  ctx.put('clarification', key, next);
  ctx.event('clarification', '用户已回答产品澄清', { projectId: next.projectId });
  return structuredClone(next);
}

export function cancelClarification(ctx: StoreContext, keyOrProject: string, maybeKey?: string) {
  const projectId = maybeKey === undefined ? undefined : keyOrProject;
  const key = maybeKey ?? keyOrProject;
  const clarification = ctx.get('clarification', key);
  if (!clarification) throw new Fault('Clarification 不存在', 404);
  if (projectId && clarification.projectId !== projectId) throw new Fault('跨项目操作被拒绝', 403);
  if (clarification.status === 'cancelled') return structuredClone(clarification);
  if (clarification.status === 'answered') throw new Fault('Clarification 已回答', 409);
  const next = { ...clarification, status: 'cancelled' as const, updatedAt: now() };
  ctx.put('clarification', key, next);
  ctx.event('clarification', '产品澄清已取消', { projectId: next.projectId });
  return structuredClone(next);
}

export function clarificationGate(ctx: StoreContext, sourceMessageId: string) {
  return ctx
    .list('clarification')
    .find(
      (clarification) =>
        clarification.sourceMessageId === sourceMessageId &&
        !clarification.review &&
        ['open', 'cancelled'].includes(clarification.status),
    );
}
