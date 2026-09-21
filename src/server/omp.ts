import { randomUUID } from 'node:crypto';
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Fault } from './store.ts';
import { command } from './process.ts';
import { normalizeUsage } from './usage.ts';
import { protectPrivateDirectory } from './data-directory.ts';
import {
  AgentTurnError,
  asAgentLegacyModel,
  asAgentModelCapability,
  assertEffectiveProfile,
  profileProvider,
  type AgentAllowance,
  type AgentBackend,
  type AgentCapabilities,
  type AgentImage,
  type AgentLegacyModel,
  type AgentModelCapability,
  type AgentProbeResult,
  type AgentProfile,
  type AgentPromptOptions,
  type AgentSession,
  type AgentSessionOptions,
  type AgentSteerReconciliation,
  type AgentThreadOptions,
  type AgentToolHandler,
  type AgentToolSpec,
  type AgentTurnResult,
  type AgentUserInputHandler,
  type AgentUserInputRequest,
  type AgentUserInputResponse,
  type AgentUsage,
} from './agent-backend.ts';

export const OMP_RPC_MAX_FRAME_BYTES = 1024 * 1024;
export const OMP_RPC_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const OMP_RPC_CHUNK_BYTES = 256 * 1024;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 45 * 60_000;

export interface OmpSpawnOptions {
  binary?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: (
    binary: string,
    args: string[],
    options: SpawnOptionsWithoutStdio & { stdio: 'pipe' },
  ) => ChildProcessWithoutNullStreams;
}

export interface OmpBackendOptions extends OmpSpawnOptions {
  /** Root for managed OMP data. Sessions are always placed below agents/omp/sessions. */
  dataDir?: string;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  /** Default role tool allow-list used when a session omits allowedTools. */
  allowedTools?: string[];
  onUserInput?: AgentUserInputHandler;
}

export interface OmpStartOptions extends AgentSessionOptions {
  resume?: string;
}

interface OmpReadyFrame {
  type: 'ready';
  protocolVersion?: number;
  supportedProtocolVersions?: number[];
  maxFrameBytes?: number;
  maxReassembledFrameBytes?: number;
}

interface OmpResponse {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: any;
  error?: string;
  code?: string;
}

interface PendingRequest {
  command: string;
  resolve: (value: OmpResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface OmpActiveTurn {
  requestId: string;
  turnId: string;
  sessionId: string;
  output: string;
  messageUsages: Array<{ id?: string; usage: AgentUsage }>;
  usage?: AgentUsage;
  raw?: unknown;
  error?: Error;
  signal?: AbortSignal;
  timer: NodeJS.Timeout;
  settled: boolean;
  resolve: (result: AgentTurnResult) => void;
  reject: (error: Error) => void;
  cleanup?: () => void;
}

interface OmpHostToolCall {
  type: 'host_tool_call';
  id: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

interface OmpHostToolCancel {
  type: 'host_tool_cancel';
  id: string;
  targetId: string;
}

interface OmpExtensionUiRequest {
  type: 'extension_ui_request';
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  [key: string]: unknown;
}

interface OmpModelState {
  id?: string;
  provider?: string;
}

interface OmpSessionState {
  model?: OmpModelState;
  thinkingLevel?: string;
  isStreaming?: boolean;
  sessionId: string;
  sessionFile?: string;
  [key: string]: unknown;
}

/** A strict reassembler for OMP protocol-v2 `rpc_chunk` frames. */
export class OmpRpcFrameDecoder {
  #pending?: {
    chunkId: string;
    count: number;
    byteLength: number;
    nextIndex: number;
    receivedBytes: number;
    chunks: Buffer[];
  };

  push(value: unknown): Record<string, unknown> | undefined {
    if (!isRecord(value) || value.type !== 'rpc_chunk') {
      if (this.#pending) throw new Error('RPC chunk sequence interrupted');
      if (!isRecord(value)) throw new Error('RPC frame must be an object');
      return value;
    }
    const frame = value as Record<string, unknown>;
    const chunkId = frame.chunkId;
    const indexValue = frame.index;
    const countValue = frame.count;
    const byteLengthValue = frame.byteLength;
    const data = frame.data;
    if (
      typeof chunkId !== 'string' ||
      chunkId.length === 0 ||
      chunkId.length > 128 ||
      !Number.isSafeInteger(indexValue) ||
      !Number.isSafeInteger(countValue) ||
      !Number.isSafeInteger(byteLengthValue) ||
      (indexValue as number) < 0 ||
      (countValue as number) < 2 ||
      (indexValue as number) >= (countValue as number) ||
      (byteLengthValue as number) < OMP_RPC_MAX_FRAME_BYTES ||
      (byteLengthValue as number) > OMP_RPC_MAX_REASSEMBLED_BYTES ||
      typeof data !== 'string' ||
      data.length === 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    )
      throw new Error('Invalid RPC chunk metadata');
    const index = indexValue as number;
    const count = countValue as number;
    const byteLength = byteLengthValue as number;
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data || bytes.byteLength > OMP_RPC_CHUNK_BYTES)
      throw new Error('Invalid RPC chunk data');
    if (!this.#pending) {
      if (index !== 0) throw new Error('RPC chunk sequence must start at index 0');
      this.#pending = {
        chunkId,
        count,
        byteLength,
        nextIndex: 0,
        receivedBytes: 0,
        chunks: [],
      };
    }
    const pending = this.#pending;
    if (!pending) throw new Error('RPC chunk sequence state lost');
    if (
      pending.chunkId !== chunkId ||
      pending.count !== count ||
      pending.byteLength !== byteLength ||
      pending.nextIndex !== index
    )
      throw new Error('RPC chunk sequence mismatch');
    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    pending.nextIndex++;
    if (pending.receivedBytes > pending.byteLength)
      throw new Error('RPC chunk sequence exceeds declared length');
    if (pending.nextIndex < pending.count) return undefined;
    if (pending.receivedBytes !== pending.byteLength)
      throw new Error('RPC chunk sequence length mismatch');
    this.#pending = undefined;
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pending.chunks));
    const result: unknown = JSON.parse(decoded);
    if (!isRecord(result)) throw new Error('RPC frame must be an object');
    return result;
  }
}

