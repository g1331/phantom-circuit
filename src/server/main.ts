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

const ownership = await resolveDataDirectory();
const dataDir = ownership.dataDir;
let store: Store | undefined;
let engine: Engine | undefined;
let previews: Previews | undefined;
let app: ReturnType<typeof createApp> | undefined;
try {
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
  app = createApp(store, engine, previews, config.port);
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
  console.log(`Phantom Circuit · http://127.0.0.1:${config.port}`);
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    try {
      await engine!.stop();
      await previews!.close();
      await app!.close();
      store!.close();
    } finally {
      await ownership.release();
      process.exit(0);
    }
  }
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
} catch (error) {
  await engine?.stop().catch(() => {});
  await previews?.close().catch(() => {});
  await app?.close().catch(() => {});
  store?.close();
  await ownership.release();
  throw error;
}
