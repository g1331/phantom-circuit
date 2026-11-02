import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { Previews } from '../src/server/preview.ts';
import { createApp } from '../src/server/app.ts';
import type { Snapshot, Task } from '../src/shared/types.ts';

test('state retains original historical evidence while scheduling excludes only settled known gaps', async () => {
  const store = new Store(':memory:');
  const ws = new Workspaces('/test', store);
  const app = createApp(
    store,
    new Engine(store, new GitHub(store), ws, '/test'),
    new Previews(store, ws),
  );
  const project = store.createProject('History', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'repo',
    path: '/test',
    github: 'example/history',
    defaultBranch: 'main',
    authorized: true,
  });
  const source = store.addMessage(project.id, 'user', 'Implement', 'implement');
  const reason =
    '历史 Task 完成同步缺少固定 revision 的测试、双轴 Review 或 PM 验收证据，需要 PM 核对';
  const cases: { name: string; patch: Partial<Task>; historical: boolean }[] = [
    { name: 'settled current policy history', patch: {}, historical: true },
    {
      name: 'settled original policy history',
      patch: { reviewPolicyVersion: undefined },
      historical: true,
    },
    { name: 'original plain reason', patch: { blocked: reason }, historical: true },
    {
      name: 'known generic block descriptor',
      patch: { blockedDescriptor: { code: 'task_blocked' } },
      historical: true,
    },
    {
      name: 'known generic pause descriptor',
      patch: { blockedDescriptor: { code: 'incident_paused' } },
      historical: true,
    },
    {
      name: 'new evidence failure with identical prose',
      patch: { blockedDescriptor: { code: 'completion_evidence_invalid' } },
      historical: false,
    },
    {
      name: 'unknown specific diagnostic',
      patch: { blockedDescriptor: { code: 'future_specific_failure' } },
      historical: false,
    },
    { name: 'normal done', patch: { blocked: undefined, control: 'active' }, historical: false },
    { name: 'unfinished', patch: { stage: 'merging' }, historical: false },
    { name: 'actual user pause', patch: { pausedByUser: true }, historical: false },
    { name: 'pending handoff', patch: { completionDeliveryPending: true }, historical: false },
    { name: 'unknown handoff', patch: { completionDeliveryPending: undefined }, historical: false },
    {
      name: 'different evidence diagnostic',
      patch: { blocked: `${reason}；另外的失败` },
      historical: false,
    },
    {
      name: 'GitHub drift',
      patch: { blocked: 'GitHub 需求发生变化，PM 正在核对' },
      historical: false,
    },
    { name: 'network failure', patch: { blocked: 'Error: HTTP 502' }, historical: false },
    {
      name: 'current revision validation failure',
      patch: {
        stage: 'merging',
        blocked: '固定 revision 测试失败',
        tests: [
          { command: 'npm test', head: 'new-head', exitCode: 1, output: 'failed', at: 'now' },
        ],
      },
      historical: false,
    },
  ];
  const records = cases.map(({ name, patch, historical }) => {
    const task = store.createTask({
      projectId: project.id,
      repoId: repo.id,
      sourceMessageId: source.id,
      title: name,
      spec: 'Build',
      acceptance: ['Works'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    return {
      historical,
      task: store.updateTask(task.id, {
        stage: 'done',
        control: 'paused',
        pausedByUser: false,
        completionDeliveryPending: false,
        blocked: `Error: ${reason}`,
        prUrl: 'https://github.com/example/history/pull/7',
        feedback: ['Delivered externally'],
        ...patch,
      }),
    };
  });
  const incidents = [
    store.createIncident({
      projectId: project.id,
      taskId: records[0].task.id,
      phase: 'sync',
      message: reason,
      evidence: 'Original historical evidence',
    }),
    store.createIncident({
      projectId: project.id,
      taskId: records[0].task.id,
      phase: 'finalize',
      message: 'HTTP 403: delivery permission denied',
      descriptor: { code: 'incident_finalize' },
      evidence: 'Original current failure',
    }),
  ];
  try {
    const init = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
    const headers = {
      host: '127.0.0.1:4317',
      cookie: String(init.headers['set-cookie']).split(';')[0],
    };
    const snapshot = (await app.inject({ url: '/api/state', headers })).json<Snapshot>();
    assert.deepEqual(
      snapshot.incidents,
      incidents,
      'historical and current Incidents retain original status and audit data',
    );
    const schedule = (
      await app.inject({ url: `/api/projects/${project.id}/scheduling`, headers })
    ).json();
    for (const { task, historical } of records) {
      assert.deepEqual(
        snapshot.tasks.find((item) => item.id === task.id),
        JSON.parse(JSON.stringify(task)),
        'API preserves all raw blockers, evidence, delivery references and timestamps',
      );
      const reasons = schedule.tasks.find(
        (item: { taskId: string }) => item.taskId === task.id,
      ).reasons;
      assert.equal(
        reasons.some((r: { code: string }) => r.code === 'blocked'),
        !historical && !!task.blocked,
        task.title,
      );
      assert.equal(
        reasons.some((r: { code: string }) => r.code === 'paused'),
        !historical && task.control === 'paused',
        task.title,
      );
      assert.ok(reasons.some((r: { code: string }) => r.code === 'stage'));
    }
    assert.equal(
      schedule.candidates.length,
      0,
      'classification never makes completed tasks claimable',
    );
    const again = (await app.inject({ url: '/api/state', headers })).json<Snapshot>();
    assert.deepEqual(again, snapshot, 'read-only HTTP refresh does not mutate history');
  } finally {
    await app.close();
    store.close();
  }
});

test('local API requires a same-site session and explicit write token', async () => {
  const store = new Store(':memory:');
  const ws = new Workspaces('/test', store);
  const engine = new Engine(store, new GitHub(store), ws, '/test');
  const app = createApp(store, engine, new Previews(store, ws));
  assert.equal(
    (await app.inject({ url: '/api/state', headers: { host: '127.0.0.1:4317' } })).statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ url: '/api/session', headers: { host: 'evil.example' } })).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        url: '/api/session',
        headers: { host: '127.0.0.1:4317', origin: 'https://evil.example' },
      })
    ).statusCode,
    403,
  );
  const init = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
  const cookie = String(init.headers['set-cookie']).split(';')[0];
  const headers = { host: '127.0.0.1:4317', cookie };
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers,
        payload: { name: 'project' },
      })
    ).statusCode,
    403,
  );
  const auth = { ...headers, 'x-phantom-csrf': init.json().csrf };
  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: auth,
    payload: { name: 'project', description: 'test' },
  });
  assert.equal(created.statusCode, 200);
  const snapshot = await app.inject({ url: '/api/state', headers });
  assert.equal(snapshot.json().projects[0].name, 'project');
  const invalid = await app.inject({
    method: 'PATCH',
    url: `/api/projects/${created.json().id}`,
    headers: auth,
    payload: { devLimit: 0 },
  });
  assert.equal(invalid.statusCode, 400);
  await app.close();
  store.close();
});

