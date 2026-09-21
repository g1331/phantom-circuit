import { mkdir, chmod, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, Fault, now, redact } from './store.ts';
import { command } from './process.ts';
import {
  officialProvider,
  type AccountAllowance,
  type AgentKind,
  type PriceCard,
  type Provider,
  type ModelDiscovery,
} from '../shared/types.ts';
import { Codex } from './codex.ts';
import { settingsSchema } from './schemas.ts';
import type { Settings } from '../shared/types.ts';
import type {
  AgentAllowance,
  AgentBackend,
  AgentModelCapability,
  AgentProbeResult,
} from './agent-backend.ts';

const fields = {
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().max(2048),
  apiKey: z
    .string()
    .max(16384)
    .refine((s) => !/[\r\n\0]/.test(s), '密钥包含无效字符'),
};
const createSchema = z.object(fields).strict();
const editSchema = createSchema.partial();

const decimal = z.union([z.string(), z.number()]).refine((value) => {
  const text = typeof value === 'number' ? String(value) : value.trim();
  return text.length <= 256 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text);
}, '价格必须是非负十进制数');
const priceCardSchema = z
  .object({
    currency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/, '货币必须是三位大写代码'),
    inputPerMillion: decimal.optional(),
    outputPerMillion: decimal.optional(),
    cachedInputPerMillion: decimal.optional(),
    cacheWritePerMillion: decimal.optional(),
    reasoningOutputPerMillion: decimal.optional(),
    inputPerToken: decimal.optional(),
    outputPerToken: decimal.optional(),
    cachedInputPerToken: decimal.optional(),
    cacheWritePerToken: decimal.optional(),
    reasoningOutputPerToken: decimal.optional(),
    version: z.string().max(256).optional(),
    source: z.string().max(1000).optional(),
  })
  .strict();
const pricesSchema = z
  .object({
    prices: z.record(z.string().trim().min(1).max(256), priceCardSchema),
  })
  .strict();

export type ProviderPrices = Record<string, PriceCard>;

export interface AgentRuntimeFactories {
  codex: () => AgentBackend;
  omp: () => AgentBackend;
}

export interface PublicAgentModel {
  id: string;
  provider?: string;
  displayName?: string;
  reasoning?: boolean;
  reasoningEfforts: string[];
  contextWindow?: number | null;
}

export interface AgentProbeResponse {
  backend: string;
  protocol?: string;
  protocolVersion?: number;
  version?: string;
  models: PublicAgentModel[];
  capabilities: AgentProbeResult['capabilities'];
  allowance?: AgentAllowance;
}

type NormalizedAllowance = AccountAllowance & {
  status: AccountAllowance['state'] | 'unknown';
  stale?: boolean;
  error?: string;
};

function baseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Fault('请输入有效的 http/https base URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Fault('base URL 只允许 http/https，不能包含凭据、查询参数或片段');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/responses$/, '');
  return url.toString().replace(/\/+$/, '');
}

