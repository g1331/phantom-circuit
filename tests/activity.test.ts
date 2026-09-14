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

test('credential commands retain ordinary paths and URLs through durable activity, events and HTTP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-auth-'));
  const file = join(root, 'state.sqlite');
  const store = new Store(file);
  const project = store.createProject('Auth diagnostics', '');
  const run = store.run('pm', project.id, 'pm');
  const path = String.raw`D:\projects\token tools\secret notes\worktree`;
  const url = 'https://example.invalid/diagnostics';
  const commands = [
    `psql postgresql://alice:db-secret@localhost/app --file "${path}\\query.sql"`,
    `redis-cli -u redis://alice:redis-secret@localhost/0`,
    `curl --user alice:basic-secret ${url} --output "${path}\\result.txt"`,
    `curl -u 'alice:short-secret' ${url}`,
    `curl --user="alice:equals-secret" ${url}`,
    `curl -ualice:attached-secret ${url}`,
    `tool --token=flag-secret --password "space secret" ${url}`,
    `type "${path}\\password notes.txt"`,
    `$env:API_KEY=ps-api-value; tool "${path}" ${url}`,
    `$env:TOKEN = 'ps-token-value'; tool "${path}" ${url}`,
    `$ENV:OPENAI_API_KEY = "ps-provider-value"; tool "${path}" ${url}`,
    `\${env:SECRET} = 'ps-braced-value'; tool "${path}" ${url}`,
    `$env:PASSWORD = 'ps-single''quote-value'; tool "${path}" ${url}`,
    '$env:PASSWORD = "ps-double`"quote-value"; tool "' + path + '" ' + url,
    `$env:AUTHORIZATION = 'Basic ps-auth-value'; tool "${path}" ${url}`,
    `$env:COOKIE = 'session=ps-cookie-value'; tool "${path}" ${url}`,
    `$env:PATH = '${path}'; tool ${url}`,
  ];
  for (const [index, command] of commands.entries()) {
    store.activity(run, `command-${index}`, {
      kind: 'command',
      title: 'command',
      status: 'completed',
      details: { command, cwd: path },
    });
    store.event('command', command, { runId: run.id, projectId: project.id });
  }
  store.close();
  const reopened = new Store(file);
  const ws = new Workspaces(root, reopened);
  const app = createApp(
    reopened,
    new Engine(reopened, new GitHub(reopened), ws, root),
    new Previews(reopened, ws),
  );
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
    for (const secret of [
      'db-secret',
      'redis-secret',
      'basic-secret',
      'short-secret',
      'equals-secret',
      'attached-secret',
      'flag-secret',
      'space secret',
      'ps-api-value',
      'ps-token-value',
      'ps-provider-value',
      'ps-braced-value',
      'ps-single',
      'quote-value',
      'ps-double',
      'ps-auth-value',
      'ps-cookie-value',
    ])
      assert.ok(!response.body.includes(secret), secret);
    const activities = response.json().activities;
    assert.ok(activities.every((a: any) => a.details.cwd === path));
    assert.ok(activities[0].details.command.includes('localhost/app'));
    assert.ok(activities[0].details.command.includes(path));
    for (const index of [2, 3, 4, 5, 6]) assert.ok(activities[index].details.command.includes(url));
    assert.equal(activities[7].details.command, commands[7]);
    for (const activity of activities.slice(8)) {
      assert.ok(activity.details.command.includes(`tool`));
      assert.ok(activity.details.command.includes(path));
      assert.ok(activity.details.command.includes(url));
    }
    assert.equal(activities.at(-1).details.command, commands.at(-1));
  } finally {
    await app.close();
    reopened.close();
  }
});

