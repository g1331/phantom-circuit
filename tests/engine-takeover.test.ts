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

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function steeringFixture(
  options: {
    prepareFailure?: boolean;
    steerFailure?: 'ended' | 'uncertain' | 'ended-after-ack';
    shortTurn?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'phantom-steer-lifecycle-'));
  const store = new Store(':memory:');
  const project = store.createProject('Steer lifecycle', '');
  store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
  const preparing = deferred();
  const preparation = deferred();
  const started = deferred();
  const completion = deferred();
  const received = deferred();
  const acknowledgements = [deferred(), deferred()];
  const calls: Parameters<Codex['steer']>[] = [];
  let turns = 0;
  class LifecycleAgent extends Codex {
    override async start() {
      preparing.release();
      await preparation.promise;
      if (options.prepareFailure) throw new Error('preparation failed');
    }
    override async stop() {
      completion.release();
    }
    override async thread() {
      return 'lifecycle-thread';
    }
    override async turn(...args: Parameters<Codex['turn']>) {
      turns++;
      args[5]?.(`turn-${turns}`);
      started.release();
      if (!options.shortTurn) await completion.promise;
      return 'reply';
    }
    override async steer(...args: Parameters<Codex['steer']>) {
      calls.push(args);
      received.release();
      if (options.steerFailure === 'ended') throw new Fault('turn ended', 409);
      if (options.steerFailure === 'uncertain') throw new Error('lost acknowledgement');
      await acknowledgements[calls.length - 1]?.promise;
      if (options.steerFailure === 'ended-after-ack') throw new Fault('turn ended', 409);
    }
  }
  const engine = new Engine(
    store,
    new GitHub(store),
    new Workspaces(join(root, 'workspaces'), store),
    root,
    () => new LifecycleAgent(),
  );
  const source = store.addMessage(project.id, 'user', 'original discussion', 'discuss');
  const pending: Promise<string>[] = [];
  const original = engine.chat(source);
  pending.push(original);
  // Failure scenarios observe the rejection before releasing their preparation gate.
  void original.catch(() => {});
  await preparing.promise;
  const run = store.list('run')[0];
  function adjustment(content = 'implement this change') {
    return store.addMessage(project.id, 'user', content, 'implement', undefined, {
      deliveryMode: 'steer',
    });
  }
  function send(message: ReturnType<typeof adjustment>) {
    const promise = engine.chat(message);
    pending.push(promise);
    return promise;
  }
  async function close() {
    for (const gate of [preparing, preparation, started, completion, received, ...acknowledgements])
      gate.release();
    await Promise.allSettled(pending);
    try {
      await engine.stop();
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  }
  return {
    store,
    engine,
    source,
    project,
    run,
    original,
    preparing,
    preparation,
    started,
    completion,
    received,
    acknowledgements,
    calls,
    adjustment,
    send,
    close,
  };
}

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

    const { operation, created } = store.beginSteer(run.id, latest.id);
    assert.equal(created, true);
    assert.equal(store.beginSteer(run.id, latest.id).created, false);
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

test('steer before thread creation deduplicates IDs and confirms FIFO', async () => {
  const f = await steeringFixture();
  try {
    assert.equal(f.store.get('run', f.run.id)?.threadId, undefined);
    const first = f.adjustment('first adjustment');
    const second = f.adjustment('second adjustment');
    const a = f.send(first);
    assert.equal(f.send(first), a);
    const b = f.send(second);
    await setImmediate();
    assert.equal(f.store.get('message', first.id)?.descriptor?.code, 'steer_waiting');
    assert.equal(f.store.get('message', second.id)?.status, 'running');
    assert.equal(f.store.list('operation').length, 0);
    assert.equal(f.calls.length, 0);
    f.preparation.release();
    await f.received.promise;
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][2]?.expectedTurnId, 'turn-1');
    assert.equal(f.store.get('run', f.run.id)?.sourceMessageId, f.source.id);
    f.acknowledgements[0].release();
    await a;
    await setImmediate();
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1][1], second.content);
    assert.equal(f.store.get('run', f.run.id)?.sourceMessageId, first.id);
    f.acknowledgements[1].release();
    await b;
    assert.equal(f.store.get('run', f.run.id)?.sourceMessageId, second.id);
    assert.equal(f.store.get('run', f.run.id)?.sourceIntent, 'implement');
    await f.send(first);
    await f.engine.chat(first, true);
    assert.equal(f.calls.length, 2);
    assert.equal(f.store.list('run').length, 1);
    assert.equal(f.store.get('message', first.id)?.content, first.content);
    assert.equal(f.store.get('message', first.id)?.descriptor, undefined);
  } finally {
    await f.close();
  }
});

