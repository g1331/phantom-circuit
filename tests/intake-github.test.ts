import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuration, intakeFixture, issueObservation } from './intake-fixture.ts';
import { Intake } from '../src/server/intake.ts';

async function admitted(f: ReturnType<typeof intakeFixture>) {
  await f.intake.configure(f.repo.id, configuration);
  await f.intake.refresh(f.repo.id);
  const entry = f.intake.workflow(f.project.id).inputs[0];
  const message = f.intake.dispatchMessage(entry.input.id)!;
  return { ...entry, message };
}

test('Issue editor identity controls admission; later revisions remain context', async () => {
  const f = intakeFixture();
  try {
    const original = await admitted(f);
    f.edit({ databaseId: 88, login: 'outsider', __typename: 'User' }, '/phantom\nDifferent scope');
    await f.intake.refresh(f.repo.id);
    const page = f.intake.workflow(f.project.id);
    assert.equal(page.inputs.length, 2);
    assert.equal(page.inputs[0].assessment.disposition.status, 'refused');
    assert.equal(page.inputs[0].input.actor.id, 88);
    assert.equal(f.intake.detail(original.input.id).input.body, issueObservation.body);
    f.edit({ databaseId: 7, login: 'human', __typename: 'User' }, '/phantom\nAllowed edit');
    await f.intake.refresh(f.repo.id);
    assert.equal(
      f.intake.workflow(f.project.id).inputs[0].assessment.disposition.status,
      'context_only',
    );
    assert.equal(f.store.list('message').filter((message) => message.origin).length, 1);
    assert.throws(
      () =>
        f.store.put('sourceInput', original.input.id, {
          ...f.intake.detail(original.input.id).input,
          body: 'changed',
        }),
      /不可修改/,
    );
  } finally {
    await f.close();
  }
});

test('receiving cutoff follows the explicit body request, not later Issue comments', async () => {
  const f = intakeFixture();
  try {
    const since = '2026-01-01T12:00:00.000Z';
    const beforeEdit = await f.github.readIntakeIssues(f.repo, since);
    assert.equal(beforeEdit.length, 0, 'a later Issue update does not renew an old body request');
    f.edit({ databaseId: 7, login: 'human', __typename: 'User' }, '/phantom\nNew body request');
    const afterEdit = await f.github.readIntakeIssues(f.repo, since);
    assert.equal(afterEdit.length, 1);
    assert.equal(afterEdit[0].bodyUpdatedAt, issueObservation.updatedAt);
  } finally {
    await f.close();
  }
});

test('source failures are unavailable, never an empty healthy inbox', async () => {
  const f = intakeFixture();
  try {
    await f.intake.configure(f.repo.id, configuration);
    f.malformed();
    const source = await f.intake.refresh(f.repo.id);
    assert.equal(source.health.status, 'unavailable');
    assert.equal(f.intake.workflow(f.project.id).inputs.length, 0);
  } finally {
    await f.close();
  }
});

test('source admission refuses bots and unaddressed requests without replies', async () => {
  const f = intakeFixture();
  try {
    await f.intake.configure(f.repo.id, configuration);
    f.edit({ databaseId: 7, login: 'human', __typename: 'Bot' });
    await f.intake.refresh(f.repo.id);
    assert.equal(
      f.intake.workflow(f.project.id).inputs[0].assessment.disposition.status,
      'refused',
    );
    f.edit({ databaseId: 7, login: 'human', __typename: 'User' }, 'Please /phantom do this');
    await f.intake.refresh(f.repo.id);
    assert.equal(
      f.intake.workflow(f.project.id).inputs[0].assessment.disposition.status,
      'refused',
    );
    assert.equal(f.store.list('message').length, 0);
    assert.equal(f.writes.length, 0);
  } finally {
    await f.close();
  }
});

test('lost replies adopt paginated evidence after restart without a second write', async () => {
  const f = intakeFixture();
  try {
    const { input, message } = await admitted(f);
    for (let index = 0; index < 45; index++)
      f.comments.push({
        id: index + 1,
        body: 'unrelated',
        html_url: `https://github.com/test/repo/issues/12#issuecomment-${index + 1}`,
        user: { id: 7, login: 'human', type: 'User' },
      });
    f.intake.noAction(message.id, 'This request needs no repository change.');
    const reply = f.intake.detail(input.id).replies[0];
    f.lose();
    await f.intake.sendReply(reply.id);
    assert.equal(f.intake.detail(input.id).replies[0].state.status, 'uncertain');
    assert.equal(f.writes.length, 1);
    const restarted = new Intake(f.store, f.github, async () => {
      throw new Error('No model calls');
    });
    await restarted.reconcileReply(input.id);
    assert.equal(restarted.detail(input.id).replies[0].state.status, 'sent');
    assert.equal(f.writes.length, 1);
    assert.equal(f.comments.at(-1)?.body, reply.body);
  } finally {
    await f.close();
  }
});

test('uncertain absence needs explicit reconciliation; read failure cannot authorize', async () => {
  const f = intakeFixture();
  try {
    const { input, message } = await admitted(f);
    f.intake.noAction(message.id, 'No change needed.');
    const reply = f.intake.detail(input.id).replies[0];
    f.lose();
    f.absent();
    await f.intake.sendReply(reply.id);
    await f.intake.sendReply(reply.id);
    assert.equal(f.writes.length, 1);
    f.failRead();
    await f.intake.reconcileReply(input.id);
    assert.equal(f.writes.length, 1);
    assert.equal(f.store.get('operation', `source-reply:${reply.id}`)?.reconciliation, undefined);
    f.failRead(false);
    await f.intake.reconcileReply(input.id);
    assert.equal(f.writes.length, 2);
    await f.intake.sendReply(reply.id);
    assert.equal(f.writes.length, 2, 'lost controlled retry consumes authorization');
    assert.equal(f.intake.detail(input.id).replies[0].state.status, 'uncertain');
  } finally {
    await f.close();
  }
});

test('imported Issue revision and completion preserve its body and identity', async () => {
  const f = intakeFixture();
  try {
    const { message } = await admitted(f);
    const task = f.store.createTask({
      projectId: f.project.id,
      repoId: f.repo.id,
      sourceMessageId: message.id,
      title: 'One task',
      spec: 'Change',
      acceptance: ['Works'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    await f.github.publishIssue(task);
    await f.github.reviseIssue(task);
    assert.equal(f.writes.length, 0);
    await assert.rejects(f.github.completeIssue(task), /完整完成/);
    const completed = f.store.updateTask(task.id, {
      stage: 'done',
      head: 'head',
      base: 'base',
      completion: {
        source: 'host',
        head: 'head',
        base: 'base',
        completedAt: new Date().toISOString(),
      },
    });
    await f.github.completeIssue(completed);
    await f.github.completeIssue(completed);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0].body, { state: 'closed', state_reason: 'completed' });
    assert.equal(f.remoteIssue().body, issueObservation.body);
  } finally {
    await f.close();
  }
});
