import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { SourceActor, SourceInput, SourceReply } from '../shared/intake.ts';
import type { Repo } from '../shared/types.ts';
import { Fault } from './store.ts';

const actorSchema = z.object({
  databaseId: z.number().int().positive(),
  login: z.string().min(1),
  __typename: z.enum(['User', 'Bot', 'Organization', 'Mannequin']),
});
const issueSchema = z.object({
  id: z.string().min(1),
  databaseId: z.number().int().positive(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  url: z.url(),
  state: z.enum(['OPEN', 'CLOSED']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastEditedAt: z.iso.datetime().nullable(),
  author: actorSchema.nullable(),
  editor: actorSchema.nullable(),
});
const issueQuery = `query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    issue(number:$number) {
      id databaseId number title body url state createdAt updatedAt lastEditedAt
      author { login __typename ... on User { databaseId } ... on Bot { databaseId } }
      editor { login __typename ... on User { databaseId } ... on Bot { databaseId } }
    }
  }
}`;
export const sourceCommentSchema = z.object({
  id: z.number().int().positive(),
  body: z.string(),
  html_url: z.url(),
  user: z.object({ id: z.number().int().positive(), type: z.string(), login: z.string() }),
});
export type ObservedIssue = Omit<
  SourceInput,
  'id' | 'sourceId' | 'projectId' | 'repoId' | 'kind' | 'observedAt'
> & { databaseId: number };
type Read = (endpoint: string, method?: string, body?: unknown) => Promise<unknown>;
type Page = (endpoint: string) => Promise<unknown>;

export async function resolveActor(read: Read, login: string): Promise<SourceActor> {
  const account = z
    .object({ id: z.number().int().positive(), login: z.string().min(1), type: z.string() })
    .parse(await read(`users/${encodeURIComponent(login)}`));
  return {
    id: account.id,
    login: account.login,
    kind: account.type === 'User' ? 'user' : account.type === 'Bot' ? 'bot' : 'unknown',
  };
}

export async function readIssues(
  read: Read,
  readPage: Page,
  repo: Repo,
  since: string,
): Promise<ObservedIssue[]> {
  const [owner, name] = repo.github.split('/');
  const result = new Map<string, ObservedIssue>();
  const started = Date.now();
  for (let page = 1; page <= 100; page++) {
    if (Date.now() - started > 120_000) throw new Fault('GitHub 接收分页超时，结果不完整', 502);
    const entries = z
      .array(
        z.object({ number: z.number().int().positive(), pull_request: z.unknown().optional() }),
      )
      .parse(
        await readPage(
          `repos/${repo.github}/issues?state=all&sort=created&direction=asc` +
            `&since=${encodeURIComponent(since)}&per_page=20&page=${page}`,
        ),
      );
    for (const entry of entries) {
      if (entry.pull_request !== undefined) continue;
      const raw = await read('graphql', 'POST', {
        query: issueQuery,
        variables: { owner, name, number: entry.number },
      });
      const envelope = z
        .object({
          data: z.object({ repository: z.object({ issue: issueSchema }) }),
          errors: z.array(z.unknown()).optional(),
        })
        .parse(raw);
      if (envelope.errors?.length) throw new Fault('GitHub Issue 编辑者证据读取失败', 502);
      const issue = envelope.data.repository.issue;
      if (
        issue.number !== entry.number ||
        issue.url !== `https://github.com/${repo.github}/issues/${entry.number}`
      )
        throw new Fault('GitHub Issue 目标身份不一致', 502);
      if (!issue.author || (issue.lastEditedAt && !issue.editor))
        throw new Fault('GitHub Issue 作者或编辑者证据不可用', 502);
      const toActor = (actor: z.infer<typeof actorSchema>): SourceActor => ({
        id: actor.databaseId,
        login: actor.login,
        kind: actor.__typename === 'User' ? 'user' : actor.__typename === 'Bot' ? 'bot' : 'unknown',
      });
      const editor = issue.lastEditedAt ? issue.editor! : issue.author;
      const bodyUpdatedAt = issue.lastEditedAt ?? issue.createdAt;
      if (Date.parse(bodyUpdatedAt) < Date.parse(since)) continue;
      const revision = createHash('sha256').update(JSON.stringify(issue)).digest('hex');
      result.set(`${issue.id}:${revision}`, {
        nativeId: issue.id,
        databaseId: issue.databaseId,
        revision,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        url: issue.url,
        state: issue.state === 'OPEN' ? 'open' : 'closed',
        author: toActor(issue.author),
        actor: toActor(editor),
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        bodyUpdatedAt,
      });
    }
    if (entries.length < 20) return [...result.values()];
  }
  throw new Fault('GitHub 接收达到分页上限，来源健康状态未知；未推进读取起点', 502);
}

export async function findReply(read: Read, readPage: Page, repo: Repo, reply: SourceReply) {
  const matches: z.infer<typeof sourceCommentSchema>[] = [];
  const started = Date.now();
  const user = z.object({ id: z.number().int().positive() }).parse(await read('user'));
  for (let page = 1; page <= 500; page++) {
    if (Date.now() - started > 120_000) throw new Fault('回复核对分页超时，不能确认不存在', 502);
    const comments = z
      .array(sourceCommentSchema)
      .parse(
        await readPage(
          `repos/${repo.github}/issues/${reply.issue}/comments?per_page=20&page=${page}`,
        ),
      );
    for (const comment of comments) {
      if (!comment.body.includes(`<!-- phantom-reply:${reply.id} -->`)) continue;
      if (comment.body !== reply.body || comment.user.id !== user.id)
        throw new Fault('远端回复标记或正文存在歧义，需核对', 409);
      matches.push(comment);
    }
    if (comments.length < 20) {
      if (matches.length > 1) throw new Fault('远端存在重复回复，不能自动采纳', 409);
      return matches[0];
    }
  }
  throw new Fault('回复核对未读完全部分页，不能确认不存在', 502);
}

export const replyBinding = (reply: SourceReply) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        id: reply.id,
        inputId: reply.inputId,
        repoId: reply.repoId,
        issue: reply.issue,
        purpose: reply.purpose,
        body: reply.body,
      }),
    )
    .digest('hex');
