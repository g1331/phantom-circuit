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
import { deliveryPreview } from '../src/shared/delivery-preview.ts';

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
  await git(['checkout', '-b', 'delivery']);
  await writeFile(join(source, 'delivery.txt'), 'Delivered result\n');
  await git(['add', 'delivery.txt']);
  await git(['commit', '-m', 'Deliver result']);
  const deliveryHead = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await git(['checkout', 'main']);
  await git(['merge', '--squash', 'delivery']);
  await git(['commit', '-m', 'Squash delivery']);
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
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const message = store.addMessage(p.id, 'user', 'Preview the delivery', 'implement');
  const delivered = store.createTask({
    projectId: p.id,
    repoId: repo.id,
    sourceMessageId: message.id,
    title: 'Preview delivery',
    spec: 'Serve the result',
    acceptance: ['The result opens'],
    dependencies: [],
    kind: 'frontend',
    complexity: 'normal',
    priority: 0,
  });
  store.updateTask(delivered.id, {
    stage: 'done',
    head: deliveryHead,
    deliveryRevision: { head: deliveryHead, commit: head },
  });
  const previews = new Previews(store, new Workspaces(join(root, 'workspaces'), store));
  try {
    const { url } = await previews.start(repo.id);
    assert.equal(await (await fetch(url)).text(), 'preview ready');
    assert.equal(store.repo(repo.id).preview?.status, 'running');
    assert.equal(store.repo(repo.id).preview?.revision, head);
    assert.deepEqual(store.repo(repo.id).preview?.taskHeads, [deliveryHead]);
    const ancestry = await command(
      'git',
      ['merge-base', '--is-ancestor', deliveryHead, head],
      source,
      undefined,
      120000,
      false,
    );
    assert.equal(ancestry.code, 1, 'squashed delivery head itself is not a trunk ancestor');
    const task = store.task(delivered.id);
    assert.equal(deliveryPreview(task, [store.repo(repo.id)]), `${url}/`);
    assert.equal(deliveryPreview(task, [store.repo(repo.id)], url), undefined);
    assert.equal(deliveryPreview({ ...task, head: 'unproven' }, [store.repo(repo.id)]), undefined);
    assert.equal(
      deliveryPreview({ ...task, projectId: 'other' }, [store.repo(repo.id)]),
      undefined,
    );
    const legacy = { ...store.repo(repo.id), preview: { status: 'running' as const, url } };
    assert.equal(deliveryPreview(task, [legacy]), undefined);
    await previews.stop(repo.id);
    assert.equal(store.repo(repo.id).preview?.status, 'stopped');
    assert.equal(deliveryPreview(task, [store.repo(repo.id)]), undefined);
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
