import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { readFile } from 'node:fs/promises';
import { MessageImages, imageLimits } from './images.ts';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Store, Fault, redact } from './store.ts';
import { Engine } from './engine.ts';
import { Previews } from './preview.ts';
import { Codex } from './codex.ts';
import { OmpBackend } from './omp.ts';
import {
  AgentRuntime,
  Providers,
  type AgentProbeResponse,
  type AgentRuntimeFactories,
} from './providers.ts';
import { bootstrapAgentSettings } from './agent-settings.ts';
import {
  attachedHostDescriptor,
  renderHostMessage,
  requestHostLocale,
} from '../shared/host-messages.ts';
import type { AgentKind, ClarificationAnswer, ProfileMode, ProfileName } from '../shared/types.ts';
import type { AgentBackend } from './agent-backend.ts';
import { commandSchema, limit, profileSchema, profileSetSchema } from './schemas.ts';

type RuntimeEngineContract = Engine & {
  answerClarification(
    projectId: string,
    clarificationId: string,
    answers: ClarificationAnswer[],
  ): Promise<unknown>;
  cancelClarification(projectId: string, clarificationId: string): Promise<unknown>;
  resumeRecovery(projectId: string, recoveryId?: string): Promise<unknown>;
  cancelRecovery(projectId: string, recoveryId: string): Promise<unknown>;
  resolveIncident(
    projectId: string,
    incidentId: string,
    action: 'resolved' | 'paused' | 'waiting_user',
    guidance?: string,
  ): Promise<unknown>;
};

const profileNames: ProfileName[] = ['backend', 'frontend', 'fullstack', 'complex', 'pm', 'review'];
const profileModesSchema = z
  .object(
    Object.fromEntries(
      profileNames.map((name) => [name, z.enum(['inherit', 'pinned'])]),
    ) as unknown as Record<ProfileName, z.ZodType<ProfileMode>>,
  )
  .strict();
const agentSelectionSchema = z.union([
  z.object({ mode: z.literal('inherit') }).strict(),
  z.object({ mode: z.literal('override'), agent: z.enum(['omp', 'codex']) }).strict(),
]);
const runtimeSchema = z
  .object({
    agentSelection: agentSelectionSchema.optional(),
    profileModes: profileModesSchema.optional(),
    profiles: profileSetSchema.optional(),
    ompProfiles: profileSetSchema.optional(),
    secondaryReviewProfile: profileSchema.nullable().optional(),
    secondaryReviewProfiles: z
      .object({
        omp: profileSchema.nullable().optional(),
        codex: profileSchema.nullable().optional(),
      })
      .strict()
      .optional(),
    recoveryPolicy: z.enum(['automatic', 'manual']).optional(),
  })
  .strict();

function asRuntimeEngine(engine: Engine): RuntimeEngineContract {
  return engine as RuntimeEngineContract;
}

function nullableSecondary(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const next = { ...input };
  if (input.secondaryReviewProfile === null) next.secondaryReviewProfile = undefined;
  if (typeof next.secondaryReviewProfiles === 'object' && next.secondaryReviewProfiles !== null) {
    const profiles = next.secondaryReviewProfiles as Record<string, unknown>;
    next.secondaryReviewProfiles = Object.fromEntries(
      Object.entries(profiles).filter(([, profile]) => profile !== null),
    );
  }
  return next;
}

function routeLocale(req: {
  query?: unknown;
  headers: Record<string, string | string[] | undefined>;
}) {
  const query =
    typeof req.query === 'object' && req.query !== null
      ? (req.query as { locale?: unknown })
      : undefined;
  return requestHostLocale(query?.locale, req.headers['accept-language']);
}

function modelCountCoverage(usage: Record<string, unknown>) {
  const fields = [
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'cacheWriteTokens',
    'reasoningOutputTokens',
  ];
  return fields.filter((field) => usage[field] !== undefined);
}

