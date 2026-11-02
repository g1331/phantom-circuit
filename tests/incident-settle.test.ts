import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';

test('a later successful Run of the same phase settles the stale Incident; other phases stay open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-incident-settle-'));
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
    const task = store.createTask({
      projectId: project.id,
      repoId: repo.id,
      sourceMessageId: message.id,
      title: 'T',
      spec: 'S',
      acceptance: ['A'],
      dependencies: [],
      kind: 'backend',
      complexity: 'complex',
      priority: 0,
    });
    const failed = store.run('review', project.id, 'review', task, { reviewAxis: 'primary' });
    store.finishRun(failed.id, 'failed', '400 invalid_json_schema');
    const primary = store.createIncident({
      projectId: project.id,
      taskId: task.id,
      runId: failed.id,
      phase: 'review:primary',
      message: '400 invalid_json_schema',
    });
    const dev = store.createIncident({
      projectId: project.id,
      taskId: task.id,
      phase: 'dev',
      message: 'dev broke',
    });
    const secondary = store.run('review', project.id, 'review', task, {
      reviewAxis: 'secondary',
      secondaryReview: true,
    });
    store.finishRun(secondary.id, 'completed');
    assert.equal(store.get('incident', primary.id)?.status, 'open', 'another axis proves nothing');

    const retried = store.run('review', project.id, 'review', task, { reviewAxis: 'primary' });
    store.finishRun(retried.id, 'completed');
    assert.equal(store.get('incident', primary.id)?.status, 'resolved');
    assert.match(store.get('incident', primary.id)!.message, new RegExp(retried.id));
    assert.equal(store.get('incident', dev.id)?.status, 'open');

    // Host-made Incidents carry whole command output; a long one must still be recorded.
    const long = store.createIncident({
      projectId: project.id,
      taskId: task.id,
      phase: 'retries',
      message: `宿主正式验证环境阻塞：${'x'.repeat(16000)}`,
      evidence: 'y'.repeat(40000),
    });
    assert.equal(long.message.length, 16000);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
