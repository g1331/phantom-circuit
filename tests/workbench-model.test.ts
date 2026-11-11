import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocale } from '../src/web/locale/core.ts';
import { workNodes } from '../src/web/workbench-model.ts';
import { intakeFixture } from './intake-fixture.ts';

test('workbench validation uses the newest attempt per command at the pinned head', async () => {
  const f = intakeFixture();
  try {
    const source = f.store.addMessage(f.project.id, 'user', 'One deliverable', 'implement');
    const task = f.store.createTask({
      projectId: f.project.id,
      repoId: f.repo.id,
      sourceMessageId: source.id,
      title: 'One deliverable',
      spec: 'One deliverable',
      acceptance: ['One observable outcome'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    const updated = f.store.updateTask(task.id, {
      head: 'current-head',
      tests: [
        { command: 'npm test', exitCode: 1, output: '', head: 'old-head', at: '2026-01-01' },
        { command: 'npm test', exitCode: 1, output: '', head: 'current-head', at: '2026-01-02' },
        { command: 'npm test', exitCode: 0, output: '', head: 'current-head', at: '2026-01-03' },
      ],
    });
    const validation = workNodes(updated, f.store.snapshot(), createLocale('en')).find(
      (node) => node.key === 'tests',
    );
    assert.equal(validation?.detail, '1 passed');
    assert.equal(validation?.tone, 'success');
    assert.equal(
      f.store.task(task.id).tests.length,
      3,
      'older attempts remain as evidence history',
    );
  } finally {
    await f.close();
  }
});
