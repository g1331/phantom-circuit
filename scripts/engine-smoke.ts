import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { command } from '../src/server/process.ts';
import { Store } from '../src/server/store.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { GitHub, type PullState } from '../src/server/github.ts';
import { Engine, mergeReady } from '../src/server/engine.ts';
import { bootstrapAgentSettings } from '../src/server/agent-settings.ts';
import type { Repo, ReviewResult, Task } from '../src/shared/types.ts';

/**
 * Metered, local-boundary acceptance check for the real OMP Engine path.
 *
 * The only GitHub implementation used here is LocalGitHub below. Its writes are durable Store
 * operations and fast-forward a temporary bare repository; no `gh` process or network endpoint
 * is reachable from this script. The OMP model calls themselves are intentionally real.
 */

const TASK_WALL_MS = 15 * 60 * 1000;
const WAIT_MS = 500;

type LocalIssue = {
  number: number;
  id: number;
  node_id: string;
  html_url: string;
  state: 'open' | 'closed';
  body: string;
};

class LocalGitHub extends GitHub {
  private readonly issues = new Map<string, LocalIssue>();
  private readonly pulls = new Map<string, PullState>();
  private readonly comments = new Map<string, Record<string, unknown>>();
  private nextIssue = 1;
  private nextPull = 100;

  readonly hostWrites: string[] = [];
  readonly reviewAxes: string[] = [];
  readonly pmMergeAcceptanceCalls = 0;

  constructor(
    private readonly stateStore: Store,
    private readonly remoteDir: string,
  ) {
    super(stateStore);
  }

  override async setupProject(_repo: Repo) {
    // Projects, labels and milestones are local test concerns; there is no remote GitHub here.
  }

  private localIssueBody(task: Task, closed: boolean) {
    return [
      `<!-- phantom-task:${task.id} -->`,
      `# ${task.title}`,
      '',
      task.spec,
      '',
      '## Acceptance',
      ...task.acceptance.map((criterion) => `- [${closed ? 'x' : ' '}] ${criterion}`),
    ].join('\n');
  }

  override async publishIssue(task: Task) {
    const issue = await this.operation<LocalIssue | undefined>(
      `issue:${task.id}`,
      'create-local-issue',
      async () => this.issues.get(task.id),
      async () => {
        const value: LocalIssue = {
          number: this.nextIssue++,
          id: this.nextIssue * 10,
          node_id: `local-issue-${task.id}`,
          html_url: `local://issues/${this.nextIssue - 1}`,
          state: 'open',
          body: this.localIssueBody(task, false),
        };
        this.issues.set(task.id, value);
        this.hostWrites.push(`issue:${task.id}`);
        return value;
      },
    );
    assert.ok(issue, 'local issue creation must return an issue');
    this.stateStore.updateTask(task.id, {
      issue: issue.number,
      issueUrl: issue.html_url,
      issueNodeId: issue.node_id,
      issueDatabaseId: issue.id,
      issueBody: issue.body,
    });
    return issue;
  }

  override async publishPR(task: Task) {
    const pr = await this.operation<PullState | undefined>(
      `pr:${task.id}`,
      'create-local-pr',
      async () => this.pulls.get(task.id),
      async () => {
        assert.ok(task.head && task.base && task.branch, 'PR requires a pinned task revision');
        const repo = this.stateStore.repo(task.repoId);
        const value: PullState = {
          number: this.nextPull++,
          html_url: `local://pulls/${this.nextPull - 1}`,
          state: 'open',
          merged: false,
          mergeable: true,
          mergeable_state: 'clean',
          head: { sha: task.head, ref: task.branch, repo: { full_name: repo.github } },
          base: {
            sha: task.base,
            ref: repo.defaultBranch,
            repo: { full_name: repo.github },
          },
          body: `<!-- phantom-task:${task.id} -->\n${task.spec}`,
        };
        this.pulls.set(task.id, value);
        this.hostWrites.push(`pr:${task.id}`);
        return value;
      },
    );
    assert.ok(pr, 'local PR publication must return a PR');
    this.stateStore.updateTask(task.id, { pr: pr.number, prUrl: pr.html_url });
    return pr;
  }

  override async pull(task: Task): Promise<PullState> {
    const pr = this.pulls.get(task.id);
    if (!pr) throw new Error(`local PR missing for ${task.id}`);
    return structuredClone(pr);
  }

  override async checks(_task: Task) {
    return { ready: true };
  }

  override async feedback(_task: Task) {
    return [];
  }

