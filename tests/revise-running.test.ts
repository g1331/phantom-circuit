import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { devFixture, hang, until } from './dev-fixture.ts';

test('a user-authorized revision preempts the running Dev instead of being refused', async () => {
  const { root, store, project, task, github } = await devFixture('phantom-revise-running-');
  github.reviseIssue = async () => {};
  let revision: unknown;
  class Model extends Codex {
    writable = false;
    handler?: Parameters<Codex['thread']>[0]['toolHandler'];
    override async start() {}
    override async stop() {}
    override async thread(options: Parameters<Codex['thread']>[0]) {
      this.writable = options.writable;
      this.handler = options.toolHandler;
      return this.writable ? 'dev' : 'pm';
    }
    override async turn(_thread: string, _prompt: string, _profile: any, signal?: AbortSignal) {
      if (this.writable) return hang(signal);
      revision = await this.handler!('revise_task', {
        taskId: task.id,
        spec: 'Do it the clarified way',
        acceptance: ['Clarified'],
        guidance: 'The user answered the clarification',
      }).catch((error: unknown) => String(error));
      return 'revised';
    }
  }
  const engine = new Engine(
    store,
    github,
    new Workspaces(join(root, 'ws'), store),
    root,
    () => new Model(),
  );
  try {
    await engine.start();
    await engine.tick();
    const devRun = () => store.list('run').find((run) => run.role === 'dev');
    await until(() => devRun()?.status === 'running', 'dev running');
    await engine.chat(
      store.addMessage(project.id, 'user', 'Clarified: do it that way', 'implement'),
    );
    assert.equal(typeof revision, 'object', `revise_task was refused: ${String(revision)}`);
    assert.equal(store.task(task.id).spec, 'Do it the clarified way');
    assert.equal(store.task(task.id).control, 'active');
    assert.equal(store.task(task.id).pausedByUser, false);
    assert.equal(devRun()?.status, 'paused');
    assert.equal(store.list('incident').length, 0, 'a preempted Dev is not a delivery failure');
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
