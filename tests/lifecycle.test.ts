import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { GitHub, type PullState } from '../src/server/github.ts';
import { Engine, mergeReady } from '../src/server/engine.ts';
import { Providers } from '../src/server/providers.ts';
import { Codex } from '../src/server/codex.ts';
import { command } from '../src/server/process.ts';
import type { Task, ReviewResult, Profile } from '../src/shared/types.ts';
import { devFixture, hang, until } from './dev-fixture.ts';

for (const role of ['dev', 'review'] as const) {
  test(`observing a merge aborts an active ${role} and ignores its late failure`, async () => {
    const f = await devFixture('phantom-active-external-merge-');
    const workspaces = new Workspaces(join(f.root, 'ws'), f.store);
    f.store.updateTask(f.task.id, { issue: 1, issueBody: 'body' });
    if (role === 'review') {
      const prepared = await workspaces.prepare(f.store.task(f.task.id));
      const head = await workspaces.git(prepared.worktree!, ['rev-parse', 'HEAD']);
      f.store.updateTask(f.task.id, {
        stage: 'reviewing',
        head,
        base: head,
        tests: [{ command: 'test', exitCode: 0, output: 'pass', head, at: 'now' }],
      });
    }
    let working = false;
    let sawAbort = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class Model extends Codex {
      override async start() {}
      override async stop() {
        release();
      }
      override async thread() {
        return `old-${role}`;
      }
      override async turn(
        _thread: string,
        _prompt: string,
        _profile: unknown,
        signal?: AbortSignal,
      ): Promise<string> {
        working = true;
        signal?.addEventListener(
          'abort',
          () => {
            sawAbort = true;
          },
          { once: true },
        );
        await gate;
        throw new Error('Late original worker failure');
      }
    }
    let merged = false;
    let writes = 0;
    class Remote extends GitHub {
      override async syncStatus() {}
      override async gh(args: string[], input?: string) {
        if (args[1] === 'graphql') {
          const query = JSON.parse(input!);
          assert.doesNotMatch(query.query, /mutation/);
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    number: 9,
                    closingIssuesReferences: {
                      nodes: [{ number: 1, repository: { nameWithOwner: 'fixture/source' } }],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                  issue: {
                    number: 1,
                    state: 'CLOSED',
                    stateReason: 'COMPLETED',
                    timelineItems: {
                      nodes: [
                        {
                          __typename: 'ClosedEvent',
                          createdAt: '2026-11-10T08:47:41Z',
                          closer: {
                            __typename: 'PullRequest',
                            number: 9,
                            repository: { nameWithOwner: 'fixture/source' },
                          },
                        },
                      ],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                },
              },
            }),
            stderr: '',
            code: 0,
          };
        }
        if (args[args.indexOf('--method') + 1] !== 'GET') {
          writes++;
          throw new Error('Remote writes forbidden');
        }
        const response = args[1].endsWith('/pulls/9')
          ? {
              number: 9,
              html_url: 'https://github.com/fixture/source/pull/9',
              state: 'closed',
              merged: true,
              merged_at: '2026-11-10T08:47:41Z',
              merge_commit_sha: 'd'.repeat(40),
              body: '',
              head: { sha: 'a'.repeat(40), ref: 'outside', repo: { full_name: 'fixture/source' } },
              base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'fixture/source' } },
            }
          : {
              body: 'body',
              state: merged ? 'closed' : 'open',
              state_reason: 'completed',
              closed_at: '2026-11-10T08:47:41Z',
            };
        return { stdout: JSON.stringify(response), stderr: '', code: 0 };
      }
    }
    const engine = new Engine(f.store, new Remote(f.store), workspaces, f.root, () => new Model());
    try {
      await engine.start();
      await engine.tick();
      await until(() => working, `${role} executing`);
      f.store.updateTask(f.task.id, { pr: 9 });
      const before = f.store.task(f.task.id);
      merged = true;
      await engine.sync();
      assert.equal(sawAbort, true, 'remote observation aborts the old engineering turn');
      const observed = f.store.task(f.task.id);
      assert.notEqual(observed.stage, 'done', 'settlement waits for the old worker callbacks');
      release();
      await until(() => !engine.active.size, 'old exception callbacks drained');
      await engine.stop();
      const after = f.store.task(f.task.id);
      for (const key of [
        'stage',
        'control',
        'pausedByUser',
        'head',
        'base',
        'devPhase',
        'ownerRunId',
        'devThreadId',
        'retries',
        'tests',
        'reviews',
        'blocked',
      ] as const)
        assert.deepEqual(after[key], before[key], `late callback preserves ${key}`);
      assert.deepEqual(after.remoteMerge, observed.remoteMerge);
      assert.equal(after.issueState, 'completed');
      assert.equal(f.store.list('incident').length, 0);
      assert.equal(f.store.list('run').length, 1);
      assert.equal(writes, 0);
      assert.equal(f.store.claimNext(), undefined);
      await engine.sync();
      assert.equal(f.store.task(f.task.id).stage, 'done');
      assert.equal(f.store.task(f.task.id).completion?.source, 'external');
      assert.equal(f.store.list('run').length, 1, 'settlement starts no model or retrospective');
      assert.equal(writes, 0);
    } finally {
      release();
      await engine.stop();
      f.store.close();
      await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
}

