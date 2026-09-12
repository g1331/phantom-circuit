import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { Codex } from '../src/server/codex.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import type { Task } from '../src/shared/types.ts';

test('external requests for new product scope wait for PM clarification instead of starting a Dev', async () => {
  const store = new Store(':memory:');
  const p = store.createProject('Example', '');
  const repo = store.createRepo({
    projectId: p.id,
    name: 'repo',
    path: '.',
    github: 'example/repo',
    authorized: true,
    defaultBranch: 'main',
  });
  const m = store.addMessage(p.id, 'user', 'Implement login', 'implement');
  const task = store.createTask({
    projectId: p.id,
    repoId: repo.id,
    sourceMessageId: m.id,
    title: 'Login',
    spec: 'Email login',
    acceptance: ['Email login works'],
    dependencies: [],
    kind: 'frontend',
    complexity: 'normal',
    priority: 0,
  });
  store.patchRepo(repo.id, { enabled: true });
  store.updateTask(task.id, { pendingFeedback: ['Also build a subscription billing system.'] });
  class FeedbackGitHub extends GitHub {
    override async publishIssue(t: Task) {
      store.updateTask(t.id, { issue: 1 });
      return { number: 1 };
    }
    override async api<T = any>(): Promise<T> {
      return { state: 'open' } as T;
    }
    override async syncStatus() {}
  }
  class FeedbackModel extends Codex {
    override async start() {}
    override async stop() {}
    override async thread() {
      return 'pm';
    }
    override async turn() {
      return JSON.stringify({
        action: 'clarify',
        reason: '订阅计费超出已批准的邮件登录需求，需确认是否新增。',
      });
    }
  }
  const engine = new Engine(
    store,
    new FeedbackGitHub(store),
    new Workspaces('.cache', store),
    '.cache',
    () => new FeedbackModel(),
  );
  try {
    await engine.tick();
    for (let i = 0; i < 50 && store.task(task.id).control !== 'paused'; i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.task(task.id).control, 'paused');
    assert.equal(
      store.list('run').some((r) => r.role === 'dev'),
      false,
    );
    assert.match(store.task(task.id).blocked ?? '', /产品澄清/);
    assert.equal(store.task(task.id).spec, 'Email login');
  } finally {
    await engine.stop();
    store.close();
  }
});

test('design discussion records are durable but never authorize task claims', () => {
  const s = new Store(':memory:');
  const p = s.createProject('Example', '');
  const r = s.createRepo({
    projectId: p.id,
    name: 'r',
    path: '.',
    github: 'example/r',
    authorized: true,
    defaultBranch: 'main',
  });
  const doc = s.recordDocument(p.id, {
    repoId: r.id,
    path: 'docs/adr/0001-storage.md',
    content: '# Storage\nKeep execution state local.',
    accepted: true,
  });
  assert.equal(s.snapshot().documents[0].id, doc.id);
  assert.equal(s.list('task').length, 0);
  assert.equal(s.claimNext(), undefined);
  assert.throws(
    () =>
      s.recordDocument(p.id, {
        repoId: r.id,
        path: '../../outside',
        content: 'bad',
        accepted: true,
      }),
    /路径/,
  );
  s.close();
});
