import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OmpBackend,
  OmpRpcClient,
  OmpRpcFrameDecoder,
  OMP_RPC_MAX_FRAME_BYTES,
} from '../src/server/omp.ts';

test('OMP owner starts an independent native CLI fork with only read tools and validates its effective session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-omp-owner-'));
  const script = `
    const args = process.argv.slice(1), arg = name => args[args.indexOf(name)+1];
    const send = value => console.log(JSON.stringify(value));
    let calls = [], rejected = false;
    const source = arg('--fork');
    const tools = source === 'unsafe-tools' ? ['read','bash'] : ['read','grep','glob'];
    require('node:readline').createInterface({input: process.stdin}).on('line', line => {
      const m = JSON.parse(line); calls.push(m.type);
      if (m.type === 'host_tool_result') { rejected = !!m.error || m.isError === true; return; }
      let data;
      if(m.type === 'negotiate_protocol') data = {protocolVersion:2};
      if(m.type === 'get_state') data = { sessionId: source === 'same-source' ? source : 'owner-fork', model: {provider:'fixture',id:source === 'wrong-model' ? 'other' : 'fixture-model'}, thinkingLevel:'low', systemPrompt:[arg('--system-prompt')], dumpTools:tools.map(name=>({name})), isStreaming:false };
      send({id:m.id,type:'response',command:m.type,success:true,data});
      if(m.type === 'prompt') {
        send({type:'agent_start'});
        send({type:'message_update',message:{role:'assistant'},assistantMessageEvent:{type:'text_delta',delta:JSON.stringify({args,calls,rejected,config:JSON.parse(require('node:fs').readFileSync(arg('--config'),'utf8'))})}});
        send({type:'agent_end'});
      }
      if(m.type === 'get_state') send({type:'host_tool_call',id:'inherited',toolCallId:'call',toolName:'ask_pm',arguments:{}});
    });
    send({type:'ready',protocolVersion:1,supportedProtocolVersions:[1,2],maxFrameBytes:1048576,maxReassembledFrameBytes:67108864});
  `;
  const create = () =>
    new OmpBackend({
      dataDir: root,
      spawn: (_binary, args, options) =>
        spawn(process.execPath, ['-e', script, '--', ...args], options),
    });
  const plan = {
    sourceThreadId: 'source',
    cwd: process.cwd(),
    profile: { provider: 'fixture', model: 'fixture-model', effort: 'low' },
    instructions: 'owner read only',
    dataDir: root,
  };
  const backend = create();
  try {
    const id = await backend.forkReadOnlyThread(plan);
    assert.equal(id, 'owner-fork');
    const observed = JSON.parse(await backend.turn(id, 'inspect', plan.profile));
    assert.equal(observed.args[observed.args.indexOf('--fork') + 1], 'source');
    assert.equal(observed.args[observed.args.indexOf('--tools') + 1], 'read,grep,glob');
    assert.equal(
      observed.args[observed.args.indexOf('--session-dir') + 1],
      join(root, 'agents', 'omp', 'sessions'),
    );
    assert.ok(!observed.args.includes('--resume') && !observed.args.includes('--no-session'));
    assert.ok(
      observed.args.includes('--no-lsp') &&
        observed.args.includes('--no-pty') &&
        observed.args.includes('--no-context-files') &&
        observed.args.includes('--no-title'),
    );
    assert.equal(observed.config.mcp.enableProjectConfig, false);
    assert.deepEqual(observed.config.enabledProviders, []);
    assert.ok(
      ['native', 'mcp-json', 'claude-plugins'].every((source) =>
        observed.config.disabledProviders.includes(source),
      ),
    );
    assert.ok(
      !observed.calls.some((c: string) => ['fork', 'new_session', 'set_host_tools'].includes(c)),
    );
    assert.equal(observed.rejected, true);
  } finally {
    await backend.stop();
  }
  for (const sourceThreadId of ['same-source', 'wrong-model', 'unsafe-tools']) {
    const invalid = create();
    try {
      await assert.rejects(
        invalid.forkReadOnlyThread({ ...plan, sourceThreadId }),
        /独立|实际模型|只读工具/,
      );
    } finally {
      await invalid.stop();
    }
  }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

