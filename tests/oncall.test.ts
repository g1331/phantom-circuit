import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { devFixture, hang } from './dev-fixture.ts';
import { command } from '../src/server/process.ts';

type Handler = NonNullable<Parameters<Codex['thread']>[0]['toolHandler']>;

/** A validation that fails on its first run only, as a port collision or a loaded machine does. */
async function scenario(
  prefix: string,
  oncall: (tool: Handler, worktree: string) => Promise<void>,
) {
  const { root, store, repo, task, github } = await devFixture(prefix);
  github.publishPR = async () => ({}) as never;
  github.reviewComment = async () => {};
  const marker = join(root, 'ran-once');
  await writeFile(
    join(root, 'flaky.cjs'),
    `const fs = require('fs'); const m = ${JSON.stringify(marker)};\nif (!fs.existsSync(m)) { fs.writeFileSync(m, ''); console.error('EADDRINUSE 4318'); process.exit(1); }`,
  );
  store.patchRepo(repo.id, {
    commands: {
      install: '',
      build: '',
      test: `node "${join(root, 'flaky.cjs')}"`,
      start: '',
      port: 3000,
    },
  });
  const devPrompts: string[] = [];
  const validationThreads: (string | undefined)[] = [];
  let reviewed = false;
  class Model extends Codex {
    role = '';
    handler?: Handler;
    override async start() {}
    override async stop() {}
    override async thread(o: Parameters<Codex['thread']>[0]) {
      this.role = o.instructions.includes('Independent Review') ? 'review' : 'dev';
      this.handler = o.toolHandler;
      if (o.tools?.some((tool) => tool.name === 'settle')) validationThreads.push(o.threadId);
      return `${this.role}-thread`;
    }
    override async turn(_thread: string, prompt: string, _profile: unknown, signal?: AbortSignal) {
      if (prompt.includes('## 正式验证失败')) {
        await oncall(this.handler!, store.task(task.id).worktree!);
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
  const engine = new Engine(
    store,
    github,
    new Workspaces(join(root, 'ws'), store),
    root,
    () => new Model(),
  );
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
  return { root, store, task, devPrompts, validationThreads, reviewed: () => reviewed, run, close };
}

test('the Dev retries an environmental validation failure after a passing rerun, without a rework round', async () => {
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
    assert.deepEqual(s.validationThreads, ['dev-thread'], 'the Dev who wrote the code handles it');
    assert.equal(s.devPrompts.length, 1, 'no extra implementation turn');
    assert.equal(s.store.task(s.task.id).retries, 0);
    const incident = s.store.list('incident').find((i) => i.taskId === s.task.id)!;
    assert.equal(incident.phase, 'validation');
    assert.equal(incident.status, 'resolved');
  } finally {
    await s.close();
  }
});

test('the Dev fixes a defect the validation found; the host commits and revalidates it as one round', async () => {
  const refused: unknown[] = [];
  const s = await scenario('phantom-oncall-fixed-', async (tool, worktree) => {
    refused.push(await tool('settle', { action: 'fixed', diagnosis: 'nothing' }).catch((e) => e));
    await writeFile(join(worktree, 'a.txt'), 'fixed port\n');
    refused.push(await tool('rerun_validation', {}).catch((e) => e));
    refused.push(await tool('settle', { action: 'retry', diagnosis: 'flaky' }).catch((e) => e));
    await tool('settle', { action: 'fixed', diagnosis: '测试依赖固定端口 4318，改用空闲端口。' });
  });
  try {
    await s.run(s.reviewed);
    assert.match(String(refused[0]), /没有改动/, 'fixed needs an edit');
    assert.match(String(refused[1]), /未提交改动/, 'no rerun over uncommitted edits');
    assert.match(String(refused[2]), /未提交改动/, 'no retry over uncommitted edits');
    assert.equal(
      s.devPrompts.length,
      1,
      'the host commits the fix without another implementation turn',
    );
    const task = s.store.task(s.task.id);
    assert.equal(task.retries, 1);
    assert.ok(task.feedback.some((f) => f.includes('改用空闲端口')));
    assert.ok(
      task.tests.length && task.tests.every((t) => t.exitCode === 0 && t.head === task.head),
    );
    const { stdout } = await command('git', ['show', `${task.head}:a.txt`], task.worktree!);
    assert.equal(stdout.trim(), 'fixed port');
  } finally {
    await s.close();
  }
});

test('the Dev asks the user in product terms and pauses the task', async () => {
  const question = '测试需要访问内网服务，能否开通这台机器的访问权限？';
  const s = await scenario('phantom-oncall-ask-', async (tool) => {
    await tool('settle', { action: 'ask_user', diagnosis: 'needs network access', question });
  });
  const paused = () => s.store.task(s.task.id).blocked === question;
  try {
    await s.run(paused);
    assert.equal(s.store.task(s.task.id).control, 'paused');
    assert.ok(
      s.store.list('message').some((m) => m.role === 'assistant' && m.content.includes(question)),
    );
    assert.equal(s.devPrompts.length, 1);
  } finally {
    await s.close();
  }
});

test('the Dev resyncs a trunk failure once the trunk moved, without spending a rework round', async () => {
  let unchanged: unknown;
  let root = '';
  const s = await scenario('phantom-oncall-resync-', async (tool) => {
    unchanged = await tool('settle', { action: 'resync', diagnosis: 'trunk' }).catch((e) => e);
    // The trunk fix lands while the Dev is diagnosing.
    const source = join(root, 'source');
    await writeFile(join(source, 'fix.txt'), 'trunk fix\n');
    await command('git', ['add', '.'], source);
    await command('git', ['commit', '-m', 'Trunk fix'], source);
    await command('git', ['push', 'origin', 'main'], source);
    await tool('settle', { action: 'resync', diagnosis: '主干上的测试本身失败，主干已修复。' });
  });
  root = s.root;
  try {
    await s.run(() => s.devPrompts.length >= 2);
    assert.match(String(unchanged), /主干/, 'resync needs a trunk that moved');
    assert.equal(s.store.task(s.task.id).retries, 0);
    assert.match(s.devPrompts[1], /同步主干后重新验证/);
  } finally {
    await s.close();
  }
});

test('a host crash while the Dev handles a failed validation resumes in the same Dev thread', async () => {
  const { root, store, repo, task, github } = await devFixture('phantom-oncall-crash-');
  github.publishPR = async () => ({}) as never;
  github.reviewComment = async () => {};
  const marker = join(root, 'ran-once');
  await writeFile(
    join(root, 'flaky.cjs'),
    `const fs = require('fs'); const m = ${JSON.stringify(marker)}; if (!fs.existsSync(m)) { fs.writeFileSync(m, ''); console.error('EADDRINUSE 4318'); process.exit(1); }`,
  );
  store.patchRepo(repo.id, {
    commands: {
      install: '',
      build: '',
      test: `node "${join(root, 'flaky.cjs')}"`,
      start: '',
      port: 3000,
    },
  });
  let crashed = false;
  let reviewed = false;
  const validationThreads: (string | undefined)[] = [];
  class Model extends Codex {
    role = '';
    handler?: Handler;
    override async start() {}
    override async stop() {}
    override async thread(o: Parameters<Codex['thread']>[0]) {
      this.role = o.instructions.includes('Independent Review') ? 'review' : 'dev';
      this.handler = o.toolHandler;
      if (o.tools?.some((tool) => tool.name === 'settle')) validationThreads.push(o.threadId);
      return `${this.role}-thread`;
    }
    override async turn(_thread: string, prompt: string, _profile: unknown, signal?: AbortSignal) {
      if (prompt.includes('## 正式验证失败')) {
        // The first host dies while the Dev is still diagnosing.
        if (!crashed) return hang(signal);
        await this.handler!('rerun_validation', {});
        await this.handler!('settle', { action: 'retry', diagnosis: '端口被占用，重跑通过。' });
        return 'settled';
      }
      if (this.role === 'review') {
        reviewed = true;
        return hang(signal);
      }
      await writeFile(join(store.task(task.id).worktree!, 'a.txt'), 'implemented\n');
      return 'done';
    }
  }
  const host = () =>
    new Engine(store, github, new Workspaces(join(root, 'ws'), store), root, () => new Model());
  const first = host();
  const second = host();
  const until = async (engine: Engine, done: () => boolean) => {
    for (let i = 0; i < 1200 && !done(); i++) {
      await engine.tick();
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(
      done(),
      JSON.stringify({
        runs: store.list('run').map((r) => [r.role, r.status, r.incidentPhase, r.error]),
        incidents: store.list('incident').map((i) => [i.status, i.assessmentRunId]),
      }),
    );
  };
  try {
    await first.start();
    const handling = () =>
      store.activeRuns().find((r) => r.role === 'dev' && r.incidentPhase === 'validation');
    await until(first, () => !!handling());
    const interrupted = handling()!;
    // A crash: the first host stops scheduling but never finishes its Runs.
    clearInterval((first as any).timer);
    crashed = true;
    await second.start();
    await until(second, () => reviewed);
    assert.deepEqual(
      validationThreads,
      ['dev-thread', 'dev-thread'],
      'both the interrupted and the recovered handling continue the Dev thread',
    );
    assert.equal(store.get('run', interrupted.id)?.status, 'interrupted');
    const recovery = store.list('recovery').find((item) => item.oldRunId === interrupted.id)!;
    const successor = store.get('run', recovery.successorRunId!)!;
    assert.equal(successor.role, 'dev');
    assert.equal(successor.incidentPhase, 'validation');
    assert.equal(store.get('incident', interrupted.incidentId!)?.status, 'resolved');
    assert.equal(store.task(task.id).retries, 0, 'an environmental failure spends no round');
  } finally {
    await second.stop();
    await first.stop();
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
