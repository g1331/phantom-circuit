import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { devFixture, hang } from './dev-fixture.ts';

test('a rework round that leaves the head unchanged reuses its passing validation', async () => {
  const { root, store, repo, task, github } = await devFixture('phantom-validation-reuse-');
  github.publishPR = async () => ({}) as never;
  github.reviewComment = async () => {};
  const counter = join(root, 'runs.txt');
  await writeFile(join(root, 'count.cjs'), `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x');`);
  store.patchRepo(repo.id, {
    commands: { install: '', build: '', test: `node "${join(root, 'count.cjs')}"`, start: '', port: 3000 },
  });
  let reviews = 0;
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
    override async turn(_thread: string, _prompt: string, _profile: unknown, signal?: AbortSignal) {
      if (this.role === 'dev') {
        // Both rounds hand in the same work: the second answers an evidence question, not a defect.
        await writeFile(join(store.task(task.id).worktree!, 'a.txt'), 'done\n');
        return 'done';
      }
      reviews++;
      if (reviews > 1) return hang(signal);
      const current = store.task(task.id);
      const verdict = {
        approved: false,
        summary: 'Explain the change in the handoff.',
        findings: ['Explain the change in the handoff.'],
        verdict: 'rework',
        head: current.head,
        base: current.base,
        tests: current.tests,
      };
      await this.handler?.('submit_review', verdict);
      return JSON.stringify(verdict);
    }
  }
  const engine = new Engine(store, github, new Workspaces(join(root, 'ws'), store), root, () => new Model());
  try {
    await engine.start();
    for (let i = 0; i < 1200 && reviews < 2; i++) {
      await engine.tick();
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(reviews, 2, JSON.stringify(store.task(task.id)));
    assert.equal(store.task(task.id).retries, 1);
    assert.equal(await readFile(counter, 'utf8'), 'x', 'the unchanged head is validated once');
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