export function createApp(
  store: Store,
  engine: Engine,
  previews: Previews,
  port = 4317,
  createCodex: () => Codex = () => new Codex(),
  createOmp: () => AgentBackend = () => new OmpBackend(),
) {
  const providers = new Providers(store, createCodex);
  const agents = new AgentRuntime(store, providers, {
    codex: createCodex,
    omp: createOmp,
  } satisfies AgentRuntimeFactories);
  // The hook is process-scoped and only replaces the untouched software seed. It never reads or
  // persists OMP credentials; API handlers below await it where settings need to be deterministic.
  const agentSettingsReady = bootstrapAgentSettings(store).catch(() => undefined);
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, forceCloseConnections: true });
  const images = new MessageImages(store, engine.dataDir);
  void app.register(multipart, { limits: imageLimits });
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    '127.0.0.1:5173',
    'localhost:5173',
  ]);
  app.setErrorHandler((error, req, reply) => {
    const code = (error as { code?: string }).code ?? '';
    const uploadStorageFailure =
      req.isMultipart() &&
      ['EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EBUSY', 'ENOTDIR', 'EEXIST'].includes(code);
    const uploadLimit = [
      'FST_REQ_FILE_TOO_LARGE',
      'FST_FILES_LIMIT',
      'FST_FIELDS_LIMIT',
      'FST_PARTS_LIMIT',
    ].includes(code);
    const providerRequest = req.url.startsWith('/api/providers');
    const status = uploadLimit
      ? 413
      : error instanceof Fault
        ? error.status
        : error instanceof z.ZodError ||
            (providerRequest && (error as { statusCode?: number }).statusCode === 400)
          ? 400
          : 500;
    const legacy = uploadStorageFailure
      ? '图片保存失败，请检查本地磁盘空间和权限后重试'
      : uploadLimit
        ? '上传超限：每条消息最多 4 张图片，每张不超过 10 MiB'
        : providerRequest && !(error instanceof Fault)
          ? 'Provider 请求无效，请检查输入或稍后重试'
          : redact(error instanceof Error ? error.message : String(error));
    const descriptor = uploadStorageFailure
      ? { code: 'upload_storage_failed', params: {}, legacy }
      : uploadLimit
        ? { code: 'upload_limit_exceeded', params: {}, legacy }
        : attachedHostDescriptor(error, status, legacy);
    const params = Object.fromEntries(
      Object.entries(descriptor.params ?? {}).map(([key, value]) => [
        key,
        typeof value === 'string' ? redact(value) : value,
      ]),
    );
    const safeDescriptor = {
      ...descriptor,
      params,
      ...(descriptor.detail ? { detail: redact(descriptor.detail) } : {}),
    };
    const locale = routeLocale(req);
    const message = renderHostMessage(safeDescriptor, locale);
    reply.code(status).send({
      code: safeDescriptor.code,
      params: safeDescriptor.params,
      error: legacy,
      message,
      detail: safeDescriptor.detail ?? legacy,
    });
  });
  app.addHook('onRequest', async (req, reply) => {
    if (!allowed.has(req.headers.host ?? '')) throw new Fault('不允许的 Host', 403);
    if (req.headers.origin) {
      let host: string;
      try {
        host = new URL(req.headers.origin).host;
      } catch {
        throw new Fault('无效 Origin', 403);
      }
      if (!allowed.has(host)) throw new Fault('不允许的跨站请求', 403);
    }
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY');
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (req.url === '/api/session' && req.method === 'GET') return;
    const cookie = (req.headers.cookie ?? '')
      .split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('phantom_session='))
      ?.slice('phantom_session='.length);
    if (
      !cookie ||
      cookie.length !== token.length ||
      !timingSafeEqual(Buffer.from(cookie), Buffer.from(token))
    )
      throw new Fault('本地会话已失效，请刷新页面', 401);
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-phantom-csrf'] !== csrf)
      throw new Fault('缺少本地操作校验', 403);
  });
  app.get('/api/session', async (_req, reply) => {
    reply.header('Set-Cookie', `phantom_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
    return { csrf };
  });
  app.get('/api/projects/:id/scheduling', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return store.explainScheduling(id);
  });
  app.post('/api/projects/:id/task-priority', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return store.setTaskPriority(id, req.body, { actor: 'user' });
  });
  app.get('/api/state', async () => {
    await agentSettingsReady;
    return store.snapshot();
  });
  const providerId = (params: unknown) => z.object({ id: z.string() }).parse(params).id;
  app.get('/api/providers', async () => providers.list());
  app.get('/api/providers/:id', async (req) => providers.get(providerId(req.params)));
  app.post('/api/providers', async (req) => providers.save(req.body));
  app.patch('/api/providers/:id', async (req) => providers.save(req.body, providerId(req.params)));
  app.delete('/api/providers/:id', async (req) => providers.remove(providerId(req.params)));
  app.post('/api/providers/:id/models', async (req) => providers.models(providerId(req.params)));
  app.patch('/api/providers/:id/prices', async (req) =>
    providers.savePrices(providerId(req.params), req.body),
  );
  app.post('/api/providers/:id/reveal-key', async (req) => {
    if (
      !z
        .object({})
        .strict()
        .safeParse(req.body ?? {}).success
    )
      throw new Fault('显示密钥请求不接受额外字段');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new Fault('不允许的跨站请求', 403);
    return { apiKey: await providers.reveal(providerId(req.params)) };
  });
  app.get('/api/events', async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (type: string, data: unknown) => {
      if (!reply.raw.destroyed)
        reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send('ready', {});
    const event = (data: unknown) => send('change', data);
    const change = () => send('change', {});
    const delta = (data: unknown) => send('delta', data);
    store.changes.on('event', event);
    store.changes.on('change', change);
    store.changes.on('delta', delta);
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n');
    }, 15000);
    reply.raw.on('close', () => {
      clearInterval(heartbeat);
      store.changes.off('event', event);
      store.changes.off('change', change);
      store.changes.off('delta', delta);
    });
  });
  const agentParam = (params: unknown): AgentKind =>
    z.object({ agent: z.enum(['omp', 'codex']) }).parse(params).agent;
  const agentQuery = (query: unknown) =>
    z
      .object({
        providerId: z.string().trim().min(1).max(100).optional(),
        force: z.enum(['1', 'true']).optional(),
        locale: z.string().trim().min(1).max(20).optional(),
      })
      .strict()
      .parse(query ?? {});
  const unavailable = (error: unknown) => ({
    available: false,
    ok: false,
    error: redact(error instanceof Error ? error.message : String(error)),
  });
  app.get('/api/agents/:agent/models', async (req) => {
    const agent = agentParam(req.params);
    const { providerId } = agentQuery(req.query);
    try {
      return { models: await agents.models(agent, providerId), available: true, ok: true };
    } catch (error) {
      if (error instanceof Fault && error.status < 500) throw error;
      return { models: [], ...unavailable(error) };
    }
  });
  app.get('/api/agents/:agent/probe', async (req) => {
    const agent = agentParam(req.params);
    const { providerId } = agentQuery(req.query);
    try {
      const result: AgentProbeResponse = await agents.probe(agent, providerId);
      return { available: true, ok: true, ...result };
    } catch (error) {
      if (error instanceof Fault && error.status < 500) throw error;
      return unavailable(error);
    }
  });
  const allowance = async (req: { params: unknown; query: unknown; body?: unknown }) => {
    const agent = agentParam(req.params);
    const query = agentQuery(req.query);
    const body =
      req.body === undefined
        ? {}
        : z.object({ force: z.boolean().optional() }).strict().parse(req.body);
    return agents.allowance(
      agent,
      query.providerId ?? (agent === 'codex' ? 'codex' : 'omp'),
      query.force === '1' || query.force === 'true' || body.force === true,
    );
  };
  app.get('/api/agents/:agent/allowance', allowance);
  app.post('/api/agents/:agent/allowance', allowance);
  app.post('/api/agents/:agent/allowance/refresh', allowance);
  app.post('/api/projects', async (req) => {
    await agentSettingsReady;
    const b = z
      .object({
        name: z.string().trim().min(1).max(100),
        description: z.string().max(3000).default(''),
      })
      .strict()
      .parse(req.body);
    return store.createProject(b.name, b.description);
  });
  app.patch('/api/projects/:id/profiles', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return providers.saveAssignments(req.body, id);
  });
  app.patch('/api/projects/:id/runtime', async (req) => {
    await agentSettingsReady;
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const parsed = runtimeSchema.parse(req.body);
    const warnings: string[] = [];
    if (parsed.profiles) {
      const saved = await providers.saveAssignments(parsed.profiles, id);
      warnings.push(...(saved.warnings ?? []));
    }
    if (parsed.ompProfiles) store.saveProjectOmpProfiles(id, parsed.ompProfiles);
    const {
      profiles: _profiles,
      ompProfiles: _ompProfiles,
      secondaryReviewProfile,
      secondaryReviewProfiles,
      ...runtime
    } = parsed;
    if (Object.keys(runtime).length || secondaryReviewProfile || secondaryReviewProfiles) {
      store.saveProjectRuntimeConfig(id, {
        ...runtime,
        ...(secondaryReviewProfile ? { secondaryReviewProfile } : {}),
        ...(secondaryReviewProfiles
          ? {
              secondaryReviewProfiles: Object.fromEntries(
                Object.entries(secondaryReviewProfiles).filter(([, profile]) => profile !== null),
              ),
            }
          : {}),
      });
    }
    if (secondaryReviewProfile === null) {
      const project = store.project(id);
      delete project.secondaryReviewProfile;
      store.put('project', id, project);
      store.changes.emit('change');
    }
    const project = store.project(id);
    return warnings.length ? { ...project, warnings } : project;
  });
  app.patch('/api/projects/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const p = store.project(id);
    const b = z
      .object({
        devLimit: limit.optional(),
        primaryRepoId: z.string().optional(),
        name: z.string().min(1).max(100).optional(),
      })
      .strict()
      .parse(req.body);
    if (b.primaryRepoId && store.repo(b.primaryRepoId).projectId !== id)
      throw new Fault('主仓库必须属于该项目');
    Object.assign(p, b);
    store.put('project', p.id, p);
    store.event('project', '项目配置已更新', { projectId: id });
    return p;
  });
  app.post('/api/repos', async (req) => {
    const b = z
      .object({
        projectId: z.string(),
        path: z.string().min(1),
        github: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
        authorized: z.boolean(),
      })
      .strict()
      .parse(req.body);
    store.project(b.projectId);
    const [remote, path] = await Promise.all([
      engine.github.inspect(b.github),
      engine.workspaces.inspect(b.path, b.github),
    ]);
    return store.createRepo({ ...b, path, name: remote.name, defaultBranch: remote.defaultBranch });
  });
  app.patch('/api/repos/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z
      .object({
        enabled: z.boolean().optional(),
        authorized: z.boolean().optional(),
        devLimit: limit.optional(),
        commands: commandSchema.optional(),
        requiredChecks: z.array(z.string()).optional(),
      })
      .strict()
      .parse(req.body);
    if (b.authorized === false && store.activeRuns().some((r) => r.repoId === id))
      throw new Fault('先暂停在途任务，再撤销授权');
    return store.patchRepo(id, { ...b, ...(b.authorized === false ? { enabled: false } : {}) });
  });
  app.post('/api/projects/:id/messages', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const m = req.isMultipart()
      ? await images.create(id, req.parts())
      : (() => {
          const b = z
            .object({
              content: z.string().trim().min(1).max(30000),
              intent: z.enum(['discuss', 'implement', 'feedback']),
              deliveryMode: z.enum(['queue', 'steer']).optional(),
            })
            .strict()
            .parse(req.body);
          return store.addMessage(id, 'user', b.content, b.intent, undefined, {
            deliveryMode: b.deliveryMode,
          });
        })();
    void engine
      .chat(m)
      .catch((e) =>
        store.addMessage(id, 'system', `PM 暂未完成本次响应：${String(e)}。你可以重试该消息。`),
      );
    reply.code(202);
    return m;
  });
  const answerSchema = z
    .object({
      answers: z
        .array(
          z
            .object({
              questionId: z.string().trim().min(1).max(100),
              value: z.union([z.string().max(10000), z.array(z.string().max(10000)).max(20)]),
            })
            .strict(),
        )
        .max(20),
    })
    .strict();
  const projectEntity = (
    kind: 'clarification' | 'recovery' | 'incident',
    projectId: string,
    id: string,
  ) => {
    const value = store.get(kind, id);
    if (!value) throw new Fault(`${kind} 不存在`, 404);
    if (value.projectId !== projectId) throw new Fault('跨项目操作被拒绝', 403);
    return value;
  };
  app.post('/api/projects/:projectId/clarifications/:id/answer', async (req) => {
    const { projectId, id } = z.object({ projectId: z.string(), id: z.string() }).parse(req.params);
    projectEntity('clarification', projectId, id);
    const { answers } = answerSchema.parse(req.body);
    return asRuntimeEngine(engine).answerClarification(projectId, id, answers);
  });
  app.post('/api/projects/:projectId/clarifications/:id/cancel', async (req) => {
    const { projectId, id } = z.object({ projectId: z.string(), id: z.string() }).parse(req.params);
    projectEntity('clarification', projectId, id);
    if (req.body !== undefined && req.body !== null) z.object({}).strict().parse(req.body);
    return asRuntimeEngine(engine).cancelClarification(projectId, id);
  });
  app.post('/api/projects/:projectId/recovery/resume', async (req) => {
    const { projectId } = z.object({ projectId: z.string() }).parse(req.params);
    const body = z
      .object({ id: z.string().optional() })
      .strict()
      .parse(req.body ?? {});
    if (body.id) projectEntity('recovery', projectId, body.id);
    return asRuntimeEngine(engine).resumeRecovery(projectId, body.id);
  });
  app.post('/api/projects/:projectId/recovery/:id/cancel', async (req) => {
    const { projectId, id } = z.object({ projectId: z.string(), id: z.string() }).parse(req.params);
    projectEntity('recovery', projectId, id);
    if (req.body !== undefined && req.body !== null) z.object({}).strict().parse(req.body);
    return asRuntimeEngine(engine).cancelRecovery(projectId, id);
  });
  app.post('/api/projects/:projectId/incidents/:id/resolve', async (req) => {
    const { projectId, id } = z.object({ projectId: z.string(), id: z.string() }).parse(req.params);
    projectEntity('incident', projectId, id);
    const body = z
      .object({
        action: z.enum(['resolved', 'paused', 'waiting_user']),
        guidance: z.string().trim().max(16000).optional(),
      })
      .strict()
      .parse(req.body);
    return asRuntimeEngine(engine).resolveIncident(projectId, id, body.action, body.guidance);
  });
  app.get('/api/tasks/:id/usage', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    store.task(id);
    const runs = store.list('run').filter((run) => run.taskId === id);
    const usage = store.taskUsage(id);
    const costs = store.taskCosts(id);
    const cost = costs.length === 1 ? costs[0] : undefined;
    const runCosts = Object.fromEntries(runs.map((run) => [run.id, store.runCost(run.id)]));
    const usageFields = modelCountCoverage(usage as Record<string, unknown>);
    const pricedFields = new Set(costs.flatMap((estimate) => estimate.coverage ?? []));
    const missing = usageFields.filter((field) => !pricedFields.has(field));
    const durationMs = runs.reduce((total, run) => {
      if (run.durationMs !== undefined) return total + Math.max(0, run.durationMs);
      if (!run.endedAt) return total;
      const duration = Date.parse(run.endedAt) - Date.parse(run.startedAt);
      return total + (Number.isFinite(duration) && duration > 0 ? duration : 0);
    }, 0);
    const started = runs
      .map((run) => Date.parse(run.startedAt))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b)[0];
    const ended = runs
      .map((run) => (run.endedAt ? Date.parse(run.endedAt) : Date.now()))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => b - a)[0];
    const elapsedMs =
      started === undefined || ended === undefined ? null : Math.max(0, ended - started);
    const available = usageFields.length - missing.length;
    return {
      usage,
      ...(cost ? { cost } : {}),
      costs,
      runCosts,
      runs,
      coverage: { available, total: usageFields.length, missing },
      durationMs,
      elapsedMs,
    };
  });
  app.get(
    '/api/projects/:projectId/messages/:messageId/images/:attachmentId',
    async (req, reply) => {
      const { projectId, messageId, attachmentId } = z
        .object({ projectId: z.string(), messageId: z.string(), attachmentId: z.string() })
        .parse(req.params);
      const { attachment, path } = images.locate(projectId, messageId, attachmentId);
      let data: Buffer;
      try {
        data = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Fault('图片不存在', 404);
        throw error;
      }
      return reply
        .header('Cache-Control', 'private, no-store')
        .type(attachment.mediaType)
        .send(data);
    },
  );
  app.post('/api/messages/:id/retry', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const m = store.get('message', id);
    if (!m || m.role !== 'user') throw new Fault('消息不存在', 404);
    void engine
      .chat(m)
      .catch((e) => store.addMessage(m.projectId, 'system', `PM 重试失败：${String(e)}`));
    return { queued: true };
  });
  app.post('/api/tasks/:id/:action', async (req) => {
    const { id, action } = z
      .object({ id: z.string(), action: z.enum(['pause', 'resume', 'cancel']) })
      .parse(req.params);
    if (action === 'resume') await engine.resume(id);
    else engine.control(id, action);
    return store.task(id);
  });
  app.patch('/api/settings', async (req) => {
    await agentSettingsReady;
    return providers.saveAssignments(nullableSecondary(req.body));
  });
  app.get('/api/health', async () => {
    const results = await Promise.allSettled([
      engine.github.identity(),
      (async () => {
        const c = createCodex();
        try {
          await c.start();
          return await c.models();
        } finally {
          await c.stop();
        }
      })(),
    ]);
    return {
      github:
        results[0].status === 'fulfilled'
          ? { ok: true, ...results[0].value }
          : { ok: false, error: redact(String(results[0].reason)) },
      codex:
        results[1].status === 'fulfilled'
          ? { ok: true, models: results[1].value }
          : { ok: false, error: redact(String(results[1].reason)) },
    };
  });
  app.post('/api/sync', async () => {
    await engine.sync();
    return { ok: true };
  });
  app.post('/api/repos/:id/preview/:action', async (req) => {
    const { id, action } = z
      .object({ id: z.string(), action: z.enum(['start', 'stop']) })
      .parse(req.params);
    store.repo(id);
    if (action === 'stop') {
      await previews.stop(id);
      return { ok: true };
    }
    void previews
      .start(id)
      .catch((e) => store.event('preview', String(e), { projectId: store.repo(id).projectId }));
    return { starting: true };
  });
  if (existsSync(resolve('dist/index.html'))) {
    void app.register(fastifyStatic, { root: resolve('dist'), prefix: '/' });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? reply.code(404).send({ error: '接口不存在' })
        : reply.sendFile('index.html'),
    );
  } else
    app.get('/', async (_req, reply) =>
      reply
        .type('text/plain')
        .send('Run npm run build, then restart. For development: npm run dev:web.'),
    );
  return app;
}