interface FakeProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(): void;
}

function fakeProcess(script: (message: any, child: FakeProcess) => void): FakeProcess {
  const child = new EventEmitter() as FakeProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    child.stdout.end();
    child.stderr.end();
  };
  child.stdin.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean))
      script(JSON.parse(line), child);
  });
  queueMicrotask(() =>
    child.stdout.write(
      `${JSON.stringify({
        type: 'ready',
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
        maxFrameBytes: 1024 * 1024,
        maxReassembledFrameBytes: 64 * 1024 * 1024,
      })}\n`,
    ),
  );
  return child;
}

function response(message: any, data?: unknown) {
  return (
    JSON.stringify({
      id: message.id,
      type: 'response',
      command: message.type,
      success: true,
      ...(data === undefined ? {} : { data }),
    }) + '\n'
  );
}

function fakeLauncher(script: (message: any, child: FakeProcess) => void, args?: string[]) {
  return {
    spawn: (binary: string, childArgs: string[], _options: any) => {
      args?.push(binary, ...childArgs);
      return fakeProcess(script) as any;
    },
  };
}

test('OMP decoder rejects interrupted or malformed v2 sequences and reassembles strict UTF-8', () => {
  const decoder = new OmpRpcFrameDecoder();
  const json = JSON.stringify({ type: 'message_end', message: { text: '你好' } });
  const bytes = Buffer.from(json);
  const first = bytes.subarray(0, Math.ceil(bytes.length / 2));
  const second = bytes.subarray(first.length);
  assert.equal(
    decoder.push({
      type: 'rpc_chunk',
      chunkId: 'test',
      index: 0,
      count: 2,
      byteLength: OMP_RPC_MAX_FRAME_BYTES,
      data: Buffer.from(first).toString('base64'),
    }),
    undefined,
  );
  // The protocol advertises byteLength for the entire logical payload. A short
  // fake frame is intentionally rejected instead of being silently truncated.
  assert.throws(
    () =>
      decoder.push({
        type: 'rpc_chunk',
        chunkId: 'test',
        index: 1,
        count: 2,
        byteLength: OMP_RPC_MAX_FRAME_BYTES,
        data: Buffer.from(second).toString('base64'),
      }),
    /length mismatch/,
  );
  const freshDecoder = new OmpRpcFrameDecoder();
  assert.throws(
    () =>
      freshDecoder.push({
        type: 'rpc_chunk',
        chunkId: 'bad',
        index: 1,
        count: 2,
        byteLength: OMP_RPC_MAX_FRAME_BYTES,
        data: 'AA==',
      }),
    /start at index 0/,
  );
});

test('OMP backend negotiates v2, keeps prompt ack separate from completion, and emits compatibility notifications', async () => {
  const args: string[] = [];
  const clientScript = (message: any, child: FakeProcess) => {
    if (message.type === 'negotiate_protocol')
      child.stdout.write(response(message, { protocolVersion: 2 }));
    else if (message.type === 'get_state')
      child.stdout.write(
        response(message, {
          sessionId: 'session-1',
          model: { provider: 'fixture', id: 'fixture-model' },
          thinkingLevel: 'low',
          isStreaming: false,
        }),
      );
    else if (message.type === 'get_available_models')
      child.stdout.write(
        response(message, {
          models: [
            {
              provider: 'fixture',
              id: 'fixture-model',
              name: 'Fixture',
              reasoning: true,
              thinking: { efforts: ['low'] },
            },
          ],
        }),
      );
    else if (message.type === 'set_model' || message.type === 'set_thinking_level')
      child.stdout.write(response(message));
    else if (message.type === 'prompt') {
      child.stdout.write(response(message, { agentInvoked: true }));
      setTimeout(() => {
        child.stdout.write(`${JSON.stringify({ type: 'agent_start' })}\n`);
        child.stdout.write(
          `${JSON.stringify({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', delta: 'hello' } })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({ type: 'agent_end', telemetry: { usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } } })}\n`,
        );
      }, 20);
    }
  };
  const backend = new OmpBackend({
    dataDir: await mkdtemp(join(tmpdir(), 'phantom-omp-')),
    ...fakeLauncher(clientScript, args),
  });
  const notifications: Array<[string, any]> = [];
  backend.on('notification', (method, payload) => notifications.push([method, payload]));
  try {
    const session = await backend.createSession({
      cwd: process.cwd(),
      profile: { provider: 'fixture', model: 'fixture-model', effort: 'low' },
      allowedTools: [],
    });
    const started = Date.now();
    const result = await session.prompt('say hello');
    assert.ok(Date.now() - started >= 15, 'prompt must wait for agent_end rather than ack');
    assert.equal(result.text, 'hello');
    assert.equal(result.usage?.totalTokens, 6);
    assert.equal(
      notifications.some(([method]) => method === 'item/agentMessage/delta'),
      true,
    );
    assert.equal(
      notifications.find(([method]) => method === 'turn/completed')?.[1].turn.status,
      'completed',
    );
    assert.ok(args.includes('--mode') && args.includes('rpc'));
    assert.ok(
      args.includes('--no-extensions') &&
        args.includes('--no-rules') &&
        args.includes('--no-skills'),
    );
  } finally {
    await backend.dispose();
  }
});