test('generic shell credential assignments never reach durable activity or events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-shell-auth-'));
  const file = join(root, 'state.sqlite');
  const store = new Store(file);
  const project = store.createProject('Shell credentials', '');
  const run = store.run('pm', project.id, 'pm');
  const path = String.raw`D:\worktrees\token tools\secret notes\worktree`;
  const url = 'https://example.invalid/diagnostics';
  const commands = [
    `PGPASSWORD=pg-secret psql -h localhost app --file "${path}\\query.sql"`,
    `AWS_SECRET_ACCESS_KEY=aws-secret aws s3 ls --output "${path}"`,
    `MYSQL_PWD=mysql-secret mysql -u root -h localhost app`,
    `set PGPASSWORD=set-secret && tool "${path}" ${url}`,
    `PGPASSWORD="pg spaced secret" psql -h localhost app`,
    `docker run -e AWS_SECRET_ACCESS_KEY=docker-secret img "${path}"`,
    `npm config set //registry/:_authToken=npm-secret && tool ${url}`,
    `TOKENIZERS_PARALLELISM=false tool "${path}" ${url}`,
    `find "${path}" -print -name password`,
    `mysql -u root -p dbname`,
    `docker run --user 1000:1000 img`,
    `psql -U postgres -d app --file "${path}\\query.sql"`,
    `curl --user alice:round-secret ${url} --output "${path}\\result.txt"`,
    `mysql -pmysql-secret db`,
    `mysqldump -pS3cr3t app`,
    `mysql -p"mysql spaced secret" db`,
    `redis-cli -a redis-secret ping`,
    `redis-cli --pass redis-pass-secret ping`,
    `redis-cli --pass=redis-equals-secret ping`,
    `sshpass -p ssh-secret ssh user@host`,
    `sqlcmd -P sqlcmd-secret -U sa`,
  ];
  for (const [index, command] of commands.entries()) {
    store.activity(run, `shell-${index}`, {
      kind: 'command',
      title: 'command',
      status: 'completed',
      details: { command, cwd: path },
    });
    store.event('command', command, { runId: run.id, projectId: project.id });
  }
  store.close();
  const reopened = new Store(file);
  try {
    const activities = reopened.snapshot().activities;
    const messages = reopened.events().map((event) => event.message);
    for (const secret of [
      'pg-secret',
      'aws-secret',
      'mysql-secret',
      'set-secret',
      'pg spaced secret',
      'docker-secret',
      'npm-secret',
      'round-secret',
      'S3cr3t',
      'mysql spaced secret',
      'redis-secret',
      'redis-pass-secret',
      'redis-equals-secret',
      'ssh-secret',
      'sqlcmd-secret',
    ]) {
      assert.ok(!activities.some((activity) => JSON.stringify(activity).includes(secret)), secret);
      assert.ok(!messages.some((message) => message.includes(secret)), secret);
    }
    assert.ok(activities.every((activity) => activity.details.cwd === path));
    assert.ok(activities[0].details.command?.includes('psql -h localhost app'));
    assert.ok(activities[0].details.command?.includes(path));
    assert.ok(activities[1].details.command?.includes('aws s3 ls'));
    assert.ok(activities[2].details.command?.includes('mysql -u root -h localhost app'));
    assert.ok(activities[3].details.command?.includes('&& tool'));
    assert.ok(activities[4].details.command?.includes('psql -h localhost app'));
    assert.ok(activities[5].details.command?.includes(path));
    assert.ok(activities[6].details.command?.includes('//registry/:_authToken='));
    assert.ok(activities[6].details.command?.includes(url));
    assert.equal(activities[7].details.command, commands[7]);
    assert.equal(activities[8].details.command, commands[8]);
    assert.equal(activities[9].details.command, commands[9]);
    assert.equal(activities[10].details.command, commands[10]);
    assert.ok(activities[11].details.command?.includes('psql -U postgres -d app'));
    assert.ok(activities[11].details.command?.includes(path));
    assert.ok(activities[12].details.command?.includes(url));
    assert.ok(activities[12].details.command?.includes(path));
    assert.ok(activities[13].details.command?.includes('-p'));
    assert.ok(activities[13].details.command?.includes(' db'));
    assert.ok(activities[14].details.command?.includes(' app'));
    assert.ok(activities[15].details.command?.includes(' db'));
    assert.ok(activities[16].details.command?.includes('-a'));
    assert.ok(activities[16].details.command?.includes(' ping'));
    assert.ok(activities[17].details.command?.includes('--pass'));
    assert.ok(activities[18].details.command?.includes('--pass='));
    assert.ok(activities[19].details.command?.includes('ssh user@host'));
    assert.ok(activities[20].details.command?.includes('-U sa'));
  } finally {
    reopened.close();
  }
});

