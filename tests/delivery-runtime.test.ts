import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { command } from '../src/server/process.ts';
import {
  captureDeliveryRuntime,
  completionNotice,
  deliveryVersion,
} from '../src/server/delivery-runtime.ts';
import { renderHostMessage } from '../src/shared/host-messages.ts';

test('delivery notices distinguish the captured running revision, pending code, and unknown evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-delivery-runtime-'));
  const source = join(root, 'source');
  const store = new Store(':memory:');
  try {
    await command('git', ['init', '-b', 'main', source]);
    const git = (args: string[]) => command('git', args, source);
    await git(['config', 'user.name', 'Phantom Test']);
    await git(['config', 'user.email', 'test@example.invalid']);
    await writeFile(join(source, 'result.txt'), 'Original\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'Initial runtime']);
    const running = await captureDeliveryRuntime(source);
    await writeFile(join(source, 'result.txt'), 'Delivered\n');
    await git(['commit', '-am', 'Deliver result']);
    const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const project = store.createProject('Delivery', '');
    const repo = store.createRepo({
      projectId: project.id,
      name: 'phantom-circuit',
      path: source,
      github: 'fixture/runtime',
      defaultBranch: 'main',
      authorized: true,
    });
    const message = store.addMessage(project.id, 'user', 'Deliver result', 'implement');
    const created = store.createTask({
      projectId: project.id,
      repoId: repo.id,
      sourceMessageId: message.id,
      title: '可直接使用的结果',
      spec: 'Deliver the result',
      acceptance: ['Works'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    const task = store.updateTask(created.id, {
      stage: 'done',
      head: commit,
      deliveryRevision: { head: commit, commit },
      pr: 7,
      prUrl: 'https://github.com/fixture/runtime/pull/7',
    });
    assert.equal(await deliveryVersion(task, repo, running), 'pending');
    const pending = await completionNotice(task, repo, running);
    assert.equal(pending.descriptor.code, 'delivery_self_pending');
    assert.match(pending.content, /当前应用尚未包含/);
    assert.doesNotMatch(pending.content, /npm|体验环境|预览/);
    assert.match(renderHostMessage(pending.descriptor, 'en'), /does not yet include/);
    const updated = await captureDeliveryRuntime(source);
    assert.equal(await deliveryVersion(task, repo, updated), 'current');
    assert.match((await completionNotice(task, repo, updated)).content, /当前应用已包含/);
    await writeFile(join(source, 'result.txt'), 'Uncommitted\n');
    const dirty = await captureDeliveryRuntime(source);
    assert.equal(await deliveryVersion(task, repo, dirty), 'unknown');
    const unknown = await completionNotice(task, repo, dirty);
    assert.match(unknown.content, /尚未确认/);
    assert.match(renderHostMessage(unknown.descriptor, 'en'), /unconfirmed/);
    assert.equal(
      running.revision === commit,
      false,
      'checkout changes never rewrite captured identity',
    );
    assert.equal(
      await deliveryVersion(
        { ...task, head: undefined, deliveryRevision: undefined },
        repo,
        updated,
      ),
      'unknown',
    );
    const release = join(root, 'release');
    await mkdir(release);
    await writeFile(
      join(release, 'release.json'),
      JSON.stringify({ source, commit, dirty: false }),
    );
    const installed = await captureDeliveryRuntime(release);
    assert.equal(await deliveryVersion(task, repo, installed), 'current');
    await writeFile(join(release, 'release.json'), JSON.stringify({ source, commit, dirty: true }));
    assert.equal(
      await deliveryVersion(task, repo, await captureDeliveryRuntime(release)),
      'unknown',
    );
    const other = join(root, 'other');
    await mkdir(other);
    const external = { ...repo, path: other };
    const notice = await completionNotice(task, external, updated);
    assert.equal(
      notice.descriptor.code,
      'delivery_completed',
      'repository name never identifies self',
    );
    assert.doesNotMatch(notice.content, /当前应用|npm|体验环境|预览/);
    assert.match(notice.content, /可直接使用的结果/);
    assert.match(notice.content, /https:\/\/github.com\/fixture\/runtime\/pull\/7/);
    const preview = {
      ...external,
      preview: {
        status: 'running' as const,
        url: 'http://127.0.0.1:49321/',
        revision: commit,
        taskHeads: [commit],
      },
    };
    const withPreview = await completionNotice(task, preview, updated);
    assert.match(withPreview.content, /http:\/\/127.0.0.1:49321\//);
    const stale = await completionNotice(
      task,
      {
        ...preview,
        preview: { ...preview.preview, taskHeads: ['another-delivery'] },
      },
      updated,
    );
    assert.doesNotMatch(stale.content, /49321/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
