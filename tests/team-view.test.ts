import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { teamView, workGroup } from '../src/shared/team.ts';

test('the team view shows who is working on what and what waits on the user', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-team-'));
  const store = new Store(join(root, 'db.sqlite'));
  try {
    const project = store.createProject('Team', '');
    const repo = store.createRepo({
      projectId: project.id,
      name: 'r',
      path: root,
      github: 'fixture/r',
      defaultBranch: 'main',
      authorized: true,
    });
    const message = store.addMessage(project.id, 'user', 'Build it', 'implement');
    const task = (title: string) =>
      store.createTask({
        projectId: project.id,
        repoId: repo.id,
        sourceMessageId: message.id,
        title,
        spec: 's',
        acceptance: ['a'],
        dependencies: [],
        kind: 'backend',
        complexity: 'normal',
        priority: 0,
      });
    const building = task('Search page');
    const stuck = task('Export');
    const asking = task('Billing');
    store.updateTask(building.id, { stage: 'developing', devPhase: 'implement' });
    const dev = store.run('dev', project.id, 'backend', store.task(building.id));
    store.updateTask(stuck.id, { stage: 'developing', control: 'paused', blocked: 'GitHub 拒绝推送' });
    store.updateTask(asking.id, { stage: 'reviewing', control: 'paused', blocked: '等待确认' });
    store.createClarification({
      projectId: project.id,
      taskId: asking.id,
      sourceMessageId: message.id,
      sourceIntent: 'implement',
      questions: [{ id: 'q', question: '按月还是按年计费？' }],
    });

    // The liaison asked a question and now waits on the user: that is not work in progress.
    const liaison = store.run('pm', project.id, 'pm');
    store.finishRun(liaison.id, 'waiting', 'ClarificationPause');
    // The liaison answering the Dev's question is coordinating, not talking with the user.
    store.run('pm', project.id, 'pm', store.task(building.id));
    // A finished review of the work that now waits on the user.
    const reviewer = store.run('review', project.id, 'review', store.task(asking.id));
    store.finishRun(reviewer.id, 'completed');
    const view = teamView(store.snapshot(), project.id);

    const developer = view.members.find((m) => m.role === 'dev')!;
    assert.equal(developer.runId, dev.id);
    assert.equal(developer.activity, 'building');
    assert.equal(developer.taskTitle, 'Search page');
    assert.deepEqual(
      view.members.map((m) => [m.role, m.activity]),
      [
        ['pm', 'coordinating'],
        ['dev', 'building'],
      ],
      'only working members are listed',
    );
    const work = Object.fromEntries(view.work.map((w) => [w.title, w]));
    assert.equal(work['Search page'].attention, 'none');
    assert.deepEqual(work['Search page'].owners, ['dev', 'pm']);
    assert.equal(work['Export'].attention, 'blocked');
    assert.equal(work['Billing'].attention, 'needs_user');
    assert.deepEqual(
      view.waiting.map((w) => [w.kind, w.taskTitle, w.text]).sort(),
      [
        ['blocked', 'Export', 'GitHub 拒绝推送'],
        ['clarification', 'Billing', '按月还是按年计费？'],
      ],
    );
    assert.deepEqual(
      view.feed.map((f) => [f.role, f.kind, f.taskTitle]),
      [['review', 'finished', 'Billing']],
      'the feed holds finished turns only: live ones are members, a question waits on the user',
    );
    assert.ok(view.feed[0].durationMs >= 0);
    assert.deepEqual(
      Object.fromEntries(view.work.map((w) => [w.title, workGroup(w)])),
      { 'Search page': 'moving', Export: 'needs_you', Billing: 'needs_you' },
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
