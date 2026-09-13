import { command } from './process.ts';
import { Fault, Store, now, redact } from './store.ts';
import type { Operation, Reconciliation, Repo, Task, ReviewResult } from '../shared/types.ts';

export interface PullState {
  number: number;
  html_url: string;
  state: string;
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  head: { sha: string };
  base: { sha: string };
  body: string;
}
export class IssueBodyConflict extends Fault {
  constructor() {
    super('GitHub Issue 正文发生变化，完成同步暂停，需要 PM 核对', 409);
  }
}
export class GitHubRejected extends Fault {}
export function isTransientGitHubError(error: unknown): boolean {
  const message = String(error);
  return (
    /gh \(\d+\):/.test(message) &&
    /HTTP 50[234]\b|Something went wrong while executing your query|unexpected end of JSON input/i.test(
      message,
    )
  );
}
export class GitHub {
  private operations = new Map<string, Promise<unknown>>();
  constructor(private store: Store) {}
  async api<T = any>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
    const r = await command(
      'gh',
      ['api', endpoint, '--method', method, ...(body === undefined ? [] : ['--input', '-'])],
      undefined,
      body === undefined ? undefined : JSON.stringify(body),
    ).catch((error: unknown) => {
      // gh reports explicit HTTP rejections in stderr. Transport failures remain uncertain.
      if (
        error instanceof Error &&
        /\(HTTP (400|401|403|404|405|409|410|422|429)\)/.test(error.message)
      )
        throw new GitHubRejected(error.message, 502);
      const operation =
        endpoint === 'graphql'
          ? `GraphQL ${/^\s*mutation\b/.test((body as { query?: string })?.query ?? '') ? 'mutation' : 'query'}`
          : `${method} ${endpoint}`;
      throw new Error(`GitHub ${operation}: ${redact(String(error))}`, { cause: error });
    });
    return r.stdout.trim() ? JSON.parse(r.stdout) : (undefined as T);
  }
  async gql<T = any>(query: string, variables: unknown = {}): Promise<T> {
    const result = await this.api<any>('graphql', 'POST', { query, variables });
    if (result.errors?.length)
      throw new Fault(result.errors.map((x: any) => x.message).join('; '), 502);
    return result.data;
  }
  async identity() {
    const user = await this.api('user');
    return { login: user.login, url: user.html_url };
  }
  async inspect(slug: string) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Fault('GitHub 仓库格式应为 owner/repo');
    const r = await this.api(`repos/${slug}`);
    if (!r.permissions?.push) throw new Fault('当前 GitHub 身份没有仓库写权限', 403);
    return { name: r.name, defaultBranch: r.default_branch, private: r.private, url: r.html_url };
  }
  private authorize(repo: Repo) {
    if (!this.store.repo(repo.id).authorized) throw new Fault('仓库尚未授权外部写入', 403);
  }
  async operation<T>(
    key: string,
    kind: string,
    lookup: () => Promise<T | undefined>,
    write: () => Promise<T>,
  ): Promise<T> {
    const active = this.operations.get(key);
    if (active) return active as Promise<T>;
    const promise = this.performOperation(key, kind, lookup, write);
    this.operations.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.operations.get(key) === promise) this.operations.delete(key);
    }
  }
  private async performOperation<T>(
    key: string,
    kind: string,
    lookup: () => Promise<T | undefined>,
    write: () => Promise<T>,
  ): Promise<T> {
    const old = this.store.get('operation', key);
    if (old?.status === 'done') return old.result as T;
    // A read that cannot answer - transport failure, partial JSON, pagination error - throws
    // and never counts as proof that the remote object is missing.
    const existing = await lookup();
    if (existing !== undefined) {
      this.store.put('operation', key, { id: key, kind, status: 'done', result: existing });
      return existing;
    }
    if (old?.status === 'uncertain' || old?.status === 'pending') {
      const authorization = old.reconciliation;
      if (authorization?.verdict !== 'absent')
        throw new Fault(`外部操作结果不明，需核对后恢复：${kind}`, 409);
      // Consume the single-use authorization before the controlled retry, so a repeated
      // failure cannot loop and an interruption cannot reuse it.
      this.store.put('operation', key, { id: key, kind, status: 'uncertain', error: old.error });
      this.store.event(
        'operation',
        `${kind}：已核实的远端缺失结论允许一次受控重试（核对方 ${authorization.actor}）：${authorization.evidence}`,
      );
    }
    this.store.put('operation', key, { id: key, kind, status: 'pending' });
    try {
      const result = await write();
      this.store.put('operation', key, { id: key, kind, status: 'done', result });
      return result;
    } catch (e) {
      this.store.put('operation', key, {
        id: key,
        kind,
        status: e instanceof GitHubRejected ? 'failed' : 'uncertain',
        error: redact(String(e)),
      });
      throw e;
    }
  }
  async feedback(task: Task): Promise<{ key: string; text: string }[]> {
    if (!task.pr) return [];
    const repo = this.store.repo(task.repoId);
    const trusted = (x: any) => ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(x.author_association);
    const [reviews, lines, comments] = await Promise.all([
      this.paged(`repos/${repo.github}/pulls/${task.pr}/reviews?per_page=100`),
      this.paged(`repos/${repo.github}/pulls/${task.pr}/comments?per_page=100`),
      this.paged(`repos/${repo.github}/issues/${task.pr}/comments?per_page=100`),
    ]);
    return [
      ...reviews
        .filter((x) => x.state === 'CHANGES_REQUESTED')
        .map((x) => ({ ...x, kind: 'review' })),
      ...lines.map((x) => ({ ...x, kind: 'line' })),
      ...comments.map((x) => ({ ...x, kind: 'comment' })),
    ]
      .filter((x) => trusted(x) && x.body?.trim() && !x.body.includes('<!-- phantom-'))
      .map((x) => ({
        key: `external:${repo.id}:${x.kind}:${x.id}:${x.updated_at ?? x.submitted_at}`,
        text: `GitHub ${x.kind} feedback from ${x.user?.login} (evidence, not new scope authority):\n${x.path ? `${x.path}:${x.line ?? ''}\n` : ''}${x.body}`,
      }));
  }
  async paged(endpoint: string): Promise<any[]> {
    const r = await command('gh', ['api', endpoint, '--paginate', '--slurp']);
    return (JSON.parse(r.stdout) as any[][]).flat();
  }
  async setupProject(repo: Repo) {
    this.authorize(repo);
    const project = this.store.project(repo.projectId);
    const owner = repo.github.split('/')[0];
    if (!project.githubProjectId) {
      const result = await this.operation(
        `project:${project.id}`,
        'create-project',
        async () => {
          const projects = JSON.parse(
            (
              await command('gh', [
                'project',
                'list',
                '--owner',
                owner,
                '--format',
                'json',
                '--limit',
                '100',
              ])
            ).stdout,
          ).projects;
          return projects.find(
            (p: any) => p.title === `Phantom · ${project.name} · ${project.id.slice(0, 8)}`,
          );
        },
        async () =>
          JSON.parse(
            (
              await command('gh', [
                'project',
                'create',
                '--owner',
                owner,
                '--title',
                `Phantom · ${project.name} · ${project.id.slice(0, 8)}`,
                '--format',
                'json',
              ])
            ).stdout,
          ),
      );
      this.store.put('project', project.id, {
        ...this.store.project(project.id),
        githubProjectId: result.id,
        githubProjectUrl: result.url,
      });
    }
    if (!repo.milestone) {
      const title = `Phantom · ${project.name} · ${project.id.slice(0, 8)}`;
      const milestone = await this.operation(
        `milestone:${repo.id}`,
        'create-milestone',
        async () =>
          (await this.paged(`repos/${repo.github}/milestones?state=all&per_page=100`)).find(
            (x) => x.title === title,
          ),
        () =>
          this.api(`repos/${repo.github}/milestones`, 'POST', {
            title,
            description: 'Managed by Phantom Circuit',
          }),
      );
      this.store.patchRepo(repo.id, { milestone: milestone.number });
    }
  }
  async publishIssue(task: Task) {
    const repo = this.store.repo(task.repoId);
    this.authorize(repo);
    await this.setupProject(repo);
    for (const key of task.dependencies) {
      const dependency = this.store.task(key);
      if (!dependency.issueDatabaseId) await this.publishIssue(dependency);
    }
    await this.operation(
      `label:${repo.id}:ready`,
      'create-label',
      async () =>
        (await this.paged(`repos/${repo.github}/labels?per_page=100`)).find(
          (x) => x.name === 'ready-for-agent',
        ),
      () =>
        this.api(`repos/${repo.github}/labels`, 'POST', {
          name: 'ready-for-agent',
          color: '9bc7a7',
          description:
            'Prepared for a delegated agent; host authorization and work switches still apply.',
        }),
    );
    const marker = `<!-- phantom-task:${task.id} -->`;
    const body = this.issueBody(task, false);
    const issue = await this.operation(
      `issue:${task.id}`,
      'create-issue',
      async () =>
        (await this.paged(`repos/${repo.github}/issues?state=all&per_page=100`)).find(
          (x) => !x.pull_request && x.body?.includes(marker),
        ),
      () =>
        this.api(`repos/${repo.github}/issues`, 'POST', {
          title: task.title,
          body,
          milestone: this.store.repo(repo.id).milestone,
          labels: ['ready-for-agent'],
        }),
    );
    this.store.updateTask(task.id, {
      issue: issue.number,
      issueUrl: issue.html_url,
      issueNodeId: issue.node_id,
      issueDatabaseId: issue.id,
      issueBody: issue.body,
    });
    for (const key of task.dependencies) {
      const dep = this.store.task(key);
      const endpoint = `repos/${repo.github}/issues/${issue.number}/dependencies/blocked_by`;
      await this.operation(
        `dependency:${task.id}:${key}`,
        'link-dependency',
        async () =>
          (await this.paged(`${endpoint}?per_page=100`)).find((x) => x.id === dep.issueDatabaseId),
        () => this.api(endpoint, 'POST', { issue_id: dep.issueDatabaseId }),
      );
    }
    const p = this.store.project(repo.projectId);
    if (p.githubProjectId && !task.projectItemId) {
      // addProjectV2ItemById returns the existing item when content is already attached.
      const data = await this.gql(
        'mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}',
        { p: p.githubProjectId, c: issue.node_id },
      );
      this.store.updateTask(task.id, { projectItemId: data.addProjectV2ItemById.item.id });
    }
    return issue;
  }
  /** Operations of one kind whose remote outcome is still unknown to this host. */
  unresolved(kind: string): Operation[] {
    return this.store
      .list('operation')
      .filter((x) => x.kind === kind && ['uncertain', 'pending'].includes(x.status));
  }
  /**
   * Record a durable, single-use authorization to retry a creation whose remote object an
   * explicit coordination step proved absent. Only host coordination paths call this; the
   * adapter's own lookups never do, so an unresolved outcome is never blindly repeated.
   */
  reconcileAbsent(key: string, input: { actor: Reconciliation['actor']; evidence: string }) {
    const old = this.store.get('operation', key);
    if (!old) throw new Fault('需要核对的外部操作不存在', 404);
    if (old.status === 'done') throw new Fault('外部操作已有结果，不需要重新创建', 409);
    if (old.status !== 'uncertain' && old.status !== 'pending')
      throw new Fault('外部操作已被明确拒绝，可直接重试', 409);
    const reconciliation: Reconciliation = {
      verdict: 'absent',
      actor: input.actor,
      evidence: redact(input.evidence).slice(0, 500),
      at: now(),
    };
    this.store.put('operation', key, { ...old, reconciliation });
    return this.store.get('operation', key)!;
  }
  /** Authoritative read of this task's PR, matched by the Phantom marker on the task branch. */
  async findTaskPR(task: Task): Promise<PullState | undefined> {
    const repo = this.store.repo(task.repoId);
    const owner = repo.github.split('/')[0];
    return (
      await this.paged(
        `repos/${repo.github}/pulls?state=all&head=${encodeURIComponent(`${owner}:${task.branch}`)}&per_page=100`,
      )
    ).find((x: PullState) => x.body?.includes(`<!-- phantom-task:${task.id} -->`));
  }
  async unresolvedTaskPR(task: Task): Promise<Operation | undefined> {
    return this.unresolved('create-pr').find((x) => x.id === `pr:${task.id}`);
  }
  /**
   * Explicit host coordination for an unresolved create-pr. The host re-reads the remote task
   * branch across all PR states and authorizes exactly one controlled retry only when that read
   * proves the marker-bearing PR was never created. An unreadable or failing read authorizes
   * nothing, and a PR that does exist is left for the normal lookup to adopt.
   */
  async authorizeTaskPRRetry(task: Task, actor: Reconciliation['actor']): Promise<boolean> {
    const operation = await this.unresolvedTaskPR(task);
    if (!operation) return false;
    const repo = this.store.repo(task.repoId);
    if ((await this.findTaskPR(task)) !== undefined) return false;
    this.reconcileAbsent(operation.id, {
      actor,
      evidence: `恢复核对：${repo.github} 全部状态的 PR 查询未发现 <!-- phantom-task:${task.id} -->，任务分支 ${task.branch}；上次记录 ${operation.error ?? '无'}`,
    });
    return true;
  }
  async publishPR(task: Task): Promise<PullState> {
    const repo = this.store.repo(task.repoId);
    this.authorize(repo);
    const marker = `<!-- phantom-task:${task.id} -->`;
    const evidence = task.tests.map((t) => `- ${t.command}: exit ${t.exitCode}`).join('\n');
    const result = await this.operation(
      `pr:${task.id}`,
      'create-pr',
      () => this.findTaskPR(task),
      () =>
        this.api(`repos/${repo.github}/pulls`, 'POST', {
          title: task.title,
          head: task.branch,
          base: repo.defaultBranch,
          body: `${marker}\n${task.spec}\n\n## Validation\n${evidence}\n\nCloses #${task.issue}`,
        }),
    );
    this.store.updateTask(task.id, { pr: result.number, prUrl: result.html_url });
    return result;
  }
  async reviseIssue(task: Task) {
    const repo = this.store.repo(task.repoId);
    this.authorize(repo);
    const endpoint = `repos/${repo.github}/issues/${task.issue}`;
    const body = this.issueBody(task, false);
    const result = await this.operation(
      `revise-issue:${task.id}:${task.sourceMessageId}`,
      'revise-issue',
      async () => {
        const issue = await this.api(endpoint);
        return issue.body === body ? issue : undefined;
      },
      () => this.api(endpoint, 'PATCH', { body }),
    );
    this.store.updateTask(task.id, { issueBody: result.body });
    return result;
  }
  private issueBody(task: Task, completed: boolean) {
    const deps = task.dependencies.map((key) => {
      const dependency = this.store.task(key);
      return `- ${dependency.issueUrl ?? dependency.title}`;
    });
    return `<!-- phantom-task:${task.id} -->\n## What to build\n${task.spec}\n\n## Acceptance criteria\n${task.acceptance.map((x) => `- [${completed ? 'x' : ' '}] ${x}`).join('\n')}\n\n## Blocked by\n${deps.join('\n') || 'None (can start immediately)'}\n`;
  }
  async completeIssue(task: Task) {
    const repo = this.store.repo(task.repoId);
    this.authorize(repo);
    if (!task.issue || !task.issueBody?.startsWith(`<!-- phantom-task:${task.id} -->`))
      throw new Fault('Issue 缺少 Phantom 正文归属记录，需要 PM 核对', 409);
    const endpoint = `repos/${repo.github}/issues/${task.issue}`;
    const body = this.issueBody(task, true);
    const key = `complete-issue:${task.id}:${task.head}:${task.base}`;
    const current = await this.api(endpoint);
    if (current.body !== body && current.body !== task.issueBody) throw new IssueBodyConflict();
    if (
      this.store.get('operation', key)?.status === 'done' &&
      (current.body !== body || current.state !== 'closed')
    )
      throw new IssueBodyConflict();
    const result = await this.operation(
      key,
      'complete-issue',
      async () => {
        const issue = await this.api(endpoint);
        if (issue.body !== body && issue.body !== task.issueBody) throw new IssueBodyConflict();
        return issue.body === body && issue.state === 'closed' ? issue : undefined;
      },
      async () => {
        const issue = await this.api(endpoint, 'PATCH', {
          body,
          state: 'closed',
          state_reason: 'completed',
        });
        if (issue.body !== body || issue.state !== 'closed')
          throw new Fault('GitHub 尚未确认 Issue 已勾选并关闭', 409);
        return issue;
      },
    );
    this.store.updateTask(task.id, { issueBody: result.body });
    return result;
  }
  async pull(task: Task): Promise<PullState> {
    return this.api(`repos/${this.store.repo(task.repoId).github}/pulls/${task.pr}`);
  }
  async reviewComment(task: Task, review: ReviewResult) {
    const repo = this.store.repo(task.repoId);
    this.authorize(repo);
    const marker = `<!-- phantom-review:${task.id}:${review.head}:${review.base}:${review.axis} -->`;
    return this.operation(
      `review:${task.id}:${review.head}:${review.base}:${review.axis}`,
      'review-comment',
      async () =>
        (await this.paged(`repos/${repo.github}/issues/${task.pr}/comments?per_page=100`)).find(
          (x) => x.body?.includes(marker),
        ),
      () =>
        this.api(`repos/${repo.github}/issues/${task.pr}/comments`, 'POST', {
          body: `${marker}\n## ${review.axis === 'standards' ? 'Standards' : 'Spec'}\n${review.approved ? 'Pass' : 'Changes requested'}\n\n${review.summary}\n${review.findings.map((x) => `- ${x}`).join('\n')}\n\nReviewed head: ${review.head}; base: ${review.base}. AI review evidence; not a GitHub approval.`,
        }),
    );
  }
  async checks(task: Task): Promise<{ ready: boolean; reason?: string }> {
    const repo = this.store.repo(task.repoId);
    const [checks, status] = await Promise.all([
      this.api(`repos/${repo.github}/commits/${task.head}/check-runs?per_page=100`),
      this.api(`repos/${repo.github}/commits/${task.head}/status`),
    ]);
    const entries = [
      ...checks.check_runs.map((x: any) => ({
        name: x.name,
        ok: x.status === 'completed' && ['success', 'neutral', 'skipped'].includes(x.conclusion),
      })),
      ...status.statuses.map((x: any) => ({ name: x.context, ok: x.state === 'success' })),
    ];
    for (const name of repo.requiredChecks)
      if (!entries.some((x) => x.name === name && x.ok))
        return { ready: false, reason: `等待检查：${name}` };
    if (entries.some((x) => !x.ok)) return { ready: false, reason: 'GitHub 检查尚未全部通过' };
    return { ready: true };
  }
  async merge(task: Task) {
    const repo = this.store.repo(task.repoId);
    this.authorize(repo);
    const pr = await this.pull(task);
    if (pr.merged) return pr;
    if (pr.head.sha !== task.head || pr.base.sha !== task.base)
      throw new Fault('PR 版本发生变化，需要重新评审', 409);
    if (pr.mergeable !== true || pr.mergeable_state === 'blocked')
      throw new Fault('PR 有冲突、保护规则限制或状态尚未就绪', 409);
    const checks = await this.checks(task);
    if (!checks.ready) throw new Fault(checks.reason!, 409);
    return this.operation(
      `merge:${task.id}:${task.head}`,
      'merge-pr',
      async () => {
        const x = await this.pull(task);
        return x.merged ? x : undefined;
      },
      async () => {
        const response = await this.api(`repos/${repo.github}/pulls/${task.pr}/merge`, 'PUT', {
          sha: task.head,
          merge_method: 'squash',
        });
        if (!response.merged) throw new Fault(response.message ?? 'GitHub 未完成合并', 409);
        const x = await this.pull(task);
        if (!x.merged) throw new Fault('尚未确认合并结果', 409);
        return x;
      },
    );
  }
  async syncStatus(task: Task) {
    const repo = this.store.repo(task.repoId);
    if (!repo.authorized) return;
    const p = this.store.project(repo.projectId);
    if (!p.githubProjectId || !task.projectItemId) return;
    const data = await this.gql(
      'query($id:ID!){node(id:$id){... on ProjectV2{fields(first:50){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}}}',
      { id: p.githubProjectId },
    );
    const field = data.node.fields.nodes.find((f: any) => f.name === 'Status');
    if (!field) return;
    const names =
      task.stage === 'done'
        ? ['Done', '已完成']
        : ['ready', 'clarifying'].includes(task.stage)
          ? ['Todo', '待办']
          : ['In Progress', 'In progress', '进行中'];
    const option = field.options.find((o: any) => names.includes(o.name));
    if (!option) throw new Fault('Project Status 选项缺失，请配置 Todo / In Progress / Done');
    await this.gql(
      'mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}',
      { p: p.githubProjectId, i: task.projectItemId, f: field.id, o: option.id },
    );
  }
}
