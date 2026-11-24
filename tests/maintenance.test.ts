import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { GitHub, type GhResult } from '../src/server/github.ts';
import { Maintenance } from '../src/server/maintenance.ts';
import { configuration, intakeFixture } from './intake-fixture.ts';
import { readMaintenanceCandidates } from '../src/server/maintenance-github.ts';

const settings = {
  expectedVersion: 0,
  name: 'Selected maintenance',
  kind: 'issue' as const,
  selector: 'maintenance',
  minimumAgeMinutes: 0,
  scope: 'Repair documentation only',
};
const old = '2026-01-01T00:00:00Z';
const issue = (number = 1) => ({
  id: number,
  number,
  title: `Issue ${number}`,
  body: 'Fix documentation',
  html_url: `https://github.com/test/repo/issues/${number}`,
  created_at: old,
  updated_at: old,
  state: 'open',
  user: { id: 7, login: 'human', type: 'User' },
  assignees: [],
  labels: [{ name: 'maintenance' }],
});
const run = (id = 1, workflow = 1) => ({
  id,
  workflow_id: workflow,
  run_attempt: 1,
  name: 'Checks',
  html_url: `https://github.com/test/repo/actions/runs/${id}`,
  head_sha: `head-${id}`,
  head_branch: 'main',
  status: 'completed',
  conclusion: 'failure',
  created_at: old,
  updated_at: old,
  actor: { id: 7, login: 'human', type: 'User' },
  pull_requests: [] as { number: number }[],
});

function fixture(file = ':memory:') {
  const store = new Store(file);
  const project = store.createProject('Maintenance', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'repo',
    path: '/unused',
    github: 'test/repo',
    defaultBranch: 'acceptance',
    authorized: true,
  });
  let issues: unknown[] = [issue()];
  let runs = [run()];
  let pulls: unknown[] = [];
  let unavailable = false;
  const calls: string[][] = [];
  class Remote extends GitHub {
    override async gh(args: string[]): Promise<GhResult> {
      calls.push(args);
      assert.equal(args[args.indexOf('--method') + 1], 'GET', 'observer must never write');
      if (unavailable) throw new Error('GitHub unavailable');
      const endpoint = args[1];
      let value: unknown;
      if (endpoint.includes('/issues?')) value = issues;
      else if (endpoint === 'repos/test/repo') value = { default_branch: 'main' };
      else if (endpoint.includes('/actions/workflows?')) {
        value = {
          workflows: [...new Set(runs.map((item) => item.workflow_id))].map((id) => ({ id })),
        };
      } else if (endpoint.includes('/runs?')) {
        assert.match(endpoint, /branch=main&/);
        const workflowId = Number(endpoint.match(/workflows\/(\d+)\//)![1]);
        const matches = runs
          .filter((item) => item.workflow_id === workflowId)
          .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt);
        value = { total_count: matches.length, workflow_runs: matches.slice(0, 1) };
      } else if (endpoint.includes('/pulls?')) value = pulls;
      else throw new Error(`Unexpected read: ${endpoint}`);
      return { stdout: JSON.stringify(value), stderr: '', code: 0 };
    }
  }
  const github = new Remote(store);
  const maintenance = new Maintenance(store, github);
  return {
    store,
    project,
    repo,
    github,
    maintenance,
    calls,
    issues(value: unknown[]) {
      issues = value;
    },
    runs(value: ReturnType<typeof run>[]) {
      runs = value;
    },
    pulls(value: unknown[]) {
      pulls = value;
    },
    unavailable() {
      unavailable = true;
    },
  };
}

