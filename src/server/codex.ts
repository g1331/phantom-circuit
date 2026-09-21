import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import { command, terminate } from './process.ts';
import { Fault, redact } from './store.ts';
import type { Profile as Assignment } from '../shared/types.ts';
import { SecretTextStream } from './secret-text-stream.ts';
import type {
  AgentAllowance,
  AgentBackend,
  AgentLegacyModel,
  AgentModelCapability,
  AgentProbeResult,
  AgentPromptOptions,
  AgentSteerReconciliation,
  AgentThreadOptions,
  AgentSession,
  AgentSessionOptions,
  AgentTurnResult,
  AgentUsage,
  AgentUserInputHandler,
} from './agent-backend.ts';
type Profile = Pick<Assignment, 'model' | 'effort'>;

export interface Model extends AgentLegacyModel {
  id: string;
  model: string;
  displayName: string;
  supportedReasoningEfforts: { reasoningEffort: string }[];
}
type Wire = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
};

interface QueuedFollowUp {
  message: string;
  options: AgentPromptOptions;
  profile: Profile;
  resolve: () => void;
  reject: (error: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (
    typeof value === 'bigint' &&
    value <= BigInt(Number.MAX_SAFE_INTEGER) &&
    value >= BigInt(Number.MIN_SAFE_INTEGER)
  )
    return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function microsValue(value: unknown): number | undefined {
  const parsed = numberValue(value);
  return parsed === undefined ? undefined : parsed / 1_000_000;
}

function usageFromCodexNotification(params: unknown): AgentUsage | undefined {
  if (!isRecord(params)) return undefined;
  const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : params;
  // Codex also publishes `total`; that is a lifetime/thread aggregate. `last`
  // is the per-turn snapshot required by the host contract.
  const last = isRecord(tokenUsage.last) ? tokenUsage.last : undefined;
  if (!last) return undefined;
  const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
  return {
    turnId,
    inputTokens: numberValue(last.inputTokens),
    outputTokens: numberValue(last.outputTokens),
    cachedInputTokens: numberValue(last.cachedInputTokens),
    cacheWriteTokens: numberValue(last.cacheWriteInputTokens),
    reasoningOutputTokens: numberValue(last.reasoningOutputTokens),
    totalTokens: numberValue(last.totalTokens),
    contextWindow: numberValue(tokenUsage.modelContextWindow),
  };
}

function allowanceStatus(error: unknown): AgentAllowance['status'] {
  const message = error instanceof Error ? error.message : String(error);
  if (/method not found|unknown method|unsupported|not implemented|-32601/i.test(message))
    return 'unavailable';
  if (/auth|unauthori[sz]ed|forbidden|credential|login|logged in|token|401|403/i.test(message))
    return 'authentication_error';
  return 'protocol_error';
}

function allowanceFailure(error: unknown, command: string): AgentAllowance {
  const status = allowanceStatus(error);
  const messages: Record<AgentAllowance['status'], string> = {
    available: '',
    unavailable: `Codex app-server 未提供 ${command} allowance RPC`,
    authentication_error: 'Codex 账户未认证或认证已失效',
    protocol_error: `Codex ${command} allowance RPC 返回协议错误`,
  };
  return { status, error: messages[status], code: status };
}

function epochSecondsToIso(value: unknown): string | undefined {
  const seconds = numberValue(value);
  if (seconds === undefined) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function mapRateLimitWindow(value: unknown) {
  if (!isRecord(value)) return undefined;
  return {
    usedPercent: numberValue(value.usedPercent),
    windowDurationMinutes: numberValue(value.windowDurationMins),
    resetsAt: epochSecondsToIso(value.resetsAt),
  };
}

function mapRateLimits(value: unknown): AgentAllowance['rateLimits'] {
  if (!isRecord(value)) return undefined;
  const snapshot = isRecord(value.rateLimits) ? value.rateLimits : undefined;
  const byLimit = isRecord(value.rateLimitsByLimitId) ? value.rateLimitsByLimitId : undefined;
  const buckets = byLimit
    ? Object.values(byLimit).flatMap((entry) => {
        if (!isRecord(entry)) return [];
        return [
          {
            name: typeof entry.limitName === 'string' ? entry.limitName : undefined,
            planType: typeof entry.planType === 'string' ? entry.planType : undefined,
            primary: mapRateLimitWindow(entry.primary),
            secondary: mapRateLimitWindow(entry.secondary),
            rateLimitReachedType:
              typeof entry.rateLimitReachedType === 'string'
                ? entry.rateLimitReachedType
                : undefined,
          },
        ];
      })
    : undefined;
  return {
    ordinaryUsageAllowed:
      typeof value.ordinaryUsageAllowed === 'boolean' || value.ordinaryUsageAllowed === null
        ? (value.ordinaryUsageAllowed as boolean | null)
        : undefined,
    primary: mapRateLimitWindow(snapshot?.primary),
    secondary: mapRateLimitWindow(snapshot?.secondary),
    buckets,
  };
}

function mapAllowanceUsage(value: unknown): AgentAllowance['usage'] {
  if (!isRecord(value)) return undefined;
  const summary = isRecord(value.summary) ? value.summary : undefined;
  const rawThread = isRecord(value.threadUsage) ? value.threadUsage : undefined;
  const groups = Array.isArray(rawThread?.groups)
    ? rawThread.groups.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        return [
          {
            model: typeof entry.model === 'string' ? entry.model : undefined,
            reasoningEffort:
              typeof entry.reasoningEffort === 'string' ? entry.reasoningEffort : undefined,
            speed: typeof entry.speed === 'string' ? entry.speed : undefined,
            estimatedUsageCredits: microsValue(entry.estimatedUsageCreditsMicros),
            inputTokens: numberValue(entry.inputTokens),
            cachedInputTokens: numberValue(entry.cachedInputTokens),
            outputTokens: numberValue(entry.outputTokens),
            totalTokens: numberValue(entry.totalTokens),
          },
        ];
      })
    : undefined;
  return {
    lifetimeTokens: numberValue(summary?.lifetimeTokens),
    peakDailyTokens: numberValue(summary?.peakDailyTokens),
    longestRunningTurnSeconds: numberValue(summary?.longestRunningTurnSec),
    currentStreakDays: numberValue(summary?.currentStreakDays),
    longestStreakDays: numberValue(summary?.longestStreakDays),
    dailyUsageBuckets: Array.isArray(value.dailyUsageBuckets)
      ? value.dailyUsageBuckets.flatMap((entry) => {
          if (!isRecord(entry) || typeof entry.startDate !== 'string') return [];
          const tokens = numberValue(entry.tokens);
          return tokens === undefined ? [] : [{ startDate: entry.startDate, tokens }];
        })
      : undefined,
    thread: rawThread
      ? {
          estimatedUsageCredits: microsValue(rawThread.estimatedUsageCreditsMicros),
          estimatedUsageUsd: microsValue(rawThread.estimatedUsageUsdMicros),
          groups,
        }
      : undefined,
  };
}

function codexInput(
  message: string,
  imagePaths: string[] = [],
  images: AgentPromptOptions['images'] = [],
) {
  return [
    { type: 'text', text: message, text_elements: [] },
    ...imagePaths.map((path) => ({ type: 'localImage', path })),
    ...(images ?? []).map((image) => ({
      type: 'image',
      url: `data:${image.mimeType};base64,${image.data}`,
    })),
  ];
}
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export class CodexTurnError extends Error {
  constructor(
    message: string,
    readonly status: 'failed' | 'interrupted',
  ) {
    super(message);
  }
}
export class Codex extends EventEmitter implements AgentBackend {
  constructor(
    private launch: (
      binary: string,
      args: string[],
      options: SpawnOptionsWithoutStdio,
    ) => ChildProcessWithoutNullStreams = spawn,
  ) {
    super();
  }
  private child?: ChildProcessWithoutNullStreams;
  private version?: string;
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (x: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private toolHandler?: (name: string, args: unknown) => Promise<unknown>;
  private fatal?: Error;
  private customProvider = false;
  private modelProvider = 'openai';
  private activeTurns = new Map<string, string>();
  private activeProfiles = new Map<string, Profile>();
  private turnUsages = new Map<string, AgentUsage>();
  private completedTurnUsages = new Map<string, AgentUsage>();
  private followUpQueues = new Map<string, QueuedFollowUp[]>();
  private drainingFollowUps = new Set<string>();
  private pendingAborts = new Set<string>();
  private userInputHandler?: AgentUserInputHandler;
  private stopping = false;
  private scrubSecret = (text: string) => text;
  private finishStreams = () => {};
  async start(provider?: { id: string; baseUrl: string; apiKey: string }) {
    this.stopping = false;
    this.customProvider = provider !== undefined;
    this.modelProvider = provider?.id ?? 'openai';
    let binary = 'codex';
    let args = ['app-server', '--stdio'];
    const env = { ...process.env };
    let keyName: string | undefined;
    let secret = provider?.apiKey ?? '';
    this.scrubSecret = (text) => (secret ? text.replaceAll(secret, '<REDACTED>') : text);
    const deliver = (message: Wire) => {
      void this.receive(
        secret
          ? JSON.parse(JSON.stringify(message), (_key, value) =>
              typeof value === 'string' ? this.scrubSecret(value) : value,
            )
          : message,
      );
    };
    const deltas = new SecretTextStream(secret);
    const completed = new SecretTextStream(secret, true);
    this.finishStreams = () => {
      deltas.finish();
      completed.finish();
    };
    const scrub = (text: string) => redact(secret ? text.replaceAll(secret, '<REDACTED>') : text);
    if (provider) {
      if (!/^[a-zA-Z0-9_-]+$/.test(provider.id)) throw new Fault('Provider id 无效');
      keyName = `PHANTOM_PROVIDER_KEY_${randomUUID().replaceAll('-', '_')}`;
      env[keyName] = secret;
      const config = {
        model_provider: provider.id,
        [`model_providers.${provider.id}.name`]: provider.id,
        [`model_providers.${provider.id}.base_url`]: provider.baseUrl,
        [`model_providers.${provider.id}.env_key`]: keyName,
        [`model_providers.${provider.id}.wire_api`]: 'responses',
        [`model_providers.${provider.id}.requires_openai_auth`]: false,
      };
      for (const [name, value] of Object.entries(config))
        args.push('-c', `${name}=${JSON.stringify(value)}`);
    } else args.push('-c', 'model_provider="openai"');
    if (process.platform === 'win32') {
      const paths = (await command('where.exe', ['codex'])).stdout.trim().split(/\r?\n/);
      const entry = paths
        .map((p) => join(dirname(p), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'))
        .find(existsSync);
      if (!entry) throw new Fault('找不到 Codex Node 入口，请检查 Codex CLI 安装', 503);
      binary = process.execPath;
      args = [entry, ...args];
    }
    if (this.launch === spawn) {
      const versionArgs = binary === process.execPath ? [args[0], '--version'] : ['--version'];
      this.version = (await command(binary, versionArgs, undefined, undefined, 15000)).stdout
        .trim()
        .slice(0, 200);
      this.emit('notification', 'agent/ready', { agentVersion: this.version });
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.launch(binary, args, {
        windowsHide: true,
        stdio: 'pipe',
        shell: false,
        env,
      });
      this.child = child;
    } finally {
      if (keyName) delete env[keyName];
    }
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      try {
        // Match the raw stream before per-value redaction: a key can span arbitrary deltas.
        const raw = JSON.parse(line) as Wire;
        if (secret && raw.id === undefined && raw.method === 'item/agentMessage/delta') {
          const p = raw.params;
          deltas.push(p.delta, (delta) => deliver({ ...raw, params: { ...p, delta } }));
          return;
        }
        if (
          secret &&
          raw.id === undefined &&
          raw.method === 'item/completed' &&
          raw.params.item.type === 'agentMessage' &&
          typeof raw.params.item.text === 'string'
        ) {
          const p = raw.params;
          completed.push(p.item.text, (text) =>
            deliver({ ...raw, params: { ...p, item: { ...p.item, text } } }),
          );
          return;
        }
        if (raw.id === undefined && raw.method === 'turn/completed') this.finishStreams();
        deliver(raw);
      } catch {
        this.emit('diagnostic', scrub(line));
      }
    });
    // Buffer complete lines so a key split across stderr chunks cannot escape redaction.
    createInterface({ input: this.child.stderr }).on('line', (line) =>
      this.emit('diagnostic', scrub(line).slice(-3000)),
    );
    child.on('close', () => {
      deltas.finish();
      completed.finish();
      deltas.dispose();
      completed.dispose();
      secret = '';
    });
    child.on('error', (e) => {
      if (this.child === child && !this.stopping) this.fail(e);
    });
    child.on('exit', (code) => {
      if (this.child === child && !this.stopping) this.fail(new Error(`Codex 进程退出 (${code})`));
    });
    child.stdin.on('error', (e) => {
      if (this.child === child && !this.stopping) this.fail(e);
    });
    await this.request('initialize', {
      clientInfo: { name: 'phantom_circuit', title: 'Phantom Circuit', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
  }
  private send(message: Wire) {
    if (!this.child || this.fatal) throw this.fatal ?? new Error('Codex 未启动');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  private fail(error: Error) {
    if (this.stopping) return;
    this.finishStreams();
    this.fatal = error;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.emit('failure', error);
  }
  request(method: string, params: unknown = {}, timeout = 60000): Promise<any> {
    return new Promise((resolve, reject) => {
      const key = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Codex 请求超时：${method}`));
      }, timeout);
      this.pending.set(key, { resolve, reject, timer });
      try {
        this.send({ id: key, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(e);
      }
    });
  }
  private async receive(message: Wire) {
    if (message.method && message.id !== undefined) {
      try {
        let result: unknown;
        if (message.method === 'item/tool/call') {
          if (!this.toolHandler) throw new Error('当前角色没有工具权限');
          const p = message.params;
          const item = {
            id: p.itemId ?? p.callId ?? `tool-${message.id}`,
            type: 'dynamicToolCall',
            tool: p.tool,
            arguments: p.arguments,
          };
          this.emit('notification', 'item/started', {
            threadId: p.threadId,
            turnId: p.turnId,
            item,
          });
          let value: unknown;
          try {
            value = await this.toolHandler(p.tool, p.arguments);
            this.emit('notification', 'item/completed', {
              threadId: p.threadId,
              turnId: p.turnId,
              item: { ...item, status: 'completed', result: value },
            });
          } catch (error) {
            this.emit('notification', 'item/completed', {
              threadId: p.threadId,
              turnId: p.turnId,
              item: { ...item, status: 'failed', error: String(error) },
            });
            throw error;
          }
          result = {
            success: true,
            contentItems: [{ type: 'inputText', text: JSON.stringify(value) }],
          };
        } else if (message.method.includes('requestApproval')) {
          // Never auto-grant sandbox escapes. Technical work continues inside the configured workspace.
          result =
            message.method === 'item/permissions/requestApproval'
              ? { permissions: {}, scope: 'turn' }
              : { decision: 'decline' };
          this.emit('approval', message.params);
        } else if (message.method === 'item/tool/requestUserInput') {
          const questions = message.params.questions ?? [];
          if (this.userInputHandler) {
            const answers: Record<string, { answers: string[] }> = {};
            for (const q of questions) {
              const answer = await this.userInputHandler({
                id: String(q.id),
                method: 'input',
                title: String(q.header ?? q.question ?? 'Codex input'),
                message: typeof q.question === 'string' ? q.question : undefined,
                options: Array.isArray(q.options)
                  ? q.options.map((option: any) => String(option.label ?? option))
                  : undefined,
              });
              if (typeof answer === 'object' && answer !== null && 'value' in answer)
                answers[q.id] = { answers: [String(answer.value)] };
              else if (
                typeof answer === 'string' ||
                typeof answer === 'number' ||
                typeof answer === 'boolean'
              )
                answers[q.id] = { answers: [String(answer)] };
              else answers[q.id] = { answers: [] };
            }
            result = { answers };
          } else {
            result = {
              answers: Object.fromEntries(
                questions.map((q: any) => [
                  q.id,
                  {
                    answers: [
                      'Use the delegated PM tool for technical questions; describe unresolved product questions in your final response. No additional permission is granted.',
                    ],
                  },
                ]),
              ),
            };
          }
        } else throw new Error(`不支持的服务器请求：${message.method}`);
        this.send({ id: message.id, result });
      } catch (e) {
        this.send({
          id: message.id,
          result: {
            success: false,
            contentItems: [{ type: 'inputText', text: redact(String(e)) }],
          },
        });
      }
    } else if (message.id !== undefined) {
      const p = this.pending.get(Number(message.id));
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(Number(message.id));
      if (message.error) p.reject(new Fault(message.error.message, 502));
      else p.resolve(message.result);
    } else if (message.method) {
      if (message.method === 'thread/tokenUsage/updated') {
        const usage = usageFromCodexNotification(message.params);
        if (usage && isRecord(message.params) && typeof message.params.threadId === 'string') {
          const normalized = { ...message.params, usage };
          this.turnUsages.set(message.params.threadId, usage);
          this.emit('notification', message.method, normalized);
          return;
        }
      }
      this.emit('notification', message.method, message.params);
    }
  }
  async models(): Promise<Model[]> {
    const all: Model[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.request('model/list', { limit: 100, cursor });
      if (Array.isArray(response.data)) {
        all.push(
          ...response.data.map((entry: unknown) => {
            const model = entry as Partial<Model>;
            return {
              id:
                typeof model.id === 'string'
                  ? model.id
                  : typeof model.model === 'string'
                    ? model.model
                    : '',
              model:
                typeof model.model === 'string'
                  ? model.model
                  : typeof model.id === 'string'
                    ? model.id
                    : '',
              displayName:
                typeof model.displayName === 'string'
                  ? model.displayName
                  : typeof model.id === 'string'
                    ? model.id
                    : '',
              supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
                ? model.supportedReasoningEfforts.filter(
                    (effort): effort is { reasoningEffort: string } =>
                      isRecord(effort) && typeof effort.reasoningEffort === 'string',
                  )
                : [],
              provider: typeof model.provider === 'string' ? model.provider : undefined,
              reasoning: model.reasoning === true,
              raw: entry,
            };
          }),
        );
      }
      cursor = response.nextCursor ?? undefined;
    } while (cursor);
    return all;
  }
  async validate(profile: Profile) {
    // Discovery is advisory for custom upstreams; thread setup still verifies effective configuration.
    if (this.customProvider) return;
    const model = (await this.models()).find(
      (m) => m.model === profile.model || m.id === profile.model,
    );
    if (!model) throw new Fault(`模型不可用：${profile.model}`, 409);
    if (!model.supportedReasoningEfforts.some((x) => x.reasoningEffort === profile.effort))
      throw new Fault(`模型不支持推理档位：${profile.model} / ${profile.effort}`, 409);
  }
  async thread(options: AgentThreadOptions) {
    await this.validate(options.profile);
    this.toolHandler = options.toolHandler;
    this.userInputHandler = options.onUserInput;
    const params = {
      cwd: options.cwd,
      model: options.profile.model,
      modelProvider: this.modelProvider,
      approvalPolicy: 'never',
      sandbox: options.writable ? 'workspace-write' : 'read-only',
      developerInstructions: options.instructions,
      config: { model_reasoning_effort: options.profile.effort, 'features.multi_agent': false },
      ...(options.tools?.length ? { dynamicTools: options.tools } : {}),
    };
    const result = options.threadId
      ? await this.request('thread/resume', { ...params, threadId: options.threadId })
      : await this.request('thread/start', {
          ...params,
          ephemeral: options.ephemeral ?? false,
          allowProviderModelFallback: false,
          serviceName: 'phantom-circuit',
        });
    // Resume has no allowProviderModelFallback field in the installed protocol.
    // Validate the effective model instead of relying on an ignored request field.
    if (result.model !== options.profile.model)
      throw new Fault(`实际模型与请求不一致：${result.model} / ${options.profile.model}`, 409);
    if (result.reasoningEffort !== options.profile.effort)
      throw new Fault(
        `实际推理档位与请求不一致：${result.reasoningEffort} / ${options.profile.effort}`,
        409,
      );
    if (result.modelProvider !== this.modelProvider)
      throw new Fault(
        `实际 Provider 与请求不一致：${result.modelProvider} / ${this.modelProvider}`,
        409,
      );
    return result.thread.id as string;
  }
  async turn(
    threadId: string,
    prompt: string,
    profile: Profile,
    signal?: AbortSignal,
    outputSchema?: unknown,
    onTurn?: (id: string) => void,
    imagePaths: string[] = [],
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let output = '';
      let turnId: string | undefined;
      let done = false;
      const timer = setTimeout(() => {
        void interrupt();
        finish(new Error('Agent 超过单次运行时限（45 分钟）'));
      }, 45 * 60_000);
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off('notification', notification);
        this.off('failure', failure);
        signal?.removeEventListener('abort', abort);
        this.finishStreams();
        this.activeTurns.delete(threadId);
        this.activeProfiles.delete(threadId);
        this.pendingAborts.delete(threadId);
        if (!error && turnId) {
          const usage = this.turnUsages.get(threadId);
          if (usage) this.completedTurnUsages.set(`${threadId}:${turnId}`, usage);
        }
        if (error) {
          this.rejectFollowUps(threadId, error);
          reject(error);
        } else {
          void this.drainFollowUps(threadId);
          resolve(this.scrubSecret(output));
        }
      };
      const interrupt = async () => {
        if (turnId) await this.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      };
      const abort = () => {
        void interrupt();
        finish(new Error('执行已暂停'));
      };
      const failure = (e: Error) => finish(e);
      const notification = (method: string, p: any) => {
        if (p.threadId !== threadId) return;
        if (turnId && (p.turnId ?? p.turn?.id) && (p.turnId ?? p.turn?.id) !== turnId) return;
        if (method === 'turn/started') {
          turnId = p.turn.id;
          this.activeTurns.set(threadId, turnId!);
          onTurn?.(turnId!);
        }
        if (method === 'item/agentMessage/delta') output += p.delta;
        if (method === 'item/completed' && p.item.type === 'agentMessage')
          output = p.item.text ?? output;
        if (method === 'turn/completed') {
          if (p.turn.status !== 'completed')
            finish(
              new CodexTurnError(
                p.turn.error?.message ?? `Agent ${p.turn.status}`,
                p.turn.status === 'interrupted' ? 'interrupted' : 'failed',
              ),
            );
          else finish();
        }
      };
      this.on('notification', notification);
      this.on('failure', failure);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      this.activeProfiles.set(threadId, profile);
      this.turnUsages.delete(threadId);
      void this.request('turn/start', {
        threadId,
        clientUserMessageId: randomUUID(),
        input: codexInput(prompt, imagePaths),
        model: profile.model,
        effort: profile.effort,
        ...(outputSchema ? { outputSchema } : {}),
      })
        .then((r) => {
          if (done) return;
          turnId = r.turn.id;
          this.activeTurns.set(threadId, turnId!);
          onTurn?.(turnId!);
          if (this.pendingAborts.delete(threadId)) void interrupt();
        })
        .catch(finish);
    });
  }
  /** Normalized session alias used by alternate Agent backends. */
  async createSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (!options.profile) throw new Fault('Codex 会话需要模型配置', 400);
    const id = await this.thread({
      cwd: options.cwd ?? process.cwd(),
      profile: { model: options.profile.model, effort: options.profile.effort },
      instructions: options.instructions ?? '',
      writable: options.writable ?? false,
      ephemeral: options.ephemeral,
      tools: options.tools,
      toolHandler: options.toolHandler
        ? (name, args) => options.toolHandler!(name, args)
        : undefined,
      onUserInput: options.onUserInput,
    });
    return this.codexSession(id, options);
  }

  async resumeSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (!options.profile) throw new Fault('Codex 会话需要模型配置', 400);
    const sessionId = options.sessionId ?? options.sessionPath;
    if (!sessionId) throw new Fault('恢复 Codex 会话需要 sessionId', 400);
    const id = await this.thread({
      cwd: options.cwd ?? process.cwd(),
      profile: { model: options.profile.model, effort: options.profile.effort },
      instructions: options.instructions ?? '',
      threadId: sessionId,
      writable: options.writable ?? false,
      tools: options.tools,
      toolHandler: options.toolHandler
        ? (name, args) => options.toolHandler!(name, args)
        : undefined,
      onUserInput: options.onUserInput,
    });
    return this.codexSession(id, options);
  }

  async prompt(
    sessionId: string,
    message: string,
    options: AgentPromptOptions = {},
  ): Promise<AgentTurnResult> {
    if (!options.profile) throw new Fault('Codex prompt 需要模型配置', 400);
    let actualTurnId: string = randomUUID();
    try {
      const text = await this.turn(
        sessionId,
        message,
        { model: options.profile.model, effort: options.profile.effort },
        options.signal,
        options.outputSchema,
        (id) => {
          actualTurnId = id;
          options.onTurn?.(id);
        },
        options.imagePaths ?? [],
      );
      const usageKey = `${sessionId}:${actualTurnId}`;
      const usage = this.completedTurnUsages.get(usageKey) ?? this.turnUsages.get(sessionId);
      this.completedTurnUsages.delete(usageKey);
      return { sessionId, turnId: actualTurnId, text, status: 'completed', usage };
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async steer(sessionId: string, message: string, options: AgentPromptOptions = {}): Promise<void> {
    const activeTurnId = this.activeTurns.get(sessionId);
    if (!activeTurnId) throw new Fault('Codex 会话没有可 steer 的运行中回合', 409);
    if (options.expectedTurnId && options.expectedTurnId !== activeTurnId)
      throw new Fault(`Codex steer 的 expectedTurnId 已过期：${options.expectedTurnId}`, 409);
    await this.request('turn/steer', {
      threadId: sessionId,
      expectedTurnId: options.expectedTurnId ?? activeTurnId,
      clientUserMessageId: options.clientUserMessageId ?? randomUUID(),
      input: codexInput(message, options.imagePaths ?? [], options.images),
    });
  }

  async reconcileSteer(
    sessionId: string,
    clientUserMessageId: string,
  ): Promise<AgentSteerReconciliation> {
    if (!clientUserMessageId) return 'unknown';
    try {
      const response = await this.request('thread/read', {
        threadId: sessionId,
        includeTurns: true,
      });
      const thread = response?.thread;
      if (!isRecord(thread) || !Array.isArray(thread.turns)) return 'unknown';
      let complete = true;
      for (const turn of thread.turns) {
        if (!isRecord(turn) || turn.itemsView !== 'full' || !Array.isArray(turn.items)) {
          complete = false;
          continue;
        }
        for (const item of turn.items) {
          if (
            isRecord(item) &&
            item.type === 'userMessage' &&
            item.clientId === clientUserMessageId
          )
            return 'accepted';
        }
      }
      return complete ? 'not_accepted' : 'unknown';
    } catch {
      // A lost process or incomplete history cannot prove either outcome.
      return 'unknown';
    }
  }

  async followUp(
    sessionId: string,
    message: string,
    options: AgentPromptOptions = {},
  ): Promise<void> {
    if (!this.activeTurns.has(sessionId) && !this.activeProfiles.has(sessionId))
      throw new Fault('Codex followUp 只能在运行中的回合中排队', 409);
    if (options.signal?.aborted) throw new CodexTurnError('执行已暂停', 'interrupted');
    const profile = options.profile ?? this.activeProfiles.get(sessionId);
    if (!profile) throw new Fault('Codex followUp 缺少当前模型配置', 400);
    return new Promise<void>((resolve, reject) => {
      const queue = this.followUpQueues.get(sessionId) ?? [];
      queue.push({
        message,
        options,
        profile: { model: profile.model, effort: profile.effort },
        resolve,
        reject,
      });
      this.followUpQueues.set(sessionId, queue);
    });
  }

  private rejectFollowUps(threadId: string, error: unknown): void {
    const queue = this.followUpQueues.get(threadId);
    if (!queue) return;
    this.followUpQueues.delete(threadId);
    const reason = error instanceof Error ? error : new Error(String(error));
    for (const item of queue) item.reject(reason);
  }

  private async drainFollowUps(threadId: string): Promise<void> {
    if (this.drainingFollowUps.has(threadId)) return;
    const queue = this.followUpQueues.get(threadId);
    if (!queue?.length) {
      this.followUpQueues.delete(threadId);
      return;
    }
    this.drainingFollowUps.add(threadId);
    try {
      while (queue.length) {
        const item = queue.shift()!;
        try {
          await this.prompt(threadId, item.message, {
            ...item.options,
            profile: item.profile,
          });
          item.resolve();
        } catch (error) {
          item.reject(error instanceof Error ? error : new Error(String(error)));
          const reason = error instanceof Error ? error : new Error(String(error));
          while (queue.length) queue.shift()!.reject(reason);
          break;
        }
      }
    } finally {
      this.followUpQueues.delete(threadId);
      this.drainingFollowUps.delete(threadId);
    }
  }

  async abort(sessionId: string): Promise<void> {
    const turnId = this.activeTurns.get(sessionId);
    if (!turnId) {
      if (this.activeProfiles.has(sessionId)) this.pendingAborts.add(sessionId);
      return;
    }
    await this.request('turn/interrupt', { threadId: sessionId, turnId }).catch(() => {});
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  async modelCapabilities(): Promise<AgentModelCapability[]> {
    return (await this.models()).map((model) => ({
      id: model.model || model.id,
      model: model.model || model.id,
      provider: this.modelProvider,
      displayName: model.displayName,
      reasoning: model.supportedReasoningEfforts.length > 0,
      supportedReasoningEfforts: model.supportedReasoningEfforts,
      reasoningEfforts: model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort),
      raw: model,
    }));
  }

  async accountAllowance(): Promise<AgentAllowance> {
    if (!this.child) throw new Fault('Codex 未启动', 503);
    let accountResponse: any;
    try {
      accountResponse = await this.request('account/read', { refreshToken: false });
    } catch (error) {
      return allowanceFailure(error, 'account/read');
    }
    const account = isRecord(accountResponse?.account) ? accountResponse.account : undefined;
    if (!account && accountResponse?.requiresOpenaiAuth === true)
      return {
        status: 'authentication_error',
        error: 'Codex 账户未认证或认证已失效',
        code: 'authentication_error',
      };
    const result: AgentAllowance = {
      status: 'available',
      account: account
        ? {
            type: typeof account.type === 'string' ? account.type : 'unknown',
            planType: typeof account.planType === 'string' ? account.planType : undefined,
          }
        : undefined,
    };
    try {
      const rateLimits = await this.request('account/rateLimits/read', {});
      result.rateLimits = mapRateLimits(rateLimits);
    } catch (error) {
      return allowanceFailure(error, 'account/rateLimits/read');
    }
    try {
      const usage = await this.request('account/usage/read', {});
      result.usage = mapAllowanceUsage(usage);
    } catch (error) {
      return allowanceFailure(error, 'account/usage/read');
    }
    return result;
  }

  async probe(): Promise<AgentProbeResult> {
    const wasStarted = this.child !== undefined;
    if (!wasStarted) await this.start();
    try {
      const allowance = await this.accountAllowance();
      return {
        backend: 'codex',
        version: this.version,
        protocol: 'codex-app-server',
        models: await this.modelCapabilities(),
        capabilities: {
          sessions: true,
          streaming: true,
          steering: true,
          followUp: true,
          abort: true,
          images: true,
          hostTools: true,
          usage: true,
          accountAllowance: true,
          modelListing: true,
          nestedAgents: false,
          extensions: false,
          rules: false,
          skills: false,
        },
        allowance,
      };
    } finally {
      if (!wasStarted) await this.stop();
    }
  }

  private codexSession(id: string, options: AgentSessionOptions): AgentSession {
    return {
      id,
      sessionId: id,
      prompt: (message, promptOptions = {}) =>
        this.prompt(id, message, {
          ...promptOptions,
          profile: promptOptions.profile ?? options.profile,
        }),
      steer: (message, promptOptions = {}) => this.steer(id, message, promptOptions),
      followUp: (message, promptOptions = {}) => this.followUp(id, message, promptOptions),
      reconcileSteer: (clientUserMessageId) => this.reconcileSteer(id, clientUserMessageId),
      abort: () => this.abort(id),
      dispose: () => this.dispose(),
      on: (event, listener) => this.on(event, listener),
      off: (event, listener) => this.off(event, listener),
    };
  }

  async stop() {
    this.finishStreams();
    const stopped = new Error('Codex 已停止');
    for (const threadId of this.followUpQueues.keys()) this.rejectFollowUps(threadId, stopped);
    if (this.child) {
      this.stopping = true;
      await terminate(this.child);
      this.child = undefined;
      this.activeTurns.clear();
      this.activeProfiles.clear();
      this.turnUsages.clear();
      this.completedTurnUsages.clear();
      this.pendingAborts.clear();
      this.fatal = undefined;
      this.stopping = false;
    }
  }
}
