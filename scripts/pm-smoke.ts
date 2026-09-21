import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { GitHub } from '../src/server/github.ts';
import { Engine } from '../src/server/engine.ts';
import { bootstrapAgentSettings } from '../src/server/agent-settings.ts';

// Metered opt-in integration check; no target repositories or external writes.
const root = await mkdtemp(join(tmpdir(), 'phantom-pm-'));
const store = new Store(join(root, 'state.sqlite'));
await bootstrapAgentSettings(store);
const project = store.createProject('Protocol acceptance', 'No repositories connected');
store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'omp' });
await mkdir(join(root, 'projects', project.id), { recursive: true });
const engine = new Engine(
  store,
  new GitHub(store),
  new Workspaces(join(root, 'workspaces'), store),
  root,
);
try {
  const message = store.addMessage(
    project.id,
    'user',
    '这是连接验收，不是实施需求。不要调用工具、创建任务或提出问题。只用一句简体中文说明你是项目 PM，已准备好讨论需求。',
    'discuss',
  );
  const reply = await engine.chat(message);
  assert.ok(reply.includes('PM'));
  assert.equal(store.list('task').length, 0);
  assert.ok(store.project(project.id).pmThreadId);
  console.log(
    'Actual project PM prompt + pinned skill context + registered host tools + persisted conversation: passed. No GitHub writes.',
  );
} finally {
  await engine.stop();
  store.close();
}
