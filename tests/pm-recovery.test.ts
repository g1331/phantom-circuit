import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { GitHub } from '../src/server/github.ts';
import { Store } from '../src/server/store.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';

test('automatic recovery preserves a running user message after its PM Run was marked interrupted', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject('Graceful recovery', '');
    const message = store.addMessage(project.id, 'user', 'Plan the report', 'discuss');
    store.updateMessage(message.id, { status: 'running', draftStatus: 'running' });
    const run = store.run('pm', project.id, 'pm', { sourceMessageId: message.id });
    store.finishRun(run.id, 'interrupted', 'Service shutdown');

    const recovery = store.recover().find((item) => item.oldRunId === run.id);

    assert.equal(recovery?.status, 'pending');
    assert.equal(store.get('message', message.id)?.status, 'running');
    assert.ok(!store.list('message').some((item) => item.content.includes('重新发送')));
  } finally {
    store.close();
  }
});

test('PM recovery leaves genuine failures and pauses alone and keeps manual interruption recoverable', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject('Recovery boundaries', '');
    for (const status of ['failed', 'paused'] as const) {
      const message = store.addMessage(project.id, 'user', `A ${status} turn`, 'discuss');
      const run = store.run('pm', project.id, 'pm', { sourceMessageId: message.id });
      store.finishRun(run.id, status, status);
      assert.ok(!store.recover().some((item) => item.oldRunId === run.id));
      assert.equal(store.get('run', run.id)?.status, status);
    }
    store.saveProjectRuntimeConfig(project.id, { recoveryPolicy: 'manual' });
    const message = store.addMessage(project.id, 'user', 'Manually resume this turn', 'discuss');
    store.updateMessage(message.id, { status: 'running', draftStatus: 'running' });
    const run = store.run('pm', project.id, 'pm', { sourceMessageId: message.id });
    store.finishRun(run.id, 'interrupted', 'Service shutdown');
    assert.equal(store.recover().find((item) => item.oldRunId === run.id)?.status, 'recoverable');
    assert.equal(store.get('message', message.id)?.status, 'failed');
  } finally {
    store.close();
  }
});