for (const ending of ['failure', 'cancel', 'shutdown'] as const) {
  test(`preparing steer settles locally on ${ending} without native delivery`, async () => {
    const f = await steeringFixture({ prepareFailure: ending === 'failure' });
    try {
      const message = f.adjustment();
      const delivery = f.send(message);
      await setImmediate();
      let stopping: Promise<void> | undefined;
      if (ending === 'shutdown') stopping = f.engine.stop();
      else if (ending === 'cancel') f.engine.active.get(f.run.id)?.abort.abort();
      else f.preparation.release();
      await delivery;
      assert.equal(f.calls.length, 0);
      assert.equal(f.store.list('operation').length, 0);
      const saved = f.store.get('message', message.id);
      assert.equal(saved?.content, message.content);
      assert.equal(
        saved?.descriptor?.code,
        ending === 'shutdown'
          ? 'steer_recovering'
          : ending === 'cancel'
            ? 'steer_cancelled'
            : 'steer_prepare_failed',
      );
      assert.equal(
        saved?.draftStatus,
        ending === 'shutdown' ? 'queued' : ending === 'cancel' ? 'cancelled' : 'failed',
      );
      assert.equal(f.store.get('run', f.run.id)?.sourceMessageId, f.source.id);
      if (ending === 'shutdown') assert.equal(saved?.runId, undefined);
      f.preparation.release();
      await stopping;
    } finally {
      await f.close();
    }
  });
}

