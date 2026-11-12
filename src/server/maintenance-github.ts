import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Repo } from '../shared/types.ts';
import type { MaintenanceCandidate } from '../shared/maintenance.ts';
import { Fault, now } from './store.ts';

type Read = (endpoint: string) => Promise<unknown>;
const actor = z.object({ id: z.number().int().positive(), login: z.string(), type: z.string() });
const issue = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.url(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  state: z.string(),
  user: actor,
  assignees: z.array(z.object({ login: z.string() })),
  labels: z.array(z.object({ name: z.string() })),
  pull_request: z.unknown().optional(),
});
const run = z.object({
  id: z.number(),
  run_attempt: z.number(),
  workflow_id: z.number(),
  name: z.string(),
  html_url: z.url(),
  head_sha: z.string(),
  head_branch: z.string().nullable(),
  status: z.string(),
  conclusion: z.string().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  actor,
  pull_requests: z.array(z.object({ number: z.number() })),
});

async function pages<T>(read: Read, endpoint: string, schema: z.ZodType<T[]>) {
  const result: T[] = [];
  const started = Date.now();
  for (let page = 1; page <= 50; page++) {
    if (Date.now() - started > 120_000) throw new Fault('维护来源分页超时，结果不完整', 502);
    const separator = endpoint.includes('?') ? '&' : '?';
    const entries = schema.parse(await read(`${endpoint}${separator}per_page=100&page=${page}`));
    result.push(...entries);
    if (entries.length < 100) return result;
  }
  throw new Fault('维护来源达到分页上限，结果不完整', 502);
}

/** Elapsed-time facts are sampled by the source, never by a waiting assessment Run. */
export async function readMaintenanceCandidates(
  read: Read,
  repo: Repo,
  kinds: Set<'issue' | 'ci'>,
): Promise<MaintenanceCandidate[]> {
  const observedAt = now();
  const result: MaintenanceCandidate[] = [];
  function capture(
    value: Omit<
      MaintenanceCandidate,
      'id' | 'revision' | 'repoId' | 'projectId' | 'observedAt' | 'ageMinutes'
    >,
  ) {
    const revision = createHash('sha256').update(JSON.stringify(value.evidence)).digest('hex');
    result.push({
      ...value,
      revision,
      id: `${repo.id}:${value.kind}:${value.nativeId}:${revision}`,
      repoId: repo.id,
      projectId: repo.projectId,
      observedAt,
      ageMinutes: Math.max(0, (Date.parse(observedAt) - Date.parse(value.sourceAt)) / 60_000),
    });
  }
  if (kinds.has('issue')) {
    const issues = await pages(
      read,
      `repos/${repo.github}/issues?state=open&sort=created&direction=asc`,
      z.array(issue),
    );
    for (const item of issues) {
      if (item.pull_request !== undefined || item.state !== 'open' || item.assignees.length)
        continue;
      capture({
        kind: 'issue',
        nativeId: String(item.id),
        issue: item.number,
        title: item.title,
        body: item.body ?? '',
        url: item.html_url,
        sourceAt: item.updated_at,
        selectorValues: item.labels.map((label) => label.name),
        pullRequests: [],
        selfGenerated: item.user.type !== 'User' || /<!--\s*phantom[-:]/i.test(item.body ?? ''),
        evidence: item,
      });
    }
  }
  if (kinds.has('ci')) {
    const { default_branch: defaultBranch } = z
      .object({ default_branch: z.string().min(1) })
      .parse(await read(`repos/${repo.github}`));
    const workflows = await pages(
      read,
      `repos/${repo.github}/actions/workflows`,
      z
        .object({ workflows: z.array(z.object({ id: z.number() })) })
        .transform((value) => value.workflows),
    );
    for (const workflow of workflows) {
      // Read the newest run, including success/pending, instead of paging years of CI history.
      const response = z
        .object({ total_count: z.number().int().nonnegative(), workflow_runs: z.array(run) })
        .parse(
          await read(
            `repos/${repo.github}/actions/workflows/${workflow.id}/runs` +
              `?branch=${encodeURIComponent(defaultBranch)}&per_page=1`,
          ),
        );
      const item = response.workflow_runs[0];
      if (!item) {
        if (response.total_count) throw new Fault('默认分支 CI 最新结果缺失', 502);
        continue;
      }
      if (item.workflow_id !== workflow.id) throw new Fault('CI 工作流身份不一致', 502);
      if (
        item.head_branch !== defaultBranch ||
        item.status !== 'completed' ||
        !['failure', 'timed_out', 'action_required', 'startup_failure'].includes(
          item.conclusion ?? '',
        )
      )
        continue;
      const pulls = await pages(
        read,
        `repos/${repo.github}/commits/${encodeURIComponent(item.head_sha)}/pulls?state=all`,
        z.array(z.object({ number: z.number(), state: z.enum(['open', 'closed']) })),
      );
      capture({
        kind: 'ci',
        nativeId: String(item.id),
        title: item.name,
        body: `${item.name}: ${item.conclusion}`,
        url: item.html_url,
        sourceAt: item.updated_at,
        selectorValues: [item.name],
        head: item.head_sha,
        branch: item.head_branch,
        pullRequests: [
          ...new Set([
            ...item.pull_requests.map((pr) => pr.number),
            ...pulls.filter((pr) => pr.state === 'open').map((pr) => pr.number),
          ]),
        ],
        selfGenerated: item.actor.type !== 'User',
        evidence: { defaultBranch, run: item, pulls },
      });
    }
  }
  return result;
}
