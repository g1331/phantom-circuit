import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Engine } from '../src/server/engine.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Previews } from '../src/server/preview.ts';
import { createApp } from '../src/server/app.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'phantom-logging-'));
  const store = new Store(':memory:');
  const workspaces = new Workspaces(root, store);
  const engine = new Engine(store, new GitHub(store), workspaces, root);
  const output: string[] = [];
  const app = createApp(
    store,
    engine,
    new Previews(store, workspaces),
    4317,
    undefined,
    undefined,
    {
      logger: {
        level: 'debug',
        stream: {
          write: (line: string) => {
            output.push(line);
          },
        },
      },
    },
  );
  t.after(async () => {
    await app.close();
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    app,
    store,
    output,
    records: () =>
      output.flatMap((line) => line.trim().split('\n')).map((line) => JSON.parse(line)),
  };
}

test('HTTP logs expose request correlation and timing without bodies, headers or query values', async (t) => {
  const { app, output } = await fixture(t);
  const session = await app.inject({
    url: '/api/session',
    headers: { host: '127.0.0.1:4317', authorization: 'Bearer header-secret' },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/projects?token=query-secret',
    headers: {
      host: '127.0.0.1:4317',
      cookie: String(session.headers['set-cookie']).split(';')[0],
      'x-phantom-csrf': session.json().csrf,
    },
    payload: { name: 'private-project-title', description: 'private-chat-body' },
  });
  assert.equal(response.statusCode, 200);
  const records = output.flatMap((line) => line.trim().split('\n')).map((line) => JSON.parse(line));
  const completed = records.find(
    (record) => record.msg === 'request completed' && record.method === 'POST',
  );
  assert.ok(completed, 'normal HTTP requests produce visible completion logs');
  assert.equal(completed.route, '/api/projects');
  assert.equal(completed.statusCode, 200);
  assert.ok(typeof completed.elapsedMs === 'number' && completed.elapsedMs >= 0);
  assert.ok(typeof completed.reqId === 'string');
  const text = output.join('');
  for (const secret of [
    'header-secret',
    'query-secret',
    session.json().csrf,
    'private-project-title',
    'private-chat-body',
  ])
    assert.ok(!text.includes(secret), `logs must exclude ${secret}`);
});

test('run logs identify lifecycle and phases without publishing model content; closing detaches logging', async (t) => {
  const { app, store, output, records } = await fixture(t);
  store.saveSettings({ ...store.settings(), defaultAgent: 'codex' });
  const project = store.createProject('private-title', 'private-specification');
  const run = store.run('pm', project.id, 'pm');
  store.activity(run, 'planning', {
    kind: 'phase',
    title: 'private-phase',
    status: 'running',
    details: { output: 'private-model-reply' },
  });
  store.finishRun(run.id, 'failed', 'upstream rejected Bearer credential-secret');
  assert.ok(
    records().some(
      (record) => record.msg === 'run started' && record.runId === run.id && record.role === 'pm',
    ),
  );
  assert.ok(
    records().some(
      (record) =>
        record.msg === 'run phase' && record.runId === run.id && record.status === 'running',
    ),
  );
  const failure = records().find((record) => record.event === 'run' && record.runId === run.id);
  assert.equal(failure.status, 'failed');
  assert.equal(failure.level, 50);
  assert.match(failure.err.message, /upstream rejected/);
  store.event('engine', 'scheduler failed Bearer engine-secret');
  const engineFailure = records().find((record) => record.event === 'engine');
  assert.match(engineFailure.err.message, /scheduler failed/);
  for (const secret of [
    'private-title',
    'private-specification',
    'private-phase',
    'private-model-reply',
    'credential-secret',
    'engine-secret',
  ])
    assert.ok(!output.join('').includes(secret));
  await app.close();
  const count = output.length;
  store.run('pm', project.id, 'pm');
  assert.equal(output.length, count);
});

test('HTTP failures retain useful redacted diagnostics without arbitrary error properties or raw unmatched URLs', async (t) => {
  const { app, output, records } = await fixture(t);
  app.get('/test-failure', async () => {
    throw Object.assign(new Error('upstream failed Bearer exception-secret'), {
      cause: { token: 'cause-secret' },
    });
  });
  const session = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
  const headers = {
    host: '127.0.0.1:4317',
    cookie: String(session.headers['set-cookie']).split(';')[0],
  };
  assert.equal((await app.inject({ url: '/test-failure', headers })).statusCode, 500);
  assert.equal(
    (await app.inject({ url: '/api/unmatched-private-path?token=query-secret', headers }))
      .statusCode,
    404,
  );
  const failure = records().find((record) => record.msg === 'request failed');
  assert.equal(failure.statusCode, 500);
  assert.ok(failure.reqId);
  assert.match(failure.err.message, /upstream failed/);
  for (const secret of [
    'exception-secret',
    'cause-secret',
    'unmatched-private-path',
    'query-secret',
  ])
    assert.ok(!output.join('').includes(secret));
});