export class OmpRpcCommandError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'OmpRpcCommandError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorFromUnknown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    case '.avif':
      return 'image/avif';
    case '.bmp':
      return 'image/bmp';
    case '.png':
      return 'image/png';
    default:
      throw new Error(`不支持的图片类型：${path}`);
  }
}

async function imagesFromPaths(paths: string[] | undefined): Promise<AgentImage[] | undefined> {
  if (!paths?.length) return undefined;
  return Promise.all(
    paths.map(async (path) => ({
      type: 'image' as const,
      data: (await readFile(path)).toString('base64'),
      mimeType: mimeType(path),
    })),
  );
}

function asToolResult(value: unknown): Record<string, unknown> {
  if (isRecord(value) && Array.isArray(value.content)) return value;
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return { content: [{ type: 'text', text }] };
}

function usageFromAgentEnd(
  frame: any,
  turnId?: string,
  messageUsages: readonly { id?: string; usage: AgentUsage }[] = [],
): AgentUsage | undefined {
  const telemetry = isRecord(frame?.telemetry?.usage) ? frame.telemetry.usage : undefined;
  // OMP may include both a whole-turn telemetry snapshot and per-message snapshots. The
  // telemetry value is authoritative; summing both would bill the same turn twice.
  if (telemetry) {
    const normalized = normalizeAgentUsage(telemetry, frame?.telemetry?.cost, frame);
    if (normalized) return normalized;
  }

  const messages = Array.isArray(frame?.messages) ? frame.messages : [];
  if (!messages.length && messageUsages.length) {
    let result: AgentUsage | undefined;
    for (const entry of messageUsages) result = addAgentUsage(result, entry.usage);
    return result;
  }
  const seen = new Set<string>();
  let result: AgentUsage | undefined;
  for (const entry of messages) {
    const message = isRecord(entry) && isRecord(entry.message) ? entry.message : entry;
    if (!isRecord(message) || message.role !== 'assistant') continue;
    const messageTurnId =
      stringOrUndefined(message.turnId) ??
      stringOrUndefined(message.turn_id) ??
      (isRecord(message.turn) ? stringOrUndefined(message.turn.id) : undefined);
    if (turnId && messageTurnId && messageTurnId !== turnId) continue;
    const messageId = stringOrUndefined(message.id);
    if (messageId && seen.has(messageId)) continue;
    if (messageId) seen.add(messageId);
    const usage = isRecord(message.usage) ? message.usage : undefined;
    const normalized = usage ? normalizeAgentUsage(usage, undefined, frame) : undefined;
    if (!normalized) continue;
    result = addAgentUsage(result, normalized);
  }
  return result;
}

function normalizeAgentUsage(
  usage: Record<string, unknown>,
  rawCost?: unknown,
  frame?: Record<string, unknown>,
): AgentUsage | undefined {
  const cost = isRecord(rawCost) ? rawCost : isRecord(usage.cost) ? usage.cost : undefined;
  const turnId = stringOrUndefined(usage.turnId) ?? stringOrUndefined(usage.turn_id);
  const contextWindow = numberOrUndefined(
    usage.contextWindow ??
      usage.modelContextWindow ??
      frame?.modelContextWindow ??
      (isRecord(frame?.telemetry) ? frame.telemetry.modelContextWindow : undefined) ??
      (isRecord(frame?.contextUsage) ? frame.contextUsage.contextWindow : undefined) ??
      (isRecord(frame?.model) ? frame.model.contextWindow : undefined),
  );
  const rawInput = numberOrUndefined(usage.input);
  const outputTokens = numberOrUndefined(usage.outputTokens ?? usage.output);
  const cachedInputTokens = numberOrUndefined(
    usage.cachedInputTokens ?? usage.cacheReadTokens ?? usage.cacheRead,
  );
  const cacheWriteTokens = numberOrUndefined(usage.cacheWriteTokens ?? usage.cacheWrite);
  // OMP's native `input` excludes cache reads/writes; Phantom/Codex `inputTokens`
  // includes them. Preserve already-normalized inputTokens without adding twice.
  const inputTokens =
    numberOrUndefined(usage.inputTokens) ??
    (rawInput === undefined
      ? undefined
      : rawInput + (cachedInputTokens ?? 0) + (cacheWriteTokens ?? 0));
  const reasoningOutputTokens = numberOrUndefined(
    usage.reasoningOutputTokens ?? usage.reasoningTokens ?? usage.reasoning,
  );
  const totalTokens = numberOrUndefined(usage.totalTokens ?? usage.total);
  const estimatedUsd = numberOrUndefined(usage.estimatedUsd ?? cost?.estimatedUsd ?? cost?.total);
  const normalized: AgentUsage = {
    ...(turnId === undefined ? {} : { turnId }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(estimatedUsd === undefined ? {} : { estimatedUsd }),
  };
  return Object.values(normalized).some((value) => value !== undefined) ? normalized : undefined;
}

function addAgentUsage(previous: AgentUsage | undefined, next: AgentUsage): AgentUsage {
  if (!previous) return { ...next };
  const result: AgentUsage = { ...previous };
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'cacheWriteTokens',
    'reasoningOutputTokens',
    'totalTokens',
    'estimatedUsd',
  ] as const) {
    if (next[key] !== undefined) result[key] = (result[key] ?? 0) + next[key];
  }
  if (next.contextWindow !== undefined)
    result.contextWindow = Math.max(result.contextWindow ?? 0, next.contextWindow);
  if (next.turnId && !result.turnId) result.turnId = next.turnId;
  return result;
}

