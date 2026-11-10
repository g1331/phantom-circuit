import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { Fault, Store } from '../src/server/store.ts';
import { Engine, ROLE_ALLOWED_TOOLS, mergeReady } from '../src/server/engine.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Codex } from '../src/server/codex.ts';
import type { Task } from '../src/shared/types.ts';

test('one Run sums distinct turn usage and does not double count repeated snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-turn-usage-'));
  const store = new Store(':memory:');
  const project = store.createProject('Usage', '');
  store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
  class UsageAgent extends Codex {
    override async start() {}
    override async stop() {}
    override async thread() {
      return 'usage-session';
    }
    override async turn() {
      for (const [turnId, inputTokens, outputTokens] of [
        ['first', 10, 2],
        ['first', 10, 2],
        ['second', 20, 3],
      ] as const) {
        this.emit('notification', 'thread/tokenUsage/updated', {
          threadId: 'usage-session',
          turnId,
          usage: { turnId, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
        });
      }
      return 'Usage recorded';
    }
  }
  const engine = new Engine(
    store,
    new GitHub(store),
    new Workspaces(join(root, 'workspaces'), store),
    root,
    () => new UsageAgent(),
  );
  try {
    await engine.chat(store.addMessage(project.id, 'user', 'Discuss only', 'discuss'));
    const usage = store.list('run')[0].usage;
    assert.equal(usage?.inputTokens, 30);
    assert.equal(usage?.outputTokens, 5);
    assert.equal(usage?.totalTokens, 35);
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

function policyTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task',
    projectId: 'project',
    repoId: 'repo',
    title: 'Policy task',
    spec: 'spec',
    acceptance: ['accepted'],
    dependencies: [],
    sourceMessageId: 'source',
    kind: 'backend',
    complexity: 'normal',
    profile: 'backend',
    routingReason: 'test',
    priority: 0,
    stage: 'reviewing',
    control: 'active',
    head: 'head',
    base: 'base',
    tests: [{ command: 'test', exitCode: 0, output: 'ok', head: 'head', at: 'now' }],
    reviews: [],
    retries: 0,
    feedback: [],
    createdAt: 'now',
    updatedAt: 'now',
    reviewPolicyVersion: 2,
    ...overrides,
  };
}

test('OMP role allowlists contain only installed tools and policy 2 accepts primary escalation only with a secondary pass', () => {
  assert.deepEqual(ROLE_ALLOWED_TOOLS.pm, ['read', 'grep', 'glob']);
  assert.deepEqual(ROLE_ALLOWED_TOOLS.dev, ['read', 'bash', 'edit', 'write', 'grep', 'glob']);
  assert.deepEqual(ROLE_ALLOWED_TOOLS.review, ['read', 'bash', 'grep', 'glob']);

  const task = policyTask({
    secondaryReviewRequired: true,
    reviews: [
      {
        axis: 'primary',
        head: 'head',
        base: 'base',
        approved: true,
        summary: 'Escalate for a second independent pass',
        findings: [],
        verdict: 'escalate',
      },
      {
        axis: 'secondary',
        head: 'head',
        base: 'base',
        approved: true,
        summary: 'Pass',
        findings: [],
        verdict: 'pass',
      },
    ],
  });
  assert.equal(mergeReady(task), true);
  assert.equal(
    mergeReady({
      ...task,
      reviews: task.reviews.map((review) =>
        review.axis === 'secondary' ? { ...review, verdict: 'escalate' as const } : review,
      ),
    }),
    false,
  );
});

