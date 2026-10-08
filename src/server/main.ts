import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Store } from './store.ts';
import { GitHub } from './github.ts';
import { Workspaces } from './workspaces.ts';
import { Engine } from './engine.ts';
import { Previews } from './preview.ts';
import { createApp } from './app.ts';
import { resolveDataDirectory } from './data-directory.ts';
import { bootstrapAgentSettings } from './agent-settings.ts';
import { startupOptions } from './logging.ts';
import { bounded } from './redaction.ts';

const options = startupOptions();
let ownership: Awaited<ReturnType<typeof resolveDataDirectory>> | undefined;
let store: Store | undefined;
let engine: Engine | undefined;
let previews: Previews | undefined;
let app: ReturnType<typeof createApp> | undefined;
try {
  ownership = await resolveDataDirectory(
    options.dataDir ? { dataDir: options.dataDir, legacyDir: options.dataDir } : {},
  );
  const dataDir = ownership.dataDir;
  await mkdir(dataDir, { recursive: true });
  const configPath = join(dataDir, 'config.json');
  let config: { port: number };
  try {
    config = z
      .object({ port: z.number().int().min(1024).max(65535) })
      .parse(JSON.parse(await readFile(configPath, 'utf8')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    config = { port: 4317 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
  }
  store = new Store(join(dataDir, 'phantom.sqlite'));
  await bootstrapAgentSettings(store);
  const github = new GitHub(store);
  const workspaces = new Workspaces(ownership.workspaceRoot, store, {
    ...(ownership.legacyWorkspaceRoot ? { legacyRoots: [ownership.legacyWorkspaceRoot] } : {}),
    taskRoots: ownership.taskRoots,
  });
  engine = new Engine(store, github, workspaces, dataDir);
  previews = new Previews(store, workspaces);
  app = createApp(store, engine, previews, config.port, undefined, undefined, {
    logger: options.logger,
  });
  app.log.info({ dataDir, port: config.port }, 'starting Phantom Circuit');
  // Bind before recovering or scheduling: a second instance must not touch running task state.
  await app.listen({ host: '127.0.0.1', port: config.port });
  await engine.start();
  store.changes.on('delivery', (repoId: string) => {
    if (store!.repo(repoId).commands.start)
      void previews!
        .start(repoId)
        .catch((e) =>
          store!.event('preview', String(e), { projectId: store!.repo(repoId).projectId }),
        );
  });
  app.log.info({ url: `http://127.0.0.1:${config.port}` }, 'Phantom Circuit ready');
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    app!.log.info('stopping Phantom Circuit');
    try {
      await engine!.stop();
      await previews!.close();
      await app!.close();
      store!.close();
      app!.log.info('Phantom Circuit stopped');
    } catch (error) {
      app!.log.error({ err: error }, 'shutdown failed');
      process.exitCode = 1;
    } finally {
      await ownership!.release();
    }
  }
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
} catch (error) {
  if (app) app.log.fatal({ err: error }, 'startup failed');
  else
    console.error(
      bounded(error instanceof Error ? (error.stack ?? error.message) : String(error), 6000),
    );
  await engine?.stop().catch(() => {});
  await previews?.close().catch(() => {});
  await app?.close().catch(() => {});
  store?.close();
  await ownership?.release();
  process.exitCode = 1;
}