function numberOrUndefined(value: unknown): number | undefined {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

/**
 * The low-level OMP JSONL transport. It is exported so tests can inject a
 * fake child process without making model calls or depending on Bun.
 */
export class OmpRpcClient extends EventEmitter {
  #process?: ChildProcessWithoutNullStreams;
  #reader?: ReturnType<typeof createInterface>;
  #requestId = 0;
  #pending = new Map<string, PendingRequest>();
  #protocolVersion = 1;
  #decoder = new OmpRpcFrameDecoder();
  #ready?: Promise<void>;
  #readyResolve?: () => void;
  #readyReject?: (error: Error) => void;
  #readySeen = false;
  #stopping = false;
  #fatal?: Error;
  #activeTurn?: OmpActiveTurn;
  #activeSessionId?: string;
  #hostTools = new Map<string, AgentToolSpec>();
  #hostToolHandlers = new Map<string, AgentToolHandler>();
  #hostToolControllers = new Map<string, AbortController>();
  #startOptions?: OmpStartOptions;
  readonly #options: OmpBackendOptions;
  version?: string;

  constructor(options: OmpBackendOptions = {}) {
    super();
    this.#options = options;
  }

  get started(): boolean {
    return this.#process !== undefined;
  }

  get sessionId(): string | undefined {
    return this.#activeSessionId;
  }

  async start(options: OmpStartOptions = {}): Promise<void> {
    if (this.#process) throw new Error('OMP RPC client already started');
    this.#stopping = false;
    this.#fatal = undefined;
    this.#protocolVersion = 1;
    this.#decoder = new OmpRpcFrameDecoder();
    this.#startOptions = { ...options };
    const dataDir = resolve(options.dataDir ?? this.#options.dataDir ?? '.phantom');
    const sessionDir = join(dataDir, 'agents', 'omp', 'sessions');
    await mkdir(sessionDir, { recursive: true });
    await protectPrivateDirectory(sessionDir);
    const args = [
      '--mode',
      'rpc',
      '--session-dir',
      sessionDir,
      '--no-extensions',
      '--no-rules',
      '--no-skills',
    ];
    if (options.cwd) args.push('--cwd', options.cwd);
    const profile = options.profile;
    if (profile) {
      const model =
        profileProvider(profile) && !profile.model.includes('/')
          ? `${profileProvider(profile)}/${profile.model}`
          : profile.model;
      args.push('--model', model, '--thinking', profile.effort);
    }
    if (options.instructions) args.push('--system-prompt', options.instructions);
    const allowedTools = (options.allowedTools ?? this.#options.allowedTools)?.filter(
      (name) => !['task', 'agent', 'agents', 'subagent'].includes(name),
    );
    if (allowedTools?.length) args.push('--tools', allowedTools.join(','));
    else args.push('--no-tools');
    if (options.ephemeral) args.push('--no-session');
    if (options.resume) args.push('--resume', options.resume);
    const launch =
      this.#options.spawn ??
      ((binary: string, childArgs: string[], spawnOptions: any) =>
        spawn(binary, childArgs, spawnOptions));
    const env: NodeJS.ProcessEnv = { ...process.env, ...(this.#options.env ?? {}) };
    const binary = this.#options.binary ?? 'omp';
    if (!this.#options.spawn) {
      this.version = (await command(binary, ['--version'], undefined, undefined, 15000)).stdout
        .trim()
        .slice(0, 200);
      this.emit('notification', 'agent/ready', { agentVersion: this.version });
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = launch(binary, args, {
        cwd: options.cwd,
        env,
        windowsHide: true,
        shell: false,
        stdio: 'pipe',
      });
    } catch (error) {
      throw errorFromUnknown(error);
    }
    this.#process = child;
    this.#reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#reader.on('line', (line) => this.#readLine(line));
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      if (text.trim()) this.emit('diagnostic', text.trim().slice(-3000));
    });
    child.on('error', (error) => this.#processFailure(error));
    child.on('exit', (code, signal) => {
      if (this.#stopping) return;
      this.#processFailure(new Error(`OMP 进程退出 (${code ?? signal ?? 'unknown'})`));
    });
    child.stdin.on('error', (error) => this.#processFailure(error));
    this.#ready = new Promise<void>((resolveReady, rejectReady) => {
      this.#readyResolve = resolveReady;
      this.#readyReject = rejectReady;
    });
    const startTimer = setTimeout(() => {
      if (!this.#readySeen) this.#readyReject?.(new Error('等待 OMP RPC ready 超时'));
    }, this.#options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    startTimer.unref();
    try {
      await this.#ready;
      if (this.#protocolVersion !== 2) {
        throw new Error('OMP RPC 不支持协议 v2');
      }
      if (options.tools?.length) await this.setHostTools(options.tools, options.toolHandler);
      else if (options.toolHandler)
        this.#hostToolHandlers.set('__unregistered__', options.toolHandler);
      const state = await this.getState();
      this.#activeSessionId = state.sessionId;
      if (profile) {
        await this.applyProfile(profile);
        assertEffectiveProfile(await this.getState(), profile);
      }
    } catch (error) {
      await this.stop();
      throw errorFromUnknown(error);
    } finally {
      clearTimeout(startTimer);
      this.#ready = undefined;
      this.#readyResolve = undefined;
      this.#readyReject = undefined;
    }
  }

  async stop(): Promise<void> {
    const child = this.#process;
    if (!child) return;
    this.#stopping = true;
    this.#reader?.close();
    this.#reader = undefined;
    this.#process = undefined;
    const error = new Error('OMP RPC client stopped');
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const controller of this.#hostToolControllers.values()) controller.abort(error);
    this.#hostToolControllers.clear();
    if (this.#activeTurn && !this.#activeTurn.settled)
      this.#finishTurnError(this.#activeTurn, error);
    try {
      child.kill();
    } catch {
      // The child may already be gone.
    }
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveExit();
        return;
      }
      const timer = setTimeout(resolveExit, 2_000);
      timer.unref();
      child.once('close', () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
    this.#activeSessionId = undefined;
    this.#startOptions = undefined;
    this.#stopping = false;
  }

  async request(
    command: string,
    body: Record<string, unknown> = {},
    timeoutMs = this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    wireId?: string,
  ): Promise<any> {
    if (!this.#process || this.#fatal) throw this.#fatal ?? new Error('OMP 未启动');
    const id = wireId ?? `req_${++this.#requestId}`;
    const frame = { id, type: command, ...body };
    const response = await new Promise<OmpResponse>((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectResponse(new OmpRpcCommandError(`等待 OMP 响应超时：${command}`, command, 'timeout'));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { command, resolve: resolveResponse, reject: rejectResponse, timer });
      try {
        this.#write(frame);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        rejectResponse(errorFromUnknown(error));
      }
    });
    if (!response.success)
      throw new OmpRpcCommandError(
        response.error ?? `OMP 命令失败：${command}`,
        command,
        response.code,
      );
    return response.data;
  }

  async getState(): Promise<OmpSessionState> {
    return (await this.request('get_state')) as OmpSessionState;
  }

  async getAvailableModels(): Promise<any[]> {
    const data = await this.request('get_available_models');
    return Array.isArray(data?.models) ? data.models : [];
  }

  async applyProfile(profile: AgentProfile): Promise<void> {
    const provider = profileProvider(profile);
    const requestedModel = profile.model.includes('/')
      ? profile.model.split('/').at(-1)!
      : profile.model;
    if (provider) await this.request('set_model', { provider, modelId: requestedModel });
    else {
      const models = await this.getAvailableModels();
      const model = models.find(
        (candidate) => candidate?.id === requestedModel || candidate?.id === profile.model,
      );
      if (!model) throw new Fault(`模型不可用：${profile.model}`, 409);
      await this.request('set_model', { provider: model.provider, modelId: model.id });
    }
    await this.request('set_thinking_level', { level: profile.effort });
  }

  async setHostTools(tools: AgentToolSpec[], handler?: AgentToolHandler): Promise<string[]> {
    this.#hostTools.clear();
    for (const tool of tools) {
      this.#hostTools.set(tool.name, tool);
      if (handler) this.#hostToolHandlers.set(tool.name, handler);
    }
    if (!this.#process) return tools.map((tool) => tool.name);
    const definitions = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      loadMode: 'essential',
    }));
    const data = await this.request('set_host_tools', { tools: definitions });
    return Array.isArray(data?.toolNames) ? data.toolNames : tools.map((tool) => tool.name);
  }

  async prompt(
    sessionId: string,
    message: string,
    options: AgentPromptOptions = {},
  ): Promise<AgentTurnResult> {
    if (this.#activeTurn && !this.#activeTurn.settled)
      throw new AgentTurnError('OMP 会话已有运行中的回合', 'failed', 'busy');
    if (options.signal?.aborted) throw new AgentTurnError('执行已暂停', 'interrupted', 'aborted');
    const images = options.images ?? (await imagesFromPaths(options.imagePaths));
    if (options.signal?.aborted) throw new AgentTurnError('执行已暂停', 'interrupted', 'aborted');
    const requestId = `prompt_${randomUUID()}`;
    const turnId = randomUUID();
    const timeoutMs = options.timeoutMs ?? this.#options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const { promise, resolve: resolveTurn, reject: rejectTurn } = deferred<AgentTurnResult>();
    const timer = setTimeout(() => {
      const active = this.#activeTurn;
      if (!active || active.settled) return;
      active.error = new AgentTurnError('Agent 超过单次运行时限', 'failed', 'timeout');
      void this.abort().catch(() => {});
      this.#finishTurnError(active, active.error);
    }, timeoutMs);
    timer.unref();
    const active: OmpActiveTurn = {
      requestId,
      turnId,
      sessionId,
      output: '',
      messageUsages: [],
      signal: options.signal,
      timer,
      settled: false,
      resolve: resolveTurn,
      reject: rejectTurn,
    };
    this.#activeTurn = active;
    this.#activeSessionId = sessionId;
    options.onTurn?.(turnId);
    const abort = () => {
      void this.abort().catch(() => {});
      if (!active.settled)
        this.#finishTurnError(active, new AgentTurnError('执行已暂停', 'interrupted', 'aborted'));
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    active.cleanup = () => options.signal?.removeEventListener('abort', abort);
    if (options.signal?.aborted) {
      abort();
      return promise;
    }
    try {
      const data = await this.request(
        'prompt',
        { message, ...(images?.length ? { images } : {}) },
        this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        requestId,
      );
      if (data?.agentInvoked === false) this.#finishTurn(active, 'completed', data);
    } catch (error) {
      this.#finishTurnError(active, errorFromUnknown(error));
    }
    return promise;
  }

  async steer(message: string, images?: AgentImage[]): Promise<void> {
    await this.request('steer', { message, ...(images?.length ? { images } : {}) });
  }

  async followUp(message: string, images?: AgentImage[]): Promise<void> {
    await this.request('follow_up', { message, ...(images?.length ? { images } : {}) });
  }

  async abort(): Promise<void> {
    await this.request('abort');
    if (this.#activeTurn && !this.#activeTurn.settled)
      this.#finishTurnError(
        this.#activeTurn,
        new AgentTurnError('执行已暂停', 'interrupted', 'aborted'),
      );
  }

  async newSession(): Promise<OmpSessionState> {
    await this.request('new_session');
    const state = await this.getState();
    this.#activeSessionId = state.sessionId;
    return state;
  }

  async negotiate(): Promise<void> {
    await this.request('negotiate_protocol', { protocolVersion: 2 });
  }

  #readLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.emit('diagnostic', `OMP 输出不是 JSON：${errorFromUnknown(error).message}`);
      return;
    }
    try {
      if (isRecord(parsed) && parsed.type === 'rpc_chunk' && this.#protocolVersion !== 2)
        throw new Error('在协商 RPC v2 之前收到 rpc_chunk');
      const decoded = this.#decoder.push(parsed);
      if (decoded) this.#handleFrame(decoded);
    } catch (error) {
      this.#processFailure(errorFromUnknown(error));
    }
  }

  #handleFrame(frame: Record<string, unknown>): void {
    if (frame.type === 'ready') {
      const ready = frame as unknown as OmpReadyFrame;
      this.#readySeen = true;
      if (
        !ready.supportedProtocolVersions?.includes(2) ||
        ready.maxFrameBytes !== OMP_RPC_MAX_FRAME_BYTES ||
        ready.maxReassembledFrameBytes !== OMP_RPC_MAX_REASSEMBLED_BYTES
      ) {
        this.#readyReject?.(new Error('OMP RPC ready 未声明完整的协议 v2 能力'));
        return;
      }
      void this.negotiate()
        .then(() => {
          this.#protocolVersion = 2;
          this.#readyResolve?.();
        })
        .catch((error) => this.#readyReject?.(errorFromUnknown(error)));
      return;
    }
    if (frame.type === 'response') {
      const response = frame as unknown as OmpResponse;
      if (response.id && this.#pending.has(response.id)) {
        const pending = this.#pending.get(response.id)!;
        this.#pending.delete(response.id);
        clearTimeout(pending.timer);
        pending.resolve(response);
      } else if (
        response.id === this.#activeTurn?.requestId &&
        response.success === false &&
        this.#activeTurn
      ) {
        this.#finishTurnError(
          this.#activeTurn,
          new AgentTurnError(
            response.error ?? `OMP prompt 失败：${response.command}`,
            'failed',
            response.code,
          ),
        );
      }
      return;
    }
    if (frame.type === 'host_tool_call') {
      void this.#handleHostToolCall(frame as unknown as OmpHostToolCall);
      return;
    }
    if (frame.type === 'host_tool_cancel') {
      const cancel = frame as unknown as OmpHostToolCancel;
      this.#hostToolControllers.get(cancel.targetId)?.abort();
      return;
    }
    if (frame.type === 'extension_ui_request') {
      void this.#handleUserInput(frame as unknown as OmpExtensionUiRequest);
      return;
    }
    this.#handleEvent(frame);
  }

  #handleEvent(frame: Record<string, unknown>): void {
    this.emit('event', frame);
    if (typeof frame.type !== 'string') return;
    const active = this.#activeTurn;
    if (frame.type === 'message_update') {
      const delta = (frame.assistantMessageEvent as any)?.delta;
      if (active && typeof delta === 'string') {
        active.output += delta;
        this.emit('notification', 'item/agentMessage/delta', {
          threadId: active.sessionId,
          turnId: active.turnId,
          itemId: (frame.message as any)?.id ?? 'assistant',
          delta,
        });
      }
    } else if (frame.type === 'message_end') {
      const message = frame.message as any;
      if (message?.role === 'assistant') {
        if (active && isRecord(message.usage)) {
          const usage = normalizeAgentUsage(message.usage, undefined, frame);
          if (usage) {
            const id = stringOrUndefined(message.id);
            const previous = active.messageUsages.findIndex((entry) => id && entry.id === id);
            if (previous >= 0)
              active.messageUsages[previous] = {
                id,
                usage: { ...usage, ...normalizeUsage(active.messageUsages[previous].usage, usage) },
              };
            else active.messageUsages.push({ ...(id ? { id } : {}), usage });
          }
        }
        const text = assistantText(message.content);
        if (active && text) active.output = text;
        this.emit('notification', 'item/completed', {
          threadId: active?.sessionId,
          turnId: active?.turnId,
          item: { id: message.id ?? 'assistant', type: 'agentMessage', text },
        });
      }
    } else if (frame.type === 'tool_execution_start') {
      const tool = frame as any;
      this.emit('notification', 'item/started', {
        threadId: active?.sessionId,
        turnId: active?.turnId,
        item: {
          id: tool.toolCallId,
          type: 'dynamicToolCall',
          tool: tool.toolName,
          arguments: tool.args,
        },
      });
    } else if (frame.type === 'tool_execution_end') {
      const tool = frame as any;
      this.emit('notification', 'item/completed', {
        threadId: active?.sessionId,
        turnId: active?.turnId,
        item: {
          id: tool.toolCallId,
          type: 'dynamicToolCall',
          tool: tool.toolName,
          arguments: tool.args,
          status: tool.isError ? 'failed' : 'completed',
          result: tool.result,
        },
      });
    } else if (frame.type === 'notice' && (frame as any).level === 'error' && active) {
      active.error = new AgentTurnError(String((frame as any).message ?? 'OMP 回合失败'), 'failed');
    } else if (frame.type === 'agent_end' && frame.isTerminal !== false && active) {
      if (active.settled) {
        if (this.#activeTurn === active) this.#activeTurn = undefined;
      } else {
        active.usage = usageFromAgentEnd(frame, active.turnId, active.messageUsages);
        active.raw = frame;
        if (active.error) this.#finishTurnError(active, active.error);
        else this.#finishTurn(active, 'completed', frame);
      }
    } else if (frame.type === 'prompt_result' && (frame as any).agentInvoked === false && active) {
      this.#finishTurn(active, 'completed', frame);
    }
    this.emit('session-event', frame);
  }

  async #handleHostToolCall(call: OmpHostToolCall): Promise<void> {
    const handler =
      this.#hostToolHandlers.get(call.toolName) ?? this.#hostToolHandlers.get('__unregistered__');
    const controller = new AbortController();
    this.#hostToolControllers.set(call.id, controller);
    try {
      if (!handler || !this.#hostTools.has(call.toolName))
        throw new Error(`Host tool "${call.toolName}" 未注册`);
      const value = await handler(call.toolName, call.arguments, controller.signal);
      if (controller.signal.aborted) return;
      this.#write({ type: 'host_tool_result', id: call.id, result: asToolResult(value) });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.#write({
        type: 'host_tool_result',
        id: call.id,
        result: { content: [{ type: 'text', text: errorFromUnknown(error).message }] },
        isError: true,
      });
    } finally {
      this.#hostToolControllers.delete(call.id);
    }
  }

  async #handleUserInput(request: OmpExtensionUiRequest): Promise<void> {
    this.emit('user-input', request);
    const handler = this.#startOptions?.onUserInput ?? this.#options.onUserInput;
    if (!handler || !['select', 'confirm', 'input', 'editor'].includes(request.method)) {
      if (
        request.method === 'select' ||
        request.method === 'confirm' ||
        request.method === 'input' ||
        request.method === 'editor'
      )
        this.#write({ type: 'extension_ui_response', id: request.id, cancelled: true });
      return;
    }
    const input: AgentUserInputRequest = {
      id: request.id,
      method: request.method as AgentUserInputRequest['method'],
      title: request.title ?? '',
      message: request.message,
      options: request.options,
      placeholder: request.placeholder,
      prefill: request.prefill,
    };
    try {
      const value = await handler(input);
      if (value === undefined) {
        this.#write({ type: 'extension_ui_response', id: request.id, cancelled: true });
        return;
      }
      if (
        typeof value === 'object' &&
        value !== null &&
        ('cancelled' in value || 'value' in value || 'confirmed' in value)
      ) {
        this.#write({
          type: 'extension_ui_response',
          id: request.id,
          ...(value as AgentUserInputResponse),
        });
      } else if (request.method === 'confirm') {
        this.#write({ type: 'extension_ui_response', id: request.id, confirmed: value === true });
      } else {
        this.#write({ type: 'extension_ui_response', id: request.id, value: String(value) });
      }
    } catch {
      this.#write({ type: 'extension_ui_response', id: request.id, cancelled: true });
    }
  }

  #finishTurn(
    active: OmpActiveTurn,
    status: 'completed' | 'interrupted' | 'failed',
    raw?: unknown,
  ): void {
    if (active.settled) return;
    active.settled = true;
    clearTimeout(active.timer);
    active.cleanup?.();
    if (this.#activeTurn === active && status === 'completed') this.#activeTurn = undefined;
    const result: AgentTurnResult = {
      sessionId: active.sessionId,
      turnId: active.turnId,
      text: active.output,
      status,
      usage: active.usage
        ? { ...active.usage, turnId: active.usage.turnId ?? active.turnId }
        : undefined,
      raw: raw ?? active.raw,
    };
    this.emit('notification', 'turn/completed', {
      threadId: active.sessionId,
      turn: { id: active.turnId, status },
      usage: active.usage
        ? { ...active.usage, turnId: active.usage.turnId ?? active.turnId }
        : undefined,
    });
    active.resolve(result);
  }

  #finishTurnError(active: OmpActiveTurn, error: Error): void {
    if (active.settled) return;
    const turnError =
      error instanceof AgentTurnError ? error : new AgentTurnError(error.message, 'failed');
    active.error = turnError;
    active.settled = true;
    clearTimeout(active.timer);
    active.cleanup?.();
    this.emit('notification', 'turn/completed', {
      threadId: active.sessionId,
      turn: { id: active.turnId, status: turnError.status, error: { message: turnError.message } },
      usage: active.usage
        ? { ...active.usage, turnId: active.usage.turnId ?? active.turnId }
        : undefined,
    });
    active.reject(turnError);
    // Keep an aborted OMP turn associated with the process until its terminal
    // agent_end arrives. This prevents a second prompt racing the RPC abort.
    if (this.#activeTurn === active && turnError.status === 'interrupted')
      this.#activeTurn = active;
  }

  #processFailure(error: Error): void {
    if (this.#fatal || this.#stopping) return;
    this.#fatal = error;
    this.#readyReject?.(error);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    if (this.#activeTurn && !this.#activeTurn.settled)
      this.#finishTurnError(this.#activeTurn, error);
    this.emit('failure', error);
  }

  #write(frame: Record<string, unknown>): void {
    if (!this.#process?.stdin || this.#fatal) throw this.#fatal ?? new Error('OMP 未启动');
    this.#process.stdin.write(`${JSON.stringify(frame)}\n`);
  }
}

function assistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
}

const OMP_CAPABILITIES: AgentCapabilities = {
  sessions: true,
  streaming: true,
  steering: true,
  followUp: true,
  abort: true,
  images: true,
  hostTools: true,
  usage: true,
  accountAllowance: false,
  modelListing: true,
  nestedAgents: false,
  extensions: false,
  rules: false,
  skills: false,
};

/** Session handle backed by one OMP RPC process/session. */
export class OmpSession implements AgentSession {
  readonly id: string;
  readonly sessionId: string;
  constructor(
    private readonly backend: OmpBackend,
    id: string,
    private readonly options: AgentSessionOptions,
  ) {
    this.id = id;
    this.sessionId = id;
  }

  prompt(message: string, options: AgentPromptOptions = {}): Promise<AgentTurnResult> {
    return this.backend.prompt(this.id, message, {
      ...options,
      profile: options.profile ?? this.options.profile,
    });
  }

  async steer(message: string, options: AgentPromptOptions = {}): Promise<void> {
    await this.backend.steer(this.id, message, options);
  }

  async followUp(message: string, options: AgentPromptOptions = {}): Promise<void> {
    await this.backend.followUp(this.id, message, options);
  }

  async reconcileSteer(clientUserMessageId: string): Promise<AgentSteerReconciliation> {
    return this.backend.reconcileSteer(this.id, clientUserMessageId);
  }

