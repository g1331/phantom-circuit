import { Fault, Store } from '../src/server/store.ts';
import { GitHub, type GhResult } from '../src/server/github.ts';
import type { Task } from '../src/shared/types.ts';

/**
 * A local fake GitHub that replaces only the `gh` process boundary. Everything above it - the
 * adapter's pagination, strict response parsing, candidate classification, operation bookkeeping
 * and reconciliation - is the real implementation under test. No test in this suite talks to
 * github.com or performs a remote write.
 */
/**
 * The "Pull Request Simple" shape that GitHub's *listing* endpoints return. It deliberately
 * carries `merged_at` and not `merged`: only the single-PR endpoint returns `merged`, so a fake
 * that supplied it would let a listing bug pass unnoticed.
 */
export interface FakePull {
  number: number;
  html_url: string;
  state: string;
  merged_at: string | null;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string; repo: { full_name: string } | null };
  body: string;
}

export function pullFixture(input: {
  number: number;
  slug: string;
  branch: string;
  body?: string;
  marker?: string;
  state?: string;
  merged?: boolean;
  headRepo?: string | null;
  headRef?: string;
  baseRepo?: string;
  baseRef?: string;
  headSha?: string;
  baseSha?: string;
}): FakePull {
  return {
    number: input.number,
    html_url: `https://github.com/${input.slug}/pull/${input.number}`,
    state: input.state ?? 'open',
    merged_at: input.merged ? '2026-09-13T00:00:00Z' : null,
    head: {
      sha: input.headSha ?? 'head',
      ref: input.headRef ?? input.branch,
      repo: input.headRepo === null ? null : { full_name: input.headRepo ?? input.slug },
    },
    base: {
      sha: input.baseSha ?? 'base',
      ref: input.baseRef ?? 'main',
      repo: { full_name: input.baseRepo ?? input.slug },
    },
    body: input.body ?? (input.marker ? `${input.marker}\nSpec\n` : 'Whitespace only\n'),
  };
}

export class FakeGitHub extends GitHub {
  /** PRs the fake remote holds; tests mutate this to model the real remote changing. */
  pulls: FakePull[] = [];
  /** Creation attempts the adapter POSTed, whether or not the remote accepted them. */
  posted: Record<string, any>[] = [];
  /** Pagination page size; a small value forces a candidate onto a later page. */
  pageSize = 100;
  /** Thrown by every read, modelling a transport or permissions failure. */
  failRead: Error | undefined;
  /** Thrown only by the branch-scoped query, leaving the repository query successful. */
  failBranchRead: Error | undefined;
  /** Raw stdout for reads, so a test can model a malformed or truncated response. */
  readBody: ((endpoint: string) => string) | undefined;
  /** Awaited inside every read, so a test can interleave work with an in-flight verification. */
  readGate: Promise<void> | undefined;
  /** Thrown before the creation is applied, modelling a request the remote never accepted. */
  failWrite: Error | undefined;
  /** Apply the creation, then fail - modelling a response lost after the remote committed it. */
  loseWriteResponse = false;
  reads = 0;
  /** Creations the remote actually applied. */
  writes = 0;

  override async gh(args: string[], input?: string): Promise<GhResult> {
    const endpoint = args[1];
    const declared = args.indexOf('--method');
    const method = declared === -1 ? 'GET' : args[declared + 1];
    if (method === 'POST' && /\/pulls$/.test(endpoint)) return this.create(input);
    if (method !== 'GET') throw new Fault(`fake gh: unsupported ${method} ${endpoint}`, 502);
    this.reads++;
    if (this.readGate) await this.readGate;
    if (this.failRead) throw this.failRead;
    if (/\/issues\/\d+$/.test(endpoint))
      return {
        stdout: JSON.stringify({
          number: Number(endpoint.split('/').pop()),
          state: 'open',
          body: '',
        }),
        stderr: '',
        code: 0,
      };
    if (/[?&]head=/.test(endpoint) && this.failBranchRead) throw this.failBranchRead;
    if (!/\/pulls\?/.test(endpoint)) throw new Fault(`fake gh: unsupported read ${endpoint}`, 502);
    if (this.readBody) return { stdout: this.readBody(endpoint), stderr: '', code: 0 };
    return { stdout: JSON.stringify(this.pages(this.matching(endpoint))), stderr: '', code: 0 };
  }

  private create(input?: string): GhResult {
    const body = JSON.parse(input ?? '{}');
    this.posted.push(body);
    if (this.failWrite) throw this.failWrite;
    this.writes++;
    const pull = pullFixture({
      number: 41,
      slug: 'example/repo',
      branch: body.head,
      baseRef: body.base,
      body: body.body,
      headRef: body.head,
      headSha: body.head === 'phantom/task' ? 'head' : 'other',
      baseSha: 'base',
    });
    this.pulls.push(pull);
    if (this.loseWriteResponse) throw new Error('gh (1): unexpected end of JSON input');
    // Creation answers with the single-PR resource, which is the shape that does carry `merged`.
    return {
      stdout: JSON.stringify({ ...pull, merged: false, mergeable: true, mergeable_state: 'clean' }),
      stderr: '',
      code: 0,
    };
  }

  /** GitHub's own `head=owner:branch` filter, applied to the fake's holdings. */
  private matching(endpoint: string) {
    const head = /[?&]head=([^&]*)/.exec(endpoint)?.[1];
    if (!head) return this.pulls;
    const [owner, branch] = decodeURIComponent(head).split(':');
    return this.pulls.filter(
      (pr) => pr.head.repo?.full_name?.split('/')[0] === owner && pr.head.ref === branch,
    );
  }

  private pages(items: FakePull[]) {
    const pages: FakePull[][] = [];
    for (let i = 0; i < items.length; i += this.pageSize)
      pages.push(items.slice(i, i + this.pageSize));
    return pages.length ? pages : [[]];
  }
}

/** Seed one adapter-level task on `example/repo` with a `phantom/task` branch. */
export function seedAdapterTask(store: Store) {
  const project = store.createProject('Publication', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'repo',
    path: '.',
    github: 'example/repo',
    authorized: true,
    defaultBranch: 'main',
  });
  const message = store.addMessage(project.id, 'user', 'Implement', 'implement');
  const task = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: message.id,
    title: 'Task',
    spec: 'Spec',
    acceptance: ['Criterion'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  const marker = `<!-- phantom-task:${task.id} -->`;
  store.updateTask(task.id, { branch: 'phantom/task', head: 'head', base: 'base' });
  return {
    store,
    repo,
    project,
    marker,
    task: (): Task => store.task(task.id),
    operation: () => store.get('operation', `pr:${task.id}`),
  };
}
