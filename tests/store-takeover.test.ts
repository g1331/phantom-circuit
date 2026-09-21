import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.ts';

test('new Projects inherit OMP while legacy records migrate to pinned Codex', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-takeover-'));
  const file = join(root, 'state.sqlite');
  let store = new Store(file);
  const project = store.createProject('new', '');
  assert.equal(store.settings().defaultAgent, 'omp');
  assert.deepEqual(project.agentSelection, { mode: 'inherit' });
  assert.equal(store.run('pm', project.id, 'pm').agentKind, 'omp');
  const settings = store.settings();
  const legacy = {
    id: project.id,
    name: project.name,
    description: project.description,
    devLimit: project.devLimit,
    createdAt: project.createdAt,
  };
  store.close();
  const db = new DatabaseSync(file);
  db.prepare('UPDATE documents SET body=? WHERE kind=? AND id=?').run(
    JSON.stringify(legacy),
    'project',
    project.id,
  );
  db.prepare('UPDATE documents SET body=? WHERE kind=? AND id=?').run(
    JSON.stringify({ globalDevLimit: 4, reviewLimit: 2, profiles: settings.profiles }),
    'settings',
    'global',
  );
  db.close();
  try {
    store = new Store(file);
    const migrated = store.project(project.id);
    assert.deepEqual(migrated.agentSelection, { mode: 'override', agent: 'codex' });
    assert.ok(Object.values(migrated.profileModes!).every((mode) => mode === 'pinned'));
    assert.equal(store.settings().defaultAgent, 'omp');
    assert.equal(migrated.recoveryPolicy, 'automatic');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('inherited settings affect only new Runs and invalidate matching cached threads', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject('inheritance', '');
    const first = store.run('pm', project.id, 'pm');
    store.bindRunThread(first, 'omp-thread');
    const settings = store.settings();
    settings.ompProfiles!.pm = { providerId: 'remote', model: 'new-model', effort: 'low' };
    store.saveSettings(settings);
    const second = store.run('pm', project.id, 'pm');
    assert.equal(second.profileConfig?.model, 'new-model');
    assert.equal(second.resumeThreadId, undefined);
    assert.equal(store.get('run', first.id)?.profileConfig?.model, 'config-required');
  } finally {
    store.close();
  }
});

test('Incidents deduplicate by Run/phase, redact evidence, and claim assessment once', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject('incident', '');
    const run = store.run('pm', project.id, 'pm');
    const first = store.createIncident({
      projectId: project.id,
      runId: run.id,
      phase: 'turn',
      message: 'authorization: Bearer secret-value',
      evidence: 'api_key=private-value',
    });
    const duplicate = store.createIncident({
      projectId: project.id,
      runId: run.id,
      phase: 'turn',
      message: 'a different symptom',
    });
    assert.equal(duplicate.id, first.id);
    assert.doesNotMatch(JSON.stringify(first), /secret-value|private-value/);
    const assessed = store.claimIncidentAssessment(first.id, 'assessment-run');
    assert.equal(assessed.assessmentRunId, 'assessment-run');
    assert.equal(
      store.claimIncidentAssessment(first.id, 'assessment-run-2').assessmentRunId,
      'assessment-run',
    );
  } finally {
    store.close();
  }
});

test('Clarifications are project/intent scoped, bounded to three questions, and answerable', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject('clarify', '');
    const other = store.createProject('other', '');
    const source = store.addMessage(project.id, 'user', 'Choose a behavior', 'implement');
    assert.throws(
      () =>
        store.createClarification({
          projectId: other.id,
          sourceMessageId: source.id,
          questions: [{ question: 'wrong project' }],
        }),
      /不属于当前项目/,
    );
    const clarification = store.createClarification({
      projectId: project.id,
      sourceMessageId: source.id,
      questions: [
        { question: 'Which?', recommendation: 'A', options: [{ value: 'a' }] },
        { question: 'Why?' },
      ],
    });
    assert.equal(clarification.sourceIntent, 'implement');
    assert.equal(
      store.answerClarification(clarification.id, { q1: 'free text despite options' }).status,
      'open',
    );
    const answered = store.answerClarification(clarification.id, { q2: 'free-form answer' });
    assert.equal(answered.status, 'answered');
  } finally {
    store.close();
  }
});

test('recover creates one durable item and preserves paused/done task state and evidence', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject('recover', '');
    const repo = store.createRepo({
      projectId: project.id,
      name: 'repo',
      path: '/recover',
      github: 'fixture/recover',
      defaultBranch: 'main',
      authorized: true,
    });
    const message = store.addMessage(project.id, 'user', 'Implement', 'implement');
    const task = store.createTask({
      projectId: project.id,
      repoId: repo.id,
      sourceMessageId: message.id,
      title: 'Recover',
      spec: 'Keep evidence',
      acceptance: ['kept'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    store.updateTask(task.id, {
      control: 'paused',
      pausedByUser: true,
      tests: [{ command: 'test', exitCode: 0, output: 'evidence', head: 'head', at: 'now' }],
    });
    const run = store.run('dev', project.id, task.profile, task);
    const first = store.recover();
    const second = store.recover();
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(first[0].id, second[0].id);
    assert.equal(first[0].policy, 'automatic');
    assert.equal(first[0].status, 'recoverable');
    assert.equal(store.get('run', run.id)?.status, 'interrupted');
    assert.equal(store.task(task.id).control, 'paused');
    assert.equal(store.task(task.id).tests[0].output, 'evidence');
  } finally {
    store.close();
  }
});