test('versioned observe rules retain complete source evidence without work or writes', async () => {
  const f = fixture();
  try {
    const rule = f.maintenance.save(f.repo.id, settings);
    assert.equal(rule.mode, 'observe');
    f.maintenance.save(f.repo.id, { ...settings, kind: 'ci', selector: 'Checks', mode: 'auto' });
    await f.maintenance.refresh(f.repo.id);
    await f.maintenance.refresh(f.repo.id);
    const page = f.maintenance.page(f.repo.id);
    assert.equal(page.observations.length, 2);
    assert(page.observations.every((item) => item.wouldAccept));
    assert(page.observations.every((item) => item.execution === 'observation_only'));
    assert.equal(page.automaticExecutionAvailable, false);
    for (const item of page.observations) {
      assert(!('body' in item.candidate));
      assert(!('evidence' in item.candidate));
      const detail = f.maintenance.detail(f.repo.id, item.id);
      assert(detail.candidate.evidence);
      assert(detail.observation.recommendation.includes(settings.scope));
      assert.equal(detail.rule.id, item.authorizationVersionId);
    }
    for (const kind of ['task', 'run', 'message', 'operation', 'sourceReply'] as const)
      assert.equal(f.store.list(kind).length, 0, kind);
    assert.throws(() => f.maintenance.save(f.repo.id, settings, rule.ruleId), /已变化/);
    const next = f.maintenance.save(
      f.repo.id,
      { ...settings, expectedVersion: 1, mode: 'off' },
      rule.ruleId,
    );
    assert.equal(next.version, 2);
    assert.equal(f.store.get('maintenanceRule', rule.id)?.mode, 'observe');
    assert.equal(f.maintenance.history(f.repo.id, rule.ruleId).versions.length, 2);
    assert.throws(() => f.maintenance.save(f.repo.id, { ...settings, scope: '' }));
  } finally {
    f.store.close();
  }
});

