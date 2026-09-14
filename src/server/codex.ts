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
type Profile = Pick<Assignment, 'model' | 'effort'>;

export interface Model {
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
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export class Codex extends EventEmitter {
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
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (x: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private toolHandler?: (name: string, args: unknown) => Promise<unknown>;
  private fatal?: Error;
  private customProvider = false;
  private modelProvider = 'openai';
  private scrubSecret = (text: string) => text;
  private finishStreams = () => {};
  async start(provider?: { id: string; baseUrl: string; apiKey: string }) {
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
    try {
      this.child = this.launch(binary, args, {
        windowsHide: true,
        stdio: 'pipe',
        shell: false,
        env,
      });
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
    this.child.on('close', () => {
      this.finishStreams();
      deltas.dispose();
      completed.dispose();
      secret = '';
    });
    this.child.on('error', (e) => this.fail(e));
    this.child.on('exit', (code) => this.fail(new Error(`Codex 进程退出 (${code})`)));
    this.child.stdin.on('error', (e) => this.fail(e));
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
          const value = await this.toolHandler(message.params.tool, message.params.arguments);
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
          result = {
            answers: Object.fromEntries(
              (message.params.questions ?? []).map((q: any) => [
                q.id,
                {
                  answers: [
                    'Use the delegated PM tool for technical questions; describe unresolved product questions in your final response. No additional permission is granted.',
                  ],
                },
              ]),
            ),
          };
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
    } else if (message.method) this.emit('notification', message.method, message.params);
  }
  async models(): Promise<Model[]> {
    const all: Model[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.request('model/list', { limit: 100, cursor });
      all.push(...response.data);
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
  async thread(options: {
    cwd: string;
    profile: Profile;
    instructions: string;
    threadId?: string;
    writable: boolean;
    ephemeral?: boolean;
    tools?: ToolSpec[];
    toolHandler?: (name: string, args: unknown) => Promise<unknown>;
  }) {
    await this.validate(options.profile);
    this.toolHandler = options.toolHandler;
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
        error ? reject(error) : resolve(this.scrubSecret(output));
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
        if (method === 'turn/started') {
          turnId = p.turn.id;
          onTurn?.(turnId!);
        }
        if (method === 'item/agentMessage/delta') output += p.delta;
        if (method === 'item/completed' && p.item.type === 'agentMessage')
          output = p.item.text ?? output;
        if (method === 'turn/completed') {
          if (p.turn.status !== 'completed')
            finish(new Error(p.turn.error?.message ?? `Agent ${p.turn.status}`));
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
      void this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
        model: profile.model,
        effort: profile.effort,
        ...(outputSchema ? { outputSchema } : {}),
      })
        .then((r) => {
          turnId = r.turn.id;
          onTurn?.(turnId!);
        })
        .catch(finish);
    });
  }
  async stop() {
    this.finishStreams();
    if (this.child) await terminate(this.child);
  }
}
