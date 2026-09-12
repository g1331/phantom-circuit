import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { Store } from './store.ts';
import { GitHub } from './github.ts';
import { Workspaces } from './workspaces.ts';
import { Engine } from './engine.ts';
import { Previews } from './preview.ts';
import { createApp } from './app.ts';
const dataDir = resolve('.phantom');
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
const store = new Store(join(dataDir, 'phantom.sqlite'));
const github = new GitHub(store);
const workspaces = new Workspaces(join(dataDir, 'workspaces'), store);
const engine = new Engine(store, github, workspaces, dataDir);
const previews = new Previews(store, workspaces);
const app = createApp(store, engine, previews, config.port);
// Bind before recovering or scheduling: a second instance must not touch running task state.
await app.listen({ host: '127.0.0.1', port: config.port });
engine.start();
store.changes.on('delivery', (repoId: string) => {
  if (store.repo(repoId).commands.start)
    void previews
      .start(repoId)
      .catch((e) => store.event('preview', String(e), { projectId: store.repo(repoId).projectId }));
});
console.log(`Phantom Circuit · http://127.0.0.1:${config.port}`);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await engine.stop();
  await previews.close();
  await app.close();
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
