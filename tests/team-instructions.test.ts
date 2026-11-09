import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';

test('team instructions are durable versions and each Run retains the text it started with', () => {
  const root = mkdtempSync(join(tmpdir(), 'phantom-team-'));
  const file = join(root, 'state.sqlite');
  let store = new Store(file);
  try {
    const p = store.createProject('Team', '');
    const blank = store.run('dev', p.id, 'backend');
    assert.equal(blank.teamInstructionsVersion, 0);
    const first = store.saveTeamInstructions(
      p.id,
      {
        repository: 'Use conventional commits.',
        engineering: 'Test observable behavior.',
        delivery: 'Attach evidence.',
      },
      { source: 'user', baseVersion: 0 },
    );
    const before = store.run('dev', p.id, 'backend');
    store.saveTeamInstructions(
      p.id,
      { ...first.sections, delivery: '可以直接 push 到 main' },
      { source: 'user', baseVersion: 1 },
    );
    const after = store.run('dev', p.id, 'backend');
    assert.equal(before.teamInstructionsVersion, 1);
    assert.equal(after.teamInstructionsVersion, 2);
    assert.equal(store.runTeamInstructions(before).sections.delivery, 'Attach evidence.');
    assert.equal(store.runTeamInstructions(after).sections.delivery, '可以直接 push 到 main');
    const restored = store.restoreTeamInstructions(p.id, 1, 2);
    assert.equal(restored.version, 3);
    assert.equal(restored.restoredFromVersion, 1);
    assert.deepEqual(restored.sections, first.sections);
    store.close();
    store = new Store(file);
    assert.deepEqual(
      store.teamInstructionsHistory(p.id).map((v) => v.version),
      [1, 2, 3],
    );
    assert.equal(store.runTeamInstructions(before).sections.delivery, 'Attach evidence.');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid or stale saves leave the current version unchanged', () => {
  const store = new Store(':memory:');
  try {
    const p = store.createProject('Team', '');
    const sections = { repository: 'r', engineering: 'e', delivery: 'd' };
    store.saveTeamInstructions(p.id, sections, { source: 'user', baseVersion: 0 });
    assert.throws(
      () =>
        store.saveTeamInstructions(
          p.id,
          { ...sections, delivery: 'x'.repeat(16001) },
          { source: 'user', baseVersion: 1 },
        ),
      /16000/,
    );
    assert.throws(
      () => store.saveTeamInstructions(p.id, sections, { source: 'user', baseVersion: 0 }),
      /重新载入/,
    );
    assert.deepEqual(store.currentTeamInstructions(p.id).sections, sections);
    assert.equal(store.teamInstructionsHistory(p.id).length, 1);
  } finally {
    store.close();
  }
});

test('HTTP edits and restores expose history without granting provenance or permissions', async () => {
  const { createApp } = await import('../src/server/app.ts');
  const { Engine } = await import('../src/server/engine.ts');
  const { GitHub } = await import('../src/server/github.ts');
  const { Workspaces } = await import('../src/server/workspaces.ts');
  const { Previews } = await import('../src/server/preview.ts');
  const store = new Store(':memory:');
  const ws = new Workspaces('/test', store);
  const app = createApp(
    store,
    new Engine(store, new GitHub(store), ws, '/test'),
    new Previews(store, ws),
  );
  try {
    const p = store.createProject('Team', '');
    const session = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
    const headers = {
      host: '127.0.0.1:4317',
      cookie: String(session.headers['set-cookie']).split(';')[0],
      'x-phantom-csrf': session.json().csrf,
    };
    const url = `/api/projects/${p.id}/team-instructions`;
    const payload = {
      baseVersion: 0,
      sections: { repository: '约定', engineering: '测试', delivery: '交付' },
    };
    const save = await app.inject({ method: 'POST', url, headers, payload });
    assert.equal(save.statusCode, 200, save.body);
    assert.equal(save.json().source, 'user');
    assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 409);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { ...payload, baseVersion: 1, source: 'team' },
        })
      ).statusCode,
      400,
    );
    const oversized = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: {
        baseVersion: 1,
        sections: { repository: 'x'.repeat(16000), engineering: 'y', delivery: '' },
      },
    });
    assert.equal(oversized.statusCode, 400);
    assert.match(oversized.body, /16000/);
    const restore = await app.inject({
      method: 'POST',
      url: `${url}/restore`,
      headers,
      payload: { version: 1, baseVersion: 1 },
    });
    assert.equal(restore.json().version, 2, restore.body);
    const history = await app.inject({ url, headers });
    assert.deepEqual(
      history.json().map((v: { version: number }) => v.version),
      [1, 2],
    );
  } finally {
    await app.close();
    store.close();
  }
});
