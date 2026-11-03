import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { devFixture, until } from './dev-fixture.ts';

test('pausing a Task during host validation is not reported as an environment block', async () => {
  const { root, store, repo, task, github } = await devFixture('phantom-validation-pause-');
  store.patchRepo(repo.id, {
    commands: {
      install: '',
      build: '',
      test: 'node -e "setTimeout(() => {}, 60000)"',
      start: '',
      port: 3000,
    },
  });
  class Model extends Codex {
    override async start() {}
    override async stop() {}
    override async thread() {
      return 'dev';
    }
    override async turn() {
      await writeFile(join(store.task(task.id).worktree!, 'a.txt'), 'done\n');
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
    await until(() => !!store.task(task.id).head, 'host finalized and validation started');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    engine.control(task.id, 'pause');
    await until(() => store.activeRuns().length === 0, 'validation stopped');
    assert.doesNotMatch(store.task(task.id).blocked ?? '', /环境阻塞/);
    assert.equal(store.list('incident').length, 0);
  } finally {
    await engine.stop();
    store.close();
    // Windows releases a killed validation process's cwd handle shortly after taskkill returns.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
