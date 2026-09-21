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
