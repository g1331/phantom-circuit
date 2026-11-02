import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Codex } from '../src/server/codex.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { devFixture, hang, until } from './dev-fixture.ts';

test('watchdog fails a silent PM turn and lets the project queue continue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-watchdog-pm-'));
  const store = new Store(':memory:');
  const project = store.createProject('Watchdog', '');
  store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
  let turns = 0;
  class Model extends Codex {
    override async start() {}
    override async stop() {}
    override async thread() {
      return 'pm';
    }
    override async turn(_thread: string, _prompt: string, _profile: any, signal?: AbortSignal) {
      return ++turns === 1 ? hang(signal) : 'second answer';
    }
  }
  const engine = new Engine(
    store,
    new GitHub(store),
    new Workspaces(join(root, 'ws'), store),
    root,
    () => new Model(),
    { stallMs: 100 },
  );
  try {
    await engine.start();
    const first = store.addMessage(project.id, 'user', 'First', 'discuss');
    const second = store.addMessage(project.id, 'user', 'Second', 'discuss');
    const firstReply = engine.chat(first).catch((error) => error);
    const secondReply = engine.chat(second);
    await until(() => turns === 1, 'first turn started');
    await new Promise((r) => setTimeout(r, 150));
    await engine.tick();
    assert.match(String(await firstReply), /Watchdog/);
    assert.equal(await secondReply, 'second answer');
    assert.equal(store.get('message', first.id)?.status, 'failed');
    const failed = store.list('run').find((run) => run.status === 'failed');
    assert.match(failed?.error ?? '', /无事件/);
    assert.ok(store.events().some((event) => event.type === 'watchdog'));
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('watchdog stops a Dev repeating one command without edits and hands it to an Incident', async () => {
  const { root, store, task, github } = await devFixture('phantom-watchdog-dev-');
  class Model extends Codex {
    writable = false;
    override async start() {}
    override async stop() {}
    override async thread(options: Parameters<Codex['thread']>[0]) {
      this.writable = options.writable;
      return this.writable ? 'dev' : 'pm';
    }
    override async turn(thread: string, _prompt: string, _profile: any, signal?: AbortSignal) {
      if (!this.writable) return 'Incident noted';
      for (let i = 0; i < 5; i++)
        this.emit('notification', 'item/completed', {
          threadId: thread,
          item: {
            type: 'commandExecution',
            command: 'npm test',
            exitCode: 1,
            aggregatedOutput: '',
          },
        });
      return hang(signal);
    }
  }
  const engine = new Engine(
    store,
    github,
    new Workspaces(join(root, 'ws'), store),
    root,
    () => new Model(),
    { stallMs: 60_000, loopRepeats: 5 },
  );
  try {
    await engine.start();
    await engine.tick();
    const devRun = () => store.list('run').find((run) => run.role === 'dev');
    await until(() => !!devRun(), 'dev started');
    await until(() => {
      void engine.tick();
      return devRun()?.status === 'failed';
    }, 'watchdog failed the looping Dev run');
    assert.match(devRun()?.error ?? '', /重复/);
    await until(
      () => store.list('incident').some((incident) => incident.phase === 'dev'),
      'an Incident was raised for PM assessment',
    );
    // As for any Dev failure, the Task is paused once the PM has assessed the Incident.
    await until(() => store.task(task.id).control === 'paused', 'task paused after assessment');
    assert.match(store.task(task.id).blocked ?? '', /Watchdog/);
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
