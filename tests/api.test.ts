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
