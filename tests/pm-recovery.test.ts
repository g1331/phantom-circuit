import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { GitHub } from '../src/server/github.ts';
import { Store } from '../src/server/store.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';

test('a user message whose PM turn resumes automatically after restart ends completed, not failed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-pm-recovery-'));
  const file = join(root, 'state.sqlite');
  const before = new Store(file);
  const project = before.createProject('Recovery', '');
  before.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
  const message = before.addMessage(project.id, 'user', 'Plan the report', 'discuss');
  before.updateMessage(message.id, { status: 'running', draftStatus: 'running' });
  before.run('pm', project.id, 'pm', { sourceMessageId: message.id });
  before.close();

  class Model extends Codex {
    override async start() {}
    override async stop() {}
    override async thread() {
      return 'pm-thread';
    }
    override async turn() {
      return 'resumed answer';
    }
  }
  const store = new Store(file);
  const engine = new Engine(
    store,
    new GitHub(store),
    new Workspaces(join(root, 'ws'), store),
    root,
    () => new Model(),
  );
  try {
    await engine.start();
    assert.equal(store.get('message', message.id)?.status, 'completed');
    const notes = store.list('message').filter((m) => m.role === 'system');
    assert.ok(
      !notes.some((m) => m.content.includes('重新发送')),
      'an automatically resumed message must not ask the user to resend it',
    );
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
