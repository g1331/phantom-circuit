import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { devFixture, hang } from './dev-fixture.ts';

type Handler = NonNullable<Parameters<Codex['thread']>[0]['toolHandler']>;

/** A validation that fails on its first run only, as a port collision or a loaded machine does. */
async function scenario(prefix: string, oncall: (tool: Handler) => Promise<void>) {
  const { root, store, repo, task, github } = await devFixture(prefix);
  github.publishPR = async () => ({}) as never;
  github.reviewComment = async () => {};
  const marker = join(root, 'ran-once');
  await writeFile(
    join(root, 'flaky.cjs'),
    `const fs = require('fs'); const m = ${JSON.stringify(marker)};\nif (!fs.existsSync(m)) { fs.writeFileSync(m, ''); console.error('EADDRINUSE 4318'); process.exit(1); }`,
  );
  store.patchRepo(repo.id, {
    commands: { install: '', build: '', test: `node "${join(root, 'flaky.cjs')}"`, start: '', port: 3000 },
  });
  const devPrompts: string[] = [];
  let reviewed = false;
  class Model extends Codex {
    role = '';
    handler?: Handler;
    override async start() {}
    override async stop() {}
    override async thread(o: Parameters<Codex['thread']>[0]) {
      this.role = o.instructions.includes('Independent Review')
        ? 'review'
        : o.instructions.includes('On-call')
          ? 'oncall'
          : 'dev';
      this.handler = o.toolHandler;
      return this.role;
    }
    override async turn(_thread: string, prompt: string, _profile: unknown, signal?: AbortSignal) {
      if (this.role === 'oncall') {
        await oncall(this.handler!);
        return 'settled';
      }
      if (this.role === 'review') {
        reviewed = true;
        return hang(signal);
      }
      devPrompts.push(prompt);
      await writeFile(join(store.task(task.id).worktree!, 'a.txt'), `round ${devPrompts.length}\n`);
      return 'done';
    }
  }
  const engine = new Engine(store, github, new Workspaces(join(root, 'ws'), store), root, () => new Model());
  const run = async (until: () => boolean) => {
    await engine.start();
    for (let i = 0; i < 1200 && !until(); i++) {
      await engine.tick();
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(until(), JSON.stringify(store.task(task.id)));
  };
  const close = async () => {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  return { store, task, devPrompts, reviewed: () => reviewed, run, close };
}

test('on-call retries an environmental validation failure after a passing rerun, without a rework round', async () => {
  let premature: unknown;
  const s = await scenario('phantom-oncall-retry-', async (tool) => {
    premature = await tool('settle', { action: 'retry', diagnosis: 'flaky' }).catch((e) => e);
    const rerun = (await tool('rerun_validation', {})) as { exitCode: number }[];
    assert.ok(rerun.every((t) => t.exitCode === 0));
    await tool('settle', { action: 'retry', diagnosis: '端口被宿主外进程短暂占用，重跑通过。' });
  });
  try {
    await s.run(s.reviewed);
    assert.match(String(premature), /rerun_validation/, 'retry needs a passing rerun first');
    assert.equal(s.devPrompts.length, 1, 'no extra Dev turn');
    assert.equal(s.store.task(s.task.id).retries, 0);
    const incident = s.store.list('incident').find((i) => i.taskId === s.task.id)!;
    assert.equal(incident.phase, 'validation');
    assert.equal(incident.status, 'resolved');
  } finally {
    await s.close();
  }
});

test('on-call rework hands its diagnosis to the Dev', async () => {
  const s = await scenario('phantom-oncall-rework-', async (tool) => {
    await tool('settle', { action: 'rework', diagnosis: '测试依赖固定端口 4318，改用空闲端口。' });
  });
  try {
    await s.run(() => s.devPrompts.length >= 2);
    assert.match(s.devPrompts[1], /改用空闲端口/);
    assert.equal(s.store.task(s.task.id).retries, 1);
  } finally {
    await s.close();
  }
});

test('on-call asks the user in product terms and pauses the task', async () => {
  const question = '测试需要访问内网服务，能否开通这台机器的访问权限？';
  const s = await scenario('phantom-oncall-ask-', async (tool) => {
    await tool('settle', { action: 'ask_user', diagnosis: 'needs network access', question });
  });
  const paused = () => s.store.task(s.task.id).blocked === question;
  try {
    await s.run(paused);
    assert.equal(s.store.task(s.task.id).control, 'paused');
    assert.ok(s.store.list('message').some((m) => m.role === 'assistant' && m.content.includes(question)));
    assert.equal(s.devPrompts.length, 1);
  } finally {
    await s.close();
  }
});