test('OMP aggregates assistant message usage for one prompt without counting tools or duplicate messages', async () => {
  const clientScript = (message: any, child: FakeProcess) => {
    if (message.type === 'negotiate_protocol')
      child.stdout.write(response(message, { protocolVersion: 2 }));
    else if (message.type === 'get_state')
      child.stdout.write(
        response(message, {
          sessionId: 'session-usage',
          model: { provider: 'fixture', id: 'fixture-model' },
          thinkingLevel: 'low',
        }),
      );
    else if (message.type === 'prompt') {
      child.stdout.write(response(message, { agentInvoked: true }));
      child.stdout.write(
        `${JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            id: 'assistant-1',
            usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 10, reasoning: 5 },
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: 'message_end',
          message: { role: 'tool', id: 'tool-1', usage: { input: 999, output: 999 } },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            id: 'assistant-2',
            usage: { input: 50, output: 10, total: 60 },
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', id: 'assistant-1', usage: { input: 100, output: 20 } },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: 'agent_end',
          messages: [],
        })}\n`,
      );
    }
  };
  const backend = new OmpBackend({
    dataDir: await mkdtemp(join(tmpdir(), 'phantom-omp-usage-')),
    ...fakeLauncher(clientScript),
  });
  try {
    const session = await backend.createSession({ cwd: process.cwd(), allowedTools: [] });
    const result = await session.prompt('usage');
    assert.deepEqual(result.usage, {
      inputTokens: 200,
      outputTokens: 30,
      cachedInputTokens: 40,
      cacheWriteTokens: 10,
      reasoningOutputTokens: 5,
      totalTokens: 60,
      turnId: result.turnId,
    });
  } finally {
    await backend.dispose();
  }
});

test('OMP whole-turn telemetry wins over per-message usage and normalizes cache aliases', async () => {
  const clientScript = (message: any, child: FakeProcess) => {
    if (message.type === 'negotiate_protocol')
      child.stdout.write(response(message, { protocolVersion: 2 }));
    else if (message.type === 'get_state')
      child.stdout.write(
        response(message, {
          sessionId: 'session-telemetry',
          model: { provider: 'fixture', id: 'fixture-model' },
          thinkingLevel: 'low',
        }),
      );
    else if (message.type === 'prompt') {
      child.stdout.write(response(message, { agentInvoked: true }));
      child.stdout.write(
        `${JSON.stringify({
          type: 'agent_end',
          telemetry: {
            usage: {
              input: 100,
              output: 20,
              cacheRead: 40,
              cacheWrite: 10,
              reasoning: 5,
              total: 170,
              modelContextWindow: 4096,
            },
          },
          messages: [{ role: 'assistant', usage: { input: 999, output: 999 } }],
        })}\n`,
      );
    }
  };
  const backend = new OmpBackend({
    dataDir: await mkdtemp(join(tmpdir(), 'phantom-omp-telemetry-')),
    ...fakeLauncher(clientScript),
  });
  try {
    const session = await backend.createSession({ cwd: process.cwd(), allowedTools: [] });
    const result = await session.prompt('telemetry');
    assert.equal(result.usage?.inputTokens, 150);
    assert.equal(result.usage?.outputTokens, 20);
    assert.equal(result.usage?.cachedInputTokens, 40);
    assert.equal(result.usage?.cacheWriteTokens, 10);
    assert.equal(result.usage?.reasoningOutputTokens, 5);
    assert.equal(result.usage?.totalTokens, 170);
    assert.equal(result.usage?.contextWindow, 4096);
  } finally {
    await backend.dispose();
  }
});