// This module is the only persistent credential reader/writer. Metadata never contains keys.
export class Providers {
  private readonly directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private store: Store,
    private createCodex: () => Codex = () => new Codex(),
  ) {
    this.directory =
      store.file === ':memory:'
        ? resolve('.phantom', 'ephemeral-secrets', randomUUID())
        : join(dirname(store.file), 'secrets');
  }
  list(): Provider[] {
    return [{ ...officialProvider }, ...this.store.list('provider')];
  }
  get(id: string): Provider {
    const provider = this.list().find((p) => p.id === id);
    if (!provider) throw new Fault('Provider 不存在', 404);
    return provider;
  }
  private custom(id: string) {
    const provider = this.get(id);
    if (provider.kind !== 'custom')
      throw new Fault('Codex 官方登录不可修改或删除，也不提供凭据显示');
    return provider;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  private async secureDirectory() {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (process.platform === 'win32') {
        const identity = await command('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
        const sid = identity.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
        if (!sid) throw new Error('No host identity');
        await command('icacls.exe', [
          this.directory,
          '/inheritance:r',
          '/grant:r',
          `*${sid}:(OI)(CI)F`,
        ]);
        // Verify the effective DACL, including unexpected explicit grants on an existing directory.
        const literal = this.directory.replaceAll("'", "''");
        const verified = await command('pwsh.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$a = Get-Acl -LiteralPath '${literal}'; if (-not $a.AreAccessRulesProtected) { exit 1 }; $rules = $a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]); foreach ($r in $rules) { if ($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -ne '${sid}') { exit 1 } }; if (-not ($rules | Where-Object { $_.IdentityReference.Value -eq '${sid}' -and $_.AccessControlType -eq 'Allow' })) { exit 1 }`,
        ]);
        if (verified.code !== 0) throw new Error('Invalid secret ACL');
      } else await chmod(this.directory, 0o700);
    } catch {
      throw new Fault('无法限制秘密存储的宿主账户访问权限', 503);
    }
  }
  private async write(id: string, key: string) {
    await this.secureDirectory();
    const temp = join(this.directory, randomUUID() + '.tmp');
    try {
      await writeFile(temp, key, { mode: 0o600, flag: 'wx' });
      await rename(temp, join(this.directory, id));
    } catch {
      await unlink(temp).catch(() => {});
      throw new Fault('无法保存 Provider 密钥', 503);
    }
  }
  async reveal(id: string): Promise<string> {
    this.custom(id);
    try {
      return await readFile(join(this.directory, id), 'utf8');
    } catch {
      throw new Fault('Provider 密钥不可用，请重新保存', 409);
    }
  }
  async connection(id: string) {
    const provider = this.get(id);
    return provider.kind === 'codex'
      ? undefined
      : {
          id: provider.id,
          baseUrl: provider.baseUrl!,
          apiKey: await this.reveal(id),
        };
  }
  modelPrice(id: string, model: string): PriceCard | undefined {
    const provider = this.get(id) as Provider & { prices?: ProviderPrices };
    return structuredClone(provider.prices?.[model] ?? provider.price);
  }
  saveAssignments(input: unknown, projectId?: string) {
    return this.serial(async () => {
      const settings = projectId === undefined ? settingsSchema.parse(input) : undefined;
      const profiles: Settings['profiles'] =
        settings?.profiles ?? settingsSchema.shape.profiles.parse(input);
      if (projectId !== undefined) this.store.project(projectId);
      const warnings: string[] = [];
      const cwd = resolve(dirname(this.directory), 'profile-validation');
      await mkdir(cwd, { recursive: true });
      const discoveries = new Map<string, ModelDiscovery>();
      const checked = new Set<string>();
      for (const [role, profile] of Object.entries(profiles)) {
        const provider = this.get(profile.providerId);
        if (provider.kind === 'codex' && profile.customModel)
          throw new Fault(`${role}: 官方 Provider 必须从模型列表选择`, 409);
        if (provider.kind === 'custom') {
          if (!discoveries.has(provider.id))
            discoveries.set(provider.id, await this.models(provider.id));
          const discovery = discoveries.get(provider.id)!;
          const model = discovery.ok
            ? discovery.models.find((m) => m.id === profile.model)
            : undefined;
          if (!model && !profile.customModel)
            throw new Fault(
              `${role}: ${discovery.ok ? '模型不在发现列表中' : discovery.error}；请明确选择“自定义模型 ID”`,
              409,
            );
          if (model?.reasoningEfforts && !model.reasoningEfforts.includes(profile.effort))
            throw new Fault(`${role}: 模型不支持推理档位 ${profile.effort}`, 409);
          warnings.push(
            `${role}: ${provider.name} / ${profile.model} 未完成运行时验证；${discovery.ok ? '' : discovery.error + '；'}此配置将在首次 Run 验证上游兼容性`,
          );
        }
        const key = JSON.stringify([profile.providerId, profile.model, profile.effort]);
        if (checked.has(key)) continue;
        const codex = this.createCodex();
        try {
          await codex.start(await this.connection(provider.id));
          await codex.thread({
            cwd,
            profile,
            writable: false,
            ephemeral: true,
            instructions: 'Validate effective configuration only. Do not execute a turn.',
          });
          checked.add(key);
        } catch (error) {
          throw new Fault(
            `${role}: 配置校验失败：${error instanceof Fault ? error.message : '无法启动或连接 Codex app-server，请检查 Provider 与本机 Codex'}`,
            409,
          );
        } finally {
          await codex.stop();
        }
      }
      const saved = settings
        ? this.store.saveSettings(settings)
        : this.store.saveProjectProfiles(projectId!, profiles);
      return { ...saved, warnings };
    });
  }
  async models(id: string): Promise<ModelDiscovery> {
    const provider = this.get(id);
    if (provider.kind === 'codex') {
      const codex = this.createCodex();
      try {
        await codex.start();
        return {
          ok: true,
          models: (await codex.models()).map((m) => ({
            id: m.model,
            reasoningEfforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
          })),
        };
      } catch {
        return {
          ok: false,
          code: 'connection',
          error: '无法获取 Codex 官方模型，请检查本机 Codex 登录与连接',
        };
      } finally {
        await codex.stop();
      }
    }
    const key = await this.reveal(id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const failure = (code: string, error: string): ModelDiscovery => ({ ok: false, code, error });
    try {
      const response = await fetch(provider.baseUrl + '/models', {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        redirect: 'manual',
        signal: controller.signal,
      });
      if ([401, 403].includes(response.status))
        return failure('authentication', '认证失败，请检查 API key 与上游权限');
      if ([404, 405, 501].includes(response.status))
        return failure('unsupported', '上游不支持模型列表，请手工填写模型 ID');
      if (response.status >= 300 && response.status < 400)
        return failure('redirect', '模型发现不接受重定向，请检查 base URL');
      if (!response.ok) return failure('connection', '上游连接失败，请稍后重试');
      const reader = response.body?.getReader();
      if (!reader) return failure('invalid_response', '上游模型列表响应无效');
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1024 * 1024) return failure('too_large', '模型列表响应超过 1 MiB 限制');
        chunks.push(chunk.value);
      }
      let data: unknown;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return failure('invalid_response', '上游模型列表不是有效 JSON');
      }
      const result = z
        .object({
          data: z.array(
            z.object({
              id: z.string().trim().min(1).max(256),
              reasoningEfforts: z
                .array(z.string().trim().min(1).max(100))
                .min(1)
                .max(32)
                .optional(),
            }),
          ),
        })
        .safeParse(data);
      if (
        !result.success ||
        result.data.data.some(
          (m) => m.id.includes(key) || m.reasoningEfforts?.some((e) => e.includes(key)),
        )
      )
        return failure('invalid_response', '上游模型列表格式无效');
      return {
        ok: true,
        models: [...new Map(result.data.data.map((m) => [m.id, m])).values()],
      };
    } catch {
      return controller.signal.aborted
        ? failure('timeout', '模型发现超过 10 秒，请重试或手工填写模型 ID')
        : failure('connection', '无法连接上游，请检查 base URL 与网络');
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
  save(input: unknown, id?: string): Promise<Provider> {
    return this.serial(async () => {
      const old = id === undefined ? undefined : this.custom(id);
      // Do not surface schema diagnostics containing user-supplied credential values.
      const parsed = (old ? editSchema : createSchema).safeParse(input);
      if (!parsed.success)
        throw new Fault('Provider 字段无效：请填写名称、base URL 和有效 API key');
      const data = parsed.data;
      const name = data.name ?? old!.name;
      if (this.list().some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase()))
        throw new Fault('Provider 名称已存在', 409);
      const url = data.baseUrl === undefined ? old!.baseUrl! : baseUrl(data.baseUrl);
      if (!old && !data.apiKey) throw new Fault('请填写 API key');
      const provider: Provider = {
        id: id ?? randomUUID(),
        kind: 'custom',
        name,
        baseUrl: url,
        hasKey: true,
        ...((old as (Provider & { prices?: ProviderPrices }) | undefined)?.prices
          ? {
              prices: structuredClone(
                (old as Provider & { prices?: ProviderPrices }).prices,
              ) as ProviderPrices,
            }
          : {}),
      };
      if (data.apiKey) await this.write(provider.id, data.apiKey);
      this.store.put('provider', provider.id, provider);
      this.store.changes.emit('change');
      return provider;
    });
  }
  savePrices(id: string, input: unknown): Promise<Provider> {
    return this.serial(async () => {
      const provider = this.custom(id);
      const parsed = pricesSchema.safeParse(input);
      if (!parsed.success) throw new Fault('Provider 模型价格无效');
      const next = {
        ...provider,
        prices: structuredClone(parsed.data.prices) as ProviderPrices,
      };
      this.store.put('provider', id, next);
      this.store.changes.emit('change');
      return next;
    });
  }
  remove(id: string) {
    return this.serial(async () => {
      this.custom(id);
      this.store.assertProviderUnused(id);
      try {
        await unlink(join(this.directory, id));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new Fault('无法删除 Provider 密钥', 503);
      }
      this.store.deleteProvider(id);
      return { ok: true };
    });
  }
}