test('ended native turn queues once and binds the successor Run', async () => {
  const f = await steeringFixture({ steerFailure: 'ended' });
  try {
    const message = f.adjustment();
    const delivery = f.send(message);
    await setImmediate();
    f.preparation.release();
    await f.received.promise;
    await setImmediate();
    assert.equal(f.store.get('message', message.id)?.deliveryMode, 'queue');
    assert.equal(f.store.get('message', message.id)?.runId, undefined);
    assert.equal(f.store.get('run', f.run.id)?.sourceMessageId, f.source.id);
    f.completion.release();
    await delivery;
    const successor = f.store.list('run').find((run) => run.id !== f.run.id);
    assert.ok(successor);
    assert.equal(f.store.get('message', message.id)?.runId, successor.id);
    const [operation] = f.store.list('operation');
    assert.equal(operation.runId, f.run.id);
    await f.send(message);
    assert.equal(f.store.list('run').length, 2);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test('not-accepted steer after cancellation stays cancelled', async () => {
  const f = await steeringFixture({ steerFailure: 'ended-after-ack' });
  try {
    const message = f.adjustment();
    const delivery = f.send(message);
    await setImmediate();
    f.preparation.release();
    await f.received.promise;
    f.engine.active.get(f.run.id)?.abort.abort();
    f.acknowledgements[0].release();
    await delivery;
    assert.equal(f.store.get('message', message.id)?.draftStatus, 'cancelled');
    assert.equal(f.store.get('message', message.id)?.descriptor?.code, 'steer_cancelled');
    assert.equal(f.store.list('run').length, 1);
    assert.equal(f.store.list('operation')[0]?.status, 'failed');
    assert.equal(f.store.get('run', f.run.id)?.sourceMessageId, f.source.id);
  } finally {
    await f.close();
  }
});

test('uncertain steer stops the FIFO and neither retry nor old pending sends again', async () => {
  const f = await steeringFixture({ steerFailure: 'uncertain' });
  try {
    const first = f.adjustment('uncertain adjustment');
    const second = f.adjustment('must remain unsent');
    const a = f.send(first);
    const b = f.send(second);
    await setImmediate();
    f.preparation.release();
    await Promise.all([a, b]);
    await f.send(first);
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.get('message', first.id)?.descriptor?.code, 'steer_uncertain');
    assert.equal(f.store.get('message', second.id)?.descriptor?.code, 'steer_prepare_failed');
    assert.equal(f.store.get('run', f.run.id)?.sourceMessageId, f.source.id);
    const old = f.adjustment('previous pending');
    const pending = f.store.beginSteer(f.run.id, old.id).operation;
    await f.send(old);
    await f.engine.chat(old, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.get('operation', pending.id)?.status, 'pending');
  } finally {
    await f.close();
  }
});

test('a short completed turn releases waiting adjustment into exactly one fresh Run', async () => {
  const f = await steeringFixture({ shortTurn: true });
  try {
    const message = f.adjustment();
    const delivery = f.send(message);
    await setImmediate();
    f.preparation.release();
    await delivery;
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.list('run').length, 2);
    assert.equal(f.store.get('message', message.id)?.deliveryMode, 'queue');
    assert.notEqual(f.store.get('message', message.id)?.runId, f.run.id);
  } finally {
    await f.close();
  }
});

test('native completion before steer ack still accepts only the acknowledged message', async () => {
  const f = await steeringFixture();
  try {
    const message = f.adjustment();
    const delivery = f.send(message);
    await setImmediate();
    f.preparation.release();
    await f.received.promise;
    f.completion.release();
    await f.original;
    assert.equal(f.store.get('run', f.run.id)?.status, 'completed');
    assert.equal(f.store.get('run', f.run.id)?.sourceMessageId, f.source.id);
    let stopped = false;
    const stopping = f.engine.stop().then(() => {
      stopped = true;
    });
    await setImmediate();
    assert.equal(stopped, false, 'stop must track the complete chat acknowledgement');
    f.acknowledgements[0].release();
    await delivery;
    await stopping;
    assert.equal(f.store.get('run', f.run.id)?.sourceMessageId, message.id);
    assert.equal(f.store.get('message', message.id)?.status, 'completed');
  } finally {
    await f.close();
  }
});

for (const policy of ['automatic', 'manual'] as const) {
  test(`restart separates unsent and uncertain adjustments under ${policy}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'phantom-steer-restart-'));
    const file = join(root, 'state.sqlite');
    let store = new Store(file);
    const project = store.createProject('Restart steering', '');
    store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
    store.put('project', project.id, { ...store.project(project.id), recoveryPolicy: policy });
    const source = store.addMessage(project.id, 'user', 'original recovery input', 'discuss');
    store.updateMessage(source.id, { status: 'running', draftStatus: 'running' });
    const run = store.run('pm', project.id, 'pm', { sourceMessageId: source.id });
    store.bindRunThread(run, 'saved-thread');
    const waiting = store.addMessage(
      project.id,
      'user',
      'unsent adjustment',
      'implement',
      undefined,
      { deliveryMode: 'steer', runId: run.id },
    );
    store.updateMessage(waiting.id, {
      status: 'running',
      draftStatus: 'running',
      descriptor: { code: 'steer_waiting' },
    });
    const sent = store.addMessage(
      project.id,
      'user',
      'uncertain adjustment',
      'implement',
      undefined,
      { deliveryMode: 'steer' },
    );
    const pending = store.beginSteer(run.id, sent.id).operation;
    const unknown = store.addMessage(
      project.id,
      'user',
      'previous uncertain input',
      'discuss',
      undefined,
      { deliveryMode: 'steer' },
    );
    const uncertain = store.beginSteer(run.id, unknown.id).operation;
    store.finishSteer(uncertain.id, 'uncertain', 'ack lost before restart');
    const cancelled = store.addMessage(
      project.id,
      'user',
      'cancelled adjustment',
      'implement',
      undefined,
      { deliveryMode: 'steer' },
    );
    store.updateMessage(cancelled.id, {
      status: 'failed',
      draftStatus: 'cancelled',
      descriptor: { code: 'steer_cancelled' },
    });
    store.close();
    store = new Store(file);
    const resumed = deferred();
    const finishRecovery = deferred();
    const delivered = deferred();
    const prompts: string[] = [];
    let steers = 0;
    let reconciles = 0;
    class RecoveryAgent extends Codex {
      override async start() {}
      override async stop() {}
      override async thread() {
        return 'resumed-thread';
      }
      override async reconcileSteer() {
        reconciles++;
        return 'unknown' as const;
      }
      override async steer() {
        steers++;
      }
      override async turn(...args: Parameters<Codex['turn']>) {
        prompts.push(args[1]);
        args[5]?.(`recovered-${prompts.length}`);
        if (args[1].endsWith(source.content)) {
          resumed.release();
          await finishRecovery.promise;
        }
        if (args[1].endsWith(waiting.content)) delivered.release();
        return 'recovered reply';
      }
    }
    const engine = new Engine(
      store,
      new GitHub(store),
      new Workspaces(join(root, 'workspaces'), store),
      root,
      () => new RecoveryAgent(),
    );
    let starting: Promise<void> | undefined;
    try {
      starting = engine.start();
      if (policy === 'automatic') {
        await resumed.promise;
        assert.equal(prompts.length, 1);
        assert.equal(store.get('message', waiting.id)?.status, 'queued');
        assert.equal(store.get('message', waiting.id)?.runId, undefined);
        finishRecovery.release();
      }
      await starting;
      await delivered.promise;
      await setImmediate();
      assert.equal(reconciles, 2);
      assert.equal(steers, 0);
      assert.equal(store.get('operation', pending.id)?.status, 'uncertain');
      assert.equal(store.get('operation', uncertain.id)?.status, 'uncertain');
      assert.equal(store.get('message', unknown.id)?.status, 'failed');
      assert.equal(store.get('message', sent.id)?.status, 'failed');
      assert.equal(store.get('message', sent.id)?.descriptor?.code, 'steer_uncertain');
      assert.equal(store.get('message', cancelled.id)?.draftStatus, 'cancelled');
      assert.equal(store.get('message', waiting.id)?.status, 'completed');
      assert.equal(store.get('message', waiting.id)?.intent, 'implement');
      assert.notEqual(store.get('message', waiting.id)?.runId, run.id);
      assert.equal(store.get('run', run.id)?.sourceMessageId, source.id);
      assert.equal(prompts.length, policy === 'automatic' ? 2 : 1);
      if (policy === 'manual') assert.equal(store.list('recovery')[0]?.status, 'recoverable');
    } finally {
      resumed.release();
      finishRecovery.release();
      delivered.release();
      try {
        await starting;
      } finally {
        try {
          await engine.stop();
        } finally {
          store.close();
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  });
}

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

for (const [policy, history] of [
  ['automatic', 'accepted'],
  ['manual', 'accepted'],
  ['automatic', 'not_accepted'],
] as const) {
  test(`history ${history} keeps recovery source and order under ${policy}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'phantom-steer-history-'));
    const store = new Store(':memory:');
    const project = store.createProject('History recovery', '');
    store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
    store.saveProjectRuntimeConfig(project.id, { recoveryPolicy: policy });
    const original = store.addMessage(project.id, 'user', 'original implement', 'implement');
    store.updateMessage(original.id, { status: 'running', draftStatus: 'running' });
    const run = store.run('pm', project.id, 'pm', { sourceMessageId: original.id });
    store.bindRunThread(run, 'saved-thread');
    const latest = store.addMessage(project.id, 'user', 'discuss only now', 'discuss', undefined, {
      deliveryMode: 'steer',
    });
    const operation = store.beginSteer(run.id, latest.id).operation;
    const queuedDelivered = deferred();
    const prompts: string[] = [];
    const sources: Array<{ id?: string; intent?: string }> = [];
    const toolErrors: string[] = [];
    let handler: Parameters<Codex['thread']>[0]['toolHandler'];
    let steers = 0;
    class HistoryAgent extends Codex {
      override async start() {}
      override async stop() {}
      override async thread(options: Parameters<Codex['thread']>[0]) {
        handler = options.toolHandler;
        return 'resumed-thread';
      }
      override async reconcileSteer() {
        return history;
      }
      override async steer() {
        steers++;
      }
      override async turn(...args: Parameters<Codex['turn']>) {
        prompts.push(args[1]);
        const turnId = `resumed-${prompts.length}`;
        args[5]?.(turnId);
        const current = store.activeRuns().find((candidate) => candidate.turnId === turnId);
        sources.push({ id: current?.sourceMessageId, intent: current?.sourceIntent });
        try {
          await handler?.('create_task', {});
        } catch (error) {
          toolErrors.push(String(error));
        }
        if (args[1].endsWith(latest.content)) queuedDelivered.release();
        return 'recovered reply';
      }
    }
    const engine = new Engine(
      store,
      new GitHub(store),
      new Workspaces(join(root, 'ws'), store),
      root,
      () => new HistoryAgent(),
    );
    try {
      await engine.start();
      const item = store.list('recovery').find((candidate) => candidate.oldRunId === run.id);
      assert.ok(item);
      if (history === 'accepted' && policy === 'manual') {
        assert.equal(item.sourceMessageId, latest.id);
        await engine.resumeRecovery(project.id, item.id, { source: 'user', reason: 'retry' });
      }
      if (history === 'not_accepted') await queuedDelivered.promise;
      await setImmediate();
      assert.equal(steers, 0);
      assert.equal(store.get('operation', operation.id)?.status, 'done');
      assert.equal(store.get('message', latest.id)?.status, 'completed');
      if (history === 'accepted') {
        assert.equal(
          store.get('recovery', item.id)?.sourceMessageId,
          latest.id,
          'recovery must follow history-confirmed source',
        );
        assert.equal(store.get('recovery', item.id)?.messageId, latest.id);
        assert.equal(sources[0]?.id, latest.id);
        assert.equal(sources[0]?.intent, 'discuss');
        assert.ok(prompts[0].endsWith(latest.content));
        assert.match(toolErrors[0], /当前回合没有新增实施授权/);
        const recovered = store.get('recovery', item.id);
        store.finishSteer(operation.id, 'done', 'repeated accepted history', true);
        assert.deepEqual(store.get('recovery', item.id), recovered);
      } else {
        assert.ok(prompts[0].endsWith(original.content), 'original recovery must precede queue');
        assert.ok(prompts[1].endsWith(latest.content));
        assert.deepEqual(
          sources.map((source) => source.intent),
          ['implement', 'discuss'],
        );
        assert.equal(prompts.length, 2);
      }
      assert.equal(store.list('task').length, 0);
      assert.equal(store.get('operation', operation.id)?.runId, run.id);
      assert.equal(store.get('message', original.id)?.intent, 'implement');
      assert.equal(store.get('message', original.id)?.content, original.content);
    } finally {
      queuedDelivered.release();
      try {
        await engine.stop();
      } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  });
}

