import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { Previews } from '../src/server/preview.ts';
import { createApp } from '../src/server/app.ts';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Codex } from '../src/server/codex.ts';

async function fixture(t: any, createCodex?: () => Codex) {
  await mkdir(resolve('.phantom/test'), { recursive: true });
  const dir = await mkdtemp(resolve('.phantom/test/providers-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const ws = new Workspaces(dir, store);
  const app = createApp(
    store,
    new Engine(store, new GitHub(store), ws, dir),
    new Previews(store, ws),
    4317,
    createCodex,
  );
  t.after(async () => {
    await app.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const session = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
  const headers = {
    host: '127.0.0.1:4317',
    cookie: String(session.headers['set-cookie']).split(';')[0],
    'x-phantom-csrf': session.json().csrf,
  };
  const request = (method: any, url: string, payload?: any, extra = {}) =>
    app.inject({
      method,
      url: '/api' + url,
      headers: { ...headers, ...extra },
      ...(payload === undefined ? {} : { payload }),
    });
  return { app, store, dir, request };
}

test('Provider lifecycle keeps secrets separate and reveals only through an explicit protected request', async (t) => {
  const { request, dir } = await fixture(t);
  const key = 'owner-private-fixture-key';
  const official = (await request('GET', '/providers')).json()[0];
  assert.equal(official.name, 'Codex 官方登录');
  assert.equal((await request('DELETE', `/providers/${official.id}`)).statusCode, 400);
  assert.equal((await request('POST', `/providers/${official.id}/reveal-key`, {})).statusCode, 400);
  const created = await request('POST', '/providers', {
    name: 'Local',
    baseUrl: 'http://localhost:9999/v1/responses/',
    apiKey: key,
  });
  assert.equal(created.statusCode, 200, created.body);
  const provider = created.json();
  assert.equal(provider.hasKey, true);
  assert.equal(provider.baseUrl, 'http://localhost:9999/v1');
  assert.ok(!created.body.includes(key));
  const reveal = `/providers/${provider.id}/reveal-key`;
  assert.equal((await request('POST', reveal, {}, { 'x-phantom-csrf': '' })).statusCode, 403);
  assert.equal((await request('POST', reveal, {}, { cookie: '' })).statusCode, 401);
  assert.equal(
    (await request('POST', reveal, {}, { 'sec-fetch-site': 'cross-site' })).statusCode,
    403,
  );
  assert.equal(
    (await request('POST', reveal, {}, { origin: 'https://evil.example' })).statusCode,
    403,
  );
  assert.equal((await request('POST', reveal, { id: official.id })).statusCode, 400);
  assert.equal((await request('POST', '/providers/missing/reveal-key', {})).statusCode, 404);
  const shown = await request('POST', reveal, {});
  assert.equal(shown.json().apiKey, key);
  assert.equal(shown.headers['cache-control'], 'no-store');
  await request('PATCH', `/providers/${provider.id}`, { name: 'Renamed', apiKey: '' });
  assert.equal((await request('POST', reveal, {})).json().apiKey, key);
  await request('PATCH', `/providers/${provider.id}`, { apiKey: 'replacement-fixture-key' });
  assert.equal((await request('POST', reveal, {})).json().apiKey, 'replacement-fixture-key');
  for (const url of ['/state', '/providers', `/providers/${provider.id}`]) {
    const result = await request('GET', url);
    assert.ok(!result.body.includes(key));
    assert.ok(!result.body.includes('replacement-fixture-key'));
  }
  for (const file of await readdir(dir))
    if (file.startsWith('state.sqlite')) {
      const content = await readFile(join(dir, file));
      assert.ok(!content.includes(Buffer.from(key)));
      assert.ok(!content.includes(Buffer.from('replacement-fixture-key')));
    }
  assert.equal((await request('DELETE', `/providers/${provider.id}`)).statusCode, 200);
  assert.equal((await request('POST', reveal, {})).statusCode, 404);
  assert.deepEqual(await readdir(join(dir, 'secrets')), []);
});

test('official Provider discovers model IDs and reasoning efforts through the Codex protocol', async (t) => {
  const { request } = await fixture(
    t,
    () =>
      new Codex((_binary, _args, options) =>
        spawn(
          process.execPath,
          [
            '-e',
            `
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      const result = message.method === 'model/list' ? { data: [{ id: 'catalog-id', model: 'official-model', supportedReasoningEfforts: [{reasoningEffort: 'low'}, {reasoningEffort: 'high'}] }] } : {};
      console.log(JSON.stringify({ id: message.id, result }));
      if (message.method === 'model/list') setImmediate(() => process.exit(0));
    });
  `,
          ],
          options,
        ),
      ),
  );
  assert.deepEqual((await request('POST', '/providers/codex/models', {})).json(), {
    ok: true,
    models: [{ id: 'official-model', reasoningEfforts: ['low', 'high'] }],
  });
});

test('Provider validation rejects duplicate identities and unsafe URLs without changing saved configuration', async (t) => {
  const { request } = await fixture(t);
  const data = {
    name: 'Gateway',
    baseUrl: 'https://example.test/prefix/v1',
    apiKey: 'fixture-value',
  };
  const saved = (await request('POST', '/providers', data)).json();
  assert.equal((await request('POST', '/providers', data)).statusCode, 409);
  assert.equal(
    (await request('POST', '/providers', { ...data, name: 'Other', id: saved.id })).statusCode,
    400,
  );
  for (const baseUrl of [
    'file:///tmp/a',
    'ftp://example.test',
    'https://user:pass@example.test',
    'https://example.test?q=x',
    'https://example.test/#x',
    'not a URL',
  ]) {
    assert.equal((await request('PATCH', `/providers/${saved.id}`, { baseUrl })).statusCode, 400);
  }
  const other = (
    await request('POST', '/providers', { ...data, name: 'Other', apiKey: 'other-value' })
  ).json();
  assert.equal(
    (await request('POST', `/providers/${saved.id}/reveal-key`, { id: other.id })).statusCode,
    400,
  );
  assert.equal(
    (await request('POST', `/providers/${saved.id}/reveal-key`, {})).json().apiKey,
    'fixture-value',
  );
  assert.equal(
    (await request('POST', `/providers/${other.id}/reveal-key`, {})).json().apiKey,
    'other-value',
  );
  assert.equal(
    (await request('GET', '/providers')).json().find((p: any) => p.id === saved.id).baseUrl,
    data.baseUrl,
  );
});

test('malformed Provider requests never echo submitted secrets in error responses', async (t) => {
  const { request } = await fixture(t);
  const secret = 'mine123';
  const response = await request('POST', '/providers', `${secret} is not JSON`, {
    'content-type': 'application/json',
  });
  assert.ok(!response.body.includes(secret));
  assert.equal(response.statusCode, 400);
});

test('a fresh HTTP host reads saved Provider metadata and its separate secret', async (t) => {
  const { request, dir } = await fixture(t);
  const saved = (
    await request('POST', '/providers', {
      name: 'Persistent',
      baseUrl: 'https://example.test/v1',
      apiKey: 'persisted-fixture',
    })
  ).json();
  const restored = new Store(join(dir, 'state.sqlite'));
  const ws = new Workspaces(dir, restored);
  const app = createApp(
    restored,
    new Engine(restored, new GitHub(restored), ws, dir),
    new Previews(restored, ws),
  );
  try {
    const session = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
    const headers = {
      host: '127.0.0.1:4317',
      cookie: String(session.headers['set-cookie']).split(';')[0],
      'x-phantom-csrf': session.json().csrf,
    };
    const list = await app.inject({ url: '/api/providers', headers });
    assert.deepEqual(
      list.json().find((p: any) => p.id === saved.id),
      saved,
    );
    assert.ok(!list.body.includes('persisted-fixture'));
    const revealed = await app.inject({
      method: 'POST',
      url: `/api/providers/${saved.id}/reveal-key`,
      headers,
      payload: {},
    });
    assert.equal(revealed.json().apiKey, 'persisted-fixture');
  } finally {
    await app.close();
    restored.close();
  }
});

test('model discovery bounds upstream requests, classifies failures and preserves the Provider', async (t) => {
  const { request } = await fixture(t);
  let mode = 'ok';
  const upstream = createServer((req, res) => {
    assert.equal(req.url, '/prefix/v1/models');
    assert.equal(req.headers.authorization, 'Bearer model-discovery-fixture');
    if (mode === 'timeout') {
      res.writeHead(200);
      res.write('{"data":[');
      return;
    }
    if (mode === '401' || mode === '403' || mode === '404' || mode === '405') {
      res.writeHead(Number(mode));
      res.end('private upstream error');
      return;
    }
    if (mode === 'redirect') {
      res.writeHead(302, { location: 'http://evil.example/models' });
      res.end();
      return;
    }
    if (mode === 'oversize') {
      res.end(' '.repeat(1024 * 1024 + 1));
      return;
    }
    if (mode === 'invalid') {
      res.end('invalid private upstream response');
      return;
    }
    res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-a' }, { id: 'model-b' }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const port = (upstream.address() as any).port;
  const saved = (
    await request('POST', '/providers', {
      name: 'Discovery',
      baseUrl: `http://127.0.0.1:${port}/prefix/v1`,
      apiKey: 'model-discovery-fixture',
    })
  ).json();
  const discover = () => request('POST', `/providers/${saved.id}/models`, {});
  assert.deepEqual((await discover()).json(), {
    ok: true,
    models: [{ id: 'model-a' }, { id: 'model-b' }],
  });
  for (const [input, code] of [
    ['401', 'authentication'],
    ['403', 'authentication'],
    ['404', 'unsupported'],
    ['405', 'unsupported'],
    ['redirect', 'redirect'],
    ['oversize', 'too_large'],
    ['invalid', 'invalid_response'],
    ['timeout', 'timeout'],
  ]) {
    mode = input;
    const result = await discover();
    assert.equal(result.json().code, code, result.body);
    assert.ok(!result.body.includes('private upstream'));
    assert.equal(
      (await request('GET', '/providers')).json().find((p: any) => p.id === saved.id).hasKey,
      true,
    );
  }
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  assert.equal((await discover()).json().code, 'connection');
});
