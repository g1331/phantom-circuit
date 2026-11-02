import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { Store } from '../src/server/store.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { GitHub } from '../src/server/github.ts';
import { devFixture, hang, until } from './dev-fixture.ts';

test('a recovered Review runs after startup instead of holding the scheduler barrier', async () => {
  const f = await devFixture('phantom-recovery-review-');
  f.github.publishPR = async () => ({}) as never;
  let reviewTurns = 0;
  class Model extends Codex {
    writable = false;
    override async start() {}
    override async stop() {}
    override async thread(options: Parameters<Codex['thread']>[0]) {
      this.writable = options.writable;
      return this.writable ? 'dev' : 'review';
    }
    override async turn(_thread: string, _prompt: string, _profile: any, signal?: AbortSignal) {
      if (this.writable) {
        await writeFile(join(store.task(f.task.id).worktree!, 'a.txt'), 'done\n');
        return 'done';
      }
      reviewTurns++;
      return hang(signal);
    }
  }
  let store = f.store;
  let engine = new Engine(
    store,
    f.github,
    new Workspaces(join(f.root, 'ws'), store),
    f.root,
    () => new Model(),
  );
  try {
    await engine.start();
    await engine.tick();
    await until(() => store.task(f.task.id).stage === 'reviewing', 'reviewing');
    await engine.stop();
    // Host crash mid-review: the Review Run stays recorded as running.
    const task = store.task(f.task.id);
    store.run('review', task.projectId, 'review', task, {
      reviewAxis: 'primary',
      revision: { head: task.head, base: task.base },
    });
    store.close();
    const before = reviewTurns;

    store = new Store(join(f.root, 'db.sqlite'));
    class Remote extends GitHub {
      override async api<T = any>(): Promise<T> {
        return { state: 'open', body: 'body' } as T;
      }
      override async syncStatus() {}
    }
    engine = new Engine(
      store,
      new Remote(store),
      new Workspaces(join(f.root, 'ws'), store),
      f.root,
      () => new Model(),
    );
    const started = await Promise.race([
      engine.start().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15000)),
    ]);
    assert.equal(started, true, 'startup must not wait for the recovered Review to finish');
    await until(() => reviewTurns === before + 1, 'recovered review turn');
    await engine.tick();
    await engine.tick();
    const running = store.activeRuns().filter((r) => r.role === 'review');
    assert.equal(running.length, 1, 'the scheduler must not launch a duplicate Review');
  } finally {
    await engine.stop();
    store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
