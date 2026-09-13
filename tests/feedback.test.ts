import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from '../src/server/process.ts';
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
  store.put('project', p.id, { ...p, pmThreadId: 'persistent-project-pm' });
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
    override async thread(options: Parameters<Codex['thread']>[0]) {
      assert.equal(options.threadId, 'persistent-project-pm');
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

test('PM tool names priority levels, creates with reason and adjusts existing work during discussion', async () => {
  const s = new Store(':memory:');
  const root = await mkdtemp(join(tmpdir(), 'phantom-priority-pm-'));
  const sourcePath = join(root, 'source');
  await command('git', ['init', '-b', 'main', sourcePath]);
  await writeFile(join(sourcePath, 'CONTEXT.md'), '# Fixture');
  await command('git', ['add', '.'], sourcePath);
  await command(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Fixture'],
    sourcePath,
  );
  await command('git', ['remote', 'add', 'origin', sourcePath], sourcePath);
  const p = s.createProject('Priority PM', '');
  const repo = s.createRepo({
    projectId: p.id,
    name: 'priority',
    path: sourcePath,
    github: 'test/pm-priority',
    defaultBranch: 'main',
    authorized: true,
  });
  let handler: NonNullable<Parameters<Codex['thread']>[0]['toolHandler']>;
  let taskId = '';
  let creating = true;
  class PriorityModel extends Codex {
    override async start() {}
    override async stop() {}
    override async thread(options: Parameters<Codex['thread']>[0]) {
      handler = options.toolHandler!;
      assert.match(JSON.stringify(options.tools?.find((t) => t.name === 'create_task')), /urgent/);
      assert.match(
        JSON.stringify(options.tools?.find((t) => t.name === 'set_task_priority')),
        /higher numbers/,
      );
      return 'priority-thread';
    }
    override async turn() {
      if (creating) {
        const input = {
          repoId: repo.id,
          title: 'Invalid named',
          spec: 'Fix',
          acceptance: ['Works'],
          dependencies: [],
          kind: 'backend',
          complexity: 'normal',
          priority: 'high',
        };
        await assert.rejects(handler('create_task', input), /priorityReason/);
        await assert.rejects(
          handler('create_task', { ...input, priority: 1, level: 'urgent' }),
          /level/,
        );
        const legacy = (await handler('create_task', {
          ...input,
          title: 'Legacy compatible',
          priority: 1,
        })) as Task;
        assert.equal(legacy.priority, 1);
        assert.equal(legacy.priorityReason, undefined);
        const result = (await handler('create_task', {
          repoId: repo.id,
          title: 'Unblock delivery',
          spec: 'Fix',
          acceptance: ['Delivery works'],
          dependencies: [],
          kind: 'backend',
          complexity: 'normal',
          priority: 'high',
          priorityReason: 'Delivery is blocked',
        })) as Task;
        taskId = result.id;
      } else {
        await handler('set_task_priority', {
          taskId,
          level: 'urgent',
          reason: 'Confirmed immediate delivery impact',
          expectedVersion: 0,
          requestId: 'pm-change',
        });
      }
      return 'Priority recorded';
    }
  }
  const engine = new Engine(
    s,
    new GitHub(s),
    new Workspaces(join(root, 'host'), s),
    join(root, 'host'),
    () => new PriorityModel(),
  );
  try {
    await engine.chat(s.addMessage(p.id, 'user', 'Build fix', 'implement'));
    assert.equal(s.task(taskId).priority, 5);
    assert.equal(s.task(taskId).priorityReason, 'Delivery is blocked');
    creating = false;
    await engine.chat(s.addMessage(p.id, 'user', 'Review queue priority', 'discuss'));
    assert.equal(s.task(taskId).priority, 10);
    assert.equal(s.task(taskId).priorityHistory?.at(-1)?.actor, 'pm');
    assert.ok(s.task(taskId).priorityHistory?.at(-1)?.runId);
    assert.equal(s.list('task').length, 2);
  } finally {
    await engine.stop();
    s.close();
  }
});
