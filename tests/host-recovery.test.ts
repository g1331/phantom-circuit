import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { GitHub } from '../src/server/github.ts';
import { Engine } from '../src/server/engine.ts';
import { Codex } from '../src/server/codex.ts';
import { command, shellCommand } from '../src/server/process.ts';
import type { Task } from '../src/shared/types.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'phantom-finalization-'));
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
  const repo = store.createRepo({
    projectId: project.id,
    name: 'source',
    path: source,
    github: 'fixture/source',
    defaultBranch: 'main',
    authorized: true,
  });
  store.patchRepo(repo.id, {
    enabled: true,
    commands: {
      install: '',
      build: '',
      test: 'node -e "process.exit(0)"',
      start: '',
      port: 3000,
    },
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
  const ws = new Workspaces(join(root, 'workspaces'), store);
  task = await ws.prepare(task);
  await git(['config', 'user.name', 'Phantom Test'], task.worktree);
  await git(['config', 'user.email', 'test@example.invalid'], task.worktree);
  const base = await ws.git(task.worktree!, ['rev-parse', 'HEAD']);
  task = store.updateTask(task.id, { base, stage: 'developing' });
  let starts = 0;
  let turns = 0;
  let deliver = true;
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
      if (deliver) await writeFile(join(task.worktree!, 'implementation.txt'), 'implemented\n');
      return 'Handing off';
    }
  }
  class Remote extends GitHub {
    override async publishIssue(t: Task) {
      store.updateTask(t.id, { issue: 1 });
      return { number: 1 };
    }
    override async publishPR() {
      return {} as any;
    }
    override async syncStatus() {}
    override async api<T = any>(): Promise<T> {
      return { state: 'open' } as T;
    }
  }
  const engine = new Engine(store, new Remote(store), ws, root, () => new Agent());
  async function cycle() {
    await engine.tick();
    for (let n = 0; n < 500 && store.activeRuns().length; n++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(store.activeRuns().length, 0, 'Run must terminate');
    return store.task(task.id);
  }
  return {
    root,
    source,
    store,
    repo,
    task,
    ws,
    engine,
    git,
    cycle,
    starts: () => starts,
    turns: () => turns,
    noDelivery: () => {
      deliver = false;
    },
    close: async () => {
      await engine.stop();
      store.close();
    },
  };
}

for (const committed of [false, true]) {
  test(`interrupted host finalization reuses ${committed ? 'committed' : 'dirty'} implementation without an AI session`, async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.task.worktree!, 'implementation.txt'), 'implemented\n');
      if (committed) {
        await f.git(['add', '.'], f.task.worktree);
        await f.git(['commit', '-m', 'Existing implementation'], f.task.worktree);
      }
      f.store.updateTask(f.task.id, { devPhase: 'finalize' });
      f.store.run('dev', f.task.projectId, 'backend', f.task);
      f.store.recover();
      assert.equal(f.store.activeRuns().length, 0);
      assert.equal(f.store.task(f.task.id).control, 'paused');
      await f.engine.resume(f.task.id);
      const result = await f.cycle();
      assert.equal(result.stage, 'reviewing', result.blocked);
      assert.equal(result.retries, 0);
      assert.equal(f.starts(), 0);
      assert.equal(f.turns(), 0);
      assert.equal(
        await f.ws.git(f.task.worktree!, ['rev-list', '--count', `${f.task.base}..HEAD`]),
        '1',
      );
      assert.equal(await f.ws.git(f.source, ['status', '--porcelain']), '');
    } finally {
      await f.close();
    }
  });
}

test('legacy missing-diff retries recover existing work without reimplementation or lost retry budget', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.task.worktree!, 'implementation.txt'), 'implemented\n');
    f.store.updateTask(f.task.id, {
      control: 'paused',
      retries: 3,
      feedback: Array(3).fill('没有可交付的实现差异，请完成任务或向 PM 说明具体阻塞'),
      blocked: '连续三轮未完成，PM 正在重评',
    });
    await f.engine.resume(f.task.id);
    const result = await f.cycle();
    assert.equal(result.stage, 'reviewing', result.blocked);
    assert.equal(result.retries, 0);
    assert.equal(f.starts(), 0);
    assert.equal(
      await readFile(join(f.task.worktree!, 'implementation.txt'), 'utf8'),
      'implemented\n',
    );
  } finally {
    await f.close();
  }
});

test('host index lock failure preserves implementation and retry budget, resume commits without another Dev turn', async () => {
  const f = await fixture();
  try {
    const lock = await f.ws.git(f.task.worktree!, ['rev-parse', '--git-path', 'index.lock']);
    // This lock belongs only to this disposable fixture, never to a live task.
    await writeFile(lock, 'test-owned lock');
    const failed = await f.cycle();
    assert.equal(failed.control, 'paused');
    assert.equal(failed.retries, 0);
    assert.equal(failed.devPhase, 'finalize');
    assert.match(failed.blocked!, /宿主提交环境阻塞/);
    assert.equal(
      await readFile(join(f.task.worktree!, 'implementation.txt'), 'utf8'),
      'implemented\n',
    );
    await unlink(lock);
    await f.engine.resume(f.task.id);
    assert.equal((await f.cycle()).stage, 'reviewing');
    assert.equal(f.turns(), 1);
  } finally {
    await f.close();
  }
});

