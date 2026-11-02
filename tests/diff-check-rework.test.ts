import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { devFixture, until } from './dev-fixture.ts';

test('a Dev change that fails git diff --check goes back to the Dev as rework, not an Incident', async () => {
  const { root, store, task, github } = await devFixture('phantom-diff-check-');
  github.publishPR = async () => ({}) as never;
  const contents = ['build log line   \r\n', 'build log line\n'];
  class Model extends Codex {
    override async start() {}
    override async stop() {}
    override async thread() {
      return 'dev';
    }
    override async turn() {
      await writeFile(join(store.task(task.id).worktree!, 'log.txt'), contents.shift()!);
      return 'done';
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
    await until(() => store.task(task.id).retries === 1, 'first round reworked');
    assert.equal(store.list('incident').length, 0, 'whitespace is the Dev’s to fix');
    assert.match(store.task(task.id).feedback.at(-1)!, /trailing whitespace/);
    assert.equal(store.task(task.id).control, 'active');
    await engine.tick();
    await until(() => store.task(task.id).stage === 'reviewing', 'clean second round');
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('resuming a paused finalize whose change fails git diff --check reopens the Dev, not a block', async () => {
  const { root, store, task, github } = await devFixture('phantom-diff-check-resume-');
  const ws = new Workspaces(join(root, 'ws'), store);
  const engine = new Engine(store, github, ws, root, () => new Codex());
  try {
    const prepared = await ws.prepare(task);
    await writeFile(join(prepared.worktree!, 'log.txt'), 'build log line   \r\n');
    store.updateTask(task.id, {
      stage: 'developing',
      devPhase: 'finalize',
      control: 'paused',
      pausedByUser: false,
    });
    await engine.resume(task.id);
    const resumed = store.task(task.id);
    assert.equal(resumed.control, 'active');
    assert.equal(resumed.devPhase, 'implement');
    assert.equal(resumed.blocked, undefined);
    assert.match(resumed.feedback.at(-1)!, /trailing whitespace/);
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
