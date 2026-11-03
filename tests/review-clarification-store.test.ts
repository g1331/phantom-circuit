import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { mergeReady } from '../src/server/engine.ts';

function fixture() {
  const store = new Store(':memory:');
  const project = store.createProject('Review questions', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'repo',
    path: '/fixture',
    github: 'fixture/repo',
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
  const pinned = store.updateTask(task.id, {
    stage: 'reviewing',
    head: 'head',
    base: 'base',
    tests: [{ command: 'test', head: 'head', exitCode: 0, output: '', at: 'now' }],
  });
  const run = store.run('review', project.id, 'review', pinned, { reviewAxis: 'primary' });
  const result = {
    approved: false,
    verdict: 'needs_user',
    summary: 'Need retention policy',
    findings: [],
    head: 'head',
    base: 'base',
    questions: [
      { question: 'How long must records be retained?' },
      { question: 'Who can access archived records?' },
    ],
  };
  return { store, project, task, run, result };
}

test('review questions atomically pause one task, retain evidence and resume one same-role Run after complete answers', () => {
  const { store, project, task, run, result } = fixture();
  try {
    const clarification = store.recordReviewClarification(run.id, result);
    assert.equal(store.recordReviewClarification(run.id, result).id, clarification.id);
    assert.equal(store.list('clarification').length, 1);
    assert.deepEqual(clarification.review, {
      runId: run.id,
      axis: 'primary',
      head: 'head',
      base: 'base',
    });
    assert.equal(store.task(task.id).control, 'paused');
    assert.equal(store.task(task.id).retries, 0);
    assert.equal(store.claimNext(), undefined);
    assert.equal(mergeReady(store.task(task.id)), false);
    store.answerClarification(project.id, clarification.id, { q1: 'Seven years' });
    assert.equal(store.claimClarificationReview(clarification.id), undefined);
    assert.equal(
      store.answerClarification(project.id, clarification.id, { q2: 'Administrators' }).status,
      'answered',
    );
    const successor = store.claimClarificationReview(clarification.id)!;
    assert.equal(successor.role, 'review');
    assert.equal(successor.reviewAxis, 'primary');
    assert.deepEqual(successor.revision, { head: 'head', base: 'base' });
    assert.equal(store.claimClarificationReview(clarification.id), undefined);
    assert.equal(store.task(task.id).tests.length, 1);
    assert.equal(store.task(task.id).reviews[0].verdict, 'needs_user');
    assert.equal(store.task(task.id).reviews[0].supersededByRunId, successor.id);
    assert.equal(mergeReady(store.task(task.id)), false);
  } finally {
    store.close();
  }
});

test('review question validation rejects invalid questions, cross-Project/Run and revision bindings without partial writes', () => {
  const { store, project, task, run, result } = fixture();
  try {
    for (const questions of [
      [],
      [{ question: '   ' }],
      Array.from({ length: 4 }, () => ({ question: 'Which?' })),
      [
        { id: 'q', question: 'Which?' },
        { id: 'q', question: 'Why?' },
      ],
    ]) {
      assert.throws(() => store.recordReviewClarification(run.id, { ...result, questions }));
    }
    assert.throws(() => store.recordReviewClarification(run.id, { ...result, head: 'other' }));
    assert.throws(() => store.recordReviewClarification(run.id, { ...result, approved: true }));
    const foreign = store.run('review', store.createProject('Other', '').id, 'review');
    assert.throws(() => store.recordReviewClarification(foreign.id, result));
    assert.equal(store.list('clarification').length, 0);
    assert.equal(store.task(task.id).control, 'active');
    const clarification = store.recordReviewClarification(run.id, result);
    assert.throws(() =>
      store.answerClarification(foreign.projectId, clarification.id, { q1: 'no' }),
    );
    assert.throws(() => store.answerClarification(project.id, clarification.id, { q1: '   ' }));
    store.answerClarification(project.id, clarification.id, { q1: 'A', q2: 'B' });
    store.control(task.id, 'pause');
    assert.equal(store.claimClarificationReview(clarification.id), undefined);
    assert.equal(store.task(task.id).pausedByUser, true);
    store.control(task.id, 'resume');
    store.updateTask(task.id, { head: 'changed' });
    assert.equal(store.claimClarificationReview(clarification.id), undefined);
    assert.equal(store.list('run').filter((r) => r.taskId === task.id).length, 1);
  } finally {
    store.close();
  }
});

for (const stage of ['done', 'cancelled'] as const)
  test(`answering a review wait preserves the terminal ${stage} state`, () => {
    const { store, project, task, run, result } = fixture();
    try {
      const c = store.recordReviewClarification(run.id, result);
      store.updateTask(task.id, { stage, control: 'paused' });
      store.answerClarification(project.id, c.id, { q1: 'Seven years', q2: 'Administrators' });
      assert.equal(store.claimClarificationReview(c.id), undefined);
      assert.equal(store.task(task.id).stage, stage);
      assert.equal(store.task(task.id).control, 'paused');
    } finally {
      store.close();
    }
  });

test('a review wait affects only its Task, even when Tasks share the original source intent', () => {
  const { store, project, task, run, result } = fixture();
  try {
    const first = store.recordReviewClarification(run.id, result);
    const sibling = store.createTask({
      projectId: project.id,
      repoId: task.repoId,
      sourceMessageId: task.sourceMessageId,
      title: 'Sibling',
      spec: 'Other work',
      acceptance: ['Done'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    const pinned = store.updateTask(sibling.id, {
      stage: 'reviewing',
      head: 'other-head',
      base: 'base',
    });
    const siblingRun = store.run('review', project.id, 'review', pinned, { reviewAxis: 'primary' });
    const second = store.recordReviewClarification(siblingRun.id, {
      ...result,
      head: 'other-head',
    });
    assert.notEqual(second.id, first.id);
    assert.equal(store.list('clarification').length, 2);
    store.answerClarification(project.id, first.id, { q1: 'A', q2: 'B' });
    assert.equal(store.get('clarification', second.id)?.status, 'open');
    assert.equal(store.task(sibling.id).reviewClarificationId, second.id);
  } finally {
    store.close();
  }
});

test('a finished Run cannot submit a fresh user wait even if its revision still matches', () => {
  const { store, task, run, result } = fixture();
  try {
    store.finishRun(run.id, 'failed');
    assert.throws(() => store.recordReviewClarification(run.id, result), /Review Run 已结束/);
    assert.equal(store.list('clarification').length, 0);
    assert.equal(store.task(task.id).control, 'active');
  } finally {
    store.close();
  }
});

for (const count of [1, 3])
  test(`a review can ask ${count} questions and retain a later question round on the same version`, () => {
    const { store, project, task, run, result } = fixture();
    try {
      const c = store.recordReviewClarification(run.id, {
        ...result,
        questions: Array.from({ length: count }, (_, i) => ({
          question: `What is the policy for audience ${i + 1}?`,
        })),
      });
      assert.equal(c.questions.length, count);
      store.answerClarification(
        project.id,
        c.id,
        Object.fromEntries(c.questions.map((q) => [q.id, 'User policy'])),
      );
      const successor = store.claimClarificationReview(c.id)!;
      const second = store.recordReviewClarification(successor.id, result);
      assert.notEqual(second.id, c.id);
      assert.equal(store.task(task.id).reviews.filter((r) => r.verdict === 'needs_user').length, 2);
      assert.equal(store.task(task.id).reviews[0].supersededByRunId, successor.id);
      assert.equal(store.get('clarification', c.id)?.answers?.[0].value, 'User policy');
      assert.equal(store.task(task.id).reviewClarificationId, second.id);
      assert.equal(store.task(task.id).retries, 0);
      assert.equal(mergeReady(store.task(task.id)), false);
    } finally {
      store.close();
    }
  });