test('recovering unsent steering preserves a related user-paused task', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject('Paused recovery', '');
    const source = store.addMessage(project.id, 'user', 'original', 'discuss');
    const task = policyTask({
      projectId: project.id,
      sourceMessageId: source.id,
      stage: 'developing',
      control: 'paused',
      pausedByUser: true,
    });
    store.put('task', task.id, task);
    const run = store.run('pm', project.id, 'pm', { sourceMessageId: source.id });
    store.put('run', run.id, { ...run, taskId: task.id });
    const waiting = store.addMessage(
      project.id,
      'user',
      'unsent adjustment',
      'implement',
      undefined,
      { deliveryMode: 'steer', runId: run.id },
    );
    store.updateMessage(waiting.id, {
      status: 'running',
      draftStatus: 'running',
      descriptor: { code: 'steer_waiting' },
    });
    const item = store.recover().find((item) => item.oldRunId === run.id);
    assert.equal(item?.status, 'recoverable');
    assert.equal(item?.pauseProvenance, 'user');
    assert.equal(store.task(task.id).pausedByUser, true);
    assert.equal(store.task(task.id).control, 'paused');
    assert.equal(store.get('message', waiting.id)?.status, 'queued');
    assert.equal(store.get('message', waiting.id)?.runId, undefined);
    assert.equal(store.get('run', run.id)?.sourceMessageId, source.id);
  } finally {
    store.close();
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