  override async reviewComment(task: Task, review: ReviewResult) {
    assert.equal(review.head, task.head);
    assert.equal(review.base, task.base);
    const key = `review:${task.id}:${review.head}:${review.base}:${review.axis}`;
    const comment = await this.operation<Record<string, unknown> | undefined>(
      key,
      'local-review-comment',
      async () => this.comments.get(key),
      async () => {
        const value = {
          key,
          axis: review.axis,
          approved: review.approved,
          verdict: review.verdict,
          head: review.head,
          base: review.base,
        };
        this.comments.set(key, value);
        this.reviewAxes.push(review.axis);
        this.hostWrites.push(key);
        return value;
      },
    );
    assert.ok(comment, 'local review publication must return a durable comment');
    return comment;
  }

  override async merge(task: Task) {
    assert.equal(mergeReady(task), true, 'host merge must require complete local evidence');
    assert.ok(task.head && task.base && task.pr, 'host merge requires a pinned PR revision');
    const key = `merge:${task.id}:${task.head}`;
    const result = await this.operation<PullState | undefined>(
      key,
      'merge-local-pr',
      async () => {
        const current = this.pulls.get(task.id);
        return current?.merged ? current : undefined;
      },
      async () => {
        const repo = this.stateStore.repo(task.repoId);
        await command(
          'git',
          ['update-ref', `refs/heads/${repo.defaultBranch}`, task.head!, task.base!],
          this.remoteDir,
        );
        const current = this.pulls.get(task.id);
        assert.ok(current, 'local PR must remain present while merging');
        const merged: PullState = {
          ...current,
          state: 'closed',
          merged: true,
          mergeable: true,
          mergeable_state: 'clean',
        };
        this.pulls.set(task.id, merged);
        this.hostWrites.push(key);
        return merged;
      },
    );
    assert.ok(result?.merged, 'local bare repository merge must be observed');
    return result;
  }

  override async completeIssue(task: Task) {
    const issue = this.issues.get(task.id);
    assert.ok(issue, 'completion must find the published local issue');
    const key = `complete-issue:${task.id}:${task.head}:${task.base}`;
    const result = await this.operation<LocalIssue | undefined>(
      key,
      'complete-local-issue',
      async () => {
        const current = this.issues.get(task.id);
        return current?.state === 'closed' ? current : undefined;
      },
      async () => {
        const closed: LocalIssue = {
          ...issue,
          state: 'closed',
          body: this.localIssueBody(task, true),
        };
        this.issues.set(task.id, closed);
        this.hostWrites.push(key);
        return closed;
      },
    );
    assert.ok(result?.state === 'closed', 'local issue completion must be observed');
    this.stateStore.updateTask(task.id, { issueBody: result.body });
    return result;
  }

  override async syncStatus(_task: Task) {}

  async remoteDefaultBranch(repo: Repo) {
    return (
      await command('git', ['rev-parse', `refs/heads/${repo.defaultBranch}`], this.remoteDir)
    ).stdout.trim();
  }
}

