import { z } from 'zod';
import type { Task } from '../shared/types.ts';
import { taskDeliveryPR } from '../shared/task-history.ts';
import { GitHub } from './github.ts';
import { FollowUps } from './follow-ups.ts';
import { Store, Fault, redact, now } from './store.ts';

const entry = z.object({
  id: z.number(),
  body: z.string().nullable().optional(),
  state: z.string().optional(),
  author_association: z.string(),
  user: z.object({ id: z.number(), login: z.string(), type: z.string().optional() }),
  html_url: z.string().url(),
  updated_at: z.string().optional(),
  submitted_at: z.string().optional(),
  created_at: z.string().optional(),
  commit_id: z.string().optional(),
});
const check = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string().url().nullable(),
  completed_at: z.string().nullable(),
  output: z.object({ title: z.string().nullable(), summary: z.string().nullable() }),
});
const status = z.object({
  id: z.number(),
  context: z.string(),
  state: z.string(),
  description: z.string().nullable(),
  target_url: z.string().url().nullable(),
  updated_at: z.string(),
});

export class GitHubFollowUps {
  constructor(
    private store: Store,
    private github: GitHub,
  ) {}

  async collect(task: Task) {
    const repo = this.store.repo(task.repoId);
    if (!repo.authorized || !repo.followUpsEnabled) return;
    const inputs = new FollowUps(this.store);
    const receiving = () => {
      const current = this.store.repo(task.repoId);
      return current.authorized && current.followUpsEnabled;
    };
    const root = `repos/${repo.github}`;
    const streams: { endpoint: string; kind: 'comment' | 'review'; issue: number }[] = [];
    if (task.issue)
      streams.push({
        endpoint: `${root}/issues/${task.issue}/comments?per_page=100`,
        kind: 'comment',
        issue: task.issue,
      });
    if (task.pr)
      streams.push(
        {
          endpoint: `${root}/issues/${task.pr}/comments?per_page=100`,
          kind: 'comment',
          issue: task.pr,
        },
        {
          endpoint: `${root}/pulls/${task.pr}/comments?per_page=100`,
          kind: 'comment',
          issue: task.pr,
        },
        {
          endpoint: `${root}/pulls/${task.pr}/reviews?per_page=100`,
          kind: 'review',
          issue: task.pr,
        },
      );
    for (const stream of streams) {
      const records = z.array(entry).parse(await this.github.paged(stream.endpoint));
      for (const record of records) {
        if (!receiving()) return;
        const source = this.store.list('intakeSource').find((item) => item.repoId === repo.id);
        const allowed = source?.allowedActors.some((actor) => actor.id === record.user.id);
        if (!allowed && !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(record.author_association))
          continue;
        if (record.user.type === 'Bot') continue;
        if (record.body?.includes('<!-- phantom-') || record.state === 'PENDING') continue;
        const revision = record.updated_at ?? record.submitted_at ?? record.created_at;
        if (!revision) throw new Fault('GitHub 反馈缺少版本时间', 502);
        if (Date.parse(revision) < Date.parse(task.createdAt)) continue;
        inputs.receive(task.id, {
          source: 'github',
          kind: stream.kind,
          nativeId: record.html_url,
          revision: `${revision}:${record.state ?? ''}`,
          author: record.user.login,
          actorId: record.user.id,
          actorAssociation: record.author_association,
          sourceTime: revision,
          url: record.html_url,
          replyIssue: stream.issue,
          head: record.commit_id,
          body: [record.state, record.body].filter(Boolean).join('\n') || 'Empty comment',
        });
      }
    }
    if (!task.head || !task.pr) return;
    const checks = z
      .array(check)
      .parse(await this.checkPages(`${root}/commits/${task.head}/check-runs`, 'check_runs'));
    for (const result of checks) {
      if (!receiving()) return;
      if (result.status !== 'completed') continue;
      inputs.receive(task.id, {
        source: 'github',
        kind: 'check',
        nativeId: `check:${result.id}`,
        revision: `${result.completed_at}:${result.conclusion}`,
        author: 'GitHub Checks',
        checkConclusion: result.conclusion ?? undefined,
        url: result.html_url ?? undefined,
        head: task.head,
        body:
          `${result.name}: ${result.conclusion}\n${result.output.title ?? ''}\n` +
          (result.output.summary ?? ''),
      });
    }
    const statuses = z
      .array(status)
      .parse(await this.github.paged(`${root}/commits/${task.head}/statuses?per_page=100`));
    // GitHub lists newest first. Older failures superseded by success are historical evidence.
    const contexts = new Set<string>();
    for (const result of statuses) {
      if (!receiving()) return;
      if (contexts.has(result.context)) continue;
      contexts.add(result.context);
      if (result.state === 'pending') continue;
      inputs.receive(task.id, {
        source: 'github',
        kind: 'check',
        nativeId: `status:${result.id}`,
        revision: result.updated_at,
        author: 'GitHub Status',
        checkConclusion: result.state,
        url: result.target_url ?? undefined,
        head: task.head,
        body: `${result.context}: ${result.state}\n${result.description ?? ''}`,
      });
    }
  }