  async abort(): Promise<void> {
    await this.backend.abort(this.id);
  }

  async dispose(): Promise<void> {
    await this.backend.dispose();
  }

  on(event: string | symbol, listener: (...args: any[]) => void): EventEmitter {
    return this.backend.on(event, listener);
  }

  off(event: string | symbol, listener: (...args: any[]) => void): EventEmitter {
    return this.backend.off(event, listener);
  }
}

/**
 * OMP's process-backed backend. It intentionally owns no credentials: OMP
 * reads its normal auth storage, while this adapter only supplies an isolated
 * session directory and role/tool restrictions.
 */
export class OmpBackend extends EventEmitter implements AgentBackend {
  readonly capabilities = OMP_CAPABILITIES;
  private readonly client: OmpRpcClient;
  private current?: OmpSession;
  private currentOptions?: AgentSessionOptions;

  constructor(options: OmpBackendOptions = {}) {
    super();
    this.client = new OmpRpcClient(options);
    this.client.on('diagnostic', (line) => this.emit('diagnostic', line));
    this.client.on('failure', (error) => this.emit('failure', error));
    this.client.on('notification', (method, params) => this.emit('notification', method, params));
    this.client.on('event', (event) => this.emit('event', event));
    this.client.on('session-event', (event) => this.emit('session-event', event));
    this.client.on('user-input', (request) => this.emit('user-input', request));
  }

