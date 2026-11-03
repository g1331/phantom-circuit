import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { Engine, mergeReady } from '../src/server/engine.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Store } from '../src/server/store.ts';
import { command } from '../src/server/process.ts';
import { GitHub, type PullState } from '../src/server/github.ts';
import type { Task } from '../src/shared/types.ts';
import { devFixture, hang } from './dev-fixture.ts';

async function fixture(axis: 'primary' | 'secondary', replyMode: 'tool' | 'json' = 'tool') {
  const f = await devFixture('phantom-review-clarification-');
  let store = f.store;
  if (axis === 'secondary') store.updateTask(f.task.id, { complexity: 'complex' });
  store.saveProjectSecondaryReviewProfile(f.project.id, {
    providerId: 'codex',
    model: 'independent-model',
    effort: 'high',
  });
  const trace: string[] = [];
  const prompts: string[] = [];
  let asked = false;
  let nextVerdict: 'pass' | 'rework' = 'pass';
  let release: (() => void) | undefined;
  let remoteHead: string | undefined;
  let remoteBase: string | undefined;
  let baseBranch = 'main';
  let beforePull: (() => void) | undefined;
  let questionPayload: Record<string, unknown> | undefined;
  class Remote extends GitHub {
    override async publishIssue(t: Task) {
      store.updateTask(t.id, { issue: 1, issueBody: 'body' });
      return { number: 1 };
    }
    override async publishPR(t: Task) {
      store.updateTask(t.id, { pr: 2 });
      return this.pull(t);
    }
    override async pull(t: Task): Promise<PullState> {
      beforePull?.();
      return {
        number: 2,
        state: 'open',
        merged: false,
        html_url: '',
        mergeable: true,
        mergeable_state: 'clean',
        body: '',
        head: { sha: remoteHead ?? t.head!, ref: t.branch, repo: { full_name: 'fixture/source' } },
        base: {
          sha: remoteBase ?? t.base!,
          ref: baseBranch,
          repo: { full_name: 'fixture/source' },
        },
      };
    }
    override async checks() {
      return { ready: false };
    }
    override async reviewComment() {
      return {};
    }
    override async syncStatus() {}
    override async api<T = any>(): Promise<T> {
      return { state: 'open', body: 'body' } as T;
    }
    override async paged() {
      return [];
    }
  }
  class Model extends Codex {
    cwd = '';
    role = '';
    handler?: Parameters<Codex['thread']>[0]['toolHandler'];
    override async start() {}
    override async stop() {}
    override async thread(o: Parameters<Codex['thread']>[0]) {
      this.cwd = o.cwd;
      this.role = o.instructions.includes('Task Developer')
        ? 'dev'
        : o.instructions.includes('Independent Review')
          ? 'review'
          : 'pm';
      this.handler = o.toolHandler;
      return this.role;
    }
    override async turn(_id: string, prompt: string, _profile: any, signal?: AbortSignal) {
      if (signal?.aborted) throw signal.reason;
      if (this.role === 'dev') {
        trace.push('dev');
        await writeFile(join(this.cwd, 'implementation.txt'), `Implementation ${trace.length}\n`);
        return 'Implemented';
      }
      if (this.role === 'pm') {
        trace.push('pm');
        return hang(signal);
      }
      const currentAxis = /Axis: (primary|secondary)/.exec(prompt)![1];
      trace.push(currentAxis);
      prompts.push(prompt);
      let result: Record<string, unknown>;
      if (currentAxis === axis && !asked) {
        asked = true;
        result = {
          approved: false,
          verdict: 'needs_user',
          summary: 'Retention is not specified',
          findings: [],
          questions: [
            { question: 'How long must records be retained?' },
            { question: 'Who can access archives?' },
          ],
        };
        Object.assign(result, questionPayload);
      } else {
        if (currentAxis === axis)
          await new Promise<void>((resolve) => {
            release = resolve;
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        result =
          nextVerdict === 'rework' && currentAxis === axis
            ? {
                approved: false,
                verdict: 'rework',
                summary: 'Implementation must enforce the policy',
                findings: ['Add retention enforcement'],
              }
            : { approved: true, verdict: 'pass', summary: 'All acceptance met', findings: [] };
      }
      if (replyMode === 'tool') await this.handler?.('submit_review', result);
      return JSON.stringify(result);
    }
  }
  const makeEngine = () =>
    new Engine(
      store,
      new Remote(store),
      new Workspaces(join(f.root, 'ws'), store),
      f.root,
      () => new Model(),
    );
  let engine = makeEngine();
  async function pump(condition: () => boolean) {
    for (let i = 0; i < 700 && !condition(); i++) {
      await engine.tick();
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.ok(
      condition(),
      `State not reached; trace=${trace}; task=${JSON.stringify(store.task(f.task.id))}`,
    );
  }
  return {
    ...f,
    get store() {
      return store;
    },
    get engine() {
      return engine;
    },
    trace,
    prompts,
    pump,
    release: () => release?.(),
    rework: () => {
      nextVerdict = 'rework';
    },
    drift: () => {
      remoteHead = 'f'.repeat(40);
    },
    race: (fn: () => void) => {
      beforePull = fn;
    },
    base: (sha: string, branch = 'main') => {
      remoteBase = sha;
      baseBranch = branch;
    },
    questionPayload: (value: Record<string, unknown>) => {
      questionPayload = value;
    },
    restart: async () => {
      await engine.stop();
      store.close();
      store = new Store(join(f.root, 'db.sqlite'));
      engine = makeEngine();
      await engine.start();
    },
    close: async () => {
      release?.();
      await engine.stop();
      store.close();
      await rm(f.root, { recursive: true, force: true });
    },
  };
}

for (const axis of ['primary', 'secondary'] as const)
  test(`${axis} questions resume the same pinned review with real user answers and retained checks`, async () => {
    const f = await fixture(axis, axis === 'primary' ? 'tool' : 'json');
    try {
      await f.engine.start();
      await f.pump(() => f.store.list('clarification').length === 1);
      const c = f.store.list('clarification')[0];
      const before = f.store.task(f.task.id);
      assert.equal(before.control, 'paused');
      assert.equal(before.retries, 0);
      assert.equal(c.taskId, f.task.id);
      assert.equal(c.sourceMessageId, f.task.sourceMessageId);
      assert.equal(c.review?.axis, axis);
      await f.engine.answerClarification(f.project.id, c.id, { q1: 'Seven years' });
      await f.engine.tick();
      assert.equal(f.store.get('clarification', c.id)?.status, 'open');
      assert.equal(f.trace.filter((r) => r === axis).length, 1);
      await f.engine.answerClarification(f.project.id, c.id, { q2: 'Administrators only' });
      await f.restart();
      await f.pump(() => f.trace.filter((r) => r === axis).length === 2);
      await Promise.all([f.engine.tick(), f.engine.tick()]);
      await f.engine.answerClarification(f.project.id, c.id, { q2: 'Duplicate answer' });
      assert.equal(f.store.task(f.task.id).retries, 0);
      assert.equal(f.trace.filter((r) => r === 'dev').length, 1);
      assert.equal(f.trace.includes('pm'), false);
      assert.deepEqual(f.store.task(f.task.id).tests, before.tests);
      assert.equal(f.store.task(f.task.id).head, before.head);
      assert.equal(f.store.task(f.task.id).base, before.base);
      assert.equal(mergeReady(f.store.task(f.task.id)), false, 'answers do not approve a review');
      const prompt = f.prompts.at(-1)!;
      assert.match(prompt, /How long must records be retained/);
      assert.match(prompt, /Seven years/);
      assert.match(prompt, /Administrators only/);
      assert.ok(prompt.includes(before.head!) && prompt.includes(before.base!));
      if (axis === 'secondary') assert.equal(f.trace.filter((r) => r === 'primary').length, 1);
      f.release();
      await f.pump(() => f.store.task(f.task.id).stage === 'merging');
      assert.equal(mergeReady(f.store.task(f.task.id)), true);
      assert.equal(f.store.list('clarification').length, 1);
      assert.equal(f.trace.filter((r) => r === axis).length, 2);
    } finally {
      await f.close();
    }
  });

test('independent pause survives answers and restart, and explicit resume continues Review rather than Dev', async () => {
  const f = await fixture('secondary');
  try {
    await f.engine.start();
    await f.pump(() => f.store.list('clarification').length === 1);
    const c = f.store.list('clarification')[0];
    f.engine.control(f.task.id, 'pause', { source: 'user', reason: 'user_pause' });
    await f.engine.answerClarification(f.project.id, c.id, {
      q1: 'Seven years',
      q2: 'Administrators',
    });
    await f.restart();
    await f.engine.tick();
    assert.equal(f.store.task(f.task.id).pausedByUser, true);
    assert.equal(f.store.task(f.task.id).control, 'paused');
    assert.equal(f.trace.filter((r) => r === 'secondary').length, 1);
    await f.engine.resume(f.task.id, undefined, { source: 'user', reason: 'http_resume' });
    await f.pump(() => f.trace.filter((r) => r === 'secondary').length === 2);
    assert.equal(f.trace.filter((r) => r === 'dev').length, 1);
    assert.equal(f.store.task(f.task.id).retries, 0);
  } finally {
    await f.close();
  }
});

for (const drift of ['remote', 'dirty', 'task-during-check'] as const)
  test(`${drift} drift preserves answers and blocks instead of reworking or approving`, async () => {
    const f = await fixture('primary');
    try {
      await f.engine.start();
      await f.pump(() => f.store.list('clarification').length === 1);
      const c = f.store.list('clarification')[0];
      const before = f.store.task(f.task.id);
      if (drift === 'remote') f.drift();
      if (drift === 'dirty')
        await writeFile(join(before.worktree!, 'uncommitted.txt'), 'Keep this change');
      if (drift === 'task-during-check')
        f.race(() => f.store.updateTask(f.task.id, { base: 'changed-base' }));
      await f.engine.answerClarification(f.project.id, c.id, {
        q1: 'Seven years',
        q2: 'Administrators',
      });
      await f.pump(() => f.store.list('incident').length === 1);
      await f.engine.tick();
      await f.engine.tick();
      assert.equal(f.store.get('clarification', c.id)?.status, 'answered');
      assert.equal(f.store.get('clarification', c.id)?.successorRunId, undefined);
      assert.equal(f.store.task(f.task.id).control, 'paused');
      assert.equal(f.store.task(f.task.id).retries, 0);
      assert.deepEqual(f.store.task(f.task.id).tests, before.tests);
      assert.equal(mergeReady(f.store.task(f.task.id)), false);
      assert.equal(f.trace.filter((r) => r === 'dev').length, 1);
      assert.equal(f.trace.filter((r) => r === 'primary').length, 1);
      assert.equal(f.store.list('incident').length, 1);
    } finally {
      await f.close();
    }
  });

test('a pause during revision reconciliation prevents the successor claim', async () => {
  const f = await fixture('primary');
  try {
    await f.engine.start();
    await f.pump(() => f.store.list('clarification').length === 1);
    const c = f.store.list('clarification')[0];
    f.race(() => f.engine.control(f.task.id, 'pause', { source: 'user', reason: 'user_pause' }));
    await f.engine.answerClarification(f.project.id, c.id, {
      q1: 'Seven years',
      q2: 'Administrators',
    });
    await f.pump(() => f.store.task(f.task.id).pausedByUser === true);
    await f.engine.tick();
    assert.equal(f.store.get('clarification', c.id)?.successorRunId, undefined);
    assert.equal(f.trace.filter((r) => r === 'primary').length, 1);
    assert.equal(f.trace.filter((r) => r === 'dev').length, 1);
  } finally {
    await f.close();
  }
});

test('a real defect found after answering still returns to Dev and invalidates old revision evidence', async () => {
  const f = await fixture('secondary');
  try {
    await f.engine.start();
    await f.pump(() => f.store.list('clarification').length === 1);
    const c = f.store.list('clarification')[0];
    const oldHead = f.store.task(f.task.id).head;
    await f.engine.answerClarification(f.project.id, c.id, {
      q1: 'Seven years',
      q2: 'Administrators',
    });
    await f.pump(() => f.trace.filter((r) => r === 'secondary').length === 2);
    f.rework();
    f.release();
    await f.pump(() => f.trace.filter((r) => r === 'dev').length === 2);
    assert.equal(f.store.task(f.task.id).retries, 1);
    assert.equal(mergeReady(f.store.task(f.task.id)), false);
    await f.pump(() => f.store.task(f.task.id).head !== oldHead);
    assert.equal(f.store.task(f.task.id).reviews.length, 0);
    assert.equal(f.store.get('clarification', c.id)?.answers?.[0].value, 'Seven years');
  } finally {
    await f.close();
  }
});

for (const replyMode of ['tool', 'json'] as const)
  test(`invalid ${replyMode} question results use the error path, never pass or rework`, async () => {
    const f = await fixture('primary', replyMode);
    f.questionPayload({ questions: [{ question: '  ' }] });
    try {
      await f.engine.start();
      await f.pump(() => f.store.list('incident').length === 1);
      assert.equal(f.store.list('clarification').length, 0);
      assert.equal(f.store.task(f.task.id).reviews.length, 0);
      assert.equal(f.store.task(f.task.id).retries, 0);
      assert.equal(mergeReady(f.store.task(f.task.id)), false);
    } finally {
      await f.close();
    }
  });

test('restart with open questions retains one wait and does not recover the completed asking Run', async () => {
  const f = await fixture('primary');
  try {
    await f.engine.start();
    await f.pump(() => f.store.list('clarification').length === 1);
    const c = f.store.list('clarification')[0];
    await f.restart();
    await f.engine.tick();
    assert.equal(f.store.list('clarification').length, 1);
    assert.equal(f.store.get('run', c.review!.runId)?.status, 'completed');
    assert.equal(f.store.list('recovery').length, 0);
    assert.equal(f.store.task(f.task.id).control, 'paused');
    assert.deepEqual(f.trace, ['dev', 'primary']);
  } finally {
    await f.close();
  }
});

test('a forward default branch resumes the original version without merging it into the Task', async () => {
  const f = await fixture('primary');
  try {
    await f.engine.start();
    await f.pump(() => f.store.list('clarification').length === 1);
    const c = f.store.list('clarification')[0];
    const before = f.store.task(f.task.id);
    const source = join(f.root, 'source');
    await writeFile(join(source, 'advanced.txt'), 'A separate default branch change');
    await command('git', ['add', '.'], source);
    await command('git', ['commit', '-m', 'Advance default'], source);
    await command('git', ['push', 'origin', 'main'], source);
    const nextBase = (await command('git', ['rev-parse', 'HEAD'], source)).stdout.trim();
    f.base(nextBase);
    await f.engine.answerClarification(f.project.id, c.id, {
      q1: 'Seven years',
      q2: 'Administrators',
    });
    await f.pump(() => f.trace.filter((r) => r === 'primary').length === 2);
    assert.equal(f.store.task(f.task.id).base, before.base);
    assert.equal(f.store.task(f.task.id).head, before.head);
    assert.deepEqual(f.store.task(f.task.id).tests, before.tests);
    assert.equal(
      (await command('git', ['rev-parse', 'HEAD'], before.worktree)).stdout.trim(),
      before.head,
    );
    assert.equal(f.trace.filter((r) => r === 'dev').length, 1);
    assert.equal(f.store.list('incident').length, 0);
  } finally {
    await f.close();
  }
});

for (const change of ['retarget', 'rewritten', 'unknown-object'] as const)
  test(`${change} base cannot resume a clarification review`, async () => {
    const f = await fixture('primary');
    try {
      await f.engine.start();
      await f.pump(() => f.store.list('clarification').length === 1);
      const c = f.store.list('clarification')[0];
      if (change === 'retarget') f.base(c.review!.base, 'another-base');
      if (change === 'unknown-object') f.base('f'.repeat(40));
      if (change === 'rewritten') {
        const source = join(f.root, 'source');
        await command('git', ['checkout', '--orphan', 'rewritten'], source);
        await command('git', ['commit', '-m', 'Unrelated history'], source);
        await command('git', ['push', 'origin', 'rewritten'], source);
        f.base((await command('git', ['rev-parse', 'HEAD'], source)).stdout.trim());
      }
      await f.engine.answerClarification(f.project.id, c.id, {
        q1: 'Seven years',
        q2: 'Administrators',
      });
      await f.pump(() => f.store.list('incident').length === 1);
      assert.equal(f.store.get('clarification', c.id)?.successorRunId, undefined);
      assert.equal(f.store.get('clarification', c.id)?.status, 'answered');
      assert.deepEqual(
        f.trace.filter((r) => r !== 'pm'),
        ['dev', 'primary'],
      );
      assert.equal(f.store.task(f.task.id).retries, 0);
    } finally {
      await f.close();
    }
  });
