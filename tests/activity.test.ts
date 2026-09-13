import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Engine } from '../src/server/engine.ts';
import { Codex } from '../src/server/codex.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { createApp } from '../src/server/app.ts';
import { Previews } from '../src/server/preview.ts';

test('PM protocol activity follows its message and Run, survives reopen, and retains diagnostic paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-activity-'));
  const file = join(root, 'state.sqlite');
  const store = new Store(file);
  const project = store.createProject('Activity', '');
  const message = store.addMessage(project.id, 'user', 'Inspect the problem', 'discuss');
  const path = String.raw`D:\project\.phantom\workspaces\task-one\src\main.ts`;
  class Protocol extends Codex {
    override async start() {}
    override async stop() {}
    override async thread() {
      return 'pm-thread';
    }
    override async request() {
      const notify = (method: string, params: object) =>
        this.emit('notification', method, { threadId: 'pm-thread', turnId: 'turn-one', ...params });
      notify('turn/started', { turn: { id: 'turn-one' } });
      notify('turn/plan/updated', {
        plan: [{ step: 'Inspect failing command', status: 'inProgress' }],
      });
      notify('item/started', {
        item: {
          id: 'command-one',
          type: 'commandExecution',
          command: `type "${path}"`,
          cwd: String.raw`D:\project\.phantom\workspaces\task-one`,
        },
      });
      notify('item/completed', {
        item: {
          id: 'command-one',
          type: 'commandExecution',
          command: `type "${path}"`,
          aggregatedOutput: 'File not found',
          exitCode: 1,
          status: 'failed',
        },
      });
      notify('item/started', {
        item: {
          id: 'tool-one',
          type: 'mcpToolCall',
          tool: 'read_file',
          arguments: { content: 'x'.repeat(12000), path, api_key: 'tool-secret' },
        },
      });
      assert.equal(store.list('run')[0].status, 'waiting');
      notify('item/completed', {
        item: {
          id: 'tool-one',
          type: 'mcpToolCall',
          tool: 'read_file',
          result: { content: [{ type: 'text', text: 'password="result-secret"' }] },
          status: 'completed',
        },
      });
      notify('item/completed', {
        item: {
          id: 'files',
          type: 'fileChange',
          changes: [{ path, diff: 'unbounded diff excluded' }],
        },
      });
      notify('item/completed', {
        item: { id: 'search', type: 'webSearch', query: 'File not found error' },
      });
      notify('item/completed', {
        item: {
          id: 'summary',
          type: 'reasoning',
          summary: ['The file is missing.'],
          content: ['HIDDEN_REASONING'],
        },
      });
      notify('turn/completed', { turn: { id: 'turn-one', status: 'completed' } });
      return { turn: { id: 'turn-one' } };
    }
  }
  const engine = new Engine(
    store,
    new GitHub(store),
    new Workspaces(root, store),
    root,
    () => new Protocol(),
  );
  try {
    await engine.chat(message);
    const activities = store.snapshot().activities;
    assert.equal(activities[0].kind, 'trigger');
    assert.equal(activities[0].messageId, message.id);
    assert.ok(activities.every((a) => a.runId === store.list('run')[0].id));
    assert.ok(activities.some((a) => a.kind === 'plan'));
    const command = activities.find((a) => a.kind === 'command')!;
    assert.equal(command.status, 'failed');
    assert.ok(command.details.command?.includes(path));
    assert.equal(command.details.output, 'File not found');
    assert.equal(activities.find((a) => a.kind === 'files')?.details.paths, path);
    assert.equal(activities.find((a) => a.kind === 'tool')?.details.paths, path);
    assert.equal(activities.find((a) => a.kind === 'search')?.status, 'completed');
    assert.ok(!JSON.stringify(activities).includes('tool-secret'));
    assert.ok(!JSON.stringify(activities).includes('result-secret'));
    assert.ok(!JSON.stringify(activities).includes('HIDDEN_REASONING'));
    store.close();
    const reopened = new Store(file);
    assert.deepEqual(reopened.snapshot().activities, activities);
    reopened.close();
  } finally {
    await engine.stop();
  }
});

