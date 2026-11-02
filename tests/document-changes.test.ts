import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Workspaces } from '../src/server/workspaces.ts';
import { devFixture } from './dev-fixture.ts';

test('an accepted design document missing from the worktree is a rework verdict, not a crash', async () => {
  const { root, store, task } = await devFixture('phantom-doc-changes-');
  const ws = new Workspaces(join(root, 'ws'), store);
  try {
    const prepared = await ws.prepare(task);
    const head = await ws.git(prepared.worktree!, ['rev-parse', 'HEAD']);
    const withDoc = store.updateTask(task.id, {
      head,
      documentChanges: [
        { id: 'doc', path: 'docs/adr/0099-missing.md', version: 1, content: '# Missing' },
      ] as never,
    });
    await assert.rejects(
      ws.verify(withDoc),
      /设计文档未按已接受版本落地：docs\/adr\/0099-missing\.md/,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