test('steer operations remain uncertain without proof and only an accepted operation changes authority', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject('Steer', '');
    store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
    const original = store.addMessage(
      project.id,
      'user',
      'Implement the original behavior',
      'implement',
    );
    const latest = store.addMessage(
      project.id,
      'user',
      'Actually, discuss the behavior first',
      'discuss',
    );
    const run = store.run('pm', project.id, 'pm', { sourceMessageId: original.id });
    store.bindRunThread(run, 'thread-1');

    const operation = store.beginSteer(run.id, latest.id);
    assert.equal(operation.status, 'pending');
    assert.equal(store.get('run', run.id)?.sourceMessageId, original.id);
    store.finishSteer(operation.id, 'uncertain', 'transport closed');
    assert.equal(store.get('run', run.id)?.sourceMessageId, original.id);
    assert.equal(store.get('operation', operation.id)?.status, 'uncertain');

    // A later host reconciliation proves acceptance exactly once; the downgraded discuss intent
    // is now the authority seen by subsequent PM tool calls.
    store.finishSteer(operation.id, 'done', 'history accepted', true);
    assert.equal(store.get('run', run.id)?.sourceMessageId, latest.id);
    assert.equal(store.get('run', run.id)?.sourceIntent, 'discuss');
  } finally {
    store.close();
  }
});