for (const scope of ['task', 'team'] as const)
  test(`${scope} pause remains authoritative after a running Dev stops`, async () => {
    const f = await devFixture('phantom-dev-user-pause-');
    let developing = false;
    class Model extends Codex {
      override async start() {}
      override async stop() {}
      override async thread() {
        return 'dev';
      }
      override async turn(
        _thread: string,
        _prompt: string,
        _profile: unknown,
        signal?: AbortSignal,
      ) {
        developing = true;
        return hang(signal);
      }
    }
    const engine = new Engine(
      f.store,
      f.github,
      new Workspaces(join(f.root, 'ws'), f.store),
      f.root,
      () => new Model(),
    );
    try {
      await engine.start();
      await engine.tick();
      await until(() => developing, 'Dev executing');
      if (scope === 'team') await engine.team(f.project.id, 'pause');
      else engine.control(f.task.id, 'pause', { source: 'user', reason: 'http_task_control' });
      await engine.stop();
      const task = f.store.task(f.task.id);
      assert.equal(task.control, 'paused');
      assert.equal(task.pausedByUser, true, 'Dev cancellation must preserve the user hold');
      assert.equal(task.blocked, undefined, 'intentional cancellation is not a delivery failure');
      assert.equal(f.store.list('incident').length, 0);
      assert.equal(f.store.list('run').find((run) => run.role === 'dev')?.status, 'paused');
      await assert.rejects(
        engine.resume(f.task.id, undefined, { source: 'pm', reason: 'resolve_task' }),
        /任务已暂停或结束/,
      );
    } finally {
      await engine.stop();
      f.store.close();
      await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

test('a resolved Dev failure stays resumed after the failed Run unwinds', async () => {
  const f = await devFixture('phantom-dev-incident-resume-');
  let assessed = false;
  let controlAtAssessment: Task['control'] | undefined;
  let blockerAtAssessment: string | undefined;
  class Model extends Codex {
    options?: Parameters<Codex['thread']>[0];
    override async start() {}
    override async stop() {}
    override async thread(options: Parameters<Codex['thread']>[0]) {
      this.options = options;
      return options.writable ? 'dev' : 'pm';
    }
    override async turn() {
      if (this.options!.writable) throw new Error('Transient developer transport failure');
      const task = f.store.task(f.task.id);
      controlAtAssessment = task.control;
      blockerAtAssessment = task.blocked;
      const incident = f.store.list('incident')[0];
      await this.options!.toolHandler!('resolve_incident', {
        incidentId: incident.id,
        action: 'resolved',
        guidance: 'Transport has recovered; retry the same implementation.',
      });
      assessed = true;
      return 'Resolved; work can continue.';
    }
  }
  const engine = new Engine(
    f.store,
    f.github,
    new Workspaces(join(f.root, 'ws'), f.store),
    f.root,
    () => new Model(),
  );
  try {
    await engine.start();
    await engine.tick();
    await until(() => assessed, 'PM resolved the Incident');
    await until(
      () => f.store.list('run').some((run) => run.role === 'pm' && run.status === 'completed'),
      'PM assessment completed',
    );
    await engine.stop();
    assert.equal(f.store.list('incident')[0].status, 'resolved');
    assert.equal(
      f.store.task(f.task.id).control,
      'active',
      'the failed Dev must not overwrite the later PM decision',
    );
    assert.equal(f.store.task(f.task.id).blocked, undefined);
    assert.equal(controlAtAssessment, 'paused', 'publish the blocker before requesting assessment');
    assert.match(blockerAtAssessment!, /Transient developer transport failure/);
    assert.deepEqual(
      f.store
        .taskEvents(f.task.id)
        .filter((event) => event.control)
        .map((event) => [event.control!.source, event.control!.action]),
      [
        ['host', 'pause'],
        ['pm', 'resume'],
      ],
    );
  } finally {
    await engine.stop();
    f.store.close();
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

for (const route of ['backend', 'frontend', 'fullstack', 'complex'] as const)
  test(`real worktrees complete ${route} through pinned Provider routing, review, rework and merge`, () =>
    completeLifecycle(route));

test('merged work with a user port interruption produces an adoptable instruction suggestion', () =>
  completeLifecycle('backend', true));

async function completeLifecycle(
  route: 'backend' | 'frontend' | 'fullstack' | 'complex',
  retrospective = false,
) {
  const root = await mkdtemp(join(tmpdir(), 'phantom-lifecycle-'));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  await command('git', ['init', '--bare', remote]);
  await command('git', ['init', '-b', 'main', source]);
  const git = (args: string[]) => command('git', args, source);
  await git(['config', 'user.name', 'Phantom Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(source, 'sum.cjs'), 'module.exports=(a,b)=>0;\n');
  await writeFile(
    join(source, 'verify.cjs'),
    "require('node:assert/strict').equal(require('./sum.cjs')(2,3),5);\n",
  );
  await git(['add', '.']);
  await git(['commit', '-m', 'Fixture']);
  await git(['remote', 'add', 'origin', remote]);
  await git(['push', '-u', 'origin', 'main']);
  const store = new Store(join(root, 'db.sqlite'));
  const p = store.createProject('Fixture', '');
  store.saveProjectAgentSelection(p.id, { mode: 'override', agent: 'codex' });
  const providers = new Providers(store);
  const upstream = await providers.save({
    name: 'Lifecycle upstream',
    baseUrl: 'http://localhost:9999/v1',
    apiKey: 'lifecycle-private-key',
  });
  const assigned = structuredClone(p.profiles);
  assigned[route] = { providerId: upstream.id, model: 'dev-' + route, effort: 'low' };
  assigned.pm = { providerId: upstream.id, model: 'pm-model', effort: 'medium' };
  assigned.review = { providerId: 'codex', model: 'review-model', effort: 'high' };
  store.saveProjectProfiles(p.id, assigned);
  const secondaryReview = { providerId: 'codex', model: 'secondary-review-model', effort: 'high' };
  if (route === 'complex') store.saveProjectSecondaryReviewProfile(p.id, secondaryReview);
  const observed: string[] = [];

  const repo = store.createRepo({
    projectId: p.id,
    name: 'source',
    path: source,
    github: 'fixture/source',
    defaultBranch: 'main',
    authorized: true,
  });
  store.patchRepo(repo.id, {
    enabled: true,
    commands: { install: '', build: '', test: 'node verify.cjs', start: '', port: 3000 },
  });
  const message = store.addMessage(p.id, 'user', 'Implement sum', 'implement');
  const task = store.createTask({
    projectId: p.id,
    repoId: repo.id,
    sourceMessageId: message.id,
    title: 'Sum numbers',
    spec: 'Add two numbers',
    acceptance: ['2 + 3 = 5'],
    dependencies: [],
    kind: route === 'complex' ? 'backend' : route,
    complexity: route === 'complex' ? 'complex' : 'normal',
    priority: 0,
  });
  store.updateMessage(message.id, { status: 'completed', draftStatus: 'completed' });
  let issue = { number: 1, body: '', state: 'open' };
  let merged = false;
  let rejected = false;
  let devTurns = 0;
  let interruptionId = '';
  let retrospectiveTurns = 0;
  const axes: string[] = [];
  class FakeGitHub extends GitHub {
    override async setupProject() {}
    override async gh(args: string[]) {
      assert.equal(args[0], 'api');
      assert.match(args[1], /^repos\/fixture\/source\/issues\?/);
      return { stdout: '[]', stderr: '', code: 0 };
    }
    override async publishPR(t: Task) {
      store.updateTask(t.id, { pr: 2, prUrl: 'https://example.invalid/pull/2' });
      return this.pull(t);
    }
    override async pull(t: Task): Promise<PullState> {
      return {
        number: 2,
        html_url: 'https://example.invalid/pull/2',
        state: 'open',
        merged,
        mergeable: true,
        mergeable_state: 'clean',
        head: { sha: t.head!, ref: t.branch, repo: { full_name: 'fixture/source' } },
        base: { sha: t.base!, repo: { full_name: 'fixture/source' } },
        body: '',
      };
    }
    override async checks() {
      return { ready: true };
    }
    override async reviewComment(_t: Task, r: ReviewResult) {
      axes.push(r.axis);
      await new Promise((r) => setTimeout(r, 10));
      return {};
    }
    override async merge(t: Task) {
      assert.equal(mergeReady(t), true);
      assert.match(issue.body, /- \[ \] 2 \+ 3 = 5/);
      if (retrospective) {
        const message = store.addMessage(
          p.id,
          'user',
          `For ${t.id}, port 3000 is occupied. Choose a free port.`,
          'discuss',
        );
        store.updateMessage(message.id, { status: 'completed' });
        interruptionId = `message:${message.id}`;
      }
      merged = true;
      const remote = await this.pull(t);
      if (retrospective)
        store.put('operation', `merge:${t.id}:${t.head}`, {
          id: `merge:${t.id}:${t.head}`,
          kind: 'merge-pr',
          status: 'done',
          result: { ...remote, merged_at: new Date(Date.now() + 1000).toISOString() },
        });
      return remote;
    }
    override async syncStatus() {}
    override async api<T = any>(endpoint: string, method = 'GET', data?: any): Promise<T> {
      if (endpoint.endsWith('/issues') && method === 'POST') issue = { ...issue, ...data };
      if (method === 'PATCH') {
        assert.equal(merged, true);
        assert.equal(store.task(task.id).stage, 'merging');
        issue = { ...issue, ...data };
      }
      return { ...issue } as T;
    }
    override async paged() {
      return [];
    }
  }
  class FakeCodex extends Codex {
    cwd = '';
    role = '';
    axis = '';
    providerId = 'codex';
    handler?: Parameters<Codex['thread']>[0]['toolHandler'];
    override async start(connection?: Parameters<Codex['start']>[0]) {
      this.providerId = connection?.id ?? 'codex';
    }
    override async stop() {}
    override async thread(o: Parameters<Codex['thread']>[0]) {
      this.cwd = o.cwd;
      this.handler = o.toolHandler;
      this.role = o.instructions.includes('Task Developer')
        ? 'dev'
        : o.instructions.includes('Independent Review')
          ? 'review'
          : 'pm';
      const expected =
        this.role === 'dev'
          ? assigned[route]
          : this.role === 'review'
            ? o.profile.model === secondaryReview.model
              ? secondaryReview
              : assigned.review
            : assigned.pm;
      assert.equal(this.providerId, expected.providerId);
      assert.deepEqual(o.profile, { model: expected.model, effort: expected.effort });
      observed.push(this.role);
      if (this.role === 'dev') {
        const settings = store.settings();
        settings.profiles[route].model = 'changed-global-during-run';
        store.saveSettings(settings);
      }
      return `fixture-${this.role}`;
    }
    override async turn(_id: string, prompt: string, _p: Profile) {
      if (this.role === 'dev') {
        devTurns++;
        await writeFile(
          join(this.cwd, 'sum.cjs'),
          `// Revision ${devTurns}\nmodule.exports=(a,b)=>a+b;\n`,
        );
        return `Handoff ${devTurns}: implemented in the task worktree; host must commit and validate.`;
      }
      if (this.role === 'review') {
        const axis = /Axis: (primary|secondary)/.exec(prompt)?.[1] ?? this.axis;
        this.axis = axis;
        assert.ok(axis, 'the host must name the Policy 2 review lane');
        assert.ok(
          prompt.includes(`Handoff ${devTurns}:`),
          'review must see the latest Dev handoff',
        );
        if (axis === 'primary' && route === 'complex' && !rejected) {
          rejected = true;
          const evidence = store.task(task.id);
          await this.handler?.('submit_review', {
            approved: false,
            summary: 'Please clarify the implementation comment',
            findings: ['Add an implementation revision comment.'],
            verdict: 'rework',
            head: evidence.head,
            base: evidence.base,
            tests: evidence.tests,
          });
          return JSON.stringify({
            approved: false,
            summary: 'Please clarify the implementation comment',
            findings: ['Add an implementation revision comment.'],
            verdict: 'rework',
            head: evidence.head,
            base: evidence.base,
            tests: evidence.tests,
          });
        }
        const evidence = store.task(task.id);
        await this.handler?.('submit_review', {
          approved: true,
          summary: 'Inspected the task diff; behavior and conventions match.',
          findings: [],
          verdict: 'pass',
          head: evidence.head,
          base: evidence.base,
          tests: evidence.tests,
        });
        return JSON.stringify({
          approved: true,
          summary: 'Inspected the task diff; behavior and conventions match.',
          findings: [],
          verdict: 'pass',
          head: evidence.head,
          base: evidence.base,
          tests: evidence.tests,
        });
      }
      if (retrospective && prompt.startsWith('Review one merged Task')) {
        retrospectiveTurns++;
        assert.equal(merged, true);
        assert.match(prompt, /port 3000/);
        return JSON.stringify({
          category: 'port_conflict',
          interruptionIds: [interruptionId],
          reason: 'Handle port selection internally.',
          change: {
            section: 'engineering',
            text: 'Choose and verify a free preview port before asking the user.',
          },
        });
      }
      assert.fail('the lifecycle must not call PM for merge acceptance');
    }
  }
  const ws = new Workspaces(join(root, 'workspaces'), store);
  const mirror = await ws.mirror(store.repo(repo.id));
  await command('git', ['config', 'user.name', 'Phantom Test'], mirror);
  await command('git', ['config', 'user.email', 'test@example.invalid'], mirror);
  const engine = new Engine(store, new FakeGitHub(store), ws, root, () => new FakeCodex());
  try {
    await engine.start();
    // A wall-clock budget: under the full suite's load a fixed tick count ran out mid-review.
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline && store.task(task.id).stage !== 'done') {
      await engine.tick();
      await new Promise((r) => setTimeout(r, 50));
    }
    const result = store.task(task.id);
    assert.equal(
      result.stage,
      'done',
      JSON.stringify({ task: result, events: store.events().slice(0, 5) }),
    );
    assert.match(issue.body, /- \[x\] 2 \+ 3 = 5/);
    assert.equal(issue.state, 'closed');
    assert.equal(result.issueBody, issue.body);
    assert.equal(devTurns, route === 'complex' ? 2 : 1);
    assert.ok(['dev', 'review'].every((role) => observed.includes(role)));
    if (retrospective) {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !store.list('suggestion').some((s) => s.status === 'pending'))
        await new Promise((r) => setTimeout(r, 25));
      const suggestion = store.list('suggestion')[0];
      assert.equal(suggestion?.status, 'pending', JSON.stringify(suggestion));
      assert.deepEqual(suggestion.interruptionIds, [interruptionId]);
      assert.equal(retrospectiveTurns, 1);
      assert.equal(store.currentTeamInstructions(p.id).version, 0);
      store.decideSuggestion(p.id, suggestion.id, 'adopt');
      assert.equal(store.currentTeamInstructions(p.id).taskId, task.id);
    }
    assert.equal(
      observed.includes('pm'),
      retrospective,
      'PM acts only after merge for a retrospective',
    );
    for (const run of store.list('run')) {
      const expected =
        run.role === 'review' && run.secondaryReview ? secondaryReview : assigned[run.profile];
      assert.deepEqual(run.profileConfig, expected);
      assert.equal(run.provider?.id, expected.providerId);
    }
    assert.ok(!JSON.stringify(store.snapshot()).includes('lifecycle-private-key'));
    assert.equal(merged, true);
    const triggers = store.snapshot().activities.filter((a) => a.kind === 'trigger');
    assert.equal(
      triggers.some((a) => a.title === '宿主事件：Review 后验收' && a.taskId === task.id),
      false,
      'Policy 2 merge acceptance must not create a PM trigger',
    );
    assert.equal(result.reviews.length, route === 'complex' ? 2 : 1);
    assert.equal(result.tests[0].exitCode, 0);
    assert.equal((await command('git', ['status', '--porcelain'], source)).stdout, '');
    assert.equal(
      (await command('git', ['branch', '--show-current'], source)).stdout.trim(),
      'main',
    );
    assert.deepEqual(
      [...new Set(axes)].sort(),
      route === 'complex' ? ['primary', 'secondary'] : ['primary'],
    );
    assert.equal(mergeReady({ ...result, head: 'unreviewed-head' }), false);
    assert.equal(mergeReady({ ...result, base: 'new-base' }), false);
  } finally {
    await engine.stop();
    store.close();
  }
}
