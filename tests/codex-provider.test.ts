import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { Engine } from '../src/server/engine.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { devFixture } from './dev-fixture.ts';

test('PM startup failures expose bounded, redacted trailing stderr in the public Run error', async () => {
  const { root, store, project, github } = await devFixture('phantom-pm-startup-failure-');
  const engine = new Engine(
    store,
    github,
    new Workspaces(root, store),
    root,
    () =>
      new Codex((_binary, _args, options) =>
        spawn(
          process.execPath,
          [
            '-e',
            `
            process.stdin.once('data', () => {
              process.stderr.write('x'.repeat(10000) + '\\n');
              process.stderr.write('\\x1b[31mError: invalid transport\\x1b[0m\\n');
              process.stderr.write('Authorization: Bearer fixture-private-token\\n');
              process.stderr.write('in mcp_servers.amap-maps', () => process.exit(1));
            });
          `,
          ],
          options,
        ),
      ),
  );
  try {
    const message = store.addMessage(project.id, 'user', 'Discuss the next step', 'discuss');
    await assert.rejects(engine.chat(message), /Codex 进程退出 \(1\)/);
    const run = store.snapshot().runs.find((run) => run.sourceMessageId === message.id)!;
    assert.equal(run.status, 'failed');
    assert.match(run.error!, /Error: invalid transport/);
    assert.match(run.error!, /in mcp_servers\.amap-maps/);
    assert.doesNotMatch(run.error!, /fixture-private-token|\x1b/);
    assert.ok(run.error!.length < 6500);
    assert.equal(store.get('message', message.id)?.status, 'failed');
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('Codex starts without inherited MCP connections when plugins disappear under isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-codex-discovery-'));
  const entry = join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const marker = join(root, 'external-mcp-started');
  const path = process.env.PATH;
  const codex = new Codex();
  await mkdir(join(root, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
  const script = `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const config = new Map();
    for (let i = 0; i < args.length; i++)
      if (args[i] === '-c') {
        const [key, ...value] = args[++i].split('=');
        config.set(key, value.join('='));
      }
    const plugins = config.get('features.plugins') !== 'false';
    if (args.includes('--version')) {
      console.log('codex-cli fixture');
    } else if (args.includes('list')) {
      console.log(JSON.stringify([
        { name: 'fixture-external' },
        ...(plugins ? [{ name: 'fixture-plugin' }] : [])
      ]));
    } else if (!plugins && config.has('mcp_servers.fixture-plugin.enabled')) {
      console.error('Error: invalid transport in mcp_servers.fixture-plugin');
      process.exitCode = 1;
    } else {
      if (config.get('mcp_servers.fixture-external.enabled') !== 'false' ||
          (plugins && config.get('mcp_servers.fixture-plugin.enabled') !== 'false'))
        fs.writeFileSync(${JSON.stringify(marker)}, 'external MCP started');
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        if (message.id !== undefined)
          console.log(JSON.stringify({ id: message.id, result: {} }));
      });
    }
  `;
  try {
    await writeFile(entry, script);
    if (process.platform === 'win32') {
      await writeFile(join(root, 'codex.cmd'), '@echo off\r\n');
    } else {
      await writeFile(join(root, 'codex'), `#!${process.execPath}\n${script}`);
      await chmod(join(root, 'codex'), 0o755);
    }
    process.env.PATH = `${root}${delimiter}${path ?? ''}`;
    await codex.start();
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally {
    await codex.stop();
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('Codex owner fork uses native read-only branching, rejects inherited host tools and verifies the effective identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-codex-owner-'));
  const forkPath = join(root, 'rollout-owner-fork.jsonl');
  const sourcePath = join(root, 'rollout-source.jsonl');
  await writeFile(sourcePath, 'synthetic source stays untouched');
  const codex = new Codex((_binary, _args, options) =>
    spawn(
      process.execPath,
      [
        '-e',
        `
    const send = value => console.log(JSON.stringify(value));
    let calls = [], rejected = false, goal = {threadId:'owner-fork'}, unsupported = false;
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      if (m.id === 'inherited-tool') { rejected = !!m.error || m.result?.success === false; return; }
      if (!m.method || m.id === undefined) return;
      calls.push(m);
      let result = {};
      if (m.method === 'thread/fork') {
        unsupported = m.params.threadId === 'unsupported-goal';
        require('node:fs').writeFileSync(${JSON.stringify(forkPath)}, JSON.stringify({type:'session_meta',payload:{id:'owner-fork'}})+'\\n');
        result = { thread: { id: m.params.threadId === 'same-source' ? 'same-source' : 'owner-fork', path:${JSON.stringify(forkPath)} }, model: m.params.threadId === 'wrong-model' ? 'other' : m.params.model, modelProvider: m.params.modelProvider, reasoningEffort: m.params.config.model_reasoning_effort };
        send({ id: m.id, result });
        send({ id: 'inherited-tool', method: 'item/tool/call', params: { threadId: 'owner-fork', tool: 'ask_pm', arguments: { question: 'mutate' } } });
        return;
      }
      if (m.method === 'fixture/read') result = { calls, rejected };
      if (m.method === 'thread/goal/get') result = {goal};
      if (m.method === 'thread/goal/get' && unsupported) { send({id:m.id,error:{message:'unsupported goal API'}}); return; }
      if (m.method === 'thread/goal/clear') { goal = null; result = {cleared:true}; }
      if (m.method === 'turn/start') {
        send({id:m.id,result:{turn:{id:'owner-turn'}}});
        send({method:'item/agentMessage/delta',params:{threadId:m.params.threadId,turnId:'owner-turn',itemId:'answer',delta:'read-only answer'}});
        send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'owner-turn',status:goal ? 'failed' : 'completed'}}});
        return;
      }
      send({ id: m.id, result });
      if (m.method === 'fixture/exit') setImmediate(() => process.exit(0));
    });
  `,
      ],
      options,
    ),
  );
  try {
    await codex.start({
      id: 'fork-fixture',
      baseUrl: 'http://localhost:9876/v1',
      apiKey: 'fixture-key',
    });
    const plan = {
      sourceThreadId: 'source',
      cwd: process.cwd(),
      profile: { model: 'fixture', effort: 'low' },
      instructions: 'owner read only',
      dataDir: join(root, '.phantom'),
    };
    assert.equal(await codex.forkReadOnlyThread(plan), 'owner-fork');
    assert.equal(
      await codex.turn('owner-fork', 'fixture owner question', plan.profile),
      'read-only answer',
    );
    const observed = await codex.request('fixture/read');
    const fork = observed.calls.find((m: { method: string }) => m.method === 'thread/fork');
    assert.equal(fork.params.threadId, 'source');
    assert.equal(fork.params.sandbox, 'read-only');
    assert.equal(fork.params.approvalPolicy, 'never');
    assert.equal(fork.params.deferGoalContinuation, true);
    assert.equal(fork.params.ephemeral, false);
    assert.equal(fork.params.developerInstructions, 'owner read only');
    assert.equal(fork.params.dynamicTools, undefined);
    assert.equal(observed.rejected, true);
    assert.deepEqual(
      observed.calls
        .filter((m: { method: string }) => m.method.startsWith('thread/goal/'))
        .map((m: { method: string; params: { threadId: string } }) => [
          m.method,
          m.params.threadId,
        ]),
      [
        ['thread/goal/get', 'owner-fork'],
        ['thread/goal/clear', 'owner-fork'],
        ['thread/goal/get', 'owner-fork'],
      ],
    );
    const firstTurn = observed.calls.findIndex(
      (m: { method: string }) => m.method === 'turn/start',
    );
    const clearGoal = observed.calls.findIndex(
      (m: { method: string }) => m.method === 'thread/goal/clear',
    );
    assert.ok(clearGoal >= 0 && firstTurn > clearGoal);
    assert.equal(observed.calls[firstTurn].params.threadId, 'owner-fork');
    assert.ok(
      !observed.calls.some((m: { method: string }) =>
        ['thread/start', 'thread/resume', 'turn/steer'].includes(m.method),
      ),
    );
    await assert.rejects(
      codex.forkReadOnlyThread({ ...plan, sourceThreadId: 'same-source' }),
      /独立/,
    );
    await assert.rejects(
      codex.forkReadOnlyThread({ ...plan, sourceThreadId: 'wrong-model' }),
      /实际模型/,
    );
    await assert.rejects(
      codex.forkReadOnlyThread({ ...plan, sourceThreadId: 'unsupported-goal' }),
      /unsupported goal API/,
    );
  } finally {
    await codex.request('fixture/exit');
    await codex.stop();
  }
  assert.equal(await readFile(sourcePath, 'utf8'), 'synthetic source stays untouched');
  assert.match(await readFile(forkPath, 'utf8'), /session_meta/);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function streamingFixture(work: (codex: Codex) => Promise<void>) {
  let exited!: Promise<void>;
  const codex = new Codex((_binary, _args, options) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      const key = process.env[Object.keys(process.env).find(k => k.startsWith('PHANTOM_PROVIDER_KEY_'))];
      const send = value => console.log(JSON.stringify(value));
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const m = JSON.parse(line);
        if (m.id === undefined) return;
        send({ id: m.id, result: { turn: { id: 'turn' } } });
        if (m.method === 'turn/start') {
          const threadId = m.params.threadId;
          send({ method: 'turn/started', params: { threadId, turn: { id: 'turn' } } });
          const scenario = m.params.input[0].text;
          if (scenario === 'terminal-completed') {
            send({ method: 'item/completed', params: { threadId, turnId: 'turn', item: { id: 'final', type: 'agentMessage', text: 'ending ow' } } });
            send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn', status: 'completed' } } });
            return;
          }
          if (['cross-item', 'completed-only', 'normal-items'].includes(scenario)) {
            const items = scenario === 'normal-items' ? [['first', 'ordinary ow'], ['second', 'ner text.']]
              : [['first', key.slice(0, 8)], ['second', key.slice(8)]];
            for (const [itemId, text] of items) {
              if (scenario !== 'completed-only') send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn', itemId, delta: text } });
              send({ method: 'item/completed', params: { threadId, turnId: 'turn', item: { id: itemId, type: 'agentMessage', text } } });
            }
            send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn', status: 'completed' } } });
            return;
          }
          const chunks = scenario === 'cancelled' || scenario === 'failed' ? ['ow'] : scenario === 'characters' ? Array.from('before ' + key + key + ' after')
            : scenario === 'prefix' ? ['ordinary ow', 'ner text ', 'ow']
            : ['before ', key.slice(0, 8), key.slice(8, 13), key.slice(13), ' after'];
          for (const delta of chunks)
            send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn', itemId: 'message', delta } });
          if (scenario === 'cancelled') return;
          if (scenario === 'completed')
            send({ method: 'item/completed', params: { threadId, turnId: 'turn', item: { id: 'message', type: 'agentMessage', text: 'before ' + key + ' after' } } });
          send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn', status: scenario === 'failed' ? 'failed' : 'completed' } } });
        }
        if (m.method === 'fixture/exit') setImmediate(() => process.exit(0));
      });
    `,
      ],
      options,
    );
    exited = new Promise((resolve) => child.on('close', () => resolve()));
    return child;
  });
  try {
    await codex.start({
      id: 'stream-fixture',
      baseUrl: 'http://localhost:9876/v1',
      apiKey: 'owner-stream-fixture-key',
    });
    await work(codex);
  } finally {
    await codex.request('fixture/exit');
    await exited;
    await codex.stop();
  }
}

test('streamed Provider keys are filtered before notifications and turn results reach consumers', async () => {
  await streamingFixture(async (codex) => {
    const deltas: string[] = [];
    codex.on('notification', (method, params) => {
      if (method === 'item/agentMessage/delta') deltas.push(params.delta);
    });
    const result = await codex.turn('thread', 'fixture', { model: 'fixture', effort: 'low' });
    assert.equal(deltas.join(''), 'before <REDACTED> after');
    assert.equal(result, 'before <REDACTED> after');
  });
});

test('Provider keys split across completed items cannot be reconstructed from either notification outlet', async () => {
  await streamingFixture(async (codex) => {
    for (const scenario of ['cross-item', 'completed-only']) {
      const deltas: string[] = [];
      const items: string[] = [];
      const attribution: unknown[] = [];
      const listen = (method: string, p: any) => {
        if (method === 'item/agentMessage/delta') deltas.push(p.delta);
        if (method === 'item/completed') {
          items.push(p.item.text);
          attribution.push([p.threadId, p.turnId, p.item.id]);
        }
      };
      codex.on('notification', listen);
      try {
        const result = await codex.turn('thread', scenario, { model: 'fixture', effort: 'low' });
        assert.equal(deltas.join(''), scenario === 'cross-item' ? '<REDACTED>' : '');
        assert.equal(items.join(''), '<REDACTED>');
        assert.deepEqual(attribution, [
          ['thread', 'turn', 'first'],
          ['thread', 'turn', 'second'],
        ]);
        assert.ok(!result.includes('owner-stream-fixture-key'));
      } finally {
        codex.off('notification', listen);
      }
    }
  });
});

test('delayed completed items preserve ordinary text, attribution and the final reply', async () => {
  await streamingFixture(async (codex) => {
    const items: unknown[] = [];
    const deltas: string[] = [];
    codex.on('notification', (method, p) => {
      if (method === 'item/completed') items.push([p.threadId, p.turnId, p.item.id, p.item.text]);
      if (method === 'item/agentMessage/delta') deltas.push(p.delta);
    });
    const result = await codex.turn('thread', 'normal-items', { model: 'fixture', effort: 'low' });
    assert.deepEqual(items, [
      ['thread', 'turn', 'first', 'ordinary ow'],
      ['thread', 'turn', 'second', 'ner text.'],
    ]);
    assert.equal(deltas.join(''), 'ordinary owner text.');
    assert.equal(result, 'ner text.');
  });
});

test('terminal completed text masks an unresolved key prefix before returning', async () => {
  await streamingFixture(async (codex) => {
    const items: string[] = [];
    codex.on('notification', (method, p) => {
      if (method === 'item/completed') items.push(p.item.text);
    });
    assert.equal(
      await codex.turn('thread', 'terminal-completed', { model: 'fixture', effort: 'low' }),
      'ending <REDACTED>',
    );
    assert.deepEqual(items, ['ending <REDACTED>']);
  });
});

test('failed turns mask candidate tails and do not carry them into the next turn', async () => {
  await streamingFixture(async (codex) => {
    const deltas: string[] = [];
    codex.on('notification', (method, p) => {
      if (method === 'item/agentMessage/delta') deltas.push(p.delta);
    });
    await assert.rejects(
      codex.turn('thread', 'failed', { model: 'fixture', effort: 'low' }),
      /Agent failed/,
    );
    assert.deepEqual(deltas, ['<REDACTED>']);
    deltas.length = 0;
    assert.equal(
      await codex.turn('thread', 'fixture', { model: 'fixture', effort: 'low' }),
      'before <REDACTED> after',
    );
    assert.equal(deltas.join(''), 'before <REDACTED> after');
  });
});

test('stream filtering preserves ordinary prefixes and handles single-character chunks, repeated keys and final item text', async () => {
  await streamingFixture(async (codex) => {
    for (const [scenario, expected] of [
      ['characters', 'before <REDACTED><REDACTED> after'],
      ['prefix', 'ordinary owner text <REDACTED>'],
      ['completed', 'before <REDACTED> after'],
    ]) {
      const deltas: string[] = [];
      const completed: string[] = [];
      const atCompletion: string[] = [];
      const listen = (method: string, p: any) => {
        if (method === 'item/agentMessage/delta') deltas.push(p.delta);
        if (method === 'item/completed') completed.push(p.item.text);
        if (method === 'turn/completed') atCompletion.push(deltas.join(''));
      };
      codex.on('notification', listen);
      try {
        assert.equal(
          await codex.turn('thread', scenario, { model: 'fixture', effort: 'low' }),
          expected,
        );
        assert.equal(deltas.join(''), expected);
        assert.deepEqual(atCompletion, [expected], 'flush must precede completion');
        if (scenario === 'completed') assert.deepEqual(completed, [expected]);
      } finally {
        codex.off('notification', listen);
      }
    }
  });
});

test('cancelling a turn masks its withheld key prefix before the next turn', async () => {
  await streamingFixture(async (codex) => {
    const deltas: string[] = [];
    codex.on('notification', (method, params) => {
      if (method === 'item/agentMessage/delta') deltas.push(params.delta);
    });
    const abort = new AbortController();
    const cancelled = codex.turn(
      'thread',
      'cancelled',
      { model: 'fixture', effort: 'low' },
      abort.signal,
    );
    const rejected = assert.rejects(cancelled, /执行已暂停/);
    await codex.request('fixture/barrier');
    abort.abort();
    await rejected;
    assert.deepEqual(deltas, ['<REDACTED>']);
    deltas.length = 0;
    const result = await codex.turn('thread', 'fixture', { model: 'fixture', effort: 'low' });
    assert.equal(result, 'before <REDACTED> after');
    assert.equal(deltas.join(''), result);
  });
});

test('custom Codex launch uses argument overrides and a child-only key binding; official launch pins the existing login', async () => {
  const secret = 'process-private-fixture';
  const inherited = { ...process.env };
  const launches: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const diagnostics: string[] = [];
  const exits: Promise<void>[] = [];
  // Real child process implements the external app-server protocol and inspects its own environment.
  const script = `
    const readline = require('node:readline');
    const keys = Object.keys(process.env).filter(k => k.startsWith('PHANTOM_PROVIDER_KEY_'));
    readline.createInterface({input: process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      if (m.id === undefined) return;
      const result = m.method === 'model/list' ? {data: [{id: 'fixture', model: 'fixture', displayName: 'Fixture', supportedReasoningEfforts: [{reasoningEffort:'low'}]}]}
        : m.method === 'thread/start' || m.method === 'thread/resume' ? {thread:{id:'fixture-thread'}, modelProvider: m.params.model === 'mismatch-provider' ? 'wrong' : keys.length ? 'fixture-provider' : 'openai', model: m.params.model === 'mismatch-model' ? 'other-model' : m.params.model, reasoningEffort: m.params.model === 'mismatch-effort' ? 'high' : m.params.model === 'missing-effort' ? undefined : m.params.config.model_reasoning_effort}
        : {keys, value: keys.length ? process.env[keys[0]] : null};
      console.log(JSON.stringify({id:m.id,result}));
      if (m.method === 'fixture/exit') setImmediate(() => process.exit(0));
    });
    if (keys.length) console.error(process.env[keys[0]]);
  `;
  const codex = new Codex((binary, args, options) => {
    launches.push({ args: [...args], env: { ...options.env } });
    const child = spawn(process.execPath, ['-e', script], options);
    exits.push(new Promise((resolve) => child.on('close', () => resolve())));
    return child;
  });
  codex.on('diagnostic', (line) => diagnostics.push(line));
  try {
    await codex.start({
      id: 'fixture-provider',
      baseUrl: 'http://localhost:9876/prefix/v1',
      apiKey: secret,
    });
    const child = await codex.request('inspect');
    assert.equal(child.keys.length, 1);
    // Protocol output itself must also be scrubbed before it can become activity/log data.
    assert.equal(child.value, '<REDACTED>');
    assert.deepEqual((await codex.models())[0].supportedReasoningEfforts, [
      { reasoningEffort: 'low' },
    ]);
    const launch = launches[0];
    assert.ok(launch.args.includes('model_provider="fixture-provider"'));
    assert.ok(
      launch.args.includes(
        'model_providers.fixture-provider.base_url="http://localhost:9876/prefix/v1"',
      ),
    );
    assert.ok(launch.args.includes('model_providers.fixture-provider.wire_api="responses"'));
    assert.ok(launch.args.includes(`model_providers.fixture-provider.env_key="${child.keys[0]}"`));
    for (const isolated of ['features.memories=false', 'memories.generate_memories=false'])
      assert.ok(launch.args.includes(isolated), `user-level ${isolated} must not reach agents`);
    assert.equal(launch.env[child.keys[0]], secret);
    assert.ok(!launch.args.join(' ').includes(secret));
    const options = {
      cwd: process.cwd(),
      instructions: '',
      writable: false,
      profile: { model: 'manual-model', effort: 'low' },
    };
    assert.equal(await codex.thread(options), 'fixture-thread');
    assert.equal(await codex.thread({ ...options, threadId: 'fixture-thread' }), 'fixture-thread');
    for (const model of [
      'mismatch-model',
      'mismatch-effort',
      'missing-effort',
      'mismatch-provider',
    ]) {
      await assert.rejects(
        codex.thread({ ...options, profile: { model, effort: 'low' } }),
        /实际模型|实际推理档位|实际 Provider/,
      );
    }
    assert.ok(
      JSON.stringify({ ...process.env }) === JSON.stringify(inherited),
      'host environment must be unchanged',
    );
  } finally {
    await codex.request('fixture/exit');
    await exits[0];
    await codex.stop();
  }
  assert.ok(!diagnostics.join('').includes(secret));
  const official = new Codex((binary, args, options) => {
    launches.push({ args: [...args], env: { ...options.env } });
    const child = spawn(process.execPath, ['-e', script], options);
    exits.push(new Promise((resolve) => child.on('close', () => resolve())));
    return child;
  });
  try {
    await official.start();
    assert.deepEqual((await official.request('inspect')).keys, []);
    assert.ok(launches[1].args.includes('model_provider="openai"'));
    const options = {
      cwd: process.cwd(),
      instructions: '',
      writable: false,
      profile: { model: 'manual-model', effort: 'low' },
    };
    await assert.rejects(official.thread(options), /模型不可用/);
    await assert.rejects(
      official.thread({ ...options, profile: { model: 'fixture', effort: 'high' } }),
      /模型不支持推理档位/,
    );
  } finally {
    await official.request('fixture/exit');
    await exits[1];
    await official.stop();
  }
  assert.ok(
    JSON.stringify({ ...process.env }) === JSON.stringify(inherited),
    'host environment must be unchanged',
  );
});

test('Codex uses turn/steer preconditions, queues followUps FIFO, and normalizes account and per-turn usage', async () => {
  const script = `
    const readline = require('node:readline');
    const send = value => console.log(JSON.stringify(value));
    let turnNumber = 0;
    let threadReadNumber = 0;
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      if (m.id === undefined) return;
      if (m.method === 'initialize') { send({ id: m.id, result: {} }); return; }
      if (m.method === 'thread/start' || m.method === 'thread/resume') {
        send({ id: m.id, result: { thread: { id: 'fixture-thread' }, modelProvider: 'fixture-provider', model: m.params.model, reasoningEffort: m.params.config?.model_reasoning_effort } });
        return;
      }
      if (m.method === 'account/read') {
        send({ id: m.id, result: { account: { type: 'chatgpt', email: 'must-not-leak@example.invalid', planType: 'pro' }, requiresOpenaiAuth: false } });
        return;
      }
      if (m.method === 'account/rateLimits/read') {
        send({ id: m.id, result: { ordinaryUsageAllowed: true, accountId: 'must-not-leak', rateLimits: { primary: { usedPercent: 7, windowDurationMins: 60, resetsAt: 2000000000 }, secondary: null }, rateLimitsByLimitId: null } });
        return;
      }
      if (m.method === 'account/usage/read') {
        send({ id: m.id, result: { summary: { lifetimeTokens: 1234, peakDailyTokens: 99, longestRunningTurnSec: 4, currentStreakDays: 2, longestStreakDays: 3 }, dailyUsageBuckets: [{ startDate: '2026-09-21', tokens: 12 }] } });
        return;
      }
      if (m.method === 'thread/read') {
        threadReadNumber += 1;
        const complete = m.params.threadId === 'fixture-thread' && m.params.includeTurns === true;
        send({ id: m.id, result: { thread: { turns: complete ? [{ status: threadReadNumber === 4 ? 'inProgress' : 'completed', itemsView: threadReadNumber === 3 ? 'summary' : 'full', items: [2, 4].includes(threadReadNumber) ? [] : [{ type: 'userMessage', clientId: 'client-steer-1' }] }] : [] } } });
        return;
      }
      if (m.method === 'turn/start') {
        turnNumber += 1;
        const id = 'turn-' + turnNumber;
        send({ id: m.id, result: { turn: { id } } });
        setTimeout(() => {
          send({ method: 'turn/started', params: { threadId: m.params.threadId, turn: { id } } });
          if (turnNumber > 1) {
            send({ method: 'item/agentMessage/delta', params: { threadId: m.params.threadId, turnId: id, delta: 'follow-up-ok' } });
            send({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id, status: 'completed' } } });
          } else {
            send({ method: 'thread/tokenUsage/updated', params: { threadId: m.params.threadId, turnId: id, tokenUsage: { total: { totalTokens: 50, inputTokens: 45, cachedInputTokens: 5, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 1 }, last: { totalTokens: 11, inputTokens: 9, cachedInputTokens: 1, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 1 }, modelContextWindow: 1000 } } });
          }
        }, 5);
        return;
      }
      if (m.method === 'turn/steer') {
        const valid = m.params.threadId === 'fixture-thread' && m.params.expectedTurnId === 'turn-1' && m.params.clientUserMessageId === 'client-steer-1' && m.params.input[0].type === 'text';
        if (!valid) { send({ id: m.id, error: { message: 'invalid steer request' } }); return; }
        send({ id: m.id, result: { turnId: 'turn-1' } });
        setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'turn-1', status: 'completed' } } }), 50);
        return;
      }
      if (m.method === 'fixture/exit') { send({ id: m.id, result: {} }); setImmediate(() => process.exit(0)); return; }
      send({ id: m.id, result: {} });
    });
  `;
  const codex = new Codex((_binary, _args, options) =>
    spawn(process.execPath, ['-e', script], options),
  );
  const notifications: Array<[string, any]> = [];
  codex.on('notification', (method, params) => notifications.push([method, params]));
  try {
    await codex.start({
      id: 'fixture-provider',
      baseUrl: 'http://localhost:9876/v1',
      apiKey: 'fixture-key',
    });
    const session = await codex.createSession({
      cwd: process.cwd(),
      profile: { model: 'fixture-model', effort: 'low' },
      instructions: 'fixture',
      writable: false,
    });
    const initial = session.prompt('initial', {
      profile: { model: 'fixture-model', effort: 'low' },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const steered = session.steer('steer-now', {
      clientUserMessageId: 'client-steer-1',
      expectedTurnId: 'turn-1',
    });
    const firstFollowUp = session.followUp('follow-one');
    const secondFollowUp = session.followUp('follow-two');
    await steered;
    const initialResult = await initial;
    assert.equal(initialResult.usage?.totalTokens, 11);
    await Promise.all([firstFollowUp, secondFollowUp]);
    assert.deepEqual(
      notifications
        .filter(([method]) => method === 'turn/completed')
        .map(([, params]) => params.turn.id),
      ['turn-1', 'turn-2', 'turn-3'],
    );
    const usageNotification = notifications.find(
      ([method]) => method === 'thread/tokenUsage/updated',
    )?.[1];
    assert.equal(usageNotification.usage.totalTokens, 11);
    assert.equal(usageNotification.usage.contextWindow, 1000);
    const allowance = await codex.accountAllowance();
    assert.equal(allowance.status, 'available');
    assert.deepEqual(allowance.account, { type: 'chatgpt', planType: 'pro' });
    assert.equal('accountId' in allowance, false);
    assert.equal(allowance.usage?.lifetimeTokens, 1234);
    assert.equal(allowance.usage?.dailyUsageBuckets?.[0].tokens, 12);
    assert.equal(await codex.reconcileSteer('fixture-thread', 'client-steer-1'), 'accepted');
    assert.equal(await codex.reconcileSteer('fixture-thread', 'missing'), 'not_accepted');
    assert.equal(await codex.reconcileSteer('fixture-thread', 'unknown'), 'unknown');
    assert.equal(await codex.reconcileSteer('fixture-thread', 'not-yet-visible'), 'unknown');
  } finally {
    await codex.request('fixture/exit').catch(() => {});
    await codex.stop();
  }
});
