import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { Engine } from '../src/server/engine.ts';
import { GitHub } from '../src/server/github.ts';
import { Store } from '../src/server/store.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import type { Task } from '../src/shared/types.ts';
import { devFixture, hang, until } from './dev-fixture.ts';

type Handler = NonNullable<Parameters<Codex['thread']>[0]['toolHandler']>;

async function scenario(failures = 1) {
  const f = await devFixture('phantom-validation-recovery-');
  let store = f.store;
  const marker = join(f.root, 'checked');
  await writeFile(
    join(f.root, 'check.cjs'),
    `const fs = require('fs'); const marker = ${JSON.stringify(marker)};
const runs = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0;
fs.writeFileSync(marker, String(runs + 1));
if (runs < ${failures}) { console.error('original failed check'); process.exit(1); }`,
  );
  store.patchRepo(f.repo.id, {
    commands: {
      install: '',
      build: 'node -e 0',
      test: `node "${join(f.root, 'check.cjs')}"`,
      start: '',
      port: 3000,
    },
  });
  const diagnoses: string[] = [];
  const coordinated: string[] = [];
  let implementationTurns = 0;
  let reviewed = false;
  let diagnose: (tool: Handler, signal?: AbortSignal) => Promise<string> = (_tool, signal) =>
    hang(signal);
  let coordinate = diagnose;
  class Model extends Codex {
    role = '';
    tool?: Handler;
    override async start() {}
    override async stop() {}
    override async thread(options: Parameters<Codex['thread']>[0]) {
      this.tool = options.toolHandler;
      this.role = options.tools?.some((t) => t.name === 'settle')
        ? 'diagnose'
        : options.tools?.some((t) => t.name === 'resolve_incident')
          ? 'pm'
          : options.writable
            ? 'dev'
            : 'review';
      return 'original-dev-thread';
    }
    override async turn(_thread: string, prompt: string, _profile: unknown, signal?: AbortSignal) {
      if (this.role === 'diagnose') {
        diagnoses.push(prompt);
        return diagnose(this.tool!, signal);
      }
      if (this.role === 'pm') {
        coordinated.push(prompt);
        return coordinate(this.tool!, signal);
      }
      if (this.role === 'review') {
        reviewed = true;
        return hang(signal);
      }
      implementationTurns++;
      await writeFile(join(store.task(f.task.id).worktree!, 'a.txt'), 'implementation\n');
      return 'done';
    }
  }
  class Remote extends GitHub {
    override async publishIssue(task: Task) {
      store.updateTask(task.id, { issue: 1, issueBody: 'body' });
      return { number: 1 };
    }
    override async publishPR() {
      return {} as never;
    }
    override async reviewComment() {}
    override async syncStatus() {}
    override async api<T = any>(): Promise<T> {
      return { state: 'open', body: 'body' } as T;
    }
  }
  const host = () =>
    new Engine(
      store,
      new Remote(store),
      new Workspaces(join(f.root, 'ws'), store),
      f.root,
      () => new Model(),
    );
  let engine = host();
  const pump = async (done: () => boolean) => {
    for (let i = 0; i < 1200 && !done(); i++) {
      await engine.tick();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(done(), JSON.stringify(store.task(f.task.id)));
  };
  return {
    taskId: f.task.id,
    projectId: f.project.id,
    repoId: f.repo.id,
    store: () => store,
    engine: () => engine,
    diagnoses,
    coordinated,
    implementationTurns: () => implementationTurns,
    reviewed: () => reviewed,
    diagnose: (fn: typeof diagnose) => {
      diagnose = fn;
    },
    coordinate: (fn: typeof coordinate) => {
      coordinate = fn;
    },
    start: async () => {
      await engine.start();
      await pump(() => diagnoses.length === 1);
    },
    restart: async () => {
      await engine.stop();
      store.close();
      store = new Store(join(f.root, 'db.sqlite'));
      engine = host();
      await engine.start();
    },
    pump,
    close: async () => {
      await engine.stop();
      store.close();
      await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

test('restarted diagnosis waits for capacity and continues the failure once', async () => {
  const s = await scenario();
  try {
    await s.start();
    const original = s.store().task(s.taskId);
    const interrupted = s
      .store()
      .activeRuns()
      .find((r) => r.incidentPhase === 'validation')!;
    // Manual recovery lets another real Dev occupy the single slot before the request is made.
    s.store().saveProjectRuntimeConfig(s.projectId, { recoveryPolicy: 'manual' });
    s.store().saveSettings({ ...s.store().settings(), globalDevLimit: 1 });
    await s.restart();
    const other = s.store().createTask({
      projectId: s.projectId,
      repoId: s.repoId,
      sourceMessageId: original.sourceMessageId,
      title: 'Other work',
      spec: 'Other work',
      acceptance: ['done'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    const busy = s.store().run('dev', s.projectId, 'backend', other);
    const recovery = s
      .store()
      .list('recovery')
      .find((r) => r.oldRunId === interrupted.id)!;
    const requested = await Promise.race([
      s
        .engine()
        .resumeRecovery(s.projectId, recovery.id)
        .then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    assert.equal(
      requested,
      true,
      'a queued recovery request must return without running diagnosis',
    );
    assert.equal(s.diagnoses.length, 1, 'full capacity must leave the diagnosis queued');
    assert.match(s.store().task(s.taskId).blocked!, /排队/);
    assert.equal(s.store().get('recovery', recovery.id)?.successorRunId, undefined);
    s.store().control(other.id, 'cancel');
    s.store().finishRun(busy.id, 'completed');
    await s.pump(() => s.diagnoses.length === 2);
    for (let i = 0; i < 3; i++) await s.engine().tick();
    await s.engine().resumeRecovery(s.projectId, recovery.id);
    assert.equal(s.diagnoses.length, 2);
    assert.match(s.diagnoses[1], /original failed check/);
    const current = s.store().task(s.taskId);
    assert.equal(current.head, original.head);
    assert.equal(current.worktree, original.worktree);
    assert.deepEqual(current.tests, original.tests);
    assert.equal(await readFile(join(current.worktree!, 'a.txt'), 'utf8'), 'implementation\n');
    assert.equal(s.implementationTurns(), 1);
  } finally {
    await s.close();
  }
});

test('three interrupted diagnoses escalate the original Incident across restarts', async () => {
  const s = await scenario();
  try {
    await s.start();
    const evidence = s.store().task(s.taskId).tests;
    const incidentId = s
      .store()
      .activeRuns()
      .find((run) => run.incidentPhase === 'validation')!.incidentId!;
    await s.restart();
    await s.pump(() => s.diagnoses.length === 2);
    await s.restart();
    await s.pump(() => s.diagnoses.length === 3);
    await s.restart();
    await s.pump(() => s.diagnoses.length === 4 || s.coordinated.length === 1);
    assert.equal(s.diagnoses.length, 3, 'recovery shares the existing three-attempt bound');
    assert.equal(s.coordinated.length, 1);
    assert.match(s.coordinated[0], /original failed check/);
    const incident = s.store().get('incident', incidentId)!;
    assert.equal(s.store().get('run', incident.assessmentRunId!)?.role, 'pm');
    assert.equal(incident.status, 'assessing');
    assert.deepEqual(s.store().task(s.taskId).tests, evidence);
    assert.equal(s.store().task(s.taskId).retries, 0);
    const exhausted = s
      .store()
      .list('recovery')
      .find((item) => item.status === 'cancelled')!;
    await s.engine().resumeRecovery(s.projectId, exhausted.id);
    await s.engine().tick();
    assert.equal(s.coordinated.length, 1);
  } finally {
    await s.close();
  }
});

test('interrupted team coordination resumes once after reopening the host state', async () => {
  const s = await scenario();
  s.diagnose(async () => {
    throw new Error('diagnostic backend exited');
  });
  try {
    await s.start();
    await until(() => s.coordinated.length === 1, 'team coordination');
    const evidence = s.store().task(s.taskId).tests;
    const restarted = await Promise.race([
      s.restart().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    assert.equal(restarted, true, 'a recovered coordination turn must not hold host startup');
    await until(() => s.coordinated.length === 2, 'recovered team coordination');
    assert.equal(s.diagnoses.length, 1, 'restart must continue coordination, not reopen diagnosis');
    assert.deepEqual(s.store().task(s.taskId).tests, evidence);
    const incident = s
      .store()
      .list('incident')
      .find((item) => item.phase === 'validation')!;
    assert.equal(incident.status, 'assessing');
    for (let i = 0; i < 3; i++) await s.engine().tick();
    assert.equal(
      s
        .store()
        .activeRuns()
        .filter((run) => run.role === 'pm').length,
      1,
    );
  } finally {
    await s.close();
  }
});

for (const action of ['pause', 'cancel', 'team_pause'] as const) {
  test(`user ${action} remains authoritative during validation diagnosis and restart`, async () => {
    const s = await scenario();
    try {
      await s.start();
      if (action === 'team_pause') await s.engine().team(s.projectId, 'pause');
      else s.engine().control(s.taskId, action);
      const held = s.store().task(s.taskId);
      if (action === 'cancel') assert.equal(held.stage, 'cancelled');
      else assert.equal(held.pausedByUser, true);
      await until(() => s.store().activeRuns().length === 0, 'user control stops diagnosis');
      assert.equal(s.store().task(s.taskId).blocked, held.blocked);
      await s.restart();
      await s.engine().tick();
      assert.equal(s.diagnoses.length, 1);
      assert.equal(s.coordinated.length, 0);
      assert.equal(s.store().task(s.taskId).control, 'paused');
    } finally {
      await s.close();
    }
  });
}

test('an explicit validation question remains waiting for the user after restart', async () => {
  const s = await scenario();
  const question = '可以授权访问验证需要的内部服务吗？';
  s.diagnose(async (tool) => {
    await tool('settle', { action: 'ask_user', diagnosis: 'Needs authorization', question });
    return 'Asked';
  });
  try {
    await s.start();
    await until(() => s.store().task(s.taskId).blocked === question, 'explicit user question');
    await s.restart();
    await s.engine().tick();
    assert.equal(s.store().task(s.taskId).blocked, question);
    assert.equal(s.store().list('incident')[0].status, 'waiting_user');
    assert.equal(s.diagnoses.length, 1);
    assert.equal(s.coordinated.length, 0);
  } finally {
    await s.close();
  }
});

test('a passing same-version rerun survives interruption without another validation', async () => {
  const s = await scenario();
  let reran = false;
  s.diagnose(async (tool, signal) => {
    await tool('rerun_validation', {});
    reran = true;
    return hang(signal);
  });
  try {
    await s.start();
    await until(() => reran, 'passing rerun before interruption');
    const evidence = s.store().task(s.taskId).tests;
    assert.ok(evidence.length === 2 && evidence.every((t) => t.exitCode === 0));
    s.diagnose(async (tool) => {
      await tool('settle', {
        action: 'retry',
        diagnosis: 'Same-version validation already passed.',
      });
      return 'Settled';
    });
    await s.restart();
    await s.pump(s.reviewed);
    assert.deepEqual(s.store().task(s.taskId).tests, evidence);
    assert.equal(s.store().task(s.taskId).retries, 0);
    assert.equal(s.implementationTurns(), 1);
  } finally {
    await s.close();
  }
});

test('restart coordinates a diagnosis that failed before its handoff was persisted', async () => {
  const s = await scenario();
  try {
    await s.start();
    const interrupted = s
      .store()
      .activeRuns()
      .find((run) => run.incidentPhase === 'validation')!;
    await s.engine().stop();
    // Crash checkpoint: the backend failure is durable, but coordination has not been claimed.
    const failed = s.store().run('dev', s.projectId, 'backend', s.store().task(s.taskId), {
      incidentId: interrupted.incidentId,
      incidentPhase: 'validation',
      incidentEvidence: interrupted.incidentEvidence,
      suppressSource: true,
    });
    s.store().rebindIncidentAssessment(interrupted.incidentId!, interrupted.id, failed.id);
    s.store().finishRun(failed.id, 'failed', 'backend exited before handoff');
    await s.restart();
    await until(() => s.coordinated.length === 1, 'handoff of already-recorded diagnostic failure');
    assert.match(s.coordinated[0], /backend exited before handoff/);
    assert.equal(s.diagnoses.length, 1);
    assert.equal(s.store().list('incident').length, 1);
  } finally {
    await s.close();
  }
});

test('a recorded team question survives interruption of its asking turn', async () => {
  const s = await scenario();
  const question = '验证需要内部服务的访问授权，可以开通吗？';
  s.diagnose(async () => {
    throw new Error('diagnostic backend exited');
  });
  s.coordinate(async (tool, signal) => {
    const incident = s
      .store()
      .list('incident')
      .find((item) => item.phase === 'validation')!;
    await tool('resolve_incident', {
      incidentId: incident.id,
      action: 'waiting_user',
      guidance: question,
    });
    return hang(signal);
  });
  try {
    await s.start();
    await until(() => s.store().task(s.taskId).blocked === question, 'team asks the user');
    await s.restart();
    assert.equal(s.store().activeRuns().length, 0, 'the recorded question owns the wait');
    await s.engine().tick();
    assert.equal(s.coordinated.length, 1);
    assert.equal(s.store().task(s.taskId).blocked, question);
  } finally {
    await s.close();
  }
});

test('repeated diagnostic failures keep an owner and respect the attempt limit', async () => {
  const s = await scenario();
  s.store().patchRepo(s.repoId, {
    commands: {
      ...s.store().repo(s.repoId).commands,
      test: 'node -e "console.error(\'persistent failure\');process.exit(1)"',
    },
  });
  s.diagnose(async () => {
    throw new Error('diagnostic backend exited');
  });
  s.coordinate(async (tool) => {
    const incident = s
      .store()
      .list('incident')
      .find((item) => item.status === 'assessing')!;
    await tool('resolve_incident', {
      incidentId: incident.id,
      action: incident.phase === 'retries' ? 'paused' : 'resolved',
      guidance: 'The team is coordinating the persistent validation failure.',
    });
    return 'Coordinated';
  });
  try {
    await s.start();
    await s.pump(
      () =>
        s
          .store()
          .list('incident')
          .some((item) => item.phase === 'retries') ||
        (s.diagnoses.length >= 2 &&
          s.store().task(s.taskId).control === 'paused' &&
          s.store().activeRuns().length === 0),
    );
    const escalation = s
      .store()
      .list('incident')
      .find((item) => item.phase === 'retries');
    assert.ok(escalation, 'repeated failures must escalate instead of losing the assessor');
    await until(() => s.store().activeRuns().length === 0, 'bounded team coordination');
    assert.equal(s.diagnoses.length, 3);
    assert.equal(s.coordinated.length, 4);
    for (let i = 0; i < 3; i++) await s.engine().tick();
    assert.equal(s.diagnoses.length, 3);
    assert.equal(s.coordinated.length, 4);
    assert.equal(s.implementationTurns(), 1);
    assert.equal(s.store().task(s.taskId).retries, 0);
    assert.match(s.store().task(s.taskId).tests[1].output, /persistent failure/);
    assert.equal(s.store().get('run', escalation.assessmentRunId!)?.role, 'pm');
  } finally {
    await s.close();
  }
});

test('a valid fix starts fresh diagnosis on the next failing revision', async () => {
  const s = await scenario(2);
  try {
    await s.start();
    await s.restart();
    await s.pump(() => s.diagnoses.length === 2);
    s.diagnose(async (tool) => {
      const worktree = s.store().task(s.taskId).worktree!;
      await writeFile(join(worktree, 'a.txt'), `fix ${s.diagnoses.length}\n`);
      await tool('settle', { action: 'fixed', diagnosis: 'Fix the failing revision.' });
      return 'Fixed';
    });
    await s.restart();
    await s.pump(s.reviewed);
    assert.equal(s.diagnoses.length, 4);
    assert.equal(s.coordinated.length, 0);
    assert.equal(s.store().task(s.taskId).retries, 2);
    assert.ok(
      s
        .store()
        .task(s.taskId)
        .tests.every((result) => result.exitCode === 0),
    );
    assert.equal(s.implementationTurns(), 1);
  } finally {
    await s.close();
  }
});
