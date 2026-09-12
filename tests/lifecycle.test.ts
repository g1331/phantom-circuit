import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { GitHub, type PullState } from '../src/server/github.ts';
import { Engine, mergeReady } from '../src/server/engine.ts';
import { Codex } from '../src/server/codex.ts';
import { command } from '../src/server/process.ts';
import type { Task, ReviewResult, Profile } from '../src/shared/types.ts';

test('real worktrees, commits and tests complete a task through independent review, rework and merge', async () => {
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
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  let merged = false;
  let rejected = false;
  let devTurns = 0;
  const axes: string[] = [];
  class FakeGitHub extends GitHub {
    override async publishIssue(t: Task) {
      store.updateTask(t.id, { issue: 1, issueUrl: 'https://example.invalid/issues/1' });
      return { number: 1 };
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
        head: { sha: t.head! },
        base: { sha: t.base! },
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
      merged = true;
      return this.pull(t);
    }
    override async syncStatus() {}
    override async api<T = any>(): Promise<T> {
      return { state: 'open', body: undefined } as T;
    }
    override async paged() {
      return [];
    }
  }
  class FakeCodex extends Codex {
    cwd = '';
    role = '';
    override async start() {}
    override async stop() {}
    override async thread(o: Parameters<Codex['thread']>[0]) {
      this.cwd = o.cwd;
      this.role = o.instructions.includes('Task Developer')
        ? 'dev'
        : o.instructions.includes('Independent Reviewer')
          ? 'review'
          : 'pm';
      return `fixture-${this.role}`;
    }
    override async turn(_id: string, prompt: string, _p: Profile) {
      if (this.role === 'dev') {
        devTurns++;
        await command('git', ['config', 'user.name', 'Phantom Test'], this.cwd);
        await command('git', ['config', 'user.email', 'test@example.invalid'], this.cwd);
        await writeFile(
          join(this.cwd, 'sum.cjs'),
          `// Revision ${devTurns}\nmodule.exports=(a,b)=>a+b;\n`,
        );
        return 'Implemented in the task worktree; host must commit and validate.';
      }
      if (this.role === 'review') {
        if (prompt.includes('Axis: spec') && !rejected) {
          rejected = true;
          return JSON.stringify({
            approved: false,
            summary: 'Please clarify the implementation comment',
            findings: ['Add an implementation revision comment.'],
          });
        }
        return JSON.stringify({
          approved: true,
          summary: 'Inspected the task diff; behavior and conventions match.',
          findings: [],
        });
      }
      return JSON.stringify({
        approved: true,
        reason: 'Acceptance criteria and both reviews pass.',
      });
    }
  }
  const ws = new Workspaces(join(root, 'workspaces'), store);
  const engine = new Engine(store, new FakeGitHub(store), ws, root, () => new FakeCodex());
  try {
    for (let i = 0; i < 250 && store.task(task.id).stage !== 'done'; i++) {
      await engine.tick();
      await new Promise((r) => setTimeout(r, 50));
    }
    const result = store.task(task.id);
    assert.equal(
      result.stage,
      'done',
      JSON.stringify({ task: result, events: store.events().slice(0, 5) }),
    );
    assert.equal(devTurns, 2);
    assert.equal(merged, true);
    assert.equal(result.reviews.length, 2);
    assert.equal(result.tests[0].exitCode, 0);
    assert.equal((await command('git', ['status', '--porcelain'], source)).stdout, '');
    assert.equal(
      (await command('git', ['branch', '--show-current'], source)).stdout.trim(),
      'main',
    );
    assert.ok(axes.includes('standards') && axes.includes('spec'));
    assert.equal(mergeReady({ ...result, head: 'unreviewed-head' }), false);
    assert.equal(mergeReady({ ...result, base: 'new-base' }), false);
  } finally {
    await engine.stop();
    store.close();
  }
});