test('priority HTTP writes require token and project ownership and reject stale versions', async () => {
  const store = new Store(':memory:');
  const ws = new Workspaces('/test', store);
  const app = createApp(
    store,
    new Engine(store, new GitHub(store), ws, '/test'),
    new Previews(store, ws),
  );
  const p = store.createProject('priority', '');
  const other = store.createProject('other', '');
  const repo = store.createRepo({
    projectId: p.id,
    name: 'repo',
    path: '/priority',
    github: 'test/priority',
    defaultBranch: 'main',
    authorized: true,
  });
  const source = store.addMessage(p.id, 'user', 'Build', 'implement');
  const task = store.createTask({
    projectId: p.id,
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
  const init = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
  const headers = {
    host: '127.0.0.1:4317',
    cookie: String(init.headers['set-cookie']).split(';')[0],
  };
  const payload = {
    taskId: task.id,
    level: 'high',
    reason: 'Delivery blocked',
    expectedVersion: 0,
    requestId: 'http-1',
  };
  const url = `/api/projects/${p.id}/task-priority`;
  assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 403);
  const auth = { ...headers, 'x-phantom-csrf': init.json().csrf };
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${other.id}/task-priority`,
        headers: auth,
        payload,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url, headers: auth, payload })).json().priority,
    5,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url, headers: auth, payload })).json().priorityHistory
      .length,
    1,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url,
        headers: auth,
        payload: { ...payload, requestId: 'http-2' },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url,
        headers: auth,
        payload: { ...payload, level: 'critical' },
      })
    ).statusCode,
    400,
  );
  const before = store.snapshot();
  assert.equal(
    (await app.inject({ url: `/api/projects/${p.id}/scheduling`, headers })).statusCode,
    200,
  );
  assert.deepEqual(store.snapshot(), before);
  await app.close();
  store.close();
});
