import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { GitHub, type PullState } from '../src/server/github.ts';
import { Engine } from '../src/server/engine.ts';
import { Codex } from '../src/server/codex.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { pullRequestBody } from '../src/server/task-naming.ts';
import { issueFree } from '../src/shared/task-history.ts';
import { command } from '../src/server/process.ts';
import { intakeFixture, configuration } from './intake-fixture.ts';

const quote = 'Do not create Issues in test/repo; deliver through PRs.';
function fixture(file = ':memory:') {
  const store = new Store(file);
  const project = store.createProject('Optional Issue', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'repo',
    path: '/unused',
    github: 'test/repo',
    defaultBranch: 'main',
    authorized: true,
  });
  const source = store.addMessage(
    project.id,
    'user',
    'Implement the requested change.',
    'implement',
  );
  store.updateMessage(source.id, { status: 'completed' });
  store.saveTeamInstructions(
    project.id,
    { repository: `#### test/repo\n${quote}`, engineering: '', delivery: '' },
    { source: 'user', baseVersion: 0 },
  );
  const input = {
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: source.id,
    title: 'Deliver change',
    spec: 'Preserve the requested behavior.',
    acceptance: ['Observable result'],
    dependencies: [],
    kind: 'backend' as const,
    complexity: 'normal' as const,
    priority: 0,
    registrationDecision: {
      mode: 'none' as const,
      basis: 'team' as const,
      section: 'repository' as const,
      quote,
    },
  };
  return { store, project, repo, source, input };
}

