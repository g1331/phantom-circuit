import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Engine } from '../src/server/engine.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { configuration, intakeFixture } from './intake-fixture.ts';

const taskData = (projectId: string, repoId: string, sourceMessageId: string, title: string) => ({
  projectId,
  repoId,
  sourceMessageId,
  title,
  spec: 'Build',
  acceptance: ['Works'],
  dependencies: [],
  kind: 'backend' as const,
  complexity: 'normal' as const,
  priority: 0,
});

test('admission hold survives restart without releasing individual pauses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-intake-pause-'));
  const file = join(root, 'state.sqlite');
  const f = intakeFixture(file);
  let closed = false;
  try {
    const message = f.store.addMessage(f.project.id, 'user', 'Local request', 'implement');
    const individuallyPaused = f.store.createTask(
      taskData(f.project.id, f.repo.id, message.id, 'Individual'),
    );
    const teamPaused = f.store.createTask(taskData(f.project.id, f.repo.id, message.id, 'Team'));
    f.store.control(individuallyPaused.id, 'pause', { source: 'user', reason: 'task_pause' });
    await f.intake.configure(f.repo.id, configuration);
    await f.engine.team(f.project.id, 'pause');
    await f.intake.refresh(f.repo.id);
    const inputId = f.intake.workflow(f.project.id).inputs[0].input.id;
    assert.equal(f.intake.detail(inputId).assessment.disposition.status, 'queued');
    assert.equal(f.intake.dispatchMessage(inputId), undefined);
    assert.equal(
      f.store.repo(f.repo.id).enabled,
      false,
      'team pause does not redefine work switch',
    );
    await f.close();
    closed = true;
    const store = new Store(file);
    class NoNetwork extends GitHub {
      override async gh(): Promise<never> {
        throw new Error('No remote calls permitted');
      }
    }
    const engine = new Engine(
      store,
      new NoNetwork(store),
      new Workspaces(join(root, 'ws'), store),
      root,
    );
    const reopened = {
      async close() {
        await engine.stop();
        store.close();
      },
    };
    try {
      assert.equal(store.project(f.project.id).admissionPaused, true);
      assert.equal(engine.intake.dispatchMessage(inputId), undefined);
      await engine.team(f.project.id, 'resume');
      assert.equal(store.project(f.project.id).admissionPaused, false);
      assert.equal(store.task(individuallyPaused.id).control, 'paused');
      assert.equal(store.task(teamPaused.id).control, 'active');
      assert(engine.intake.dispatchMessage(inputId)?.origin);
    } finally {
      await reopened.close();
    }
  } finally {
    if (!closed) await f.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('admitted authority survives settings changes; stale policy cannot start work', async () => {
  const f = intakeFixture();
  try {
    await f.intake.configure(f.repo.id, configuration);
    await f.intake.refresh(f.repo.id);
    const inputId = f.intake.workflow(f.project.id).inputs[0].input.id;
    const message = f.intake.dispatchMessage(inputId)!;
    await f.intake.configure(f.repo.id, {
      ...configuration,
      enabled: false,
      allowedActors: [],
      expectedVersion: 1,
    });
    const task = f.store.createTask(
      taskData(f.project.id, f.repo.id, message.id, 'Accepted request'),
    );
    assert.equal(task.issue, 12);
    assert.equal(
      f.store.sourceAuthority(message.id, f.project.id).external?.assessment.admission
        ?.policyVersion,
      1,
    );
    const other = f.store.createRepo({
      projectId: f.project.id,
      name: 'other',
      path: '/other',
      github: 'test/other',
      defaultBranch: 'main',
      authorized: true,
    });
    assert.throws(
      () => f.store.createTask(taskData(f.project.id, other.id, message.id, 'Wrong repository')),
      /授权证据/,
    );
  } finally {
    await f.close();
  }

  const stale = intakeFixture();
  try {
    await stale.intake.configure(stale.repo.id, configuration);
    await stale.intake.refresh(stale.repo.id);
    const inputId = stale.intake.workflow(stale.project.id).inputs[0].input.id;
    await stale.intake.configure(stale.repo.id, { ...configuration, expectedVersion: 1 });
    assert.equal(stale.intake.dispatchMessage(inputId), undefined);
    assert.equal(stale.intake.detail(inputId).assessment.disposition.status, 'unavailable');
    await assert.rejects(stale.intake.retry(inputId), /策略已变化/);
    assert.equal(stale.store.list('task').length, 0);
    assert.equal(stale.store.list('message').length, 0);
  } finally {
    await stale.close();
  }
});

test('uncertain reply survives SQLite restart and adopts its original Operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-intake-reply-restart-'));
  const file = join(root, 'state.sqlite');
  const f = intakeFixture(file);
  let closed = false;
  try {
    await f.intake.configure(f.repo.id, configuration);
    await f.intake.refresh(f.repo.id);
    const inputId = f.intake.workflow(f.project.id).inputs[0].input.id;
    const message = f.intake.dispatchMessage(inputId)!;
    f.intake.noAction(message.id, 'No change needed for this request.');
    const reply = f.intake.detail(inputId).replies[0];
    f.lose();
    await f.intake.sendReply(reply.id);
    assert.equal(f.intake.detail(inputId).replies[0].state.status, 'uncertain');
    assert.equal(f.writes.length, 1);
    await f.close();
    closed = true;
    const store = new Store(file);
    let writes = 0;
    class Remote extends GitHub {
      override async gh(args: string[]) {
        if (args[args.indexOf('--method') + 1] !== 'GET') {
          writes++;
          throw new Error('Unexpected duplicate write');
        }
        const result = args[1] === 'user' ? { id: 7 } : f.comments;
        return { stdout: JSON.stringify(result), stderr: '', code: 0 };
      }
    }
    const engine = new Engine(
      store,
      new Remote(store),
      new Workspaces(join(root, 'ws'), store),
      root,
    );
    const reopened = {
      async close() {
        await engine.stop();
        store.close();
      },
    };
    try {
      assert.equal(engine.intake.detail(inputId).replies[0].body, reply.body);
      await engine.intake.reconcileReply(inputId);
      await engine.intake.reconcileReply(inputId);
      assert.equal(engine.intake.detail(inputId).replies[0].state.status, 'sent');
      assert.equal(store.get('operation', `source-reply:${reply.id}`)?.status, 'done');
      assert.equal(writes, 0);
      assert.equal(f.writes.length, 1);
    } finally {
      await reopened.close();
    }
  } finally {
    if (!closed) await f.close();
    await rm(root, { recursive: true, force: true });
  }
});