test(
  'shutdown preserves a queued PM recovery until restart executes both original messages',
  { timeout: 15_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'phantom-pm-queued-recovery-'));
    const file = join(root, 'state.sqlite');
    let enteredTurn!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredTurn = resolve;
    });
    let interruptedTurns = 0;
    // Model-boundary doubles only: the Store, queues and Engine lifecycle are real.
    class GatedModel extends Codex {
      rejectTurn?: (error: Error) => void;
      override async start() {}
      override async stop() {
        this.rejectTurn?.(new Error('Model stopped'));
      }
      override async thread() {
        return 'gated-pm-thread';
      }
      override async turn() {
        interruptedTurns++;
        enteredTurn();
        return new Promise<string>((_resolve, reject) => {
          this.rejectTurn = reject;
        });
      }
    }
    const before = new Store(file);
    const project = before.createProject('Queued recovery', '');
    before.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
    const messages = ['Plan the report', 'Plan the export'].map((content) => {
      const message = before.addMessage(project.id, 'user', content, 'discuss');
      before.updateMessage(message.id, { status: 'running', draftStatus: 'running' });
      before.run('pm', project.id, 'pm', { sourceMessageId: message.id });
      return message;
    });
    const first = new Engine(
      before,
      new GitHub(before),
      new Workspaces(join(root, 'ws'), before),
      root,
      () => new GatedModel(),
    );
    try {
      const starting = first.start();
      await entered;
      await first.stop();
      await starting;
      assert.equal(interruptedTurns, 1, 'the second recovery must still be queued at shutdown');
    } finally {
      await first.stop();
      before.close();
    }

    let completedTurns = 0;
    class CompletingModel extends Codex {
      override async start() {}
      override async stop() {}
      override async thread() {
        return 'completed-pm-thread';
      }
      override async turn() {
        completedTurns++;
        return `Recovered answer ${completedTurns}`;
      }
    }
    const after = new Store(file);
    const second = new Engine(
      after,
      new GitHub(after),
      new Workspaces(join(root, 'ws'), after),
      root,
      () => new CompletingModel(),
    );
    try {
      await second.start();
      assert.equal(
        completedTurns,
        2,
        'restart must execute both interrupted and never-started PM work',
      );
      for (const message of messages) {
        assert.equal(after.get('message', message.id)?.status, 'completed');
        assert.ok(
          after
            .list('message')
            .some(
              (reply) =>
                reply.role === 'assistant' &&
                reply.sourceMessageId === message.id &&
                reply.status === 'completed',
            ),
        );
      }
      assert.equal(after.list('message').filter((message) => message.role === 'user').length, 2);
      assert.ok(!after.list('message').some((message) => message.content.includes('重新发送')));
    } finally {
      await second.stop();
      after.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('cancelling a queued PM recovery prevents its successor from executing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-pm-cancel-recovery-'));
  const store = new Store(join(root, 'state.sqlite'));
  const project = store.createProject('Cancelled recovery', '');
  store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
  const runs = ['First message', 'Cancelled message'].map((content) => {
    const message = store.addMessage(project.id, 'user', content, 'discuss');
    store.updateMessage(message.id, { status: 'running', draftStatus: 'running' });
    return store.run('pm', project.id, 'pm', { sourceMessageId: message.id });
  });
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let turns = 0;
  class Model extends Codex {
    override async start() {}
    override async stop() {
      release();
    }
    override async thread() {
      return 'cancel-recovery-thread';
    }
    override async turn() {
      turns++;
      entered();
      await gate;
      return 'Completed first message';
    }
  }
  const engine = new Engine(
    store,
    new GitHub(store),
    new Workspaces(join(root, 'ws'), store),
    root,
    () => new Model(),
  );
  try {
    const startup = engine.start();
    await started;
    const item = store.list('recovery').find((entry) => entry.oldRunId === runs[1].id);
    assert.ok(item);
    engine.cancelRecovery(project.id, item.id);
    release();
    await startup;
    assert.equal(turns, 1, 'cancelled work must not execute after the preceding PM turn completes');
    assert.equal(store.get('recovery', item.id)?.status, 'cancelled');
    assert.equal(store.get('recovery', item.id)?.successorRunId, undefined);
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const interruptionMode of ['abrupt', 'graceful']) {
  test(
    `PM executes a successor and delivers the original reply after two ${interruptionMode} process interruptions`,
    { timeout: 45_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'phantom-pm-repeated-recovery-'));
      const file = join(root, 'state.sqlite');
      const imports = [
        { symbol: 'Codex', file: 'codex' },
        { symbol: 'GitHub', file: 'github' },
        { symbol: 'Store', file: 'store' },
        { symbol: 'Workspaces', file: 'workspaces' },
        { symbol: 'Engine', file: 'engine' },
      ]
        .map(
          ({ symbol, file }) =>
            `import { ${symbol} } from ${JSON.stringify(new URL(`../src/server/${file}.ts`, import.meta.url).href)};`,
        )
        .join('\n');
      const script = `${imports}
    const root = ${JSON.stringify(root)};
    const store = new Store(${JSON.stringify(file)});
    const initial = store.list('project').length === 0;
    if (initial) {
      const project = store.createProject('Repeated recovery', '');
      store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
      store.addMessage(project.id, 'user', 'Plan the report', 'discuss');
    }
    class GatedModel extends Codex {
      rejectTurn;
      async start() {}
      async stop() { this.rejectTurn?.(new Error('Model stopped')); }
      async thread() { return 'interrupted-pm-thread'; }
      async turn() {
        process.send(store.activeRuns().find(run => run.role === 'pm').id);
        setInterval(() => {}, 1000);
        return new Promise((resolve, reject) => { this.rejectTurn = reject; });
      }
    }
    const engine = new Engine(store, new GitHub(store), new Workspaces(root + '/ws', store), root, () => new GatedModel());
    let shuttingDown = false;
    const shutdown = async () => {
      shuttingDown = true;
      await engine.stop();
      store.close();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('message', message => { if (message === 'shutdown') void shutdown(); });
    try {
      await engine.start();
      if (initial) await engine.chat(store.list('message').find(message => message.role === 'user'));
    } catch (error) { if (!shuttingDown) throw error; }
  `;
      const interruptedRuns: string[] = [];
      try {
        for (let interruption = 0; interruption < 2; interruption++) {
          const child = spawn(
            process.execPath,
            ['--import', 'tsx', '--input-type=module', '--eval', script],
            {
              stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            },
          );
          const closed = once(child, 'close');
          let stderr = '';
          child.stderr?.on('data', (chunk) => {
            stderr += String(chunk);
          });
          try {
            const [runId]: unknown[] = await once(child, 'message', {
              signal: AbortSignal.timeout(15_000),
            });
            assert.equal(typeof runId, 'string', `child must enter an actual PM turn: ${stderr}`);
            if (typeof runId !== 'string') throw new Error('Missing executing Run');
            interruptedRuns.push(runId);
          } finally {
            if (interruptionMode === 'graceful' && child.connected) {
              if (process.platform === 'win32') child.send('shutdown');
              else child.kill('SIGTERM');
            } else child.kill('SIGKILL');
            const [code] = await closed;
            if (interruptionMode === 'graceful') assert.equal(code, 0, stderr);
          }
          const snapshot = new Store(file);
          try {
            assert.equal(
              snapshot.get('run', interruptedRuns[interruption]!)?.status,
              interruptionMode === 'abrupt' ? 'running' : 'interrupted',
            );
          } finally {
            snapshot.close();
          }
        }
        assert.notEqual(
          interruptedRuns[0],
          interruptedRuns[1],
          'the first restart must execute a new successor',
        );

        let completedTurns = 0;
        class CompletingModel extends Codex {
          override async start() {}
          override async stop() {}
          override async thread() {
            return 'completed-pm-thread';
          }
          override async turn() {
            completedTurns++;
            return 'The report plan survived both interruptions.';
          }
        }
        const store = new Store(file);
        const engine = new Engine(
          store,
          new GitHub(store),
          new Workspaces(join(root, 'ws'), store),
          root,
          () => new CompletingModel(),
        );
        try {
          await engine.start();
          assert.equal(
            completedTurns,
            1,
            'the second restart must execute, not merely retain running state',
          );
          const messages = store.list('message');
          assert.equal(
            messages.filter((message) => message.role === 'user').length,
            1,
            'recovery must not need a resend',
          );
          assert.equal(messages.find((message) => message.role === 'user')?.status, 'completed');
          assert.ok(
            messages.some(
              (message) =>
                message.role === 'assistant' &&
                message.status === 'completed' &&
                message.content === 'The report plan survived both interruptions.',
            ),
          );
          assert.equal(store.activeRuns().length, 0);
          for (const runId of interruptedRuns) {
            const recovery = store.list('recovery').find((item) => item.oldRunId === runId);
            assert.ok(recovery?.successorRunId, 'each interruption must retain its successor link');
          }
        } finally {
          await engine.stop();
          store.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

test('Dev scheduling links each interruption to its own successor instead of reusing an older recovery', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject('Repeated Dev recovery', '');
    store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
    const repo = store.createRepo({
      projectId: project.id,
      name: 'fixture',
      path: process.cwd(),
      github: 'fixture/recovery',
      defaultBranch: 'main',
      authorized: true,
    });
    store.patchRepo(repo.id, { enabled: true });
    const source = store.addMessage(project.id, 'user', 'Implement the report', 'implement');
    const task = store.createTask({
      projectId: project.id,
      repoId: repo.id,
      sourceMessageId: source.id,
      title: 'Report',
      spec: 'Implement the report',
      acceptance: ['The report exists'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    let run = store.claimNext();
    assert.ok(run);
    for (let interruption = 0; interruption < 2; interruption++) {
      const recovery = store.recover().find((item) => item.oldRunId === run?.id);
      assert.ok(recovery);
      store.finishRecovery(recovery.id, 'resumed');
      store.updateTask(task.id, {
        control: 'active',
        blocked: undefined,
        blockedDescriptor: undefined,
      });
      run = store.claimNext();
      assert.ok(run);
      assert.equal(store.get('recovery', recovery.id)?.successorRunId, run.id);
      assert.equal(run.recoveryItemId, recovery.id);
    }
  } finally {
    store.close();
  }
});

test('a user message whose PM turn resumes automatically after restart ends completed, not failed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-pm-recovery-'));
  const file = join(root, 'state.sqlite');
  const before = new Store(file);
  const project = before.createProject('Recovery', '');
  before.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
  const message = before.addMessage(project.id, 'user', 'Plan the report', 'discuss');
  before.updateMessage(message.id, { status: 'running', draftStatus: 'running' });
  before.run('pm', project.id, 'pm', { sourceMessageId: message.id });
  before.close();

  class Model extends Codex {
    override async start() {}
    override async stop() {}
    override async thread() {
      return 'pm-thread';
    }
    override async turn() {
      return 'resumed answer';
    }
  }
  const store = new Store(file);
  const engine = new Engine(
    store,
    new GitHub(store),
    new Workspaces(join(root, 'ws'), store),
    root,
    () => new Model(),
  );
  try {
    await engine.start();
    assert.equal(store.get('message', message.id)?.status, 'completed');
    const notes = store.list('message').filter((m) => m.role === 'system');
    assert.ok(
      !notes.some((m) => m.content.includes('重新发送')),
      'an automatically resumed message must not ask the user to resend it',
    );
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