test('program-scoped password flags remove credentials while ambiguous flags and paths stay readable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-flag-auth-'));
  const file = join(root, 'state.sqlite');
  const store = new Store(file);
  const project = store.createProject('Flag credentials', '');
  const run = store.run('pm', project.id, 'pm');
  const path = String.raw`D:\worktrees\token tools\secret notes\worktree`;
  const url = 'https://example.invalid/keep';
  const commands = [
    `curl -H "X-Api-Key: header-secret" ${url}`,
    `curl -H "X-Trace: keep-header" ${url}`,
    `PASSWORDS=plural-secret tool`,
    `setx MYSQL_PWD setx-secret`,
    `sqlplus scott/tiger-secret@db`,
    `notoken=1 tool`,
    `TOKENS=123 tool`,
    `{"tokens":123}`,
    `docker run -p 8080:80 img`,
    `docker run -p8080:80 img`,
    `grep -a pattern file`,
    `mysql -P 3306 -h db`,
    `pg_dump -W -U app -h db app`,
    `setx PATH "C:\\tools"`,
    `redis-cli -aredis-glued-secret ping`,
    `PGPASSWORD="pg spaced prefix" mysql -pprefixed-secret db`,
  ];
  for (const [index, command] of commands.entries()) {
    store.activity(run, `flag-${index}`, {
      kind: 'command',
      title: 'command',
      status: 'completed',
      details: { command, cwd: path },
    });
    store.event('command', command, { runId: run.id, projectId: project.id });
  }
  store.close();
  const reopened = new Store(file);
  try {
    const activities = reopened.snapshot().activities;
    const messages = reopened.events().map((event) => event.message);
    for (const secret of [
      'header-secret',
      'plural-secret',
      'setx-secret',
      'tiger-secret',
      'redis-glued-secret',
      'prefixed-secret',
      'pg spaced prefix',
    ]) {
      assert.ok(!activities.some((activity) => JSON.stringify(activity).includes(secret)), secret);
      assert.ok(!messages.some((message) => message.includes(secret)), secret);
    }
    assert.ok(activities.every((activity) => activity.details.cwd === path));
    const header = activities[0].details.command ?? '';
    assert.ok(header.includes('X-Api-Key: '));
    assert.equal(header.split('"').length - 1, 2);
    assert.ok(header.endsWith(url));
    assert.ok(activities[2].details.command?.includes('PASSWORDS='));
    assert.ok(activities[2].details.command?.endsWith(' tool'));
    assert.ok(activities[3].details.command?.includes('setx MYSQL_PWD '));
    assert.ok(activities[4].details.command?.includes('scott/'));
    assert.ok(activities[4].details.command?.includes('@db'));
    assert.ok(activities[4].details.command?.startsWith('sqlplus '));
    for (const index of [1, 5, 6, 7, 8, 9, 10, 11, 12, 13])
      assert.equal(activities[index].details.command, commands[index]);
    // A glued redis-cli password and a password flag behind an environment assignment are both credentials.
    assert.ok(activities[14].details.command?.includes('redis-cli -a'));
    assert.ok(activities[14].details.command?.includes(' ping'));
    assert.ok(activities[15].details.command?.includes('mysql -p'));
    assert.ok(activities[15].details.command?.includes(' db'));
  } finally {
    reopened.close();
  }
});

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
