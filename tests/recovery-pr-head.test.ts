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

async function interruptedWithPR(prefix: string, foreignPush: boolean) {
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
    issue: 1,
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

test('recovery accepts local work that moved past the published PR head', async () => {
  const f = await interruptedWithPR('phantom-recovery-pr-ahead-', false);
  try {
    await f.engine.start();
    assert.equal(prMoved(f.store), false);
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
  } finally {
    await f.engine.stop();
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
