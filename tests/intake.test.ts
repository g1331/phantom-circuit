import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { Intake } from '../src/server/intake.ts';
import { GitHub } from '../src/server/github.ts';

const actor = { id: 7, login: 'human', kind: 'user' as const };
function fixture() {
  const store = new Store(':memory:');
  const project = store.createProject('Intake', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'repo',
    path: '/unused',
    github: 'test/repo',
    defaultBranch: 'main',
    authorized: true,
  });
  const github = new GitHub(store);
  const intake = new Intake(store, github, async () => '');
  return { store, project, repo, github, intake, close: async () => store.close() };
}

test(
  'intake preserves original evidence, rejects untrusted actors ' + 'and binds one Issue',
  async () => {
    const f = fixture();
    try {
      f.github.resolveIntakeActor = async () => actor;
      const source = await f.intake.configure(f.repo.id, {
        enabled: true,
        command: '/phantom',
        allowedActors: ['human'],
        since: '2026-01-01T00:00:00.000Z',
        expectedVersion: 0,
      });
      const observed = {
        nativeId: 'I_node',
        databaseId: 91,
        revision: 'rev1',
        number: 12,
        title: 'Request',
        body: '/phantom\nKeep original body.',
        url: 'https://github.com/test/repo/issues/12',
        author: actor,
        actor,
        state: 'open' as const,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      };
      f.github.readIntakeIssues = async () => [
        observed,
        { ...observed, nativeId: 'I_bot', number: 13, actor: { ...actor, kind: 'bot' } },
      ];
      await f.intake.refresh(f.repo.id);
      const page = f.intake.workflow(f.project.id);
      assert.equal(page.inputs.length, 2);
      assert(!('body' in page.inputs[0].input));
      const detail = page.inputs.find((item) => item.input.nativeId === 'I_node')!;
      const message = f.intake.dispatchMessage(detail.input.id)!;
      assert.equal(message.role, 'system');
      assert.equal(message.content, observed.body);
      assert.equal(message.origin?.actor.id, 7);
      const taskData = {
        projectId: f.project.id,
        repoId: f.repo.id,
        sourceMessageId: message.id,
        title: 'Deliver',
        spec: 'One thing',
        acceptance: ['Verified'],
        dependencies: [],
        kind: 'backend' as const,
        complexity: 'normal' as const,
        priority: 0,
      };
      const task = f.store.createTask(taskData);
      assert.equal(task.issue, 12);
      assert.equal(task.issueNodeId, 'I_node');
      assert.equal(task.issueDatabaseId, 91);
      assert.equal(task.issueBody, observed.body);
      assert.equal(f.store.createTask(taskData).id, task.id);
      assert.throws(
        () => f.store.createTask({ ...taskData, title: 'Another deliverable' }),
        /独立交付/,
      );
      assert.equal(f.store.task(task.id).control, 'paused');
      assert.throws(() => f.store.updateMessage(message.id, { content: 'rewritten' }), /外部来源/);
      assert.equal(
        page.inputs.find((item) => item.input.number === 13)?.assessment.disposition.status,
        'refused',
      );
      assert.equal(source.version, 1);
      assert.equal(f.store.snapshot().messages.find((item) => item.id === message.id)?.content, '');
      await f.intake.refresh(f.repo.id);
      assert.equal(f.intake.workflow(f.project.id).inputs.length, 2);
    } finally {
      await f.close();
    }
  },
);
