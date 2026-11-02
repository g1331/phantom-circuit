import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { devFixture, until } from './dev-fixture.ts';
import { command } from '../src/server/process.ts';
import type { Task } from '../src/shared/types.ts';

/** A Dev whose turns write the given contents in order; it records every prompt it was sent. */
function devModel(task: () => Task, contents: string[], prompts: string[]) {
  return class extends Codex {
    override async start() {}
    override async stop() {}
    override async thread() {
      return 'dev';
    }
    override async turn(_thread: string, prompt: string) {
      prompts.push(prompt);
      await writeFile(join(task().worktree!, 'log.txt'), contents.shift()!);
      return 'done';
    }
  };
}

test('a Dev change that fails git diff --check gets one fix turn in the same Run', async () => {
  const { root, store, task, github } = await devFixture('phantom-diff-check-');
  github.publishPR = async () => ({}) as never;
  const prompts: string[] = [];
  const Model = devModel(
    () => store.task(task.id),
    ['build log line   \r\n', 'build log line\n'],
    prompts,
  );
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
    await until(() => store.task(task.id).stage === 'reviewing', 'fixed and delivered');
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /trailing whitespace/);
    assert.equal(store.task(task.id).retries, 0, 'a whitespace fix is not a product rework');
    assert.equal(store.list('incident').length, 0);
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('uncommitted Dev work does not block integrating a moved base', async () => {
  const { root, store, task, github } = await devFixture('phantom-diff-check-moved-');
  github.publishPR = async () => ({}) as never;
  const prepared = await new Workspaces(join(root, 'ws'), store).prepare(task);
  // The Dev was interrupted mid-implementation, then the default branch moved on.
  await writeFile(join(prepared.worktree!, 'log.txt'), 'build log line   \r\n');
  const source = join(root, 'source');
  await writeFile(join(source, 'other.cjs'), 'module.exports = 2;\n');
  for (const args of [
    ['add', '.'],
    ['commit', '-m', 'Moved'],
    ['push', 'origin', 'main'],
  ])
    await command('git', args, source);
  store.updateTask(task.id, { stage: 'developing', devPhase: 'implement' });
  const prompts: string[] = [];
  const Model = devModel(
    () => store.task(task.id),
    ['build log line   \r\n', 'build log line\n'],
    prompts,
  );
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
    await until(() => store.task(task.id).stage === 'reviewing', 'integrated and delivered');
    const head = store.task(task.id).head!;
    const tree = await command('git', ['ls-tree', '--name-only', head], prepared.worktree!);
    assert.match(tree.stdout, /other\.cjs/, 'the moved base is integrated');
    assert.equal(store.list('incident').length, 0);
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('resuming a finalize whose change fails git diff --check lets the next Dev Run fix it', async () => {
  const { root, store, task, github } = await devFixture('phantom-diff-check-resume-');
  github.publishPR = async () => ({}) as never;
  const prompts: string[] = [];
  const Model = devModel(() => store.task(task.id), ['build log line\n'], prompts);
  const ws = new Workspaces(join(root, 'ws'), store);
  const engine = new Engine(store, github, ws, root, () => new Model());
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
    assert.equal(store.task(task.id).control, 'active');
    assert.equal(store.task(task.id).blocked, undefined);
    await engine.start();
    await engine.tick();
    await until(() => store.task(task.id).stage === 'reviewing', 'fixed on the next Run');
    assert.match(prompts[0], /trailing whitespace/);
    assert.equal(store.task(task.id).retries, 0);
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
