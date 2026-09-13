import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Codex } from '../src/server/codex.ts';

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
