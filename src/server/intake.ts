import { createHash } from 'node:crypto';
import {
  intakeConfigurationInput,
  type IntakeSource,
  type InputAssessment,
  type SourceInput,
  type SourceReply,
  type SourceReplyPurpose,
  type WorkflowPage,
  type WorkflowInputDetail,
} from '../shared/intake.ts';
import type { Message, Task } from '../shared/types.ts';
import { isExternalDelivery } from '../shared/task-history.ts';
import { Fault, Store, id, now, redact } from './store.ts';
import type { GitHub, ObservedIssue } from './github.ts';

const identity = (text: string) => createHash('sha256').update(text).digest('hex');

export class Intake {
  private scans = new Map<string, Promise<IntakeSource>>();
  private pumping?: Promise<void>;
  private nextScan = 0;
  constructor(
    private store: Store,
    private github: GitHub,
    private chat: (message: Message) => Promise<string>,
  ) {}

  source(repoId: string) {
    return this.store.get('intakeSource', repoId);
  }

  async configure(repoId: string, value: unknown) {
    const input = intakeConfigurationInput.parse(value);
    const repo = this.store.repo(repoId);
    if (input.enabled && !repo.authorized) throw new Fault('仓库需单独授权外部写入', 409);
    const previous = this.source(repoId);
    const actors = await Promise.all(
      [...new Set(input.allowedActors.map((login) => login.toLowerCase()))].map((login) => {
        const known = previous?.allowedActors.find((actor) => actor.login.toLowerCase() === login);
        // Disabling retains verified identities so an outage cannot prevent switching intake off.
        return !input.enabled && known ? known : this.github.resolveIntakeActor(login);
      }),
    );
    if (actors.some((actor) => actor.kind !== 'user'))
      throw new Fault('仅可允许已核实的人类 GitHub 用户', 409);
    return this.store.transaction(() => {
      const previous = this.source(repoId);
      if ((previous?.version ?? 0) !== input.expectedVersion)
        throw new Fault('接收配置已变化，请刷新后重试', 409);
      const source: IntakeSource = {
        id: repoId,
        projectId: repo.projectId,
        repoId,
        kind: 'github.issues',
        enabled: input.enabled,
        command: input.command,
        allowedActors: actors,
        since: input.since,
        version: input.expectedVersion + 1,
        health: { status: 'not_connected' },
        createdAt: previous?.createdAt ?? now(),
        updatedAt: now(),
      };
      this.store.put('intakeSource', repoId, source);
      return source;
    });
  }

  refresh(repoId: string): Promise<IntakeSource> {
    const active = this.scans.get(repoId);
    if (active) return active;
    const job = this.readSource(repoId);
    this.scans.set(repoId, job);
    void job
      .finally(() => {
        if (this.scans.get(repoId) === job) this.scans.delete(repoId);
      })
      .catch(() => {});
    return job;
  }

  private async readSource(repoId: string) {
    const source = this.source(repoId);
    if (!source) throw new Fault('尚未配置接收来源', 404);
    if (!source.enabled) throw new Fault('接收来源未开启', 409);
    try {
      const issues = await this.github.readIntakeIssues(this.store.repo(repoId), source.since);
      this.store.transaction(() => {
        const current = this.source(repoId)!;
        // Full overlap from the fixed since prevents a shifting page from consuming a cursor.
        for (const issue of issues) this.capture(source, issue);
        this.store.put('intakeSource', repoId, {
          ...current,
          health:
            current.version === source.version
              ? { status: 'healthy', checkedAt: now() }
              : { status: 'not_connected' },
        });
      });
    } catch (error) {
      this.store.transaction(() => {
        const current = this.source(repoId)!;
        this.store.put('intakeSource', repoId, {
          ...current,
          health: { status: 'unavailable', checkedAt: now(), reason: redact(String(error)) },
        });
      });
    }
    return this.source(repoId)!;
  }