  private async checkPages(endpoint: string, field: string) {
    const items: unknown[] = [];
    for (let page = 1; ; page++) {
      const result = z
        .object({ total_count: z.number() })
        .catchall(z.unknown())
        .parse(await this.github.api(`${endpoint}?per_page=100&page=${page}`));
      const batch = z.array(z.unknown()).parse(result[field]);
      items.push(...batch);
      if (items.length >= result.total_count) return items;
      if (batch.length < 100) throw new Fault('GitHub 检查列表未完整读取', 502);
    }
  }

  async reply(id: string, retry = false) {
    const input = this.store.get('followUp', id);
    if (!input?.replyIssue || !input.disposition || input.reply?.status === 'sent') return;
    if (!retry && input.reply?.status !== 'pending') return;
    const task = this.store.task(input.taskId);
    if (input.disposition.action === 'rework' && task.stage !== 'done') return;
    const repo = this.store.repo(task.repoId);
    if (!repo.authorized) throw new Fault('仓库尚未授权外部写入', 403);
    const marker = `<!-- phantom-followup:${id} -->`;
    const endpoint = `repos/${repo.github}/issues/${input.replyIssue}/comments`;
    const delivered = input.disposition.action === 'rework';
    const pr = taskDeliveryPR(task);
    const body =
      `${
        delivered
          ? `已完成：${task.title}\n` +
            (pr ? `https://github.com/${repo.github}/pull/${pr}\n\n` : '')
          : ''
      }` + `${input.disposition.reason}\n\n${marker}`;
    const lookup = async () => {
      const user = z.object({ id: z.number() }).parse(await this.github.api('user'));
      const matches = (await this.github.paged(`${endpoint}?per_page=100`)).filter(
        (comment) => typeof comment.body === 'string' && comment.body.includes(marker),
      );
      if (matches.length > 1 || matches.some((x) => x.body !== body || x.user?.id !== user.id))
        throw new Fault('原平台回复的身份或正文存在歧义，保留待核对状态', 409);
      return matches[0] as { html_url: string } | undefined;
    };
    try {
      if (retry) {
        const observed = this.store.get('operation', `followup-reply:${id}`);
        const remote = await lookup();
        const current = this.store.get('operation', `followup-reply:${id}`);
        if (
          !remote &&
          current &&
          observed &&
          current.status === observed.status &&
          current.attempt === observed.attempt &&
          current.error === observed.error &&
          ['pending', 'uncertain'].includes(current.status)
        )
          this.store.put('operation', current.id, {
            ...current,
            reconciliation: {
              id: `followup:${id}:${current.attempt ?? 0}`,
              verdict: 'absent',
              actor: 'user',
              observedOperation: {
                status: current.status,
                attempt: current.attempt ?? 0,
                error: current.error,
              },
              taskRevision: id,
              evidence: '原讨论所有评论已核对，未找到本次回复',
              at: now(),
            },
          });
      }
      const result = await this.github.operation(
        `followup-reply:${id}`,
        'followup-reply',
        lookup,
        () =>
          this.github.api<{ html_url: string }>(endpoint, 'POST', {
            body,
          }),
        id,
      );
      this.store.put('followUp', id, {
        ...input,
        status: delivered ? 'resolved' : input.status,
        reply: { status: 'sent', url: result.html_url },
      });
      this.store.event('feedback', '后续反馈的回复已送达原平台', {
        taskId: task.id,
        projectId: task.projectId,
      });
    } catch (error) {
      this.store.put('followUp', id, {
        ...input,
        reply: { status: 'uncertain', error: redact(String(error)) },
      });
      this.store.event('feedback', '后续反馈的原平台回复需要核对', {
        taskId: task.id,
        projectId: task.projectId,
      });
    }
  }
}
