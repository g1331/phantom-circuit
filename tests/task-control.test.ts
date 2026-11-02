import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { Previews } from '../src/server/preview.ts';
import { createApp } from '../src/server/app.ts';
import { Codex } from '../src/server/codex.ts';
import { DatabaseSync } from 'node:sqlite';
import { command } from '../src/server/process.ts';
import { devFixture } from './dev-fixture.ts';

function fixture(file: string, root = tmpdir()) {
  const store = new Store(file);
  const project = store.createProject('Controls', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'r',
    path: root,
    github: 'test/controls',
    defaultBranch: 'main',
    authorized: true,
  });
  const source = store.addMessage(project.id, 'user', 'Build', 'implement');
  const task = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: source.id,
    title: 'Task',
    spec: 'Build',
    acceptance: ['Works'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 1,
  });
  const ws = new Workspaces(join(root, 'ws'), store);
  const engine = new Engine(store, new GitHub(store), ws, root);
  return { store, project, repo, task, ws, engine };
}

test('HTTP task controls persist user provenance regardless of body, retaining control and terminal rules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-controls-'));
  const file = join(root, 'phantom.sqlite');
  const f = fixture(file);
  const app = createApp(f.store, f.engine, new Previews(f.store, f.ws));
  let closed = false;
  try {
    const init = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
    const headers = {
      host: '127.0.0.1:4317',
      cookie: String(init.headers['set-cookie']).split(';')[0],
      'x-phantom-csrf': init.json().csrf,
    };
    for (const action of ['pause', 'pause', 'resume', 'cancel']) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/tasks/${f.task.id}/${action}`,
        headers,
        payload: { source: 'host', control: { source: 'pm', reason: 'forged' } },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().control, action === 'resume' ? 'active' : 'paused');
      assert.equal(response.json().pausedByUser, action === 'pause');
    }
    const events = f.store
      .taskEvents(f.task.id)
      .filter((e) => /^任务 (pause|resume|cancel)$/.test(e.message));
    // Repeated pause already records one request event per call; provenance adds no second event.
    assert.equal(events.length, 4);
    assert.deepEqual(
      events.map((e) => e.control),
      ['pause', 'pause', 'resume', 'cancel'].map((action) => ({
        action,
        source: 'user',
        reason: 'http_task_control',
      })),
    );
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/tasks/${f.task.id}/resume`,
      headers,
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(f.store.taskEvents(f.task.id).length, 5); // prepared + four requests
    await app.close();
    f.store.close();
    closed = true;
    const reopened = new Store(file);
    try {
      assert.equal(reopened.task(f.task.id).stage, 'cancelled');
      assert.deepEqual(reopened.taskEvents(f.task.id).slice(1), events);
    } finally {
      reopened.close();
    }
  } finally {
    await app.close();
    if (!closed) f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('sync closure is host control while PM Incident actions and resolve_task carry the PM Run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-controls-pm-'));
  await command('git', ['init', '-b', 'main', root]);
  await command('git', ['config', 'user.name', 'Test'], root);
  await command('git', ['config', 'user.email', 'test@example.invalid'], root);
  await writeFile(join(root, 'source.txt'), 'fixture');
  await command('git', ['add', 'source.txt'], root);
  await command('git', ['commit', '-m', 'Fixture'], root);
  await command('git', ['remote', 'add', 'origin', root], root);
  const f = fixture(':memory:', root);
  f.store.saveProjectAgentSelection(f.project.id, { mode: 'override', agent: 'codex' });
  f.store.updateTask(f.task.id, { issue: 1 });
  class Remote extends GitHub {
    override async api<T = any>(): Promise<T> {
      return { state: 'closed' } as T;
    }
    override async syncStatus() {}
  }
  const sync = new Engine(f.store, new Remote(f.store), f.ws, '/test');
  await sync.sync();
  assert.equal(f.store.task(f.task.id).stage, 'cancelled');
  assert.deepEqual(f.store.taskEvents(f.task.id).at(-1)?.control, {
    action: 'cancel',
    source: 'host',
    reason: 'sync_issue_closed',
  });
  // Cancellation cannot resume. A separate live Task receives the PM's technical actions.
  const task = f.store.createTask({ ...f.task, title: 'PM task' });
  const incident = f.store.createIncident({
    projectId: f.project.id,
    taskId: task.id,
    phase: 'dev',
    message: 'failed',
  });
  class Model extends Codex {
    handler?: Parameters<Codex['thread']>[0]['toolHandler'];
    override async start() {}
    override async stop() {}
    override async thread(options: Parameters<Codex['thread']>[0]) {
      this.handler = options.toolHandler;
      return 'pm';
    }
    override async turn() {
      await assert.rejects(
        this.handler!('resolve_incident', {
          incidentId: incident.id,
          action: 'resolved',
          source: 'user',
          control: { source: 'host' },
        }),
      );
      for (const action of ['paused', 'waiting_user', 'resolved'])
        await this.handler!('resolve_incident', {
          incidentId: incident.id,
          action,
          guidance: 'technical',
        });
      await assert.rejects(
        this.handler!('resolve_task', {
          taskId: task.id,
          guidance: 'continue',
          upgrade: false,
          source: 'user',
          control: { source: 'host' },
        }),
      );
      await this.handler!('resolve_task', {
        taskId: task.id,
        guidance: 'continue',
        upgrade: false,
      });
      return 'resolved';
    }
  }
  const engine = new Engine(f.store, new Remote(f.store), f.ws, root, () => new Model());
  try {
    await engine.chat(f.store.addMessage(f.project.id, 'user', 'Recover', 'discuss'));
    const events = f.store.taskEvents(task.id).filter((e) => e.control);
    assert.deepEqual(
      events.map((e) => e.control?.source),
      ['pm', 'pm', 'pm'],
    );
    assert.deepEqual(
      events.map((e) => e.control?.action),
      ['pause', 'resume', 'resume'],
    );
    assert.equal(events[0].control?.incidentId, incident.id);
    const pm = f.store.list('run').find((r) => r.role === 'pm')!;
    assert.ok(events.every((e) => e.runId === pm.id));
    assert.equal(f.store.get('incident', incident.id)?.status, 'resolved');
    assert.equal(f.store.task(task.id).pausedByUser, false);
  } finally {
    await engine.stop();
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('control evidence failure rolls back state, and legacy unspecified calls stay unspecified after reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-controls-atomic-'));
  const file = join(root, 'phantom.sqlite');
  const f = fixture(file);
  const db = new DatabaseSync(file);
  try {
    f.store.control(f.task.id, 'pause');
    const before = f.store.task(f.task.id);
    const events = f.store.taskEvents(f.task.id);
    db.exec(
      "CREATE TRIGGER fail_control BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'event unavailable'); END",
    );
    assert.throws(
      () => f.store.control(f.task.id, 'resume', { source: 'user', reason: 'test' }),
      /event unavailable/,
    );
    assert.deepEqual(f.store.task(f.task.id), before);
    assert.deepEqual(f.store.taskEvents(f.task.id), events);
    assert.throws(
      () =>
        f.store.updateTaskControl(f.task.id, { control: 'active', pausedByUser: false }, 'resume', {
          source: 'host',
          reason: 'startup_recovery',
        }),
      /event unavailable/,
    );
    assert.deepEqual(f.store.task(f.task.id), before);
    assert.deepEqual(f.store.taskEvents(f.task.id), events);
    db.exec('DROP TRIGGER fail_control');
  } finally {
    db.close();
    f.store.close();
  }
  const reopened = new Store(file);
  try {
    assert.equal(reopened.taskEvents(f.task.id).at(-1)?.control, undefined);
  } finally {
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const policy of ['automatic', 'manual'] as const) {
  test(`${policy} recovery preserves phase and user pause protection while recording its actual entry`, async () => {
    const f = await devFixture('phantom-control-recovery-');
    const ws = new Workspaces(join(f.root, 'ws'), f.store);
    f.store.saveProjectRuntimeConfig(f.project.id, { recoveryPolicy: policy });
    const task = await ws.prepare(f.task);
    f.store.updateTask(task.id, { stage: 'developing', devPhase: 'implement' });
    const interrupted = f.store.run('dev', f.project.id, 'backend', f.store.task(task.id));
    const protectedTask = f.store.createTask({ ...f.task, title: 'User paused' });
    f.store.control(protectedTask.id, 'pause', { source: 'user', reason: 'http_task_control' });
    f.store.run('dev', f.project.id, 'backend', protectedTask);
    const cancelled = f.store.createTask({ ...f.task, title: 'Cancelled' });
    f.store.control(cancelled.id, 'cancel', { source: 'user', reason: 'http_task_control' });
    f.store.run('dev', f.project.id, 'backend', cancelled);
    const engine = new Engine(f.store, f.github, ws, f.root);
    const app = createApp(f.store, engine, new Previews(f.store, ws));
    try {
      await engine.start();
      const recovery = f.store.list('recovery').find((r) => r.oldRunId === interrupted.id)!;
      if (policy === 'manual') {
        assert.equal(f.store.task(task.id).control, 'paused');
        const init = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
        const headers = {
          host: '127.0.0.1:4317',
          cookie: String(init.headers['set-cookie']).split(';')[0],
          'x-phantom-csrf': init.json().csrf,
        };
        const request = {
          method: 'POST' as const,
          url: `/api/projects/${f.project.id}/recovery/resume`,
          headers,
          payload: { id: recovery.id },
        };
        assert.equal(
          (await app.inject({ ...request, payload: { id: recovery.id, source: 'host' } }))
            .statusCode,
          400,
        );
        assert.equal((await app.inject(request)).statusCode, 200);
        const count = f.store.taskEvents(task.id).length;
        assert.equal((await app.inject(request)).statusCode, 200);
        assert.equal(f.store.taskEvents(task.id).length, count);
      }
      const events = f.store.taskEvents(task.id).filter((e) => e.control);
      assert.deepEqual(
        events.map((e) => e.control),
        [
          { action: 'pause', source: 'host', reason: 'startup_interrupted' },
          {
            action: 'resume',
            source: policy === 'automatic' ? 'host' : 'user',
            reason: policy === 'automatic' ? 'startup_recovery' : 'http_recovery',
            recoveryItemId: recovery.id,
          },
        ],
      );
      assert.ok(events.every((e) => e.runId === interrupted.id));
      const result = f.store.task(task.id);
      assert.equal(result.control, 'active');
      assert.equal(result.pausedByUser, false);
      assert.equal(result.stage, 'developing');
      assert.equal(result.devPhase, 'implement');
      assert.equal(result.retries, 0);
      assert.equal(f.store.task(protectedTask.id).pausedByUser, true);
      assert.equal(f.store.task(protectedTask.id).control, 'paused');
      assert.equal(f.store.taskEvents(protectedTask.id).filter((e) => e.control).length, 1);
      assert.equal(f.store.task(cancelled.id).stage, 'cancelled');
      assert.equal(f.store.taskEvents(cancelled.id).filter((e) => e.control).length, 1);
      assert.equal(
        f.store.list('recovery').find((r) => r.taskId === protectedTask.id)?.pauseProvenance,
        'user',
      );
    } finally {
      await app.close();
      await engine.stop();
      f.store.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test('HTTP Incident disposition and Clarification effects record user context and retain their original state patches', async () => {
  const f = await devFixture('phantom-control-http-indirect-');
  class Model extends Codex {
    override async start() {}
    override async stop() {}
    override async thread() {
      return 'pm';
    }
    override async turn() {
      return 'answered';
    }
  }
  const ws = new Workspaces(join(f.root, 'ws'), f.store);
  const engine = new Engine(f.store, f.github, ws, f.root, () => new Model());
  const app = createApp(f.store, engine, new Previews(f.store, ws));
  try {
    const init = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
    const headers = {
      host: '127.0.0.1:4317',
      cookie: String(init.headers['set-cookie']).split(';')[0],
      'x-phantom-csrf': init.json().csrf,
    };
    const request = (path: string, payload?: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: `/api/projects/${f.project.id}/${path}`,
        headers,
        payload,
      });
    const incident = f.store.createIncident({
      projectId: f.project.id,
      taskId: f.task.id,
      phase: 'dev',
      message: 'environment',
    });
    const path = `incidents/${incident.id}/resolve`;
    assert.equal((await request(path, { action: 'paused', source: 'host' })).statusCode, 400);
    assert.equal((await request(path, { action: 'paused' })).statusCode, 200);
    assert.equal(f.store.task(f.task.id).pausedByUser, false);
    assert.equal((await request(path, { action: 'resolved' })).statusCode, 200);
    assert.equal(f.store.task(f.task.id).control, 'active');
    const cancel = f.store.createClarification({
      projectId: f.project.id,
      taskId: f.task.id,
      sourceMessageId: f.task.sourceMessageId,
      questions: [{ id: 'q', question: 'Which?' }],
    });
    assert.equal((await request(`clarifications/${cancel.id}/cancel`)).statusCode, 200);
    assert.equal(f.store.task(f.task.id).pausedByUser, false);
    const count = f.store.taskEvents(f.task.id).length;
    assert.equal((await request(`clarifications/${cancel.id}/cancel`)).statusCode, 200);
    assert.equal(f.store.taskEvents(f.task.id).length, count);
    const source = f.store.addMessage(f.project.id, 'user', 'Another', 'implement');
    const task = f.store.createTask({ ...f.task, sourceMessageId: source.id, title: 'Answer' });
    const clarify = f.store.createClarification({
      projectId: f.project.id,
      taskId: task.id,
      sourceMessageId: source.id,
      questions: [{ id: 'q', question: 'Which?' }],
    });
    f.store.control(task.id, 'pause');
    assert.equal(
      (
        await request(`clarifications/${clarify.id}/answer`, {
          answers: [{ questionId: 'q', value: 'A' }],
        })
      ).statusCode,
      200,
    );
    assert.equal(f.store.task(task.id).control, 'active');
    assert.equal(f.store.task(task.id).pausedByUser, false);
    assert.deepEqual(
      f.store
        .taskEvents(f.task.id)
        .filter((e) => e.control)
        .map((e) => e.control),
      [
        { action: 'pause', source: 'user', reason: 'http_incident', incidentId: incident.id },
        { action: 'resume', source: 'user', reason: 'http_incident', incidentId: incident.id },
        { action: 'pause', source: 'user', reason: 'clarification_cancelled' },
      ],
    );
    assert.deepEqual(f.store.taskEvents(task.id).findLast((e) => e.control)?.control, {
      action: 'resume',
      source: 'user',
      reason: 'clarification_answered',
    });
  } finally {
    await app.close();
    await engine.stop();
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