  private capture(source: IntakeSource, issue: ObservedIssue) {
    const inputId = identity(`${source.id}:${issue.nativeId}:${issue.revision}`);
    if (this.store.get('sourceInput', inputId)) return;
    const { databaseId, ...facts } = issue;
    const input: SourceInput = {
      ...facts,
      id: inputId,
      sourceId: source.id,
      projectId: source.projectId,
      repoId: source.repoId,
      kind: 'github.issue',
      observedAt: now(),
    };
    let disposition: InputAssessment['disposition'] = { status: 'queued' };
    const hostOwned =
      this.store
        .list('task')
        .some(
          (task) =>
            task.repoId === source.repoId &&
            !task.issueOrigin &&
            (task.issue === issue.number ||
              task.issueNodeId === issue.nativeId ||
              task.issueDatabaseId === databaseId),
        ) ||
      this.store.list('operation').some((operation) => {
        if (
          operation.kind !== 'create-issue' ||
          !operation.result ||
          typeof operation.result !== 'object'
        )
          return false;
        const result = operation.result;
        return (
          ('node_id' in result && result.node_id === issue.nativeId) ||
          ('html_url' in result && result.html_url === issue.url)
        );
      });
    const prior = this.store
      .list('sourceInput')
      .find((record) => record.sourceId === source.id && record.nativeId === issue.nativeId);
    const bound = this.store
      .list('task')
      .find((task) => task.repoId === source.repoId && task.issue === issue.number);
    if (hostOwned) disposition = { status: 'refused', reason: '宿主已创建的 Issue 不作为新请求' };
    else if (issue.actor.kind !== 'user')
      disposition = { status: 'refused', reason: '正文编辑者不是已核实的人类用户' };
    else if (
      !source.allowedActors.some((actor) => actor.id === issue.actor.id && actor.kind === 'user')
    )
      disposition = { status: 'refused', reason: '正文编辑者不在允许用户中' };
    else if (
      !issue.body.startsWith(source.command) ||
      !/^(?:\s|$)/.test(issue.body.slice(source.command.length))
    )
      disposition = { status: 'refused', reason: `Issue 正文未以 ${source.command} 直接发起请求` };
    else if (prior || bound)
      disposition = {
        status: 'context_only',
        reason: 'Issue 后续版本仅保留上下文；M1 不自动授权新工作或修订',
        ...(bound ? { taskId: bound.id } : {}),
      };
    else if (issue.state !== 'open') disposition = { status: 'refused', reason: 'Issue 已关闭' };
    const assessment: InputAssessment = {
      id: inputId,
      inputId,
      sourceId: source.id,
      projectId: source.projectId,
      repoId: source.repoId,
      policyVersion: source.version,
      disposition,
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.put('sourceInput', inputId, input);
    this.store.put('inputIdentity', inputId, { id: inputId, databaseId, nodeId: issue.nativeId });
    this.store.put('inputAssessment', assessment.id, assessment);
  }

  detail(inputId: string): WorkflowInputDetail {
    const input = this.store.get('sourceInput', inputId);
    const assessment = this.store.get('inputAssessment', inputId);
    if (!input || !assessment) throw new Fault('输入记录不存在', 404);
    return {
      input,
      assessment,
      replies: this.store.list('sourceReply').filter((reply) => reply.inputId === inputId),
    };
  }

  workflow(projectId: string, before?: string, limit = 30): WorkflowPage {
    this.store.project(projectId);
    const page = this.store.workflowInputs(projectId, before, limit);
    return {
      sources: this.store.list('intakeSource').filter((source) => source.projectId === projectId),
      admissionPaused: !!this.store.project(projectId).admissionPaused,
      inputs: page.inputs.map((input) => this.summary(input)),
      ...(page.next ? { next: page.next } : {}),
    };
  }

  summaries(projectId: string, ids: string[]): WorkflowPage['inputs'] {
    this.store.project(projectId);
    return this.store.workflowInputSummaries(projectId, ids).map((input) => this.summary(input));
  }

  private summary(input: Omit<SourceInput, 'body'>): WorkflowPage['inputs'][number] {
    const assessment = this.store.get('inputAssessment', input.id)!;
    const taskId = 'taskId' in assessment.disposition ? assessment.disposition.taskId : undefined;
    const task = taskId ? this.store.get('task', taskId) : undefined;
    return {
      input,
      assessment,
      replies: this.store.workflowReplies(input.id),
      ...(task
        ? {
            task: {
              id: task.id,
              title: task.title,
              stage: task.stage,
              control: task.control,
              blocked: task.blocked,
              completion: task.completion,
            },
          }
        : {}),
    };
  }

  dispatchMessage(inputId: string): Message | undefined {
    return this.store.transaction(() => {
      const { input, assessment } = this.detail(inputId);
      if (
        this.store.project(input.projectId).admissionPaused ||
        !this.store.repo(input.repoId).authorized
      )
        return;
      if (
        assessment.admission &&
        'messageId' in assessment.disposition &&
        assessment.disposition.messageId
      ) {
        const message = this.store.sourceAuthority(
          assessment.disposition.messageId,
          input.projectId,
          input.repoId,
        ).message;
        const task = this.store.list('task').find((item) => item.sourceMessageId === message.id);
        if (task && assessment.disposition.status === 'assessing')
          this.assess(assessment, { status: 'accepted', messageId: message.id, taskId: task.id });
        return message;
      }
      if (assessment.disposition.status !== 'queued') return;
      const source = this.source(input.repoId);
      if (!source?.enabled || source.version !== assessment.policyVersion) {
        this.assess(assessment, {
          status: 'unavailable',
          reason: '接收策略已变化，旧判断不可授权新工作',
        });
        return;
      }
      const message: Message = {
        id: id(),
        projectId: input.projectId,
        role: 'system',
        content: input.body,
        intent: 'implement',
        createdAt: now(),
        status: 'queued',
        draftStatus: 'queued',
        deliveryMode: 'queue',
        origin: {
          kind: 'github.issue',
          inputId,
          assessmentId: assessment.id,
          issue: input.number,
          url: input.url,
          actor: input.actor,
        },
      };
      this.store.put('message', message.id, message);
      this.store.put('inputAssessment', assessment.id, {
        ...assessment,
        admission: {
          actorId: input.actor.id,
          command: source.command,
          inputId,
          policyVersion: source.version,
        },
        disposition: { status: 'assessing', messageId: message.id },
        updatedAt: now(),
      });
      return message;
    });
  }

  private assess(assessment: InputAssessment, disposition: InputAssessment['disposition']) {
    this.store.transaction(() =>
      this.store.put('inputAssessment', assessment.id, {
        ...assessment,
        disposition,
        updatedAt: now(),
      }),
    );
  }

  noAction(messageId: string, reason: string) {
    const { external } = this.store.sourceAuthority(
      messageId,
      this.store.get('message', messageId)?.projectId ?? '',
    );
    if (!external) throw new Fault('此决定仅适用于外部来源', 403);
    if (this.store.project(external.input.projectId).admissionPaused)
      throw new Fault('团队已暂停接收工作', 409);
    if (this.store.list('task').some((task) => task.sourceMessageId === messageId))
      throw new Fault('已派生工作，不能改为无需行动', 409);
    const decision = external.assessment.disposition;
    if (decision.status === 'no_action') {
      if (decision.reason !== reason) throw new Fault('此请求已记录无需行动判断', 409);
      return { recorded: true };
    }
    this.store.transaction(() => {
      this.assess(external.assessment, { status: 'no_action', messageId, reason });
      this.queueReply(external.input.id, { kind: 'no_action' }, reason);
    });
    return { recorded: true };
  }

  hasFinalNoAction(messageId: string | undefined): boolean {
    const message = messageId ? this.store.get('message', messageId) : undefined;
    const disposition = message?.origin
      ? this.store.get('inputAssessment', message.origin.assessmentId)?.disposition
      : undefined;
    return disposition?.status === 'no_action' && disposition.messageId === messageId;
  }

  settle(message: Message, failure?: unknown) {
    if (!message.origin || this.hasFinalNoAction(message.id)) return;
    const { input, assessment } = this.detail(message.origin.inputId);
    const clarification = this.store
      .list('clarification')
      .find((item) => item.sourceMessageId === message.id && item.status === 'open');
    if (clarification) {
      const reason = clarification.questions.map((question) => question.question).join('\n');
      this.store.transaction(() => {
        this.assess(assessment, {
          status: 'awaiting_decision',
          messageId: message.id,
          clarificationId: clarification.id,
          reason,
        });
        this.queueReply(input.id, { kind: 'question', clarificationId: clarification.id }, reason);
      });
    } else if (
      !failure &&
      this.store.list('task').some((task) => task.sourceMessageId === message.id)
    ) {
      const task = this.store.list('task').find((task) => task.sourceMessageId === message.id)!;
      this.assess(assessment, { status: 'accepted', messageId: message.id, taskId: task.id });
    } else if (failure || assessment.disposition.status === 'assessing') {
      this.assess(assessment, {
        status: 'unavailable',
        messageId: message.id,
        reason: failure ? redact(String(failure)) : 'PM 回合未记录任务、澄清或明确无需行动决定',
      });
    }
  }

  async retry(inputId: string) {
    const { input, assessment, replies } = this.detail(inputId);
    const retryable = replies.filter(
      (reply) =>
        reply.state.status === 'unavailable' &&
        !this.store.get('operation', `source-reply:${reply.id}`),
    );
    if (retryable.length) {
      this.store.transaction(() => {
        for (const reply of retryable) {
          this.assertReply(reply);
          this.store.put('sourceReply', reply.id, { ...reply, state: { status: 'queued' } });
        }
      });
      for (const reply of retryable) await this.sendReply(reply.id);
      return this.detail(inputId);
    }
    if (assessment.disposition.status !== 'unavailable')
      throw new Fault('仅可重试判断不可用的输入', 409);
    if (this.store.project(input.projectId).admissionPaused)
      throw new Fault('团队已暂停接收工作', 409);
    if (assessment.admission && assessment.disposition.messageId) {
      const message = this.store.sourceAuthority(
        assessment.disposition.messageId,
        input.projectId,
        input.repoId,
      ).message;
      this.assess(assessment, { status: 'assessing', messageId: message.id });
      this.store.updateMessage(message.id, { status: 'queued', draftStatus: 'queued' });
    } else {
      const source = this.source(input.repoId);
      if (!source?.enabled || source.version !== assessment.policyVersion)
        throw new Fault('策略已变化，不能重用旧判断', 409);
      this.assess(assessment, { status: 'queued' });
    }
    await this.pump(false);
    return this.detail(inputId);
  }

  queueReply(inputId: string, purpose: SourceReplyPurpose, text: string) {
    const { input, assessment } = this.detail(inputId);
    if (!assessment.admission) throw new Fault('未接纳输入不能发送回复', 403);
    const semantic =
      purpose.kind === 'outcome'
        ? `outcome:${purpose.taskId}`
        : purpose.kind === 'question'
          ? `question:${purpose.clarificationId}`
          : `no_action:${inputId}`;
    const replyId = identity(`${input.sourceId}:${input.nativeId}:${semantic}`);
    const existing = this.store.get('sourceReply', replyId);
    if (existing) return existing;
    const reply: SourceReply = {
      id: replyId,
      inputId,
      projectId: input.projectId,
      repoId: input.repoId,
      issue: input.number,
      purpose,
      body: `${redact(text)}\n\n<!-- phantom-reply:${replyId} -->`,
      state: { status: 'queued' },
      createdAt: now(),
    };
    this.store.transaction(() => this.store.put('sourceReply', replyId, reply));
    return reply;
  }

  outcome(task: Task, text: string) {
    if (task.issueOrigin && task.stage === 'done' && task.completion)
      this.queueReply(task.issueOrigin.inputId, { kind: 'outcome', taskId: task.id }, text);
  }

  private assertReply(reply: SourceReply) {
    const { input, assessment } = this.detail(reply.inputId);
    if (!('messageId' in assessment.disposition) || !assessment.disposition.messageId)
      throw new Fault('回复来源不可用', 409);
    this.store.sourceAuthority(assessment.disposition.messageId, reply.projectId, reply.repoId);
    if (
      this.store.project(reply.projectId).admissionPaused ||
      !this.store.repo(reply.repoId).authorized
    )
      throw new Fault('团队或仓库写入已暂停', 409);
    if (input.number !== reply.issue || input.repoId !== reply.repoId)
      throw new Fault('回复目标绑定不一致', 409);
    if (reply.purpose.kind === 'no_action' && assessment.disposition.status !== 'no_action')
      throw new Fault('无需行动决定尚未完成', 409);
    if (
      reply.purpose.kind === 'question' &&
      (assessment.disposition.status !== 'awaiting_decision' ||
        assessment.disposition.clarificationId !== reply.purpose.clarificationId)
    )
      throw new Fault('澄清已结束，不再发送过期问题', 409);
    if (reply.purpose.kind === 'outcome') {
      const task = this.store.task(reply.purpose.taskId);
      if (
        task.stage !== 'done' ||
        !task.completion ||
        task.issueOrigin?.inputId !== input.id ||
        assessment.disposition.status !== 'accepted' ||
        (task.control === 'paused' && !isExternalDelivery(task))
      )
        throw new Fault('原请求尚未完整交付，不能发送完成回复', 409);
    }
  }

  async sendReply(replyId: string) {
    const reply = this.store.get('sourceReply', replyId);
    if (!reply || reply.state.status === 'sent' || reply.state.status === 'unavailable') return;
    try {
      this.assertReply(reply);
      const result = await this.github.deliverSourceReply(reply, () => this.assertReply(reply));
      this.store.transaction(() =>
        this.store.put('sourceReply', reply.id, {
          ...reply,
          state: { status: 'sent', url: result.html_url, sentAt: now() },
        }),
      );
    } catch (error) {
      const operation = this.store.get('operation', `source-reply:${reply.id}`);
      if (
        (!operation || !['pending', 'uncertain'].includes(operation.status)) &&
        (this.store.project(reply.projectId).admissionPaused ||
          !this.store.repo(reply.repoId).authorized ||
          (reply.purpose.kind === 'outcome' &&
            this.store.task(reply.purpose.taskId).control === 'paused' &&
            !isExternalDelivery(this.store.task(reply.purpose.taskId))))
      )
        return;
      this.store.transaction(() =>
        this.store.put('sourceReply', reply.id, {
          ...reply,
          state: {
            status:
              operation && ['pending', 'uncertain'].includes(operation.status)
                ? 'uncertain'
                : 'unavailable',
            reason: redact(String(error)),
          },
        }),
      );
    }
  }

  async reconcileReply(inputId: string) {
    const { replies } = this.detail(inputId);
    for (const reply of replies.filter((item) => item.state.status === 'uncertain')) {
      try {
        this.assertReply(reply);
        await this.github.reconcileSourceReply(reply);
        await this.sendReply(reply.id);
      } catch (error) {
        this.store.transaction(() =>
          this.store.put('sourceReply', reply.id, {
            ...reply,
            state: { status: 'uncertain', reason: redact(String(error)) },
          }),
        );
      }
    }
    return this.detail(inputId);
  }

  pump(scan = true): Promise<void> {
    if (this.pumping) return this.pumping;
    const job = this.runPump(scan);
    this.pumping = job;
    void job
      .finally(() => {
        if (this.pumping === job) this.pumping = undefined;
      })
      .catch(() => {});
    return job;
  }

  private async runPump(scan: boolean) {
    if (scan && Date.now() >= this.nextScan) {
      this.nextScan = Date.now() + 60_000;
      for (const source of this.store.list('intakeSource').filter((item) => item.enabled))
        await this.refresh(source.repoId);
    }
    for (const assessment of this.store.list('inputAssessment')) {
      if (this.store.project(assessment.projectId).admissionPaused) continue;
      const disposition = assessment.disposition;
      if (disposition.status !== 'queued' && disposition.status !== 'assessing') continue;
      const message = this.dispatchMessage(assessment.inputId);
      if (!message) continue;
      const recovery = this.store
        .list('recovery')
        .some((item) => item.sourceMessageId === message.id && item.status === 'pending');
      if (recovery || message.status === 'running') continue;
      if (message.status === 'completed' || message.status === 'failed') {
        this.settle(message, message.status === 'failed' ? '判断回合失败，需显式重试' : undefined);
        continue;
      }
      try {
        await this.chat(message);
        if (!this.store.project(message.projectId).admissionPaused) this.settle(message);
      } catch (error) {
        this.settle(message, error);
      }
    }
    for (const reply of this.store.list('sourceReply')) {
      if (this.store.project(reply.projectId).admissionPaused) continue;
      if (reply.state.status === 'queued' || reply.state.status === 'uncertain')
        await this.sendReply(reply.id);
    }
  }
}
