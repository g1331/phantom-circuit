import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { devFixture, hang, until } from './dev-fixture.ts';

type Handler = NonNullable<Parameters<Codex['thread']>[0]['toolHandler']>;

/** A Task whose Dev has handed in and whose review hangs, so its owner is around to talk. */
async function scenario(prefix: string, owner: (tool: Handler) => Promise<void>) {
  const { root, store, task, github } = await devFixture(prefix);
  github.publishPR = async () => ({}) as never;
  github.reviewComment = async () => {};
  const ownerTurns: { writable: boolean; ephemeral?: boolean }[] = [];
  const liaisonPrompts: string[] = [];
  let reviewed = false;
  class Model extends Codex {
    options?: Parameters<Codex['thread']>[0];
    override async start() {}
    override async stop() {}
    override async thread(o: Parameters<Codex['thread']>[0]) {
      this.options = o;
      return 'thread';
    }
    override async turn(_thread: string, prompt: string, _profile: unknown, signal?: AbortSignal) {
      const o = this.options!;
      if (prompt.includes('## 用户直接找你')) {
        ownerTurns.push({ writable: o.writable, ephemeral: o.ephemeral });
        await owner(o.toolHandler!);
        return 'answered';
      }
      if (prompt.includes('talking directly with the owner')) {
        liaisonPrompts.push(prompt);
        return '可以改成蓝色，我已经更新了任务要求。';
      }
      if (o.instructions.includes('Independent Review')) {
        reviewed = true;
        return hang(signal);
      }
      await writeFile(join(store.task(task.id).worktree!, 'a.txt'), 'implemented\n');
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
  const tickUntil = async (done: () => boolean, label: string) => {
    for (let i = 0; i < 1200 && !done(); i++) {
      await engine.tick();
      await new Promise((r) => setTimeout(r, 25));
    }
    await until(done, label);
  };
  const lines = () => store.list('ownerMessage').filter((m) => m.taskId === task.id);
  const close = async () => {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  return {
    store,
    task,
    engine,
    ownerTurns,
    liaisonPrompts,
    reviewed: () => reviewed,
    tickUntil,
    lines,
    close,
  };
}

test('the user asks the owner directly; the owner answers read-only and the liaison gets a summary', async () => {
  const s = await scenario('phantom-owner-ask-', async (tool) => {
    await tool('reply', {
      answer: '代码写完了，正在独立评审。',
      summary: '用户问进度，已说明在评审。',
    });
  });
  try {
    assert.throws(() => s.store.addOwnerMessage(s.task.id, '谁在做？'), /还没有负责人/);
    await s.engine.start();
    await s.tickUntil(s.reviewed, 'review started');
    const question = s.store.addOwnerMessage(s.task.id, '现在做到哪了？');
    await s.tickUntil(() => s.lines().some((m) => m.role === 'owner'), 'owner answered');
    assert.equal(s.lines().find((m) => m.role === 'owner')!.content, '代码写完了，正在独立评审。');
    assert.equal(s.store.get('ownerMessage', question.id)!.status, 'answered');
    assert.deepEqual(s.ownerTurns, [{ writable: false, ephemeral: true }]);
    assert.ok(
      s.store
        .list('message')
        .some((m) => m.role === 'system' && m.content.includes('用户问进度，已说明在评审。')),
      'the liaison reads the summary in the project conversation',
    );
    const task = s.store.task(s.task.id);
    assert.equal(task.stage, 'reviewing', 'answering does not move the work');
    assert.equal(task.retries ?? 0, 0);
  } finally {
    await s.close();
  }
});

test('a change of direction asked of the owner goes to the liaison before the owner answers', async () => {
  let liaison: unknown;
  const s = await scenario('phantom-owner-align-', async (tool) => {
    liaison = await tool('align_with_liaison', { request: '用户想把按钮改成蓝色，属于验收变更。' });
    await tool('reply', {
      answer: `联络人的答复：${(liaison as { answer: string }).answer}`,
      summary: '用户要求按钮改蓝色，已转联络人并获同意。',
    });
  });
  try {
    await s.engine.start();
    await s.tickUntil(s.reviewed, 'review started');
    s.store.addOwnerMessage(s.task.id, '按钮能改成蓝色吗？');
    await s.tickUntil(() => s.lines().some((m) => m.role === 'owner'), 'owner answered');
    assert.equal(s.liaisonPrompts.length, 1);
    assert.match(
      s.liaisonPrompts[0],
      /按钮能改成蓝色吗？/,
      "the liaison sees the user's own words",
    );
    assert.match(s.lines().find((m) => m.role === 'owner')!.content, /已经更新了任务要求/);
  } finally {
    await s.close();
  }
});

test('a restart during an owner answer fails only the question; the work keeps going', async () => {
  const { root, store, task } = await devFixture('phantom-owner-restart-');
  try {
    store.updateTask(task.id, { worktree: root });
    const question = store.addOwnerMessage(task.id, '还要多久？');
    const run = store.run('dev', task.projectId, task.profile, store.task(task.id), {
      ownerMessageId: question.id,
    });
    store.recover();
    assert.equal(store.get('run', run.id)!.status, 'interrupted');
    assert.equal(store.get('ownerMessage', question.id)!.status, 'failed');
    assert.equal(store.task(task.id).control, 'active', 'a read-only answer never pauses the Task');
    assert.ok(!store.list('recovery').some((item) => item.oldRunId === run.id));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