test('OMP host tools round-trip through the injected handler and image paths become ImageContent', async () => {
  const imageDir = await mkdtemp(join(tmpdir(), 'phantom-omp-image-'));
  const imagePath = join(imageDir, 'fixture.png');
  await writeFile(imagePath, Buffer.from([137, 80, 78, 71]));
  let receivedImage: any;
  const clientScript = (message: any, child: FakeProcess) => {
    if (message.type === 'negotiate_protocol')
      child.stdout.write(response(message, { protocolVersion: 2 }));
    else if (message.type === 'get_state')
      child.stdout.write(
        response(message, {
          sessionId: 'session-tools',
          model: { provider: 'fixture', id: 'fixture-model' },
          thinkingLevel: 'low',
        }),
      );
    else if (message.type === 'set_host_tools')
      child.stdout.write(
        response(message, { toolNames: message.tools.map((tool: any) => tool.name) }),
      );
    else if (message.type === 'prompt') {
      receivedImage = message.images?.[0];
      child.stdout.write(response(message, { agentInvoked: true }));
      child.stdout.write(
        `${JSON.stringify({ type: 'host_tool_call', id: 'host-1', toolCallId: 'call-1', toolName: 'echo', arguments: { text: 'x' } })}\n`,
      );
    } else if (message.type === 'host_tool_result') {
      assert.equal(message.result.content[0].text, 'host-ok');
      child.stdout.write(`${JSON.stringify({ type: 'agent_end' })}\n`);
    }
  };
  const backend = new OmpBackend({
    dataDir: await mkdtemp(join(tmpdir(), 'phantom-omp-tools-')),
    ...fakeLauncher(clientScript),
  });
  try {
    const session = await backend.createSession({
      cwd: process.cwd(),
      allowedTools: [],
      tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
      toolHandler: async () => 'host-ok',
    });
    const result = await session.prompt('use tool', { imagePaths: [imagePath] });
    assert.equal(result.status, 'completed');
    assert.equal(receivedImage.mimeType, 'image/png');
    assert.equal(receivedImage.data, Buffer.from([137, 80, 78, 71]).toString('base64'));
  } finally {
    await backend.dispose();
  }
});

test('OMP cancellation rejects the turn and sends abort instead of reporting success', async () => {
  let sawAbort = false;
  const clientScript = (message: any, child: FakeProcess) => {
    if (message.type === 'negotiate_protocol')
      child.stdout.write(response(message, { protocolVersion: 2 }));
    else if (message.type === 'get_state')
      child.stdout.write(
        response(message, {
          sessionId: 'session-abort',
          model: { provider: 'fixture', id: 'fixture-model' },
          thinkingLevel: 'low',
        }),
      );
    else if (message.type === 'prompt')
      child.stdout.write(response(message, { agentInvoked: true }));
    else if (message.type === 'abort') {
      sawAbort = true;
      child.stdout.write(response(message));
    }
  };
  const backend = new OmpBackend({
    dataDir: await mkdtemp(join(tmpdir(), 'phantom-omp-abort-')),
    ...fakeLauncher(clientScript),
  });
  try {
    const session = await backend.createSession({ cwd: process.cwd(), allowedTools: [] });
    const controller = new AbortController();
    const pending = session.prompt('long', { signal: controller.signal });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, /执行已暂停/);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(sawAbort, true);
  } finally {
    await backend.dispose();
  }
});

