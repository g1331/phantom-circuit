import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';

test('a Task with a partial engineering naming tuple is refused at creation, not after it is claimed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-naming-'));
  const store = new Store(join(root, 'db.sqlite'));
  try {
    const project = store.createProject('P', '');
    const repo = store.createRepo({
      projectId: project.id,
      name: 'r',
      path: root,
      github: 'o/r',
      defaultBranch: 'main',
      authorized: true,
    });
    const message = store.addMessage(project.id, 'user', 'do it', 'implement');
    const base = {
      projectId: project.id,
      repoId: repo.id,
      sourceMessageId: message.id,
      title: 'T',
      spec: 'S',
      acceptance: ['A'],
      dependencies: [],
      kind: 'backend' as const,
      complexity: 'normal' as const,
      priority: 0,
      documentChanges: [],
    };
    assert.throws(
      () => store.createTask({ ...base, changeType: 'feat', scope: 'report' }),
      /summaryEn/,
    );
    assert.equal(store.list('task').length, 0);
    const named = store.createTask({
      ...base,
      changeType: 'feat',
      scope: 'report',
      summaryEn: 'record control actors',
    });
    assert.equal(named.summaryEn, 'record control actors');
    assert.ok(store.createTask(base), 'a Task without naming metadata stays legacy');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