test('activity and technical events redact credentials while preserving paths and bounded diagnostic output', () => {
  const store = new Store(':memory:');
  const project = store.createProject('Secrets', '');
  const run = store.run('pm', project.id, 'pm');
  const path = String.raw`D:\private\worktree-two\file.ts`;
  const secrets =
    'Authorization: Bearer auth-secret\nCookie: session=cookie-secret; other=other-secret\n{"api_key":"key-secret","password":"pass secret","token":"token-secret"}\nhttps://user:url-secret@example.invalid/?token=query-secret\n--password cli-secret\n';
  store.activity(run, 'command', {
    kind: 'command',
    title: 'command',
    status: 'failed',
    details: {
      command: `type "${path}"`,
      output: `First cause\n${secrets}${'x'.repeat(24000)}`,
      error: secrets,
    },
  });
  store.activity(run, 'headers', {
    kind: 'command',
    title: 'headers',
    status: 'completed',
    details: {
      command: `curl -H "Authorization: Basic basic-secret" -H 'Cookie: session=quoted-cookie' --output "${path}" https://url-token@example.invalid`,
    },
  });
  store.event('command', secrets, { runId: run.id, projectId: project.id });
  const snapshot = store.snapshot();
  const serialized = JSON.stringify(snapshot);
  for (const secret of [
    'auth-secret',
    'cookie-secret',
    'other-secret',
    'key-secret',
    'pass secret',
    'token-secret',
    'url-secret',
    'query-secret',
    'cli-secret',
    'basic-secret',
    'quoted-cookie',
    'url-token',
  ])
    assert.ok(!serialized.includes(secret), secret);
  assert.ok(snapshot.activities[0].details.command?.includes(path));
  assert.ok(snapshot.activities[1].details.command?.includes(path));
  assert.ok(snapshot.activities[0].details.output!.startsWith('First cause'));
  assert.ok(snapshot.activities[0].details.output!.length <= 8200);
  store.close();
});

test('PM batches readable deltas, filters other Runs, publishes safe streaming text and closes interrupted activity on recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-deltas-'));
  const store = new Store(join(root, 'state.sqlite'));
  const project = store.createProject('Deltas', '');
  const message = store.addMessage(project.id, 'user', 'Inspect', 'discuss');
  let changes = 0;
  const streams: unknown[] = [];
  store.changes.on('change', () => changes++);
  store.changes.on('delta', (value) => streams.push(value));
  class Protocol extends Codex {
    override async start() {}
    override async stop() {}
    override async thread() {
      return 'pm-thread';
    }
    override async request() {
      const notify = (method: string, params: object) =>
        this.emit('notification', method, { threadId: 'pm-thread', turnId: 'turn-one', ...params });
      notify('turn/started', { turn: { id: 'turn-one' } });
      notify('item/started', { item: { id: 'summary', type: 'reasoning', summary: [] } });
      for (const delta of 'Examining the worktree.\nAuthorization: Bearer split-secret\n') {
        notify('item/reasoning/summaryTextDelta', { itemId: 'summary', summaryIndex: 0, delta });
        notify('item/agentMessage/delta', { itemId: 'answer', delta });
      }
      notify('item/reasoning/textDelta', { itemId: 'summary', delta: 'HIDDEN_RAW' });
      notify('item/started', {
        threadId: 'another-thread',
        item: { id: 'wrong', type: 'webSearch', query: 'WRONG_RUN' },
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.match(JSON.stringify(store.snapshot().activities), /Examining the worktree/);
      assert.ok(changes < 12, `coalesced ${changes} writes`);
      notify('item/completed', {
        item: { id: 'summary', type: 'reasoning', summary: ['Examining the worktree.'] },
      });
      notify('turn/completed', {
        turn: {
          id: 'turn-one',
          status: 'failed',
          error: { message: 'failed at D:\\worktree\\file.ts' },
        },
      });
      return { turn: { id: 'turn-one' } };
    }
  }
  const engine = new Engine(
    store,
    new GitHub(store),
    new Workspaces(root, store),
    root,
    () => new Protocol(),
  );
  await assert.rejects(engine.chat(message), /failed at/);
  const result = JSON.stringify([store.snapshot(), streams]);
  for (const forbidden of ['split-secret', 'HIDDEN_RAW', 'WRONG_RUN'])
    assert.ok(!result.includes(forbidden), forbidden);
  assert.equal(store.list('run')[0].status, 'failed');
  changes = 0;
  await assert.rejects(engine.chat(store.get('message', message.id)!), /failed at/);
  assert.equal(
    store.snapshot().activities.filter((a) => a.kind === 'trigger')[1].title,
    '恢复：重试用户消息',
  );
  const interrupted = store.run('pm', project.id, 'pm');
  store.activity(interrupted, 'pending', {
    kind: 'tool',
    title: 'Waiting for tool',
    status: 'waiting',
    details: {},
  });
  store.recover();
  assert.equal(
    store.snapshot().activities.find((a) => a.id === `${interrupted.id}:pending`)?.status,
    'interrupted',
  );
  assert.ok(
    store
      .snapshot()
      .activities.some((a) => a.runId === interrupted.id && a.details.source === '服务重启恢复'),
  );
  await engine.stop();
  store.close();
});

