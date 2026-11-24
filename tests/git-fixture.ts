import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { command } from '../src/server/process.ts';

const templates = new Map<string, Promise<string>>();
const createdTemplates: string[] = [];
let cleanupRegistered = false;

async function buildTemplate(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'phantom-git-template-'));
  createdTemplates.push(dir);
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once('exit', () => {
      for (const item of createdTemplates) {
        try {
          rmSync(item, { recursive: true, force: true });
        } catch {}
      }
    });
  }
  const source = join(dir, 'source');
  const remote = join(dir, 'remote.git');
  await command('git', ['init', '--bare', remote]);
  await command('git', ['init', '-b', 'main', source]);
  const git = (args: string[]) => command('git', args, source);
  await git(['config', 'user.name', 'Phantom Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(source, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  await git(['add', '.']);
  await git(['commit', '-m', 'Fixture']);
  await git(['remote', 'add', 'origin', remote.replaceAll('\\', '/')]);
  await git(['push', '-u', 'origin', 'main']);
  return dir;
}

/** Seed a temporary `{ source, remote }` Git repo pair by cloning an in-process template. */
export async function seedGitRepo(root: string, files: Record<string, string>) {
  const key = JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  let pending = templates.get(key);
  if (!pending) {
    pending = buildTemplate(files).catch((error) => {
      templates.delete(key);
      throw error;
    });
    templates.set(key, pending);
  }
  const template = await pending;
  await cp(template, root, { recursive: true });
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  const configPath = join(source, '.git', 'config');
  const templateRemote = join(template, 'remote.git').replaceAll('\\', '/');
  const config = await readFile(configPath, 'utf8');
  await writeFile(configPath, config.replaceAll(templateRemote, remote.replaceAll('\\', '/')));
  return { source, remote };
}
