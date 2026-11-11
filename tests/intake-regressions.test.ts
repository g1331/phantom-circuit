import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Engine, mergeReady } from '../src/server/engine.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Previews } from '../src/server/preview.ts';
import { createApp } from '../src/server/app.ts';
import { configuration, intakeFixture } from './intake-fixture.ts';

async function admitted(file = ':memory:') {
  const f = intakeFixture(file);
  await f.intake.configure(f.repo.id, configuration);
  await f.intake.refresh(f.repo.id);
  const inputId = f.intake.workflow(f.project.id).inputs[0].input.id;
  const message = f.intake.dispatchMessage(inputId)!;
  const task = f.store.createTask({
    projectId: f.project.id,
    repoId: f.repo.id,
    sourceMessageId: message.id,
    title: 'One deliverable',
    spec: 'One change',
    acceptance: ['Works'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  return { ...f, inputId, message, task };
}

test('committed no-action stays final after a later PM failure', async () => {
  const f = intakeFixture();
  try {
    await f.intake.configure(f.repo.id, configuration);
    await f.intake.refresh(f.repo.id);
    const inputId = f.intake.workflow(f.project.id).inputs[0].input.id;
    const message = f.intake.dispatchMessage(inputId)!;
    f.intake.noAction(message.id, 'The recorded final answer');
    assert.throws(
      () =>
        f.store.createClarification({
          projectId: f.project.id,
          sourceMessageId: message.id,
          questions: [{ id: 'later', question: 'A conflicting new question?' }],
        }),
      /已记录/,
    );
    assert.equal(f.store.list('clarification').length, 0);
    f.intake.noAction(message.id, 'The recorded final answer');
    assert.throws(() => f.intake.noAction(message.id, 'A conflicting new answer'), /已记录/);
    f.intake.settle(message, new Error('Transport failed after the recorded judgment'));
    assert.deepEqual(f.intake.detail(inputId).assessment.disposition, {
      status: 'no_action',
      messageId: message.id,
      reason: 'The recorded final answer',
    });
    await f.intake.retry(inputId).then(
      () => assert.fail('a completed judgment must not start a new assessment'),
      (error: Error) => assert.match(error.message, /仅可重试/),
    );
    await f.intake.pump(false);
    assert.equal(f.writes.length, 1);
    assert.match(f.comments[0].body, /^The recorded final answer\n/);
    assert.equal(f.intake.detail(inputId).replies.length, 1);
  } finally {
    await f.close();
  }
});

for (const recoveryPolicy of ['automatic', 'manual'] as const) {
  test(`committed no-action survives interrupted PM recovery (${recoveryPolicy})`, async () => {
    const f = intakeFixture();
    let engine: Engine | undefined;
    let calls = 0;
    try {
      f.store.put('project', f.project.id, { ...f.project, recoveryPolicy });
      await f.intake.configure(f.repo.id, configuration);
      await f.intake.refresh(f.repo.id);
      const inputId = f.intake.workflow(f.project.id).inputs[0].input.id;
      const message = f.intake.dispatchMessage(inputId)!;
      const run = f.store.run('pm', f.project.id, 'pm', { sourceMessageId: message.id });
      f.store.updateMessage(message.id, {
        status: 'running',
        draftStatus: 'running',
        runId: run.id,
      });
      f.intake.noAction(message.id, 'A durable no-work answer');
      f.store.finishRun(run.id, 'interrupted');
      engine = new Engine(
        f.store,
        f.github,
        new Workspaces(join(tmpdir(), 'phantom-no-action-unused'), f.store),
        tmpdir(),
        () => {
          calls++;
          throw new Error('A final no-work judgment must not be reassessed');
        },
      );
      await engine.start();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await engine.intake.pump(false);
      assert.equal(calls, 0);
      assert.equal(f.store.get('run', run.id)?.status, 'interrupted');
      assert.equal(f.store.get('message', message.id)?.status, 'completed');
      assert(f.store.list('recovery').every((item) => item.status === 'cancelled'));
      assert.equal(f.writes.length, 1);
      assert.equal(f.store.list('task').length, 0);
    } finally {
      await engine?.stop();
      await f.close();
    }
  });
}

test(
  'task-bound Web steer preserves imported admission ' +
    'and local effective-source behavior after restart',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'phantom-intake-steer-'));
    const file = join(root, 'state.sqlite');
    const f = await admitted(file);
    let closed = false;
    try {
      const local = f.store.addMessage(f.project.id, 'user', 'Local implementation', 'implement');
      const localTask = f.store.createTask({
        projectId: f.project.id,
        repoId: f.repo.id,
        sourceMessageId: local.id,
        title: 'Local task',
        spec: 'Local change',
        acceptance: ['Works'],
        dependencies: [],
        kind: 'backend',
        complexity: 'normal',
        priority: 0,
      });
      const pairs = [f.task, localTask].map((task) => {
        const run = f.store.run('pm', f.project.id, 'pm', task);
        const discuss = f.store.addMessage(f.project.id, 'user', 'Discuss only', 'discuss');
        f.store.acceptRunSource(run.id, discuss.id);
        const implement = f.store.addMessage(
          f.project.id,
          'user',
          'Implement the agreed change',
          'implement',
        );
        f.store.acceptRunSource(run.id, implement.id);
        const final = f.store.addMessage(
          f.project.id,
          'user',
          'Discuss the result only',
          'discuss',
        );
        f.store.acceptRunSource(run.id, final.id);
        f.store.finishRun(run.id, 'completed');
        return { task, run, final };
      });
      await f.close();
      closed = true;
      const store = new Store(file);
      try {
        for (const { task, run, final } of pairs) {
          assert.equal(store.get('run', run.id)?.sourceMessageId, final.id);
          assert.equal(store.get('run', run.id)?.sourceIntent, 'discuss');
          assert.equal(
            store.task(task.id).sourceMessageId,
            task.issueOrigin ? f.message.id : final.id,
          );
          assert.doesNotThrow(() => store.assertTaskExecutable(task.id));
        }
        assert.deepEqual(store.task(f.task.id).issueOrigin, f.task.issueOrigin);
        assert.equal(store.sourceTask(f.message.id, f.project.id, f.task.id).id, f.task.id);
      } finally {
        store.close();
      }
    } finally {
      if (!closed) await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

const invalidations: Record<string, (f: Awaited<ReturnType<typeof admitted>>) => void> = {
  revised: (f) =>
    f.store.updateTask(f.task.id, {
      stage: 'ready',
      head: 'new-head',
      tests: [],
      reviews: [],
      mergeApproval: undefined,
    }),
  paused: (f) => f.store.control(f.task.id, 'pause'),
  cancelled: (f) => f.store.control(f.task.id, 'cancel'),
  head: (f) => f.store.updateTask(f.task.id, { head: 'new-head' }),
  base: (f) => f.store.updateTask(f.task.id, { base: 'new-base' }),
  tests: (f) => f.store.updateTask(f.task.id, { tests: [] }),
  review: (f) => f.store.updateTask(f.task.id, { reviews: [] }),
  approval: (f) => f.store.updateTask(f.task.id, { mergeApproval: undefined }),
  source: (f) =>
    f.store.updateTask(f.task.id, {
      sourceMessageId: f.store.addMessage(f.project.id, 'user', 'Different request', 'implement')
        .id,
    }),
  origin: (f) =>
    f.store.updateTask(f.task.id, {
      issueOrigin: { kind: 'external', inputId: 'other-input', assessmentId: 'other-assessment' },
    }),
  admission: (f) => {
    const assessment = f.intake.detail(f.inputId).assessment;
    f.store.put('inputAssessment', assessment.id, {
      ...assessment,
      disposition: {
        status: 'unavailable',
        messageId: f.message.id,
        reason: 'Scope requires reassessment',
      },
    });
  },
  team: (f) =>
    f.store.put('project', f.project.id, {
      ...f.store.project(f.project.id),
      admissionPaused: true,
    }),
};

for (const [name, invalidate] of Object.entries(invalidations)) {
  test(`imported completion rejects ${name} during the remote merge read`, async () => {
    const f = await admitted();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      f.store.updateTask(f.task.id, {
        stage: 'merging',
        head: 'old-head',
        base: 'base',
        pr: 22,
        mergeApproval: { head: 'old-head', base: 'base' },
        tests: [{ command: 'test', exitCode: 0, output: 'pass', head: 'old-head', at: 'now' }],
        reviews: [
          {
            axis: 'primary',
            head: 'old-head',
            base: 'base',
            approved: true,
            verdict: 'pass',
            findings: [],
            summary: 'pass',
          },
        ],
      });
      assert(mergeReady(f.store.task(f.task.id)));
      let reads = 0;
      f.github.pull = async () => {
        if (++reads === 2) {
          entered();
          await gate;
        }
        return {
          number: 22,
          html_url: '',
          state: 'closed',
          merged: true,
          head: { sha: 'old-head' },
          base: { sha: 'base' },
          mergeable: true,
          mergeable_state: 'clean',
          body: '',
        };
      };
      const pending = f.engine.sync();
      await reading;
      invalidate(f);
      release();
      await pending;
      const task = f.store.task(f.task.id);
      assert.notEqual(task.stage, 'done');
      assert.equal(task.completion, undefined);
      assert.equal(f.writes.length, 0, 'stale completion must not close the original Issue');
      assert.equal(f.intake.detail(f.inputId).replies.length, 0);
    } finally {
      release();
      await f.close();
    }
  });
}

test('input retry safely recovers a pre-write unavailable reply without reassessment', async () => {
  const f = intakeFixture();
  const app = createApp(
    f.store,
    f.engine,
    new Previews(f.store, new Workspaces('/unused', f.store)),
  );
  try {
    await f.intake.configure(f.repo.id, configuration);
    await f.intake.refresh(f.repo.id);
    const inputId = f.intake.workflow(f.project.id).inputs[0].input.id;
    const message = f.intake.dispatchMessage(inputId)!;
    f.intake.noAction(message.id, 'No change required.');
    const before = f.intake.detail(inputId);
    const reply = before.replies[0];
    f.failRead();
    await f.intake.sendReply(reply.id);
    assert.equal(f.intake.detail(inputId).replies[0].state.status, 'unavailable');
    assert.equal(f.store.get('operation', `source-reply:${reply.id}`), undefined);
    f.store.put('project', f.project.id, {
      ...f.store.project(f.project.id),
      admissionPaused: true,
    });
    await assert.rejects(f.intake.retry(inputId), /暂停/);
    assert.equal(f.intake.detail(inputId).replies[0].state.status, 'unavailable');
    assert.equal(f.writes.length, 0);
    f.store.put('project', f.project.id, {
      ...f.store.project(f.project.id),
      admissionPaused: false,
    });
    f.failRead(false);
    const session = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
    const headers = {
      host: '127.0.0.1:4317',
      cookie: String(session.headers['set-cookie']).split(';')[0],
      'x-phantom-csrf': session.json().csrf,
    };
    const response = await app.inject({
      method: 'POST',
      url: `/api/inputs/${inputId}/retry`,
      headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    const after = f.intake.detail(inputId);
    assert.equal(after.replies[0].state.status, 'sent');
    assert.equal(after.replies[0].body, reply.body);
    assert.equal(after.replies[0].id, reply.id);
    assert.deepEqual(after.assessment, before.assessment);
    assert.equal(f.store.list('run').length, 0);
    assert.equal(f.store.list('task').length, 0);
    assert.equal(f.store.list('message').filter((item) => item.origin).length, 1);
    assert.equal(f.writes.length, 1);
    assert.equal(
      (await app.inject({ method: 'POST', url: `/api/inputs/${inputId}/retry`, headers }))
        .statusCode,
      409,
    );
    await f.intake.pump(false);
    assert.equal(f.writes.length, 1);
  } finally {
    await app.close();
    await f.close();
  }
});

test('input retry cannot replace uncertain Operation reconciliation', async () => {
  const f = intakeFixture();
  try {
    await f.intake.configure(f.repo.id, configuration);
    await f.intake.refresh(f.repo.id);
    const inputId = f.intake.workflow(f.project.id).inputs[0].input.id;
    const message = f.intake.dispatchMessage(inputId)!;
    f.intake.noAction(message.id, 'No change required.');
    const reply = f.intake.detail(inputId).replies[0];
    f.lose();
    await f.intake.sendReply(reply.id);
    assert.equal(f.intake.detail(inputId).replies[0].state.status, 'uncertain');
    await assert.rejects(f.intake.retry(inputId), /重试|核对/);
    assert.equal(f.writes.length, 1);
  } finally {
    await f.close();
  }
});

test(
  'imported external settlement durably queues one original-Issue outcome ' +
    'without local evidence claims',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'phantom-intake-external-'));
    const file = join(root, 'state.sqlite');
    const f = await admitted(file);
    let closed = false;
    try {
      const remote = {
        repoId: f.repo.id,
        repository: f.repo.github,
        pr: 22,
        url: 'https://github.com/test/repo/pull/22',
        head: 'remote-head',
        base: 'remote-base',
        baseRef: 'main',
        mergeCommit: 'merge-commit',
        mergedAt: '2026-01-03T00:00:00.000Z',
        checkedAt: '2026-01-04T00:00:00.000Z',
      };
      const before = f.store.updateTask(f.task.id, {
        stage: 'developing',
        head: 'local-head',
        base: 'local-base',
        control: 'paused',
        pausedByUser: true,
        pr: 22,
        prUrl: remote.url,
        issueState: 'completed',
        prState: 'merged',
        remoteMerge: remote,
      });
      const evidence = {
        issue: 12,
        primary: remote,
        closing: remote,
        closedAt: '2026-01-03T00:00:00.000Z',
        checkedAt: '2026-01-04T00:00:00.000Z',
        relationship: {
          primaryReferencesIssue: true,
          closingReferencesIssue: true,
          closureEventAt: '2026-01-03T00:00:00.000Z',
        },
      } satisfies Parameters<Store['completeExternalTask']>[1];
      f.store.completeExternalTask(f.task.id, evidence);
      f.store.completeExternalTask(f.task.id, evidence);
      await f.close();
      closed = true;
      const store = new Store(file);
      class Remote extends GitHub {
        override async gh(args: string[], input?: string) {
          return f.github.gh(args, input);
        }
        override async syncStatus() {
          throw new Error('External settlement must not resync engineering status');
        }
      }
      const engine = new Engine(
        store,
        new Remote(store),
        new Workspaces(join(root, 'ws'), store),
        root,
        () => {
          throw new Error('Model calls forbidden');
        },
      );
      const reopened = {
        async close() {
          await engine.stop();
          store.close();
        },
      };
      try {
        assert.equal(store.task(f.task.id).completionDeliveryPending, true);
        await engine.sync();
        await engine.intake.pump(false);
        await engine.sync();
        await engine.intake.pump(false);
        const detail = engine.intake.detail(f.inputId);
        assert.equal(detail.replies.length, 1);
        assert.equal(detail.replies[0].purpose.kind, 'outcome');
        assert.equal(detail.replies[0].issue, 12);
        assert.equal(detail.replies[0].state.status, 'sent');
        assert.match(detail.replies[0].body, /远端交付结案/);
        assert.match(detail.replies[0].body, /本机验证与评审保留原记录/);
        assert.equal(f.writes.length, 1);
        assert.equal(
          store
            .list('message')
            .filter((item) => item.descriptor?.code === 'delivery_external_completed').length,
          1,
        );
        const settled = store.task(f.task.id);
        assert.equal(settled.completionDeliveryPending, false);
        assert.equal(settled.completion?.source, 'external');
        assert.equal(settled.control, 'paused');
        assert.equal(settled.pausedByUser, true);
        assert.equal(settled.head, before.head);
        assert.deepEqual(settled.tests, before.tests);
        assert.deepEqual(settled.reviews, before.reviews);
        assert.equal(mergeReady(settled), false);
      } finally {
        await reopened.close();
      }
    } finally {
      if (!closed) await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