test('local HTTP restores only safe activity details including full worktree paths', async () => {
  const store = new Store(':memory:');
  const project = store.createProject('HTTP activity', '');
  const run = store.run('pm', project.id, 'pm');
  const path = String.raw`D:\projects\private\worktree-three\main.ts`;
  store.activity(run, 'command', {
    kind: 'command',
    title: '执行命令',
    status: 'completed',
    details: {
      command: `type "${path}" --token http-secret`,
      output: 'Cookie: session=http-cookie',
    },
  });
  const ws = new Workspaces('.phantom/test-http', store);
  const engine = new Engine(store, new GitHub(store), ws, '.phantom/test-http');
  const app = createApp(store, engine, new Previews(store, ws));
  try {
    const session = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
    const response = await app.inject({
      url: '/api/state',
      headers: {
        host: '127.0.0.1:4317',
        cookie: String(session.headers['set-cookie']).split(';')[0],
      },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().activities[0].details.command.includes(path));
    assert.ok(!response.body.includes('http-secret'));
    assert.ok(!response.body.includes('http-cookie'));
  } finally {
    await app.close();
    store.close();
  }
});

test('a protocol-interrupted PM Run remains interrupted after a service restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-interrupted-'));
  const file = join(root, 'state.sqlite');
  const store = new Store(file);
  const project = store.createProject('Interrupted', '');
  class Protocol extends Codex {
    override async start() {}
    override async stop() {}
    override async thread() {
      return 'thread';
    }
    override async request() {
      this.emit('notification', 'turn/started', { threadId: 'thread', turn: { id: 'turn' } });
      this.emit('notification', 'item/started', {
        threadId: 'thread',
        turnId: 'turn',
        item: { id: 'tool', type: 'dynamicToolCall', tool: 'read_file', arguments: {} },
      });
      this.emit('notification', 'turn/completed', {
        threadId: 'thread',
        turn: { id: 'turn', status: 'interrupted' },
      });
      return { turn: { id: 'turn' } };
    }
  }
  const engine = new Engine(
    store,
    new GitHub(store),
    new Workspaces(root, store),
    root,
    () => new Protocol(),
  );
  try {
    await assert.rejects(
      engine.chat(store.addMessage(project.id, 'user', 'Inspect', 'discuss')),
      /interrupted/,
    );
    assert.equal(store.list('run')[0].status, 'interrupted');
    assert.equal(store.snapshot().activities.find((a) => a.kind === 'tool')?.status, 'interrupted');
    const active = store.run('pm', project.id, 'pm');
    store.activity(active, 'waiting', {
      kind: 'tool',
      title: '等待工具',
      status: 'waiting',
      details: {},
    });
    await engine.stop();
    store.close();
    const reopened = new Store(file);
    reopened.recover();
    assert.equal(reopened.get('run', active.id)?.status, 'interrupted');
    assert.ok(
      reopened
        .snapshot()
        .activities.some((a) => a.runId === active.id && a.details.source === '服务重启恢复'),
    );
    reopened.close();
  } finally {
    await engine.stop();
  }
});