test('OMP cancellation before admission handles a delayed prompt response', async () => {
  let release!: () => void;
  const client = new OmpRpcClient({
    dataDir: await mkdtemp(join(tmpdir(), 'phantom-omp-admission-')),
    ...fakeLauncher((message, child) => {
      if (message.type === 'prompt') {
        release = () => child.stdout.write(response(message, { agentInvoked: false }));
      } else child.stdout.write(response(message, { sessionId: 'session-admission' }));
    }),
  });
  try {
    await client.start();
    const controller = new AbortController();
    const rejected = assert.rejects(
      client.prompt('session-admission', 'long', { signal: controller.signal }),
      /执行已暂停/,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    // Admission may await image preparation while the server already handles abort.
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    release();
    await rejected;
  } finally {
    await client.stop();
  }
});

test('OMP timeout before admission rejects before the prompt acknowledgement', async () => {
  let release!: () => void;
  let acknowledged = false;
  const client = new OmpRpcClient({
    dataDir: await mkdtemp(join(tmpdir(), 'phantom-omp-admission-timeout-')),
    ...fakeLauncher((message, child) => {
      if (message.type === 'prompt')
        release = () => {
          acknowledged = true;
          child.stdout.write(response(message, { agentInvoked: false }));
        };
      else child.stdout.write(response(message, { sessionId: 'session-timeout' }));
    }),
  });
  let acknowledgement: NodeJS.Timeout | undefined;
  try {
    await client.start();
    const rejected = assert.rejects(
      client.prompt('session-timeout', 'slow admission', { timeoutMs: 10 }),
      /超过单次运行时限/,
    );
    acknowledgement = setTimeout(() => release(), 50);
    await rejected;
    assert.equal(acknowledged, false);
  } finally {
    clearTimeout(acknowledgement);
    release?.();
    await client.stop();
  }
});

test('OMP cancellation before dispatch releases a session without a terminal', async () => {
  const messages: string[] = [];
  const client = new OmpRpcClient({
    dataDir: await mkdtemp(join(tmpdir(), 'phantom-omp-before-dispatch-')),
    ...fakeLauncher((message, child) => {
      messages.push(message.type);
      child.stdout.write(response(message, { sessionId: 'before-dispatch', agentInvoked: false }));
    }),
  });
  try {
    await client.start();
    const controller = new AbortController();
    await assert.rejects(
      client.prompt('before-dispatch', 'cancelled', {
        signal: controller.signal,
        onTurn: () => controller.abort(),
      }),
      /执行已暂停/,
    );
    await client.abort();
    assert.equal(messages.includes('prompt'), false);
    assert.equal((await client.prompt('before-dispatch', 'next')).status, 'completed');
  } finally {
    await client.stop();
  }
});

test('OMP completed failures and rejected commands release the session', async () => {
  for (const rejectedCommand of [false, true]) {
    let calls = 0;
    const client = new OmpRpcClient({
      dataDir: await mkdtemp(join(tmpdir(), 'phantom-omp-retry-')),
      ...fakeLauncher((message, child) => {
        if (message.type === 'prompt') {
          calls++;
          if (calls === 1 && rejectedCommand) {
            child.stdout.write(
              `${JSON.stringify({
                id: message.id,
                type: 'response',
                command: 'prompt',
                success: false,
                error: 'rejected fixture',
              })}\n`,
            );
            return;
          }
          child.stdout.write(response(message, { agentInvoked: true }));
          if (calls === 1)
            child.stdout.write(
              `${JSON.stringify({
                type: 'notice',
                level: 'error',
                message: 'failed fixture',
              })}\n`,
            );
          child.stdout.write(`${JSON.stringify({ type: 'agent_end' })}\n`);
        } else child.stdout.write(response(message, { sessionId: 'session-retry' }));
      }),
    });
    try {
      await client.start();
      await assert.rejects(client.prompt('session-retry', 'first'), /fixture/);
      assert.equal((await client.prompt('session-retry', 'second')).status, 'completed');
    } finally {
      await client.stop();
    }
  }
});

test('OMP waits for both abort acknowledgement and old terminal before reuse', async () => {
  for (const terminalFirst of [false, true]) {
    let child!: FakeProcess;
    let acknowledgeAbort!: () => void;
    const prompts: string[] = [];
    const client = new OmpRpcClient({
      dataDir: await mkdtemp(join(tmpdir(), 'phantom-omp-drain-')),
      ...fakeLauncher((message, process) => {
        child = process;
        if (message.type === 'prompt') prompts.push(message.message);
        if (message.type === 'abort') {
          acknowledgeAbort = () => child.stdout.write(response(message));
        } else child.stdout.write(response(message, { sessionId: 'session-drain' }));
      }),
    });
    const terminal = () => child.stdout.write(`${JSON.stringify({ type: 'agent_end' })}\n`);
    try {
      await client.start();
      const controller = new AbortController();
      const rejected = assert.rejects(
        client.prompt('session-drain', 'first', { signal: controller.signal }),
        /执行已暂停/,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort();
      await rejected;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (terminalFirst) terminal();
      else acknowledgeAbort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const early = client.prompt('session-drain', 'too soon').then(
        () => 'completed',
        (error: Error & { code?: string }) => error.code,
      );
      assert.equal(
        await Promise.race([
          early,
          new Promise<string>((resolve) => setTimeout(() => resolve('accepted-pending'), 25)),
        ]),
        'busy',
      );
      if (terminalFirst) acknowledgeAbort();
      else {
        child.stdout.write(
          `${JSON.stringify({
            type: 'message_update',
            assistantMessageEvent: { delta: 'old output' },
          })}\n`,
        );
        terminal();
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      const next = client.prompt('session-drain', 'second');
      await new Promise<void>((resolve) => setImmediate(resolve));
      child.stdout.write(
        `${JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: { delta: 'new output' },
        })}\n`,
      );
      terminal();
      assert.equal((await next).text, 'new output');
      assert.deepEqual(prompts, ['first', 'second']);
    } finally {
      await client.stop();
    }
  }
});

test('OMP retains namespaced model IDs when applying and validating a profile', async () => {
  const selected: unknown[] = [];
  const backend = new OmpBackend({
    dataDir: await mkdtemp(join(tmpdir(), 'phantom-omp-model-id-')),
    ...fakeLauncher((message, child) => {
      let data: unknown;
      if (message.type === 'get_state')
        data = {
          sessionId: 'namespaced',
          model: { provider: 'gateway', id: 'org/model' },
          thinkingLevel: 'low',
        };
      if (message.type === 'get_available_models')
        data = {
          models: [
            {
              provider: 'gateway',
              id: 'org/model',
              reasoningEfforts: ['low'],
            },
          ],
        };
      if (message.type === 'set_model')
        selected.push({
          provider: message.provider,
          modelId: message.modelId,
        });
      child.stdout.write(response(message, data));
    }),
  });
  try {
    for (const provider of ['gateway', undefined]) {
      for (const model of ['org/model', 'gateway/org/model']) {
        const profile = { provider, model, effort: 'low' };
        await backend.createSession({ cwd: process.cwd(), profile, allowedTools: [] });
        await backend.validate(profile);
      }
    }
    assert.deepEqual(selected, [
      { provider: 'gateway', modelId: 'org/model' },
      { provider: 'gateway', modelId: 'org/model' },
      { provider: 'gateway', modelId: 'org/model' },
      { provider: 'gateway', modelId: 'org/model' },
    ]);
  } finally {
    await backend.stop();
  }
});

test(
  'real OMP handshake and model listing are read-only when the executable is installed',
  { skip: !process.env.PHANTOM_RUN_OMP_PROBE },
  async () => {
    const backend = new OmpBackend({ dataDir: await mkdtemp(join(tmpdir(), 'phantom-omp-real-')) });
    const result = await backend.probe({ cwd: process.cwd(), allowedTools: [] });
    assert.equal(result.protocolVersion, 2);
    assert.ok(result.models.length > 0);
  },
);
