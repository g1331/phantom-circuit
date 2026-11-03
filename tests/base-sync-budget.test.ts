import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { devFixture } from './dev-fixture.ts';

test('a base that moved before merge resyncs without spending the product rework budget', async () => {
  const { root, store, task, github } = await devFixture('phantom-base-sync-');
  github.publishPR = async () => ({}) as never;
  github.reviewComment = async () => {};
  // Another change landed on the default branch while this Task was in review.
  github.pull = async (t) =>
    ({ merged: false, head: { sha: t.head }, base: { sha: 'moved-on' } }) as never;
  class Model extends Codex {
    role = '';
    handler?: Parameters<Codex['thread']>[0]['toolHandler'];
    override async start() {}
    override async stop() {}
    override async thread(o: Parameters<Codex['thread']>[0]) {
      this.role = o.instructions.includes('Independent Review') ? 'review' : 'dev';
      this.handler = o.toolHandler;
      return this.role;
    }
    override async turn() {
      if (this.role === 'dev') {
        await writeFile(join(store.task(task.id).worktree!, 'a.txt'), 'done\n');
        return 'done';
      }
      const current = store.task(task.id);
      const verdict = {
        approved: true,
        summary: 'Matches the task.',
        findings: [],
        verdict: 'pass',
        head: current.head,
        base: current.base,
        tests: current.tests,
      };
      await this.handler?.('submit_review', verdict);
      return JSON.stringify(verdict);
    }
  }
  const engine = new Engine(store, github, new Workspaces(join(root, 'ws'), store), root, () => new Model());
  const resynced = () => store.task(task.id).feedback.some((f) => f.includes('基线发生变化'));
  try {
    await engine.start();
    for (let i = 0; i < 1200 && !resynced(); i++) {
      await engine.tick();
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(resynced(), JSON.stringify(store.task(task.id)));
    assert.equal(store.task(task.id).retries, 0);
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