test('self activity, explicit requests, bound CI and existing paused work cannot compete', async () => {
  const f = fixture();
  try {
    f.issues([
      issue(),
      { ...issue(2), body: '<!-- phantom-task:x --> Self' },
      { ...issue(3), user: { id: 8, login: 'robot', type: 'Bot' } },
      { ...issue(4), labels: [{ name: 'other' }] },
      { ...issue(5), assignees: [{ login: 'owner' }] },
    ]);
    f.pulls([{ number: 11, state: 'open' }]);
    const message = f.store.addMessage(f.project.id, 'user', 'Explicit work', 'implement');
    const task = f.store.createTask({
      projectId: f.project.id,
      repoId: f.repo.id,
      sourceMessageId: message.id,
      title: 'Already owned',
      spec: 'Fix',
      acceptance: ['Fixed'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    f.store.put('task', task.id, { ...task, issue: 1, pr: 11 });
    f.store.control(task.id, 'pause', { source: 'user', reason: 'task_pause' });
    f.maintenance.save(f.repo.id, settings);
    f.maintenance.save(f.repo.id, { ...settings, kind: 'ci', selector: 'Checks' });
    await f.maintenance.refresh(f.repo.id);
    const records = f.maintenance.page(f.repo.id).observations;
    assert.equal(records.length, 5);
    assert(records.every((item) => !item.wouldAccept));
    assert.equal(records.filter((item) => item.taskIds.includes(task.id)).length, 2);
    assert(records.find((item) => item.candidate.issue === 1)?.holdReasons.length);
    assert.equal(f.store.task(task.id).control, 'paused');
    assert.equal(f.store.list('task').length, 1);
  } finally {
    f.store.close();
  }
});

test('source samples age and latest CI; failed reads retain prior records', async () => {
  const f = fixture();
  try {
    const rule = f.maintenance.save(f.repo.id, { ...settings, minimumAgeMinutes: 60 });
    f.issues([{ ...issue(), updated_at: new Date().toISOString() }]);
    await f.maintenance.refresh(f.repo.id);
    assert.equal(f.maintenance.page(f.repo.id).observations[0].wouldAccept, false);
    f.issues([issue()]);
    f.runs([run(1), { ...run(2), conclusion: 'success' }, run(3, 2)]);
    f.maintenance.save(f.repo.id, { ...settings, kind: 'ci', selector: 'Checks' });
    await f.maintenance.refresh(f.repo.id);
    const records = f.maintenance.page(f.repo.id).observations;
    assert.equal(records.filter((item) => item.candidate.kind === 'ci').length, 1);
    assert.equal(records.filter((item) => item.wouldAccept).length, 2);
    assert.equal(f.maintenance.detail(f.repo.id, records[0].id).rule.version, rule.version);
    f.unavailable();
    await assert.rejects(f.maintenance.refresh(f.repo.id), /unavailable/);
    assert.equal(f.maintenance.page(f.repo.id).observations.length, records.length);
    assert.equal(f.maintenance.page(f.repo.id).health?.status, 'unavailable');
  } finally {
    f.store.close();
  }
});

test('configuration changes fence an in-flight source read; off does not collect', async () => {
  const f = fixture();
  try {
    const rule = f.maintenance.save(f.repo.id, settings);
    const read = f.github.readMaintenanceCandidates.bind(f.github);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.github.readMaintenanceCandidates = async (...args) => {
      const candidates = await read(...args);
      await pending;
      return candidates;
    };
    const scan = f.maintenance.refresh(f.repo.id);
    f.maintenance.save(f.repo.id, { ...settings, mode: 'off', expectedVersion: 1 }, rule.ruleId);
    release();
    await scan;
    assert.equal(f.maintenance.page(f.repo.id).observations.length, 0);
    const calls = f.calls.length;
    await f.maintenance.refresh(f.repo.id);
    assert.equal(f.calls.length, calls);
  } finally {
    f.store.close();
  }
});

test('restart preserves rule authorization history and team and individual pause provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-maintenance-'));
  const file = join(root, 'state.sqlite');
  const f = fixture(file);
  try {
    const rule = f.maintenance.save(f.repo.id, settings);
    const message = f.store.addMessage(f.project.id, 'user', 'Existing work', 'implement');
    const task = f.store.createTask({
      projectId: f.project.id,
      repoId: f.repo.id,
      sourceMessageId: message.id,
      title: 'Paused work',
      spec: 'Fix',
      acceptance: ['Fixed'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    f.store.put('task', task.id, { ...task, issue: 1 });
    f.store.control(task.id, 'pause', { source: 'user', reason: 'task_pause' });
    f.store.put('project', f.project.id, { ...f.project, admissionPaused: true });
    await f.maintenance.refresh(f.repo.id);
    const record = f.maintenance.page(f.repo.id).observations[0];
    assert.equal(record.wouldAccept, false);
    assert.deepEqual(record.holdReasons, ['用户已暂停团队接收', '用户已暂停关联工作：Paused work']);
    f.store.close();
    const reopened = new Store(file);
    try {
      const maintenance = new Maintenance(reopened, new GitHub(reopened));
      assert.equal(reopened.project(f.project.id).admissionPaused, true);
      assert.equal(reopened.task(task.id).control, 'paused');
      assert.equal(reopened.task(task.id).pausedByUser, true);
      assert.deepEqual(
        maintenance.detail(f.repo.id, record.id).observation,
        recordWithoutCandidate(record),
      );
      assert.equal(maintenance.detail(f.repo.id, record.id).rule.id, rule.id);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function recordWithoutCandidate<T extends { candidate: unknown }>(record: T) {
  const { candidate, ...observation } = record;
  return observation;
}

test('source pagination refuses partial pages and validates external structures', async () => {
  const f = fixture();
  try {
    let count = 0;
    await assert.rejects(
      readMaintenanceCandidates(
        async () => {
          if (++count === 1) return Array.from({ length: 100 }, (_, i) => issue(i + 1));
          throw new Error('Second page unavailable');
        },
        f.repo,
        new Set(['issue']),
      ),
      /Second page unavailable/,
    );
    assert.equal(count, 2);
    await assert.rejects(
      readMaintenanceCandidates(
        async () => [{ ...issue(), labels: null }],
        f.repo,
        new Set(['issue']),
      ),
    );
  } finally {
    f.store.close();
  }
});

for (const mode of ['off', 'observe', 'auto'] as const) {
  test(`explicit admitted Issue requests remain usable in ${mode}`, async () => {
    const f = intakeFixture();
    try {
      f.engine.maintenance.save(f.repo.id, { ...settings, mode });
      await f.intake.configure(f.repo.id, configuration);
      await f.intake.refresh(f.repo.id);
      const input = f.intake.workflow(f.project.id).inputs[0].input;
      assert(f.intake.dispatchMessage(input.id)?.origin);
    } finally {
      await f.close();
    }
  });
}

test('a received explicit request owns its Issue before a Task exists', async () => {
  const f = intakeFixture();
  try {
    await f.intake.configure(f.repo.id, configuration);
    await f.intake.refresh(f.repo.id);
    f.engine.maintenance.save(f.repo.id, settings);
    // Even a later unaddressed body revision must not race a queued explicit request.
    f.github.readMaintenanceCandidates = (repo, kinds) =>
      readMaintenanceCandidates(async () => [issue(12)], repo, kinds);
    await f.engine.maintenance.refresh(f.repo.id);
    const record = f.engine.maintenance.page(f.repo.id).observations[0];
    assert.equal(record.wouldAccept, false);
    assert(record.judgments.some((item) => item.condition.includes('显式请求') && !item.matched));
    assert.equal(f.store.list('task').length, 0);
    assert.equal(f.intake.workflow(f.project.id).inputs[0].assessment.disposition.status, 'queued');
  } finally {
    await f.close();
  }
});
