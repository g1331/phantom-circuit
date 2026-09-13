import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { Previews } from '../src/server/preview.ts';
import { createApp } from '../src/server/app.ts';

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