  get started(): boolean {
    return this.client.started;
  }

  get sessionId(): string | undefined {
    return this.client.sessionId;
  }

  async start(provider?: unknown): Promise<void> {
    if (this.client.started) return;
    const options =
      isRecord(provider) && ('cwd' in provider || 'profile' in provider || 'dataDir' in provider)
        ? (provider as unknown as OmpStartOptions)
        : {};
    await this.client.start(options);
    this.currentOptions = options;
  }

  async stop(): Promise<void> {
    await this.client.stop();
    this.current = undefined;
    this.currentOptions = undefined;
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  async models(): Promise<AgentLegacyModel[]> {
    await this.ensureStarted();
    return (await this.client.getAvailableModels()).map((model) => asAgentLegacyModel(model));
  }

  async modelCapabilities(): Promise<AgentModelCapability[]> {
    return (await this.client.getAvailableModels()).map((model) => asAgentModelCapability(model));
  }

  async validate(profile: AgentProfile): Promise<void> {
    await this.ensureStarted();
    const capabilities = await this.modelCapabilities();
    const provider = profileProvider(profile);
    const requestedId = profile.model.includes('/')
      ? profile.model.split('/').at(-1)!
      : profile.model;
    const model = capabilities.find(
      (candidate) =>
        (candidate.id === requestedId || candidate.id === profile.model) &&
        (!provider || !candidate.provider || candidate.provider === provider),
    );
    if (!model) throw new Fault(`模型不可用：${profile.model}`, 409);
    if (!model.reasoningEfforts.includes(profile.effort))
      throw new Fault(`模型不支持推理档位：${profile.model} / ${profile.effort}`, 409);
  }

  async createSession(options: AgentSessionOptions): Promise<OmpSession> {
    if (!this.client.started) {
      await this.client.start({
        ...options,
        allowedTools: options.allowedTools ?? this.clientAllowedTools(),
      });
    } else {
      // OMP starts with one durable session. A second create request is an
      // explicit new session, never a silent reuse of the old conversation.
      const state = await this.client.getState();
      if (state.isStreaming)
        throw new AgentTurnError('无法在运行中的 OMP 会话创建新会话', 'failed', 'busy');
      await this.client.newSession();
      await this.configureSession(options);
    }
    const state = await this.client.getState();
    if (options.profile) assertEffectiveProfile(state, options.profile);
    const session = new OmpSession(this, state.sessionId, options);
    this.current = session;
    this.currentOptions = options;
    return session;
  }

  async resumeSession(options: AgentSessionOptions): Promise<OmpSession> {
    const sessionId = options.sessionId ?? options.sessionPath;
    if (!sessionId) throw new Fault('恢复 OMP 会话需要 sessionId', 400);
    if (this.client.started && this.client.sessionId && this.client.sessionId === sessionId) {
      const state = await this.client.getState();
      if (options.profile) assertEffectiveProfile(state, options.profile);
      const session = new OmpSession(this, state.sessionId, options);
      this.current = session;
      this.currentOptions = options;
      return session;
    }
    await this.stop();
    await this.client.start({ ...options, resume: sessionId });
    const state = await this.client.getState();
    if (
      !state.sessionId.startsWith(sessionId) &&
      state.sessionId !== sessionId &&
      state.sessionFile !== sessionId
    )
      throw new Fault(`OMP 未恢复请求的会话：${sessionId}`, 409);
    if (options.profile) assertEffectiveProfile(state, options.profile);
    const session = new OmpSession(this, state.sessionId, options);
    this.current = session;
    this.currentOptions = options;
    return session;
  }

  /** Legacy Codex-compatible alias: thread creation/resume returns an id. */
  async thread(options: AgentThreadOptions): Promise<string> {
    const session = options.threadId
      ? await this.resumeSession({
          ...options,
          sessionId: options.threadId,
          profile: options.profile,
          tools: options.tools,
          toolHandler: options.toolHandler,
        })
      : await this.createSession({
          ...options,
          profile: options.profile,
          tools: options.tools,
          toolHandler: options.toolHandler,
        });
    return session.id;
  }

  /** Legacy turn alias. Completion is still based on agent_end, not prompt ack. */
  async turn(
    sessionId: string,
    prompt: string,
    profile: AgentProfile,
    signal?: AbortSignal,
    outputSchema?: unknown,
    onTurn?: (id: string) => void,
    imagePaths: string[] = [],
  ): Promise<string> {
    const result = await this.prompt(sessionId, prompt, {
      profile,
      signal,
      outputSchema,
      onTurn,
      imagePaths,
    });
    if (result.status !== 'completed')
      throw new AgentTurnError(
        result.status === 'interrupted' ? '执行已暂停' : 'OMP 回合失败',
        result.status,
      );
    return result.text;
  }

  async prompt(
    sessionId: string,
    message: string,
    options: AgentPromptOptions = {},
  ): Promise<AgentTurnResult> {
    await this.ensureStarted();
    if (this.client.sessionId && this.client.sessionId !== sessionId)
      throw new Fault(`OMP 会话不匹配：${sessionId}`, 409);
    if (options.profile) {
      const state = await this.client.getState();
      assertEffectiveProfile(state, options.profile);
    }
    return this.client.prompt(sessionId, message, options);
  }

  async steer(sessionId: string, message: string, options: AgentPromptOptions = {}): Promise<void> {
    await this.ensureSession(sessionId);
    const images = options.images ?? (await imagesFromPaths(options.imagePaths));
    await this.client.steer(message, images);
  }

  async followUp(
    sessionId: string,
    message: string,
    options: AgentPromptOptions = {},
  ): Promise<void> {
    await this.ensureSession(sessionId);
    const images = options.images ?? (await imagesFromPaths(options.imagePaths));
    await this.client.followUp(message, images);
  }

  /** OMP RPC v2 has no durable client message id or message-history read command. */
  async reconcileSteer(
    sessionId: string,
    _clientUserMessageId: string,
  ): Promise<AgentSteerReconciliation> {
    if (!this.client.started || this.client.sessionId !== sessionId) return 'unknown';
    return 'unknown';
  }

  async abort(sessionId: string): Promise<void> {
    await this.ensureSession(sessionId);
    await this.client.abort();
  }

  async accountAllowance(): Promise<AgentAllowance> {
    return {
      status: 'unavailable',
      code: 'unsupported',
      error: 'OMP RPC v2 未提供 account/read、account/rateLimits/read 或 account/usage/read',
    };
  }

  async probe(options: Partial<AgentSessionOptions> = {}): Promise<AgentProbeResult> {
    const wasStarted = this.client.started;
    if (!wasStarted) await this.client.start(options as OmpStartOptions);
    try {
      const state = await this.client.getState();
      const models = (await this.client.getAvailableModels()).map((model) =>
        asAgentModelCapability(model),
      );
      return {
        backend: 'omp',
        version: this.client.version,
        protocol: 'omp-rpc',
        protocolVersion: 2,
        sessionId: state.sessionId,
        models,
        capabilities: OMP_CAPABILITIES,
        allowance: await this.accountAllowance(),
      };
    } finally {
      if (!wasStarted) await this.stop();
    }
  }

  private async ensureStarted(): Promise<void> {
    if (!this.client.started) throw new Fault('OMP 未启动', 503);
  }

  private async ensureSession(sessionId: string): Promise<void> {
    await this.ensureStarted();
    if (this.client.sessionId !== sessionId) throw new Fault(`OMP 会话不匹配：${sessionId}`, 409);
  }

  private async configureSession(options: AgentSessionOptions): Promise<void> {
    if (options.tools?.length) await this.client.setHostTools(options.tools, options.toolHandler);
    if (options.profile) {
      await this.client.applyProfile(options.profile);
      assertEffectiveProfile(await this.client.getState(), options.profile);
    }
  }

  private clientAllowedTools(): string[] | undefined {
    return undefined;
  }
}

export function createOmpBackend(options: OmpBackendOptions = {}): OmpBackend {
  return new OmpBackend(options);
}
