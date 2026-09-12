import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Store, Fault, redact } from './store.ts';
import { Engine } from './engine.ts';
import { Previews } from './preview.ts';
import { Codex } from './codex.ts';
import { commandSchema, limit, settingsSchema } from './schemas.ts';

export function createApp(store: Store, engine: Engine, previews: Previews, port = 4317) {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, forceCloseConnections: true });
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    '127.0.0.1:5173',
    'localhost:5173',
  ]);
  app.setErrorHandler((error, _req, reply) => {
    const status = error instanceof Fault ? error.status : error instanceof z.ZodError ? 400 : 500;
    reply
      .code(status)
      .send({ error: redact(error instanceof Error ? error.message : String(error)) });
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
  app.get('/api/state', async () => store.snapshot());
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
  app.post('/api/projects', async (req) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(100),
        description: z.string().max(3000).default(''),
      })
      .strict()
      .parse(req.body);
    return store.createProject(b.name, b.description);
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
    const b = z
      .object({
        content: z.string().trim().min(1).max(30000),
        intent: z.enum(['discuss', 'implement', 'feedback']),
      })
      .strict()
      .parse(req.body);
    const m = store.addMessage(id, 'user', b.content, b.intent);
    void engine
      .chat(m)
      .catch((e) =>
        store.addMessage(id, 'system', `PM 暂未完成本次响应：${String(e)}。你可以重试该消息。`),
      );
    reply.code(202);
    return m;
  });
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
  app.patch('/api/settings', async (req) => store.saveSettings(settingsSchema.parse(req.body)));
  app.get('/api/health', async () => {
    const results = await Promise.allSettled([
      engine.github.identity(),
      (async () => {
        const c = new Codex();
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
