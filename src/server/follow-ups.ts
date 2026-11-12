import { createHash } from 'node:crypto';
import type { FollowUp } from '../shared/collaboration.ts';
import { Store, Fault, now, redact } from './store.ts';

export type FollowUpInput = Pick<
  FollowUp,
  'source' | 'kind' | 'nativeId' | 'revision' | 'author' | 'body'
> &
  Partial<
    Pick<FollowUp, 'url' | 'replyIssue' | 'head' | 'actorId' | 'actorAssociation' | 'sourceTime'>
  >;

export class FollowUps {
  constructor(private store: Store) {}

  receive(taskId: string, input: FollowUpInput): FollowUp {
    const task = this.store.task(taskId);
    const identity = [taskId, input.source, input.kind, input.nativeId, input.revision];
    const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const existing = this.store.get('followUp', id);
    if (existing) return existing;
    const record: FollowUp = {
      ...input,
      body: redact(input.body),
      id,
      taskId,
      projectId: task.projectId,
      receivedAt: now(),
      status: 'queued',
    };
    this.store.put('followUp', id, record);
    this.store.event('feedback', input.body.slice(0, 2000), {
      projectId: task.projectId,
      taskId,
    });
    return record;
  }

  queued(taskId: string) {
    return this.store.list('followUp').filter((x) => x.taskId === taskId && x.status === 'queued');
  }

  claim(id: string, runId: string) {
    const input = this.store.get('followUp', id);
    if (!input || input.status !== 'queued') throw new Fault('反馈已被接收', 409);
    const claimed: FollowUp = { ...input, status: 'processing', runId };
    this.store.put('followUp', id, claimed);
    this.store.event('feedback', '负责人正在处理后续反馈', {
      projectId: input.projectId,
      taskId: input.taskId,
      runId,
    });
    return claimed;
  }

  settle(id: string, runId: string, verdict: Omit<NonNullable<FollowUp['disposition']>, 'at'>) {
    const input = this.store.get('followUp', id);
    if (!input || input.status !== 'processing' || input.runId !== runId)
      throw new Fault('反馈处理回合已经失效', 409);
    const result: FollowUp = {
      ...input,
      status:
        verdict.action === 'clarify'
          ? 'handed_back'
          : verdict.action === 'rework'
            ? 'accepted'
            : 'resolved',
      disposition: { ...verdict, at: now() },
      ...(input.replyIssue ? { reply: { status: 'pending' as const } } : {}),
    };
    this.store.put('followUp', id, result);
    this.store.event('feedback', verdict.reason, {
      projectId: input.projectId,
      taskId: input.taskId,
      runId,
    });
    return result;
  }

  complete(taskId: string) {
    for (const input of this.store.list('followUp'))
      if (input.taskId === taskId && input.status === 'accepted')
        this.store.put('followUp', input.id, { ...input, status: 'resolved' });
  }

  release(runId: string) {
    for (const input of this.store.list('followUp'))
      if (input.status === 'processing' && input.runId === runId)
        this.store.put('followUp', input.id, { ...input, status: 'queued', runId: undefined });
  }
}
