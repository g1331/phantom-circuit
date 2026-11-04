import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './finalization-fixture.ts';

test('a stuck piece of work goes to a fresh developer who continues from the current code', async (t) => {
  const f = await fixture(t, async (cwd) => writeFile(join(cwd, 'value.txt'), 'after'));
  const stuck = f.store.updateTask(f.task().id, {
    stage: 'developing',
    devPhase: 'implement',
    control: 'paused',
    retries: 3,
    blocked: '连续三轮未完成，PM 正在重评',
    devThreadId: 'thread-of-the-previous-developer',
    devThreadProviderId: 'codex',
  });

  await f.engine.reassign(stuck.id, { source: 'user', reason: 'http_task_reassign' });
  const handed = f.task();
  assert.equal(handed.control, 'active');
  assert.equal(handed.retries, 0, 'the new developer starts with a full rework budget');
  assert.equal(handed.devThreadId, undefined);

  const delivered = await f.run();
  const devRuns = f.store.snapshot().runs.filter((r) => r.role === 'dev' && r.taskId === stuck.id);
  assert.equal(devRuns.length, 1);
  assert.equal(devRuns[0].resumeThreadId, undefined, 'the previous conversation is not resumed');
  assert.equal(
    delivered.stage,
    'reviewing',
    'the fresh developer delivers from the existing worktree',
  );
});

test('reassigning refuses while the current developer is still working', async (t) => {
  const f = await fixture(t);
  const task = f.store.updateTask(f.task().id, { stage: 'developing', devPhase: 'implement' });
  f.store.run('dev', task.projectId, task.profile, task);
  await assert.rejects(
    f.engine.reassign(task.id, { source: 'user', reason: 'http_task_reassign' }),
    /先暂停/,
  );
});