test('registration evidence and pauses survive restart and agreement changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phantom-registration-'));
  const file = join(root, 'state.sqlite');
  const f = fixture(file);
  let store = f.store;
  let engine: Engine | undefined;
  try {
    const run = store.run('pm', f.project.id, 'pm');
    const task = store.createTask(f.input, { actor: 'pm', runId: run.id });
    store.finishRun(run.id, 'completed');
    const legacy = store.createTask({
      ...f.input,
      title: 'Default work',
      registrationDecision: undefined,
    });
    assert.equal(legacy.issueRegistration?.mode, 'issue');
    assert.equal(task.issueRegistration?.teamInstructionsVersion, 1);
    assert.equal(task.issueRegistration?.quote, quote);
    assert.throws(
      () =>
        store.createTask({
          ...f.input,
          title: 'Invalid evidence',
          registrationDecision: { ...f.input.registrationDecision, quote: 'Invented agreement' },
        }),
      /原文/,
    );
    store.updateTask(task.id, { ownerRunId: 'saved-owner', devThreadId: 'native-session' });
    store.control(task.id, 'pause');
    store.control(legacy.id, 'pause');
    store.saveTeamInstructions(
      f.project.id,
      { repository: 'Create Issues for future work.', engineering: '', delivery: '' },
      { source: 'user', baseVersion: 1 },
    );
    store.close();
    store = new Store(file);
    class Remote extends GitHub {
      override async gh(): Promise<never> {
        throw new Error('No remote calls expected');
      }
    }
    const github = new Remote(store);
    engine = new Engine(store, github, new Workspaces(join(root, 'ws'), store), root);
    await engine.start();
    await engine.sync();
    const restored = store.task(task.id);
    assert.equal(restored.control, 'paused');
    assert.equal(restored.pausedByUser, true);
    assert.equal(restored.ownerRunId, 'saved-owner');
    assert.equal(restored.devThreadId, 'native-session');
    assert.equal(restored.spec, task.spec);
    assert.deepEqual(restored.issueRegistration, task.issueRegistration);
    await github.publishIssue(restored);
    await github.reviseIssue(restored);
    await github.completeIssue(restored);
    assert.equal(store.list('operation').length, 0);
    store.put('operation', `issue:${task.id}`, {
      id: `issue:${task.id}`,
      kind: 'create-issue',
      status: 'uncertain',
    });
    await assert.rejects(github.publishIssue(restored), /登记操作需要核对/);
    assert.equal(store.get('operation', `issue:${task.id}`)?.status, 'uncertain');
  } finally {
    await engine?.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('all PR body formats retain Issue-free requirements and acceptance', () => {
  const f = fixture();
  try {
    const task = f.store.createTask(f.input);
    for (const extra of [
      {},
      { changeType: 'feat', scope: 'work', summaryEn: 'deliver work' },
      {
        deliveryText: {
          commitMessage: 'feat: deliver work',
          pullRequestBody: '## Result\nDelivered.',
        },
      },
    ]) {
      const body = pullRequestBody({ ...task, ...extra });
      assert.ok(body.includes(task.spec));
      assert.ok(body.includes(task.acceptance[0]));
      assert.ok(body.includes(`phantom-task:${task.id}`));
      assert.doesNotMatch(body, /Closes|#undefined/);
    }
  } finally {
    f.store.close();
  }
});

test('PR revisions preserve authored content and reconcile lost responses', async () => {
  const f = fixture();
  const task = f.store.createTask(f.input);
  const original = f.store.updateTask(task.id, {
    branch: `phantom/${task.id}`,
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
  });
  let pr = {
    number: 7,
    html_url: 'https://github.com/test/repo/pull/7',
    state: 'open',
    merged: false,
    body: `${pullRequestBody(original)}\n\nHuman review context.`,
    head: { sha: original.head, ref: original.branch, repo: { full_name: 'test/repo' } },
    base: { sha: original.base, ref: 'main', repo: { full_name: 'test/repo' } },
  };
  f.store.put('operation', `pr:${task.id}`, {
    id: `pr:${task.id}`,
    kind: 'create-pr',
    status: 'done',
    result: pr,
  });
  let writes = 0;
  let loseResponse = true;
  class Remote extends GitHub {
    override async api<T = unknown>(endpoint: string, method = 'GET', body?: any): Promise<T> {
      assert.equal(endpoint, 'repos/test/repo/pulls/7');
      if (method === 'PATCH') {
        writes++;
        pr = { ...pr, ...body };
        if (loseResponse) {
          loseResponse = false;
          throw new Error('Lost PR update response');
        }
      } else assert.equal(method, 'GET');
      return pr as T;
    }
  }
  try {
    const revised = f.store.updateTask(task.id, {
      spec: 'New requirement',
      acceptance: ['New acceptance'],
    });
    const github = new Remote(f.store);
    await assert.rejects(github.publishPR(revised), /Lost PR update response/);
    assert.ok(pr.body.includes('New requirement'));
    assert.ok(pr.body.includes('New acceptance'));
    assert.ok(pr.body.includes('Human review context.'));
    assert.doesNotMatch(pr.body, /Observable result|Closes/);
    await github.publishPR(f.store.task(task.id));
    assert.equal(writes, 1);
    assert.equal(
      f.store.list('operation').find((op) => op.kind === 'sync-pr-requirements')?.status,
      'done',
    );
  } finally {
    f.store.close();
  }
});

test('Web coordination creates and revises Issue-free work from adopted instructions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phantom-registration-pm-'));
  const f = fixture();
  f.store.saveProjectAgentSelection(f.project.id, { mode: 'override', agent: 'codex' });
  const source = join(root, 'source');
  await command('git', ['init', '-b', 'main', source]);
  await command('git', ['config', 'user.name', 'Phantom Test'], source);
  await command('git', ['config', 'user.email', 'test@example.invalid'], source);
  writeFileSync(join(source, 'README.md'), 'Fixture');
  await command('git', ['add', '.'], source);
  await command('git', ['commit', '-m', 'Fixture'], source);
  const remote = join(root, 'remote.git');
  await command('git', ['init', '--bare', remote]);
  await command('git', ['remote', 'add', 'origin', remote], source);
  await command('git', ['push', '-u', 'origin', 'main'], source);
  f.store.put('repo', f.repo.id, { ...f.repo, path: source });
  let taskId = '';
  class Model extends Codex {
    handler?: Parameters<Codex['thread']>[0]['toolHandler'];
    override async start() {}
    override async stop() {}
    override async thread(options: Parameters<Codex['thread']>[0]) {
      this.handler = options.toolHandler;
      assert.ok(options.instructions.includes(quote));
      return 'coordinator';
    }
    override async turn() {
      if (!taskId) {
        const { projectId: _project, sourceMessageId: _source, ...input } = f.input;
        const result = (await this.handler!('create_task', input)) as { id: string };
        taskId = result.id;
      } else {
        await this.handler!('revise_task', {
          taskId,
          spec: 'Revised requirement',
          acceptance: ['Revised acceptance'],
          guidance: 'User revision',
        });
      }
      return 'Recorded.';
    }
  }
  class Remote extends GitHub {
    override async gh(): Promise<never> {
      throw new Error('No Issue operations expected');
    }
  }
  const engine = new Engine(
    f.store,
    new Remote(f.store),
    new Workspaces(join(root, 'ws'), f.store),
    root,
    () => new Model(),
  );
  try {
    await engine.chat(f.source);
    const original = f.store.task(taskId);
    assert.equal(original.issueRegistration?.teamInstructionsVersion, 1);
    await engine.chat(
      f.store.addMessage(f.project.id, 'user', 'Revise this requirement', 'implement'),
    );
    const revised = f.store.task(taskId);
    assert.equal(revised.spec, 'Revised requirement');
    assert.deepEqual(revised.acceptance, ['Revised acceptance']);
    assert.equal(revised.sourceMessageId, original.sourceMessageId);
    assert.deepEqual(revised.issueRegistration, original.issueRegistration);
    await engine.sync();
    assert.equal(f.store.list('operation').length, 0);
  } finally {
    await engine.stop();
    f.store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Issue-free external delivery verifies the PR and survives restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phantom-registration-delivery-'));
  const file = join(root, 'state.sqlite');
  const f = fixture(file);
  let reads = 0;
  const task = f.store.createTask(f.input);
  f.store.updateTask(task.id, { pr: 7, stage: 'developing', head: 'a'.repeat(40) });
  f.store.control(task.id, 'pause');
  let complete = false;
  class Remote extends GitHub {
    override async gh(args: string[]) {
      assert.equal(args[1], 'repos/test/repo/pulls/7');
      reads++;
      const pr: PullState = {
        number: 7,
        html_url: 'https://github.com/test/repo/pull/7',
        state: 'closed',
        merged: true,
        merged_at: '2026-11-10T08:00:00Z',
        merge_commit_sha: complete ? 'c'.repeat(40) : undefined,
        head: { sha: 'd'.repeat(40), ref: 'feature', repo: { full_name: 'test/repo' } },
        base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'test/repo' } },
        body: '',
      };
      return { stdout: JSON.stringify(pr), stderr: '', code: 0 };
    }
  }
  const github = new Remote(f.store);
  let engine = new Engine(f.store, github, new Workspaces(join(root, 'ws'), f.store), root);
  try {
    await engine.sync();
    assert.notEqual(f.store.task(task.id).stage, 'done', 'incomplete merge evidence holds work');
    complete = true;
    await engine.sync();
    const settled = f.store.task(task.id);
    assert.equal(settled.stage, 'done');
    assert.equal(settled.completion?.source, 'external');
    assert.equal(settled.control, 'paused');
    assert.equal(settled.pausedByUser, true);
    assert.equal(settled.deliveryRevision?.head, 'd'.repeat(40));
    assert.equal(settled.head, task.head ?? 'a'.repeat(40));
    const before = reads;
    await engine.stop();
    f.store.close();
    f.store = new Store(file);
    engine = new Engine(
      f.store,
      new Remote(f.store),
      new Workspaces(join(root, 'ws'), f.store),
      root,
    );
    await engine.sync();
    assert.equal(reads, before);
    const notices = f.store
      .list('message')
      .filter((m) => m.descriptor?.code === 'delivery_external_without_issue');
    assert.equal(notices.length, 1);
    assert.doesNotMatch(notices[0].content, /Issue|undefined/);
    assert.equal(f.store.list('operation').length, 0);
  } finally {
    await engine.stop();
    f.store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('existing Issue admission retains its original association', async () => {
  const f = intakeFixture();
  try {
    await f.intake.configure(f.repo.id, configuration);
    await f.intake.refresh(f.repo.id);
    const messageId = f.intake.dispatchMessage(f.store.list('sourceInput')[0].id)?.id;
    assert.ok(messageId);
    const task = f.store.createTask({
      projectId: f.project.id,
      repoId: f.repo.id,
      sourceMessageId: messageId,
      title: 'Original Issue',
      spec: 'Preserve source',
      acceptance: ['Delivered'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
      registrationDecision: { mode: 'none', basis: 'source', quote: 'Do not create Issues' },
    });
    assert.equal(issueFree(task), false);
    assert.equal(task.issue, 12);
    assert.equal(task.issueRegistration?.basis, 'imported');
    assert.ok(task.issueOrigin);
  } finally {
    f.store.close();
  }
});