test('unchanged work remains a product rework instead of an environment pause', async () => {
  const f = await fixture();
  try {
    f.noDelivery();
    const result = await f.cycle();
    assert.equal(result.retries, 1);
    assert.equal(result.devPhase, 'implement');
    assert.equal(result.control, 'active');
  } finally {
    await f.close();
  }
});

test('host stages resolved conflict files and completes the merge before validation', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.task.worktree!, 'implementation.txt'), 'local change\n');
    await f.git(['add', '.'], f.task.worktree);
    await f.git(['commit', '-m', 'Local implementation'], f.task.worktree);
    const local = await f.ws.git(f.task.worktree!, ['rev-parse', 'HEAD']);
    await writeFile(join(f.source, 'implementation.txt'), 'upstream change\n');
    await f.git(['add', '.']);
    await f.git(['commit', '-m', 'Upstream implementation']);
    await f.git(['push', 'origin', 'main']);
    const upstream = await f.ws.git(f.source, ['rev-parse', 'HEAD']);
    const result = await f.cycle();
    assert.equal(result.stage, 'reviewing', result.blocked);
    assert.equal(result.control, 'active');
    assert.equal(
      await f.ws.git(f.task.worktree!, ['show', '-s', '--format=%P', 'HEAD']),
      `${local} ${upstream}`,
    );
    assert.equal(await f.ws.git(f.task.worktree!, ['status', '--porcelain']), '');
    assert.equal(result.tests[0].head, result.head);
    assert.equal(result.retries, 0);
    assert.equal(
      await readFile(join(f.task.worktree!, 'implementation.txt'), 'utf8'),
      'implemented\n',
    );
    assert.equal(await readFile(join(f.source, 'implementation.txt'), 'utf8'), 'upstream change\n');
  } finally {
    await f.close();
  }
});

for (const environment of [false, true]) {
  test(`${environment ? 'environment failure pauses' : 'assertion failure reworks'} after formal host validation`, async () => {
    const f = await fixture();
    try {
      f.store.patchRepo(f.repo.id, {
        commands: {
          ...f.store.repo(f.repo.id).commands,
          test: `node -e "console.error('${environment ? 'Assertion failed: UV_HANDLE_CLOSING' : 'AssertionError: incorrect result'}'); process.exit(1)"`,
        },
      });
      const result = await f.cycle();
      assert.equal(result.retries, environment ? 0 : 1);
      assert.equal(result.control, environment ? 'paused' : 'active');
      assert.equal(result.devPhase, environment ? 'finalize' : 'implement');
      if (environment) assert.equal(result.tests[0].exitCode, 1);
      assert.notEqual(await f.ws.git(f.task.worktree!, ['rev-parse', 'HEAD']), f.task.base);
    } finally {
      await f.close();
    }
  });
}

for (const action of ['pause', 'cancel'] as const) {
  test(`${action} at the validation handoff prevents remote publication`, async () => {
    const f = await fixture();
    try {
      let controlled = false;
      f.store.changes.on('change', () => {
        if (!controlled && f.store.task(f.task.id).tests.length) {
          controlled = true;
          f.engine.control(f.task.id, action);
        }
      });
      const result = await f.cycle();
      assert.equal(controlled, true);
      assert.equal(result.stage, action === 'cancel' ? 'cancelled' : 'developing');
      assert.equal(result.control, 'paused');
      const remote = await f.ws.git(f.task.worktree!, [
        'ls-remote',
        'origin',
        `refs/heads/${f.task.branch}`,
      ]);
      assert.equal(remote, '', 'Paused/cancelled work must not be pushed');
    } finally {
      await f.close();
    }
  });
}

test('configured chained validation commands execute and propagate failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-shell-'));
  const success = await shellCommand(
    'node -e "process.exit(0)" && node -e "console.log(42)"',
    root,
  );
  assert.equal(success.code, 0, success.stderr);
  assert.match(success.stdout, /42/);
  const failure = await shellCommand(
    'node -e "process.exit(7)" && node -e "console.log(42)"',
    root,
  );
  assert.equal(failure.code, 7);
  assert.doesNotMatch(failure.stdout, /42/);
});

test('PM product revision invalidates a pending host finalization checkpoint', async () => {
  const f = await fixture();
  let pm: Engine | undefined;
  try {
    f.store.updateTask(f.task.id, { control: 'paused', devPhase: 'finalize' });
    class PM extends Codex {
      handler?: Parameters<Codex['thread']>[0]['toolHandler'];
      override async start() {}
      override async stop() {}
      override async thread(options: Parameters<Codex['thread']>[0]) {
        this.handler = options.toolHandler;
        return 'pm';
      }
      override async turn() {
        await this.handler!('revise_task', {
          taskId: f.task.id,
          spec: 'Implement revised behavior',
          acceptance: ['Revised behavior works'],
          guidance: 'Update implementation for revised scope',
        });
        return 'Revised';
      }
    }
    pm = new Engine(f.store, new GitHub(f.store), f.ws, f.root, () => new PM());
    const message = f.store.addMessage(
      f.task.projectId,
      'user',
      'Change the requirements',
      'implement',
    );
    await pm.chat(message);
    assert.equal(f.store.task(f.task.id).devPhase, 'implement');
    assert.equal(f.store.task(f.task.id).spec, 'Implement revised behavior');
  } finally {
    await pm?.stop();
    await f.close();
  }
});
