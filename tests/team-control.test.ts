import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { Previews } from '../src/server/preview.ts';
import { createApp } from '../src/server/app.ts';

test('a team pause holds all running work and a team resume releases only what it held', async () => {
  const store = new Store(':memory:');
  const ws = new Workspaces('/test', store);
  const app = createApp(store, new Engine(store, new GitHub(store), ws, '/test'), new Previews(store, ws));
  const project = store.createProject('Team', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'repo',
    path: '/test',
    github: 'example/team',
    defaultBranch: 'main',
    authorized: true,
  });
  const source = store.addMessage(project.id, 'user', 'Implement', 'implement');
  const task = (title: string) =>
    store.createTask({
      projectId: project.id,
      repoId: repo.id,
      sourceMessageId: source.id,
      title,
      spec: 's',
      acceptance: ['a'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    }).id;
  const running = task('Running');
  const ready = task('Ready');
  const heldByUser = task('Held by the user');
  store.updateTask(running, { stage: 'developing' });
  store.control(heldByUser, 'pause', { source: 'user', reason: 'http_task_control' });
  try {
    const init = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
    const headers = {
      host: '127.0.0.1:4317',
      cookie: String(init.headers['set-cookie']).split(';')[0],
      'x-phantom-csrf': init.json().csrf,
    };
    const post = (action: string) =>
      app.inject({ method: 'POST', url: `/api/projects/${project.id}/team/${action}`, headers });

    const paused = await post('pause');
    assert.equal(paused.statusCode, 200, paused.body);
    assert.deepEqual(paused.json().changed.sort(), [running, ready].sort());
    for (const id of [running, ready, heldByUser]) assert.equal(store.task(id).control, 'paused');

    const resumed = await post('resume');
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(store.task(running).control, 'active');
    assert.equal(store.task(ready).control, 'active');
    assert.equal(store.task(heldByUser).control, 'paused', 'a task paused on its own stays paused');
  } finally {
    await app.close();
    store.close();
  }
});
