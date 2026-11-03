import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { Codex } from '../src/server/codex.ts';
import { command } from '../src/server/process.ts';
import { FakeGitHub } from './fake-github.ts';
import type { Task } from '../src/shared/types.ts';

/**
 * Complete host recovery for a create-pr whose remote outcome is unknown, driven through the real
 * Engine lifecycle: a real temporary Git repository, the real workspace finalization and push,
 * the real GitHub adapter, and only the `gh` process boundary faked. Nothing here calls an
 * adapter method directly to stand in for the host - every assertion follows `engine.resume` and
 * `engine.tick`, which is where the host actually recovers.
 */
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'phantom-publication-'));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  await command('git', ['init', '--bare', remote]);
  await command('git', ['init', '-b', 'main', source]);
  const git = (args: string[], cwd = source) => command('git', args, cwd);
  await git(['config', 'user.name', 'Phantom Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(source, 'implementation.txt'), 'baseline\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Fixture']);
  await git(['remote', 'add', 'origin', remote]);
  await git(['push', 'origin', 'main']);
  const store = new Store(join(root, 'db.sqlite'));
  const project = store.createProject('Fixture', '');
  store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
  const repo = store.createRepo({
    projectId: project.id,
    name: 'source',
    path: source,
    github: 'example/repo',
    defaultBranch: 'main',
    authorized: true,
  });
  // The work switch stays closed: recovering an already-claimed task must not need a new claim.
  store.patchRepo(repo.id, {
    enabled: false,
    commands: { install: '', build: '', test: 'node -e "process.exit(0)"', start: '', port: 3000 },
  });
  const message = store.addMessage(project.id, 'user', 'Implement', 'implement');
  let task = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: message.id,
    title: 'Implement',
    spec: 'Change implementation',
    acceptance: ['Implementation exists'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  store.updateMessage(message.id, { status: 'completed', draftStatus: 'completed' });
  const ws = new Workspaces(join(root, 'workspaces'), store);
  task = await ws.prepare(task);
  await git(['config', 'user.name', 'Phantom Test'], task.worktree);
  await git(['config', 'user.email', 'test@example.invalid'], task.worktree);
  const base = await ws.git(task.worktree!, ['rev-parse', 'HEAD']);
  task = store.updateTask(task.id, { base, stage: 'developing' });
  let starts = 0;
  let turns = 0;
  class Agent extends Codex {
    override async start() {
      starts++;
    }
    override async stop() {}
    override async thread() {
      return 'fixture';
    }
    override async turn() {
      turns++;
      await writeFile(join(task.worktree!, 'implementation.txt'), 'implemented\n');
      return 'Handing off';
    }
  }
  class Remote extends FakeGitHub {
    override async publishIssue(t: Task) {
      store.updateTask(t.id, { issue: 1 });
      return { number: 1 } as any;
    }
  }
  const github = new Remote(store);
  const engine = new Engine(store, github, ws, root, () => new Agent());
  await engine.start();
  async function cycle() {
    await engine.tick();
    for (let n = 0; n < 3000 && store.activeRuns().length; n++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(store.activeRuns().length, 0, 'Run must terminate');
    return store.task(task.id);
  }
  const marker = () => `<!-- phantom-task:${task.id} -->`;
  const key = () => `pr:${task.id}`;
  // Recovery must add no Dev work of its own; tests compare against this baseline.
  let marks = { starts: 0, turns: 0 };
  return {
    root,
    source,
    store,
    repo,
    ws,
    git,
    engine,
    github,
    marker,
    key,
    operation: () => store.get('operation', key()),
    task: () => store.task(task.id),
    cycle,
    starts: () => starts - marks.starts,
    turns: () => turns - marks.turns,
    mark: () => {
      marks = { starts, turns };
    },
    /** Model the accepted-request-with-lost-response variant of the same unknown outcome. */
    loseResponse: (value: boolean) => {
      github.loseWriteResponse = value;
    },
    failWrite: (value: boolean) => {
      github.failWrite = value ? new Error('gh (1): gh: Server Error (HTTP 502)') : undefined;
    },
    failRead: (value: boolean) => {
      github.failRead = value ? new Error('gh (1): gh: Server Error (HTTP 502)') : undefined;
    },
    close: async () => {
      await engine.stop();
      store.close();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * Reach the real Task #32 state, in the order production reached it: the first run fails on the
 * 502 itself, and a later uncoordinated re-entry is refused by the unresolved-outcome guard. That
 * second entry is driven by the public Store control operation rather than `engine.resume`,
 * because explicit recovery is exactly what must not have happened yet.
 */
export async function blockedOnPublication(f: Fixture) {
  f.failWrite(true);
  const first = await f.cycle();
  f.failWrite(false);
  assert.equal(first.control, 'paused');
  assert.equal(first.stage, 'developing');
  assert.equal(first.devPhase, 'finalize');
  assert.match(first.blocked!, /HTTP 502/);
  assert.equal(f.operation()!.status, 'uncertain');
  assert.equal(f.operation()!.result, undefined);
  assert.equal(f.operation()!.reconciliation, undefined);
  assert.equal(f.github.posted.length, 1);
  assert.equal(f.github.writes, 0, 'the remote never accepted the request');
  assert.ok(first.head, 'the finalized revision is pinned');
  assert.equal(first.tests[0].exitCode, 0, 'formal evidence exists for that revision');
  assert.equal(
    await f.ws.git(f.task().worktree!, ['ls-remote', 'origin', `refs/heads/${f.task().branch}`]),
    `${first.head}\trefs/heads/${f.task().branch}`,
    'the push succeeded before publication was attempted',
  );

  f.store.control(f.task().id, 'resume');
  const second = await f.cycle();
  assert.equal(second.control, 'paused');
  assert.equal(second.stage, 'developing');
  assert.equal(second.devPhase, 'finalize');
  assert.match(second.blocked!, /外部操作结果不明，需核对后恢复：create-pr/);
  assert.equal(second.head, first.head, 'the pinned revision did not move');
  assert.equal(second.retries, 0);
  assert.equal(f.github.posted.length, 1, 'entry without coordination never writes again');
  assert.equal(f.operation()!.reconciliation, undefined);
  f.mark();
  return second;
}
