import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Projects inherit all defaults once and Runs retain their Project assignment', () => {
  const store = new Store(':memory:');
  try {
    const first = store.createProject('First', '');
    const inherited = structuredClone(store.settings().profiles);
    const defaults = store.settings();
    defaults.profiles.pm.model = 'new-default';
    store.saveSettings(defaults);
    assert.deepEqual(store.project(first.id).profiles, inherited);
    const run = store.run('pm', first.id, 'pm');
    assert.deepEqual(run.profileConfig, inherited.pm);
    assert.equal(run.provider?.id, 'codex');
    assert.equal(store.createProject('Second', '').profiles.pm.model, 'new-default');
    assert.deepEqual(store.get('run', run.id)?.profileConfig, inherited.pm);
  } finally {
    store.close();
  }
});

test('Dev route upgrades cannot resume a thread from another Provider', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject('Routing', '');
    const repo = store.createRepo({
      projectId: project.id,
      name: 'repo',
      path: '/route',
      github: 'fixture/route',
      defaultBranch: 'main',
      authorized: true,
    });
    const source = store.addMessage(project.id, 'user', 'Implement', 'implement');
    const task = store.createTask({
      projectId: project.id,
      repoId: repo.id,
      sourceMessageId: source.id,
      title: 'Task',
      spec: 'Implement',
      acceptance: ['Done'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    store.put('provider', 'complex-provider', {
      id: 'complex-provider',
      name: 'Complex',
      kind: 'custom',
      hasKey: true,
    });
    const profiles = structuredClone(project.profiles);
    profiles.complex.providerId = 'complex-provider';
    store.saveProjectProfiles(project.id, profiles);
    const first = store.run('dev', project.id, 'backend', task);
    store.bindRunThread(first, 'backend-thread');
    const upgraded = store.updateTask(task.id, { profile: 'complex' });
    const next = store.run('dev', project.id, 'complex', upgraded);
    assert.equal(next.resumeThreadId, undefined);
  } finally {
    store.close();
  }
});

test('profile saves are atomic, protect Provider references and invalidate future thread bindings', () => {
  const store = new Store(':memory:');
  try {
    const p = store.createProject('Independent', '');
    store.put('project', p.id, { ...p, pmThreadId: 'old-thread' });
    const active = store.run('pm', p.id, 'pm');
    store.put('provider', 'upstream', {
      id: 'upstream',
      name: 'Test upstream',
      kind: 'custom',
      baseUrl: 'https://example.invalid/v1',
      hasKey: true,
    });
    const profiles = structuredClone(p.profiles);
    profiles.pm = { providerId: 'upstream', model: 'custom-model', effort: 'low' };
    store.saveProjectProfiles(p.id, profiles);
    assert.equal(store.project(p.id).pmThreadId, undefined);
    assert.throws(() => store.deleteProvider('upstream'), /Independent.*pm/);
    store.bindRunThread(active, 'late-old-thread');
    assert.equal(store.project(p.id).pmThreadId, undefined);
    assert.equal(store.get('run', active.id)?.threadId, 'late-old-thread');
    const current = store.run('pm', p.id, 'pm');
    assert.equal(current.resumeThreadId, undefined);
    assert.deepEqual(current.profileConfig, profiles.pm);
    const invalid = structuredClone(profiles);
    invalid.review.providerId = 'missing';
    assert.throws(() => store.saveProjectProfiles(p.id, invalid), /Provider/);
    assert.deepEqual(store.project(p.id).profiles, profiles);
    const defaults = store.settings();
    defaults.profiles.review.providerId = 'upstream';
    store.saveSettings(defaults);
    store.saveProjectProfiles(p.id, p.profiles);
    assert.throws(() => store.deleteProvider('upstream'), /全局.*review/);
    defaults.profiles.review.providerId = 'codex';
    store.saveSettings(defaults);
    assert.throws(() => store.deleteProvider('upstream'), /Run/);
    store.finishRun(current.id, 'completed');
    store.deleteProvider('upstream');
  } finally {
    store.close();
  }
});

test('legacy Projects persist the upgrade snapshot across reopen and later defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-profile-'));
  const file = join(root, 'state.sqlite');
  let store = new Store(file);
  const project = store.createProject('Legacy', '');
  const settings = store.settings();
  store.close();
  const db = new DatabaseSync(file);
  const legacy = { ...project } as any;
  delete legacy.profiles;
  for (const profile of Object.values(settings.profiles)) delete (profile as any).providerId;
  db.prepare('UPDATE documents SET body=? WHERE kind=? AND id=?').run(
    JSON.stringify(legacy),
    'project',
    project.id,
  );
  db.prepare('UPDATE documents SET body=? WHERE kind=? AND id=?').run(
    JSON.stringify(settings),
    'settings',
    'global',
  );
  db.close();
  try {
    store = new Store(file);
    const snapshot = store.project(project.id).profiles;
    assert.equal(snapshot.pm.providerId, 'codex');
    const next = store.settings();
    next.profiles.pm.model = 'changed-after-upgrade';
    store.saveSettings(next);
    store.close();
    store = new Store(file);
    assert.deepEqual(store.project(project.id).profiles, snapshot);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
