import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { command } from '../src/server/process.ts';
import { Store } from '../src/server/store.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Previews } from '../src/server/preview.ts';

test('a real preview becomes healthy, stops its process tree, and a cancelled start stays stopped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-preview-'));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  const port = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
  await command('git', ['init', '--bare', remote]);
  await command('git', ['init', '-b', 'main', source]);
  const git = (args: string[]) => command('git', args, source);
  await git(['config', 'user.name', 'Phantom Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await writeFile(
    join(source, 'server.cjs'),
    "require('node:http').createServer((q,s)=>s.end('preview ready')).listen(Number(process.env.PORT),'127.0.0.1');\n",
  );
  await git(['add', '.']);
  await git(['commit', '-m', 'Preview fixture']);
  await git(['remote', 'add', 'origin', remote]);
  await git(['push', 'origin', 'main']);
  const store = new Store(':memory:');
  const p = store.createProject('Preview', '');
  const repo = store.createRepo({
    projectId: p.id,
    name: 'preview',
    path: source,
    github: 'fixture/preview',
    authorized: true,
    defaultBranch: 'main',
  });
  store.patchRepo(repo.id, {
    commands: { install: '', test: 'node --version', build: '', start: 'node server.cjs', port },
  });
  const previews = new Previews(store, new Workspaces(join(root, 'workspaces'), store));
  try {
    const { url } = await previews.start(repo.id);
    assert.equal(await (await fetch(url)).text(), 'preview ready');
    assert.equal(store.repo(repo.id).preview?.status, 'running');
    await previews.stop(repo.id);
    assert.equal(store.repo(repo.id).preview?.status, 'stopped');
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
    const pending = previews.start(repo.id);
    const outcome = assert.rejects(pending);
    await previews.stop(repo.id);
    await outcome;
    assert.equal(store.repo(repo.id).preview?.status, 'stopped');
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
  } finally {
    await previews.close();
    store.close();
  }
});
