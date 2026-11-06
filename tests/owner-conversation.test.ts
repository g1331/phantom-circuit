import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import type { AgentReadOnlyForkOptions } from '../src/server/agent-backend.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { devFixture, hang, until } from './dev-fixture.ts';

const decision = '使用 37 桶按用户分片，避免同一用户请求乱序。';
const answer = (text = decision) =>
  JSON.stringify({ result: { kind: 'answer', answer: text, summary: '已解释实现决定。' } });

/** Only the model and GitHub are fixtures. Git workspaces, Engine and Store are real. */
async function scenario(
  options: {
    live?: boolean;
    forkError?: boolean;
    beforeThread?: () => Promise<void>;
    owner?: (prompt: string, signal?: AbortSignal) => Promise<string>;
    ownerStop?: () => Promise<void>;
  } = {},
) {
  const { root, store, task, github } = await devFixture('phantom-owner-context-');
  github.publishPR = async () => ({}) as never;
  github.reviewComment = async () => {};
  const history = new Map<string, string[]>();
  const forks: AgentReadOnlyForkOptions[] = [];
  const ownerThreads: string[] = [];
  const liaisonPrompts: string[] = [];
  let reviewed = false;
  let developing = false;
  let devInterrupted = false;
  let serial = 0;
  class Model extends Codex {
    options?: Parameters<Codex['thread']>[0];
    isOwner = false;
    override async start() {}
    override async stop() {
      if (this.isOwner) await options.ownerStop?.();
    }
    override async thread(o: Parameters<Codex['thread']>[0]) {
      this.options = o;
      const id = o.threadId ?? `thread-${++serial}`;
      if (!history.has(id)) history.set(id, []);
      await options.beforeThread?.();
      return id;
    }
    async forkReadOnlyThread(o: AgentReadOnlyForkOptions) {
      this.isOwner = true;
      forks.push(o);
      if (options.forkError) throw new Error('source unavailable');
      const inherited = history.get(o.sourceThreadId);
      if (!inherited) throw new Error('missing source');
      const id = `fork-${++serial}`;
      history.set(id, [...inherited]);
      ownerThreads.push(id);
      return id;
    }
    override async turn(thread: string, prompt: string, _profile: unknown, signal?: AbortSignal) {
      if (prompt.includes('## 用户直接找你')) {
        assert.notEqual(thread, store.task(task.id).devThreadId);
        assert.ok(
          history.get(thread)?.includes(decision),
          'answer requires the inherited implementation history, absent from handoff',
        );
        return options.owner
          ? options.owner(prompt, signal)
          : answer(history.get(thread)!.join('\n'));
      }
      if (prompt.includes('PM decision for this owner conversation')) {
        assert.ok(liaisonPrompts.length > 0);
        assert.ok(ownerThreads.includes(thread), 'alignment resumes the same independent fork');
        return answer('联络人已决定可以改蓝色。');
      }
      if (prompt.includes('talking directly with the owner')) {
        liaisonPrompts.push(prompt);
        return '可以改成蓝色，我已经更新了任务要求。';
      }
      if (this.options!.instructions.includes('Independent Review')) {
        reviewed = true;
        return hang(signal);
      }
      history.get(thread)!.push(decision);
      developing = true;
      if (options.live) {
        signal?.addEventListener('abort', () => {
          devInterrupted = true;
        });
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
    forks,
    history,
    liaisonPrompts,
    reviewed: () => reviewed,
    developing: () => developing,
    devInterrupted: () => devInterrupted,
    tickUntil,
    lines,
    close,
  };
}

test('owner answers from an independent native branch of the working history while Dev keeps running', async () => {
  const s = await scenario({ live: true });
  try {
    await s.engine.start();
    await s.tickUntil(s.developing, 'Dev started');
    const source = s.store.task(s.task.id).devThreadId!;
    const sourceRun = s.store.list('run').find((r) => r.threadId === source)!;
    for (const content of ['为什么这样分片？', '这样会不会乱序？']) {
      const question = s.store.addOwnerMessage(s.task.id, content);
      await s.tickUntil(
        () => ['answered', 'failed'].includes(s.store.get('ownerMessage', question.id)!.status!),
        'question settled',
      );
      assert.equal(s.store.get('ownerMessage', question.id)!.status, 'answered');
    }
    assert.deepEqual(
      s.forks.map((f) => f.sourceThreadId),
      [source, source],
    );
    assert.equal(s.store.task(s.task.id).devThreadId, source);
    assert.equal(s.store.task(s.task.id).ownerRunId, sourceRun.id);
    assert.deepEqual(s.store.get('run', sourceRun.id), sourceRun);
    assert.deepEqual(s.history.get(source), [decision]);
    assert.equal(s.devInterrupted(), false);
    assert.equal(s.store.task(s.task.id).stage, 'developing');
    assert.ok(
      s
        .lines()
        .filter((m) => m.role === 'owner')
        .every((m) => m.content === decision && m.context === 'work_history'),
    );
    assert.ok(
      s.store
        .list('message')
        .some((m) => m.role === 'system' && m.content.includes('已解释实现决定')),
    );
  } finally {
    await s.close();
  }
});

test('a direction change reaches PM before the final structured answer on the same fork', async () => {
  const s = await scenario({
    owner: async () =>
      JSON.stringify({ result: { kind: 'needs_alignment', request: '按钮改蓝属于验收变更。' } }),
  });
  try {
    await s.engine.start();
    await s.tickUntil(s.reviewed, 'review started');
    const question = s.store.addOwnerMessage(s.task.id, '按钮能改成蓝色吗？');
    await s.tickUntil(
      () =>
        s.store.get('ownerMessage', question.id)!.status !== 'queued' &&
        s.store.get('ownerMessage', question.id)!.status !== 'answering',
      'answer settled',
    );
    assert.equal(s.store.get('ownerMessage', question.id)!.status, 'answered');
    assert.equal(s.liaisonPrompts.length, 1);
    assert.match(s.liaisonPrompts[0], /按钮能改成蓝色吗？/);
    assert.match(s.liaisonPrompts[0], /按钮改蓝属于验收变更/);
    assert.match(s.lines().find((m) => m.role === 'owner')!.content, /已决定可以改蓝色/);
    assert.equal(s.forks.length, 1);
  } finally {
    await s.close();
  }
});

test('fork or invalid structured output fails only the question, without pausing Dev or creating recovery', async () => {
  for (const options of [{ forkError: true }, { owner: async () => 'not JSON' }]) {
    const s = await scenario({ live: true, ...options });
    try {
      await s.engine.start();
      await s.tickUntil(s.developing, 'Dev started');
      const question = s.store.addOwnerMessage(s.task.id, '为什么？');
      await s.tickUntil(
        () => s.store.get('ownerMessage', question.id)!.status === 'failed',
        'question failed',
      );
      const failed = s.store.get('ownerMessage', question.id)!;
      assert.equal(
        failed.failureReason,
        options.forkError ? 'history_unavailable' : 'answer_interrupted',
      );
      assert.equal(s.store.get('run', failed.runId!)!.status, 'failed');
      assert.equal(s.store.task(s.task.id).control, 'active');
      assert.equal(s.devInterrupted(), false);
      assert.equal(s.lines().filter((m) => m.role === 'owner').length, 0);
      assert.ok(!s.store.list('recovery').some((r) => r.oldRunId === failed.runId));
    } finally {
      await s.close();
    }
  }
});

test('project backend changes do not hand the existing owner history to another backend', async () => {
  const s = await scenario({ live: true });
  try {
    await s.engine.start();
    await s.tickUntil(s.developing, 'Dev started');
    const source = s.store.task(s.task.id).devThreadId!;
    const sourceRun = s.store.list('run').find((r) => r.threadId === source)!;
    s.store.saveProjectAgentSelection(s.task.projectId, { mode: 'override', agent: 'omp' });
    assert.equal(s.store.task(s.task.id).devThreadId, undefined);
    const question = s.store.addOwnerMessage(s.task.id, '为什么这样实现？');
    await s.tickUntil(
      () => ['answered', 'failed'].includes(s.store.get('ownerMessage', question.id)!.status!),
      'question settled',
    );
    assert.equal(s.store.get('ownerMessage', question.id)!.status, 'answered');
    const owner = s.store.get('run', s.store.get('ownerMessage', question.id)!.runId!)!;
    assert.equal(owner.agentKind, 'codex');
    assert.deepEqual(owner.profileConfig, sourceRun.profileConfig);
    assert.deepEqual(owner.provider, sourceRun.provider);
    assert.equal(s.forks[0].sourceThreadId, source);
    assert.equal(
      s.store.task(s.task.id).devThreadId,
      undefined,
      'owner must not reinstate the invalidated scheduler binding',
    );
  } finally {
    await s.close();
  }
});

test('an owner starting during a configuration change keeps its working memory without restoring resume bindings', async () => {
  let requested = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const s = await scenario({
    live: true,
    beforeThread: async () => {
      requested = true;
      await gate;
    },
  });
  try {
    await s.engine.start();
    await s.tickUntil(() => requested, 'Dev creating its thread');
    s.store.saveProjectAgentSelection(s.task.projectId, { mode: 'override', agent: 'omp' });
    release();
    await s.tickUntil(s.developing, 'Dev started');
    const question = s.store.addOwnerMessage(s.task.id, '为什么这样实现？');
    await s.tickUntil(
      () => ['answered', 'failed'].includes(s.store.get('ownerMessage', question.id)!.status!),
      'question settled',
    );
    assert.equal(s.store.get('ownerMessage', question.id)!.status, 'answered');
    assert.equal(s.store.task(s.task.id).devThreadId, undefined);
    assert.equal(
      s.store.get('run', s.store.get('ownerMessage', question.id)!.runId!)!.agentKind,
      'codex',
    );
    assert.equal(s.lines().find((message) => message.role === 'owner')!.content, decision);
    assert.equal(s.devInterrupted(), false);
  } finally {
    release();
    await s.close();
  }
});

test('reassign clears the owner source and never selects the previous worker from history', async () => {
  const s = await scenario();
  try {
    await s.engine.start();
    await s.tickUntil(s.reviewed, 'review started');
    assert.ok(s.store.task(s.task.id).ownerRunId);
    await s.engine.reassign(s.task.id, { source: 'user', reason: 'new_owner' });
    assert.equal(s.store.task(s.task.id).ownerRunId, undefined);
    const question = s.store.addOwnerMessage(s.task.id, '你为什么这样实现？');
    await s.tickUntil(
      () => s.store.get('ownerMessage', question.id)!.status === 'failed',
      'no stale source',
    );
    assert.equal(s.store.get('ownerMessage', question.id)!.failureReason, 'history_unavailable');
    assert.equal(s.forks.length, 0);
  } finally {
    await s.close();
  }
});

test('an answer from a superseded owner is not published, but a new Run on the same work thread remains valid', async () => {
  for (const replaceThread of [true, false]) {
    let finish: (value: string) => void = () => {};
    let asked = false;
    const s = await scenario({
      live: true,
      owner: async () => {
        asked = true;
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
    });
    try {
      await s.engine.start();
      await s.tickUntil(s.developing, 'Dev started');
      const source = s.store.task(s.task.id).devThreadId!;
      const question = s.store.addOwnerMessage(s.task.id, '为什么？');
      await s.tickUntil(() => asked, 'owner answering');
      const successor = s.store.run(
        'dev',
        s.task.projectId,
        s.task.profile,
        s.store.task(s.task.id),
      );
      s.store.bindRunThread(successor, replaceThread ? 'new-worker-thread' : source);
      s.store.finishRun(successor.id, 'completed');
      finish(answer());
      await s.tickUntil(
        () => ['failed', 'answered'].includes(s.store.get('ownerMessage', question.id)!.status!),
        'question settled',
      );
      assert.equal(
        s.store.get('ownerMessage', question.id)!.status,
        replaceThread ? 'failed' : 'answered',
      );
      if (replaceThread) {
        assert.equal(s.store.get('ownerMessage', question.id)!.failureReason, 'owner_changed');
        assert.equal(s.lines().filter((m) => m.role === 'owner').length, 0);
      }
    } finally {
      finish(answer());
      await s.close();
    }
  }
});

test('a legacy current dev binding resolves only its exact real source Run', async () => {
  const s = await scenario({ live: true });
  try {
    await s.engine.start();
    await s.tickUntil(s.developing, 'Dev started');
    const source = s.store.task(s.task.id).devThreadId!;
    s.store.updateTask(s.task.id, { ownerRunId: undefined });
    const unrelated = s.store.run('dev', s.task.projectId, s.task.profile, s.store.task(s.task.id));
    s.store.put('run', unrelated.id, { ...unrelated, threadId: 'unrelated-history' });
    s.store.finishRun(unrelated.id, 'completed');
    const question = s.store.addOwnerMessage(s.task.id, '为什么？');
    await s.tickUntil(
      () => ['failed', 'answered'].includes(s.store.get('ownerMessage', question.id)!.status!),
      'question settled',
    );
    assert.equal(s.store.get('ownerMessage', question.id)!.status, 'answered');
    assert.equal(s.forks[0].sourceThreadId, source);
  } finally {
    await s.close();
  }
});

test('owner replacement while closing the fork rejects the answer and fails its Run', async () => {
  const s = await scenario({
    live: true,
    ownerStop: async () => {
      const successor = s.store.run(
        'dev',
        s.task.projectId,
        s.task.profile,
        s.store.task(s.task.id),
      );
      s.store.bindRunThread(successor, 'replacement-during-close');
      s.store.finishRun(successor.id, 'completed');
    },
  });
  try {
    await s.engine.start();
    await s.tickUntil(s.developing, 'Dev started');
    const question = s.store.addOwnerMessage(s.task.id, '为什么？');
    await s.tickUntil(
      () => s.store.get('ownerMessage', question.id)!.status === 'failed',
      'stale answer rejected',
    );
    const failed = s.store.get('ownerMessage', question.id)!;
    assert.equal(failed.failureReason, 'owner_changed');
    assert.equal(s.store.get('run', failed.runId!)!.status, 'failed');
    assert.equal(s.lines().filter((m) => m.role === 'owner').length, 0);
  } finally {
    await s.close();
  }
});

test('a restart during an owner answer fails only the question; the work keeps going', async () => {
  const { root, store, task } = await devFixture('phantom-owner-restart-');
  try {
    store.updateTask(task.id, { worktree: root });
    const dev = store.run('dev', task.projectId, task.profile, store.task(task.id));
    store.bindRunThread(dev, 'real-source');
    store.finishRun(dev.id, 'completed');
    const question = store.addOwnerMessage(task.id, '还要多久？');
    const run = store.run('dev', task.projectId, task.profile, store.task(task.id), {
      ownerMessageId: question.id,
    });
    store.recover();
    assert.equal(store.get('run', run.id)!.status, 'interrupted');
    assert.equal(store.get('ownerMessage', question.id)!.status, 'failed');
    assert.equal(store.task(task.id).control, 'active');
    assert.ok(!store.list('recovery').some((item) => item.oldRunId === run.id));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