async function delay(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function compactFailure(store: Store) {
  return {
    tasks: store.list('task').map((task) => ({
      id: task.id,
      title: task.title,
      stage: task.stage,
      control: task.control,
      blocked: task.blocked,
      head: task.head,
      base: task.base,
      reviews: task.reviews.map((review) => ({ axis: review.axis, verdict: review.verdict })),
      tests: task.tests.map((test) => ({ command: test.command, exitCode: test.exitCode })),
    })),
    runs: store.list('run').map((run) => ({
      id: run.id,
      role: run.role,
      status: run.status,
      profile: run.profile,
      agentKind: run.agentKind,
      model: run.modelIdentity,
      usage: run.usage,
      error: run.error?.slice(-600),
      diagnostic: run.diagnostic?.slice(-600),
    })),
    operations: store.list('operation').map((operation) => ({
      id: operation.id,
      kind: operation.kind,
      status: operation.status,
      attempt: operation.attempt,
    })),
  };
}

function usageTokens(
  usage: { totalTokens?: number; inputTokens?: number; outputTokens?: number } | undefined,
) {
  return (usage?.totalTokens ?? 0) + (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
}

async function runTask(engine: Engine, store: Store, taskId: string) {
  const deadline = Date.now() + TASK_WALL_MS;
  for (;;) {
    await engine.tick();
    const task = store.task(taskId);
    if (
      task.stage === 'done' &&
      task.completionDeliveryPending === false &&
      !store.activeRuns().some((run) => run.taskId === taskId)
    )
      return;
    if (task.blocked || (task.control === 'paused' && task.stage !== 'done'))
      throw new Error(`task blocked before completion: ${JSON.stringify(compactFailure(store))}`);
    if (Date.now() >= deadline)
      throw new Error(`task exceeded ${TASK_WALL_MS / 60000} minute wall bound`);
    await delay(WAIT_MS);
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'phantom-engine-smoke-'));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  const verify = [
    "const assert = require('node:assert/strict');",
    "const { execFileSync } = require('node:child_process');",
    "const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();",
    "if (branch.includes('/normal-')) assert.equal(require('./normal.cjs')(2, 3), 5);",
    "else if (branch.includes('/complex-')) assert.equal(require('./complex.cjs')(3, 4), 12);",
    'else throw new Error(`unexpected smoke branch: ${branch}`);',
  ].join('\n');
  await command('git', ['init', '--bare', remote]);
  await command('git', ['init', '-b', 'main', source]);
  const git = (args: string[]) => command('git', args, source);
  await git(['config', 'user.name', 'Phantom Engine Smoke']);
  await git(['config', 'user.email', 'engine-smoke@example.invalid']);
  await writeFile(join(source, 'normal.cjs'), 'module.exports = () => 0;\n');
  await writeFile(join(source, 'complex.cjs'), 'module.exports = () => 0;\n');
  await writeFile(join(source, 'verify.cjs'), verify + '\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Smoke fixture']);
  await git(['remote', 'add', 'origin', remote]);
  await git(['push', '-u', 'origin', 'main']);

  const store = new Store(join(root, 'state.sqlite'));
  const bootstrap = await bootstrapAgentSettings(store);
  assert.deepEqual(bootstrap.missing, [], 'installed OMP roles must be available');
  const project = store.createProject(
    'Real OMP Engine smoke',
    'Temporary local acceptance project',
  );
  store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'omp' });
  const configured = store.project(project.id);
  assert.equal(configured.ompProfiles?.backend?.providerId, 'deepseek');
  assert.equal(configured.ompProfiles?.backend?.model, 'deepseek-flash');
  assert.equal(configured.ompProfiles?.backend?.effort, 'high');
  assert.equal(configured.ompProfiles?.complex?.providerId, 'openai-codex');
  assert.equal(configured.ompProfiles?.complex?.model, 'gpt-5.6-sol');
  assert.equal(configured.ompProfiles?.review?.model, 'gpt-5.6-sol');
  assert.equal(configured.secondaryReviewProfiles?.omp?.model, 'gpt-6-astra');

  const repo = store.createRepo({
    projectId: project.id,
    name: 'local-source',
    path: source,
    github: 'local/source',
    defaultBranch: 'main',
    authorized: true,
  });
  store.patchRepo(repo.id, {
    enabled: true,
    commands: { install: '', build: '', test: 'node verify.cjs', start: '', port: 3000 },
  });

  const normalMessage = store.addMessage(
    project.id,
    'user',
    'Implement the normal smoke task.',
    'implement',
  );
  const normal = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: normalMessage.id,
    title: 'Normal add implementation',
    spec: 'In normal.cjs export a function that adds two numbers. The current implementation returns 0. Do not edit verify.cjs or other files. Review-only protocol (the Developer must ignore this paragraph): call submit_review with only approved, summary, findings and verdict; then finish the same turn with one JSON object containing approved, summary, findings, verdict, and the exact HEAD, BASE and Validation evidence copied verbatim from the review prompt.',
    acceptance: ['normal.cjs add(2, 3) returns 5'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
    changeType: 'feat',
    scope: 'normal',
    summaryEn: 'Implement normal add behavior',
  });
  store.updateMessage(normalMessage.id, { status: 'completed', draftStatus: 'completed' });

  const complexMessage = store.addMessage(
    project.id,
    'user',
    'Implement the complex high-risk smoke task.',
    'implement',
  );
  const complex = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: complexMessage.id,
    title: 'High risk multiply implementation',
    spec: 'In complex.cjs export a function that multiplies two numbers. The current implementation returns 0. Do not edit verify.cjs or other files. Review-only protocol (the Developer must ignore this paragraph): call submit_review with only approved, summary, findings and verdict; then finish the same turn with one JSON object containing approved, summary, findings, verdict, and the exact HEAD, BASE and Validation evidence copied verbatim from the review prompt.',
    acceptance: ['complex.cjs multiply(3, 4) returns 12'],
    dependencies: [],
    kind: 'backend',
    complexity: 'complex',
    priority: 1,
    changeType: 'feat',
    scope: 'complex',
    summaryEn: 'Implement high risk multiply behavior',
  });
  store.updateMessage(complexMessage.id, { status: 'completed', draftStatus: 'completed' });
  store.control(complex.id, 'pause');

  const workspaces = new Workspaces(join(root, 'workspaces'), store);
  const localGithub = new LocalGitHub(store, remote);
  const engine = new Engine(store, localGithub, workspaces, root);
  try {
    await engine.start();
    await runTask(engine, store, normal.id);
    const normalResult = store.task(normal.id);
    assert.equal(normalResult.stage, 'done');
    assert.equal(normalResult.reviews.length, 1, 'normal task must receive exactly one review');
    assert.deepEqual(localGithub.reviewAxes, ['primary']);
    assert.ok(usageTokens(normalResult.usage) > 0, 'normal task must persist OMP usage');
    const normalRemoteHead = await localGithub.remoteDefaultBranch(repo);
    assert.equal(normalRemoteHead, normalResult.head);

    store.control(complex.id, 'resume');
    await runTask(engine, store, complex.id);
    const complexResult = store.task(complex.id);
    assert.equal(complexResult.stage, 'done');
    assert.equal(
      complexResult.reviews.length,
      2,
      'complex task must receive primary and secondary reviews',
    );
    assert.deepEqual([...new Set(localGithub.reviewAxes)].sort(), ['primary', 'secondary']);
    assert.ok(usageTokens(complexResult.usage) > 0, 'complex task must persist OMP usage');
    const complexRemoteHead = await localGithub.remoteDefaultBranch(repo);

    const runs = store
      .list('run')
      .filter((run) => run.taskId === normal.id || run.taskId === complex.id);
    assert.equal(
      runs.some((run) => run.role === 'pm'),
      false,
      'merge must not call PM acceptance',
    );
    const normalDev = runs.find((run) => run.taskId === normal.id && run.role === 'dev');
    const normalReview = runs.find((run) => run.taskId === normal.id && run.role === 'review');
    const complexDev = runs.find((run) => run.taskId === complex.id && run.role === 'dev');
    const complexPrimary = runs.find(
      (run) => run.taskId === complex.id && run.role === 'review' && !run.secondaryReview,
    );
    const complexSecondary = runs.find(
      (run) => run.taskId === complex.id && run.role === 'review' && run.secondaryReview,
    );
    assert.equal(normalDev?.profileConfig?.model, 'deepseek-flash');
    assert.equal(normalReview?.profileConfig?.model, 'gpt-5.6-sol');
    assert.equal(complexDev?.profileConfig?.model, 'gpt-5.6-sol');
    assert.equal(complexPrimary?.profileConfig?.model, 'gpt-5.6-sol');
    assert.equal(complexSecondary?.profileConfig?.model, 'gpt-6-astra');
    assert.ok(runs.every((run) => run.agentKind === 'omp'));
    assert.ok(runs.every((run) => usageTokens(run.usage) > 0));

    assert.equal(normalRemoteHead, normalResult.head);
    assert.equal(complexRemoteHead, complexResult.head);
    const verifyAtMain = (await command('git', ['show', `refs/heads/main:verify.cjs`], remote))
      .stdout;
    assert.equal(verifyAtMain, verify + '\n', 'smoke model must not rewrite the host verification');
    assert.ok(localGithub.hostWrites.some((key) => key.startsWith('merge:')));
    assert.ok(localGithub.hostWrites.some((key) => key.startsWith('complete-issue:')));
    assert.equal(localGithub.pmMergeAcceptanceCalls, 0);
    console.log(
      JSON.stringify(
        {
          ok: true,
          root,
          agent: 'omp',
          tasks: [normalResult, complexResult].map((task) => ({
            id: task.id,
            stage: task.stage,
            head: task.head,
            base: task.base,
            reviews: task.reviews.map((review) => ({
              axis: review.axis,
              model: review.modelIdentity?.model,
            })),
            usage: task.usage,
          })),
          hostWrites: localGithub.hostWrites,
          remoteMain: complexRemoteHead,
          agentVersions: runs.map((run) => ({ role: run.role, version: run.agentVersion ?? null })),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    // Stop before printing evidence so any incident/diagnostic Run is observed after the paid
    // children have been aborted, while the temporary directory remains available for inspection.
    await engine.stop();
    console.error(
      JSON.stringify(
        { ok: false, root, error: String(error), evidence: compactFailure(store) },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await engine.stop();
    store.close();
  }
}

await main();
