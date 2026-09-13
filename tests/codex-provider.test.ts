import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Codex } from '../src/server/codex.ts';

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
          const chunks = scenario === 'cancelled' ? ['ow'] : scenario === 'characters' ? Array.from('before ' + key + key + ' after')
            : scenario === 'prefix' ? ['ordinary ow', 'ner text ', 'ow']
            : ['before ', key.slice(0, 8), key.slice(8, 13), key.slice(13), ' after'];
          for (const delta of chunks)
            send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn', itemId: 'message', delta } });
          if (scenario === 'cancelled') return;
          if (scenario === 'completed')
            send({ method: 'item/completed', params: { threadId, turnId: 'turn', item: { id: 'message', type: 'agentMessage', text: 'before ' + key + ' after' } } });
          send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn', status: 'completed' } } });
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

test('stream filtering preserves ordinary prefixes and handles single-character chunks, repeated keys and final item text', async () => {
  await streamingFixture(async (codex) => {
    for (const [scenario, expected] of [
      ['characters', 'before <REDACTED><REDACTED> after'],
      ['prefix', 'ordinary owner text ow'],
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

test('cancelling a turn discards its withheld key prefix before the next turn', async () => {
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
    assert.deepEqual(deltas, []);
    const result = await codex.turn('thread', 'fixture', { model: 'fixture', effort: 'low' });
    assert.equal(result, 'before <REDACTED> after');
    assert.equal(deltas.join(''), result);
  });
});

test('custom Codex launch uses argument overrides and a child-only key binding; official launch stays unchanged', async () => {
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
        : m.method === 'thread/start' || m.method === 'thread/resume' ? {thread:{id:'fixture-thread'}, model: m.params.model === 'mismatch-model' ? 'other-model' : m.params.model, reasoningEffort: m.params.model === 'mismatch-effort' ? 'high' : m.params.model === 'missing-effort' ? undefined : m.params.config.model_reasoning_effort}
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
    for (const model of ['mismatch-model', 'mismatch-effort', 'missing-effort']) {
      await assert.rejects(
        codex.thread({ ...options, profile: { model, effort: 'low' } }),
        /实际模型|实际推理档位/,
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
    assert.ok(!launches[1].args.some((arg) => arg.includes('model_provider')));
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