test('steer during PM preparation keeps one Run and changes authority only after ack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-pm-preparing-steer-'));
  const store = new Store(':memory:');
  function gate() {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }
  const preparing = gate();
  const preparation = gate();
  const turnStarted = gate();
  const steerReceived = gate();
  const acknowledgement = gate();
  const completion = gate();
  const steerCalls: Parameters<Codex['steer']>[] = [];
  let threadCreated = false;
  let turnOpen = false;
  let turns = 0;
  class PreparingCodex extends Codex {
    override async start() {}
    override async stop() {}
    override async thread() {
      threadCreated = true;
      return 'preparing-thread';
    }
    override async turn(...args: Parameters<Codex['turn']>) {
      turns++;
      turnOpen = true;
      args[5]?.('original-turn');
      turnStarted.release();
      await completion.promise;
      turnOpen = false;
      return 'The updated goal is included in this reply';
    }
    override async steer(...args: Parameters<Codex['steer']>) {
      steerCalls.push(args);
      if (!turnOpen) throw new Fault('Codex 会话没有可 steer 的运行中回合', 409);
      steerReceived.release();
      await acknowledgement.promise;
    }
  }
  class PreparingWorkspaces extends Workspaces {
    override async view() {
      assert.equal(threadCreated, true);
      preparing.release();
      await preparation.promise;
      return root;
    }
  }
  const project = store.createProject('Preparing PM steer', '');
  store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
  store.createRepo({
    projectId: project.id,
    name: 'Context',
    path: root,
    github: 'fixture/context',
    defaultBranch: 'main',
    authorized: false,
  });
  const source = store.addMessage(project.id, 'user', 'ping', 'discuss');
  const engine = new Engine(
    store,
    new GitHub(store),
    new PreparingWorkspaces(join(root, 'workspaces'), store),
    root,
    () => new PreparingCodex(),
  );
  const pending: Promise<string>[] = [];
  try {
    const ping = engine.chat(source);
    pending.push(ping);
    await preparing.promise;
    const [run] = store.list('run');
    assert.ok(run);
    assert.equal(run.threadId, 'preparing-thread');
    assert.equal(run.turnId, undefined);
    assert.equal(turns, 0);
    const steer = store.addMessage(
      project.id,
      'user',
      'Implement the updated goal in this reply',
      'implement',
      undefined,
      { deliveryMode: 'steer' },
    );
    const redirect = engine.chat(steer);
    pending.push(redirect);
    await setImmediate();
    assert.equal(
      store.get('message', steer.id)?.deliveryMode,
      'steer',
      'preparing PM must retain steer delivery instead of queueing a new turn',
    );
    assert.equal(steerCalls.length, 0, 'native steer must wait until the turn is open');
    assert.equal(store.list('run').length, 1);
    assert.equal(store.get('run', run.id)?.sourceMessageId, source.id);
    assert.equal(store.get('run', run.id)?.sourceIntent, 'discuss');

    preparation.release();
    await turnStarted.promise;
    await steerReceived.promise;
    assert.equal(steerCalls.length, 1);
    assert.equal(steerCalls[0][0], 'preparing-thread');
    assert.equal(steerCalls[0][1], steer.content);
    assert.equal(steerCalls[0][2]?.clientUserMessageId, steer.id);
    assert.equal(store.get('run', run.id)?.sourceMessageId, source.id);
    assert.equal(store.get('run', run.id)?.sourceIntent, 'discuss');

    acknowledgement.release();
    await redirect;
    assert.equal(store.get('run', run.id)?.sourceMessageId, steer.id);
    assert.equal(store.get('run', run.id)?.sourceIntent, 'implement');
    assert.equal(store.get('message', steer.id)?.status, 'completed');
    completion.release();
    await ping;
    assert.equal(store.get('run', run.id)?.status, 'completed');
    assert.equal(store.list('run').length, 1);
    assert.equal(turns, 1);
    assert.equal(steerCalls.length, 1);
    assert.equal(store.get('message', steer.id)?.deliveryMode, 'steer');
  } finally {
    preparing.release();
    preparation.release();
    turnStarted.release();
    steerReceived.release();
    acknowledgement.release();
    completion.release();
    try {
      await Promise.allSettled(pending);
      await engine.stop();
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('request_clarification pauses the PM Run without an Incident and leaves one durable assistant draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-engine-takeover-'));
  const store = new Store(join(root, 'state.sqlite'));
  class ClarifyingCodex extends Codex {
    handler?: Parameters<Codex['thread']>[0]['toolHandler'];
    override async start() {}
    override async stop() {}
    override async thread(options: Parameters<Codex['thread']>[0]) {
      this.handler = options.toolHandler;
      return 'pm-thread';
    }
    override async turn() {
      await this.handler?.('request_clarification', {
        sourceMessageId: source.id,
        questions: [{ id: 'q1', question: 'Which product behavior should apply?' }],
      });
      return 'unreachable';
    }
  }
  const project = store.createProject('Clarification', '');
  store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
  const source = store.addMessage(
    project.id,
    'user',
    'Implement an ambiguous behavior',
    'implement',
  );
  const engine = new Engine(
    store,
    new GitHub(store),
    new Workspaces(join(root, 'workspaces'), store),
    root,
    () => new ClarifyingCodex(),
  );
  try {
    await engine.chat(source);
    const clarifications = store.list('clarification');
    assert.equal(clarifications.length, 1);
    assert.equal(clarifications[0].status, 'open');
    assert.equal(clarifications[0].sourceMessageId, source.id);
    const runs = store.list('run');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'waiting');
    assert.equal(store.list('incident').length, 0);
    const drafts = store.list('message').filter((message) => message.role === 'assistant');
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].draftStatus, 'completed');
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery successor creation is idempotent and preserves the interrupted PM context', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject('Recovery', '');
    store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
    const source = store.addMessage(project.id, 'user', 'Continue the PM decision', 'implement');
    const oldRun = store.run('pm', project.id, 'pm', { sourceMessageId: source.id });
    store.bindRunThread(oldRun, 'pm-thread');
    store.finishRun(oldRun.id, 'interrupted', 'service restart');
    // recover() only creates an item for an active Run; restore the interrupted state as an
    // active persisted row to model the process boundary.
    store.put('run', oldRun.id, {
      ...store.get('run', oldRun.id)!,
      status: 'running',
      endedAt: undefined,
    });
    const item = store.recover()[0];
    assert.ok(item);
    const first = store.ensureRecoverySuccessor(item.id, {
      role: 'pm',
      profile: 'pm',
      sourceMessageId: source.id,
      recoveryPrompt: source.content,
    });
    const second = store.ensureRecoverySuccessor(item.id, {
      role: 'pm',
      profile: 'pm',
      sourceMessageId: source.id,
      recoveryPrompt: source.content,
    });
    assert.equal(first.id, second.id);
    assert.equal(store.get('recovery', item.id)?.successorRunId, first.id);
    assert.equal(store.get('run', first.id)?.recoveryItemId, item.id);
    assert.equal(store.get('run', first.id)?.resumeThreadId, 'pm-thread');
  } finally {
    store.close();
  }
});
