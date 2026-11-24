import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { Store } from '../src/server/store.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { GitHub, type PullState } from '../src/server/github.ts';
import { devFixture } from './dev-fixture.ts';

const prMoved = (store: Store) =>
  store.events().some((e) => e.type === 'recovery' && /远端 PR revision 已变化/.test(e.message));

class Idle extends Codex {
  override async start() {}
  override async stop() {}
  override async thread() {
    return 'dev';
  }
  override async turn() {
    return 'done';
  }
}

async function interruptedWithPR(prefix: string, foreignPush: boolean, withoutIssue = false) {
  const f = await devFixture(prefix);
  const ws = new Workspaces(join(f.root, 'ws'), f.store);
  const prepared = await ws.prepare(f.task);
  const wt = prepared.worktree!;
  await writeFile(join(wt, 'a.txt'), 'pushed\n');
  await ws.git(wt, ['add', '.']);
  await ws.git(wt, ['commit', '-m', 'pushed']);
  const pushed = await ws.git(wt, ['rev-parse', 'HEAD']);
  // Local work moved on after the PR head was published (rework, base merge, checkpoint).
  await writeFile(join(wt, 'b.txt'), 'local\n');
  await ws.git(wt, ['add', '.']);
  await ws.git(wt, ['commit', '-m', 'local']);
  const local = await ws.git(wt, ['rev-parse', 'HEAD']);
  const remoteHead = foreignPush ? '1'.repeat(40) : pushed;
  f.store.updateTask(f.task.id, {
    stage: 'developing',
    devPhase: 'finalize',
    pr: 57,
    head: local,
    issue: withoutIssue ? undefined : 1,
    ...(withoutIssue
      ? {
          issueRegistration: {
            mode: 'none' as const,
            basis: 'source' as const,
            sourceMessageId: f.task.sourceMessageId,
            quote: 'Do not create Issues.',
          },
        }
      : {}),
  });
  f.store.run('dev', f.project.id, 'backend', f.store.task(f.task.id));
  const file = join(f.root, 'db.sqlite');
  f.store.close();
  const store = new Store(file);
  const repo = store.repo(f.repo.id);
  class Remote extends GitHub {
    override async pull() {
      const ref = { repo: { full_name: repo.github } };
      return {
        number: 57,
        html_url: '',
        state: 'open',
        merged: false,
        head: { ...ref, ref: store.task(f.task.id).branch, sha: remoteHead },
        base: { ...ref, ref: 'main', sha: '2'.repeat(40) },
      } as unknown as PullState;
    }
    override async api<T = any>(): Promise<T> {
      assert.equal(withoutIssue, false, 'Issue-free recovery must not read or write an Issue');
      return { state: 'open', body: 'body' } as T;
    }
    override async syncStatus() {}
    override async publishPR() {
      return {} as never;
    }
  }
  const engine = new Engine(
    store,
    new Remote(store),
    new Workspaces(join(f.root, 'ws'), store),
    f.root,
    () => new Idle(),
  );
  return { ...f, store, engine, taskId: f.task.id };
}

test('Issue-free interruption recovers its PR phase and registration', async () => {
  const f = await interruptedWithPR('phantom-recovery-no-issue-', false, true);
  const registration = f.store.task(f.taskId).issueRegistration;
  try {
    await f.engine.start();
    assert.equal(prMoved(f.store), false);
    const recovered = f.store.task(f.taskId);
    assert.equal(recovered.control, 'active');
    assert.equal(recovered.devPhase, 'finalize');
    assert.equal(recovered.issue, undefined);
    assert.deepEqual(recovered.issueRegistration, registration);
    assert.equal(f.store.list('recovery').filter((item) => item.taskId === f.taskId).length, 1);
    assert.equal(f.store.get('operation', `issue:${f.taskId}`), undefined);
  } finally {
    await f.engine.stop();
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('recovery accepts local work that moved past the published PR head', async () => {
  const f = await interruptedWithPR('phantom-recovery-pr-ahead-', false);
  try {
    await f.engine.start();
    assert.equal(prMoved(f.store), false);
    const recovery = f.store.list('recovery').find((item) => item.taskId === f.taskId)!;
    const controls = f.store.taskEvents(f.taskId).filter((event) => event.control);
    assert.deepEqual(
      controls.map((event) => event.control),
      [
        { action: 'pause', source: 'host', reason: 'startup_interrupted' },
        {
          action: 'resume',
          source: 'host',
          reason: 'startup_recovery',
          recoveryItemId: recovery.id,
        },
      ],
    );
    assert.ok(controls.every((event) => event.runId === recovery.oldRunId));
    assert.equal(f.store.task(f.taskId).control, 'active');
    assert.equal(f.store.task(f.taskId).pausedByUser, false);
    assert.equal(f.store.task(f.taskId).devPhase, 'finalize');
    assert.equal(f.store.task(f.taskId).retries, 0);
  } finally {
    await f.engine.stop();
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('recovery still stops when someone else pushed to the PR branch', async () => {
  const f = await interruptedWithPR('phantom-recovery-pr-foreign-', true);
  try {
    await f.engine.start();
    assert.equal(prMoved(f.store), true);
    assert.deepEqual(
      f.store
        .taskEvents(f.taskId)
        .filter((event) => event.control)
        .map((event) => event.control),
      [{ action: 'pause', source: 'host', reason: 'startup_interrupted' }],
    );
    assert.equal(f.store.task(f.taskId).control, 'paused');
    assert.equal(f.store.task(f.taskId).pausedByUser, false);
    assert.equal(f.store.task(f.taskId).devPhase, 'finalize');
    assert.equal(f.store.task(f.taskId).retries, 0);
  } finally {
    await f.engine.stop();
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
