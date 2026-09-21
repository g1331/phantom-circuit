import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OmpBackend,
  OmpRpcClient,
  OmpRpcFrameDecoder,
  OMP_RPC_MAX_FRAME_BYTES,
} from '../src/server/omp.ts';

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