function publicModel(model: AgentModelCapability): PublicAgentModel {
  const id = model.id || model.model;
  return {
    id,
    ...(model.provider ? { provider: model.provider } : {}),
    ...(model.displayName ? { displayName: model.displayName } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    reasoningEfforts: [...new Set(model.reasoningEfforts)],
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
  };
}

function safeAgentAllowance(value: AgentAllowance): AgentAllowance {
  return {
    status: value.status,
    ...(value.account
      ? {
          account: {
            type: value.account.type,
            ...(value.account.planType ? { planType: value.account.planType } : {}),
          },
        }
      : {}),
    ...(value.rateLimits ? { rateLimits: structuredClone(value.rateLimits) } : {}),
    ...(value.usage ? { usage: structuredClone(value.usage) } : {}),
    ...(value.error ? { error: redact(value.error) } : {}),
    ...(value.code ? { code: value.code } : {}),
  };
}

function normalizedAllowance(
  agentKind: AgentKind,
  providerId: string,
  value: AgentAllowance,
): NormalizedAllowance {
  const safe = safeAgentAllowance(value);
  const exhausted = safe.status === 'available' && safe.rateLimits?.ordinaryUsageAllowed === false;
  const state: AccountAllowance['state'] =
    safe.status !== 'available' ? 'unavailable' : exhausted ? 'exhausted' : 'available';
  const resetAt = safe.rateLimits?.primary?.resetsAt ?? safe.rateLimits?.secondary?.resetsAt;
  return {
    providerId,
    agentKind,
    state,
    status: state,
    capturedAt: now(),
    ...(resetAt ? { resetAt } : {}),
    ...(safe.status !== 'available' && safe.error ? { error: safe.error } : {}),
  };
}

/** HTTP-facing adapter coordinator. It owns lifecycle, redaction and allowance throttling. */
export class AgentRuntime {
  private readonly allowanceRuns = new Map<string, Promise<unknown>>();
  private readonly allowanceAt = new Map<string, number>();
  private readonly allowanceCache = new Map<string, NormalizedAllowance>();
  private readonly throttleMs: number;

  constructor(
    private readonly store: Store,
    private readonly providers: Providers,
    private readonly factories: AgentRuntimeFactories,
    options: { allowanceThrottleMs?: number } = {},
  ) {
    this.throttleMs = options.allowanceThrottleMs ?? 10_000;
  }

  private make(agent: AgentKind): AgentBackend {
    return agent === 'codex' ? this.factories.codex() : this.factories.omp();
  }

  private async withBackend<T>(
    agent: AgentKind,
    providerId: string | undefined,
    work: (backend: AgentBackend) => Promise<T>,
  ): Promise<T> {
    const backend = this.make(agent);
    try {
      const connection =
        agent === 'codex' ? await this.providers.connection(providerId ?? 'codex') : undefined;
      await backend.start(connection);
      return await work(backend);
    } finally {
      await backend.stop().catch(() => {});
    }
  }

  async models(agent: AgentKind, providerId?: string) {
    const models = await this.withBackend(agent, providerId, (backend) =>
      backend.modelCapabilities(),
    );
    return models.map(publicModel);
  }

  async probe(agent: AgentKind, providerId?: string): Promise<AgentProbeResponse> {
    const result = await this.withBackend(agent, providerId, (backend) => backend.probe());
    return {
      backend: result.backend,
      ...(result.protocol ? { protocol: result.protocol } : {}),
      ...(result.protocolVersion !== undefined ? { protocolVersion: result.protocolVersion } : {}),
      ...(result.version ? { version: result.version } : {}),
      models: result.models.map(publicModel),
      capabilities: result.capabilities,
      ...(result.allowance ? { allowance: safeAgentAllowance(result.allowance) } : {}),
    };
  }

  async allowance(
    agent: AgentKind,
    providerId = agent === 'codex' ? 'codex' : 'omp',
    force = false,
  ): Promise<NormalizedAllowance> {
    const key = `${agent}:${providerId}`;
    const previous = this.store.accountAllowance(agent, providerId) ?? this.allowanceCache.get(key);
    const last = this.allowanceAt.get(key) ?? 0;
    if (!force && previous && Date.now() - last < this.throttleMs)
      return { ...structuredClone(previous), status: previous.state, stale: true };
    const running = this.allowanceRuns.get(key);
    if (running && !force) return (await running) as NormalizedAllowance;
    const refresh = (async () => {
      try {
        const value = await this.withBackend(
          agent,
          agent === 'codex' ? providerId : undefined,
          (backend) => backend.accountAllowance(),
        );
        const normalized = normalizedAllowance(agent, providerId, value);
        this.store.saveAccountAllowance(normalized);
        this.allowanceCache.set(key, normalized);
        this.allowanceAt.set(key, Date.now());
        return normalized;
      } catch (error) {
        this.allowanceAt.set(key, Date.now());
        const message = redact(error instanceof Error ? error.message : String(error));
        const stale = previous
          ? { ...structuredClone(previous), status: previous.state, stale: true, error: message }
          : {
              agentKind: agent,
              providerId,
              state: 'unknown' as const,
              status: 'unknown' as const,
              capturedAt: now(),
              stale: true,
              error: message,
            };
        this.allowanceCache.set(key, stale);
        return stale;
      }
    })();
    this.allowanceRuns.set(key, refresh);
    try {
      return (await refresh) as NormalizedAllowance;
    } finally {
      if (this.allowanceRuns.get(key) === refresh) this.allowanceRuns.delete(key);
    }
  }
}
