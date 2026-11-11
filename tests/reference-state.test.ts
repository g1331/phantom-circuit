import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { GitHub, type GhResult } from '../src/server/github.ts';
import { seedAdapterTask, pullFixture } from './fake-github.ts';
import { devFixture } from './dev-fixture.ts';
import { Engine } from '../src/server/engine.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pendingExternalMerge, incidentAttention } from '../src/shared/task-history.ts';
import { teamView } from '../src/shared/team.ts';

test('existing GitHub reads retain observed PR states in the client snapshot', async () => {
  const store = new Store(':memory:');
  try {
    const seed = seedAdapterTask(store);
    store.updateTask(seed.task().id, { pr: 9, prUrl: 'https://github.com/example/repo/pull/9' });
    const pr = {
      ...pullFixture({ number: 9, slug: 'example/repo', branch: 'phantom/task' }),
      draft: false,
    };
    class Remote extends GitHub {
      override async gh(): Promise<GhResult> {
        return { stdout: JSON.stringify(pr), stderr: '', code: 0 };
      }
    }
    const github = new Remote(store);
    for (const [state, draft, mergedAt, expected] of [
      ['open', false, null, 'open'],
      ['open', true, null, 'draft'],
      ['closed', false, null, 'closed'],
      ['closed', false, '2026-11-09T00:00:00Z', 'merged'],
      ['unrecognized', false, null, 'merged'],
    ] as const) {
      Object.assign(pr, { state, draft, merged_at: mergedAt });
      await github.pull(seed.task());
      assert.equal(store.snapshot().tasks.find((t) => t.id === seed.task().id)?.prState, expected);
    }
  } finally {
    store.close();
  }
});

test('Issue observations preserve closure reasons and unknown states', async () => {
  for (const [state, reason, expected] of [
    ['open', null, 'open'],
    ['closed', 'completed', 'completed'],
    ['closed', 'not_planned', 'not_planned'],
    ['closed', null, 'closed'],
    ['unknown', null, undefined],
  ] as const) {
    const store = new Store(':memory:');
    try {
      const seed = seedAdapterTask(store);
      assert.equal(seed.task().issueState, undefined);
      class Remote extends GitHub {
        override async gh(_args: string[], input?: string): Promise<GhResult> {
          return {
            stdout: JSON.stringify({
              body: input ? JSON.parse(input).body : '',
              state,
              state_reason: reason,
            }),
            stderr: '',
            code: 0,
          };
        }
      }
      await new Remote(store).reviseIssue(seed.task());
      assert.equal(
        store.snapshot().tasks.find((t) => t.id === seed.task().id)?.issueState,
        expected,
      );
    } finally {
      store.close();
    }
  }
});

test('Engine sync refreshes Issue states through its existing remote reads', async () => {
  const f = await devFixture('phantom-reference-sync-');
  const { store, task } = f;
  const issue: { body: string; state?: string; state_reason?: string | null } = {
    body: 'same body',
    state: 'closed',
    state_reason: 'not_planned',
  };
  let issueReads = 0;
  class Remote extends GitHub {
    override async gh(args: string[]): Promise<GhResult> {
      assert.equal(args[args.indexOf('--method') + 1], 'GET', 'sync only reads remote state');
      const endpoint = args[1];
      let response: unknown;
      if (endpoint === 'repos/fixture/source/issues/71') {
        issueReads++;
        response = issue;
      } else if (endpoint === 'repos/fixture/source/pulls/9') {
        response = pullFixture({ number: 9, slug: 'fixture/source', branch: 'phantom/task' });
      } else if (/\/(reviews|comments)\?/.test(endpoint)) response = [];
      else throw new Error(`Unexpected request: ${endpoint}`);
      return { stdout: JSON.stringify(response), stderr: '', code: 0 };
    }
  }
  const engine = new Engine(
    store,
    new Remote(store),
    new Workspaces(join(f.root, 'workspaces'), store),
    f.root,
  );
  try {
    store.updateTask(task.id, {
      stage: 'developing',
      issue: 71,
      issueBody: issue.body,
      issueState: 'open',
      pr: 9,
      head: 'head',
    });
    for (const [state, reason, expected] of [
      ['closed', 'not_planned', 'not_planned'],
      ['closed', 'completed', 'completed'],
      ['open', null, 'open'],
      ['closed', null, 'closed'],
      [undefined, undefined, undefined],
    ] as const) {
      Object.assign(issue, { state, state_reason: reason });
      const before = issueReads;
      await engine.sync();
      const current = store.snapshot().tasks.find((t) => t.id === task.id)!;
      assert.equal(issueReads, before + 1, 'each sync keeps its single existing Issue read');
      assert.equal(current.issueState, expected);
      assert.equal(current.prState, 'open');
      assert.equal(current.stage, 'developing');
      assert.equal(current.control, 'active');
    }
  } finally {
    await engine.stop();
    store.close();
  }
});

for (const legacy of [false, true]) {
  test(`unknown reads and restart preserve merged recovery hold (legacy=${legacy})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'phantom-merged-hold-'));
    const file = join(root, 'state.sqlite');
    let store = new Store(file);
    const seed = seedAdapterTask(store);
    store.saveProjectAgentSelection(seed.project.id, { mode: 'override', agent: 'codex' });
    const oldRun = store.run('dev', seed.project.id, 'backend', seed.task());
    store.updateTask(seed.task().id, {
      stage: 'developing',
      worktree: 'must-not-read',
      ownerRunId: oldRun.id,
      devThreadId: 'retained-thread',
      pr: 9,
      head: 'b'.repeat(40),
      base: 'c'.repeat(40),
    });
    const stale = store.task(seed.task().id);
    const history = store.addOwnerMessage(stale.id, 'Explain your original work');
    store.setOwnerMessage(history.id, { status: 'answered' });
    store.control(stale.id, 'pause', { source: 'user', reason: 'original_pause' });
    const dependent = store.createTask({
      projectId: stale.projectId,
      repoId: stale.repoId,
      sourceMessageId: stale.sourceMessageId,
      title: 'Dependent work',
      spec: 'Wait for host completion',
      acceptance: ['Done'],
      dependencies: [stale.id],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    const incident = store.createIncident({
      projectId: stale.projectId,
      taskId: stale.id,
      phase: 'validation',
      message: 'Old failure',
    });
    store.updateIncident(incident.id, {
      status: 'waiting_user',
      descriptor: { code: 'incident_waiting_user' },
    });
    const response = {
      ...pullFixture({
        number: 9,
        slug: 'example/repo',
        branch: 'other-branch',
        merged: true,
        headSha: 'a'.repeat(40),
        baseSha: 'c'.repeat(40),
      }),
      merged: true,
      merge_commit_sha: 'd'.repeat(40),
    };
    let failed = false;
    class Remote extends GitHub {
      override async gh(args: string[]) {
        assert.equal(args[args.indexOf('--method') + 1], 'GET');
        if (failed) throw new Error('read unavailable');
        return { stdout: JSON.stringify(response), stderr: '', code: 0 };
      }
    }
    let remote = new Remote(store);
    if (legacy) store.updateTask(stale.id, { prState: 'merged' });
    else {
      await remote.pull(store.task(stale.id));
      assert.equal(store.task(stale.id).remoteMerge?.head, 'a'.repeat(40));
      assert.equal(store.task(stale.id).remoteMerge?.mergeCommit, 'd'.repeat(40));
      assert.equal(
        store.task(stale.id).deliveryRevision,
        undefined,
        'local head is still different',
      );
      assert.equal(store.task(stale.id).head, stale.head);
    }
    const observation = store.task(stale.id).remoteMerge;
    failed = true;
    await assert.rejects(remote.pull(store.task(stale.id)), /read unavailable/);
    assert.equal(store.task(stale.id).prReadFailure?.status, 'unknown');
    assert.deepEqual(store.task(stale.id).remoteMerge, observation);
    const recovery = store.recover().find((item) => item.oldRunId === oldRun.id)!;
    assert.ok(recovery);
    const savedRecovery = store.get('recovery', recovery.id);
    const savedIncidents = store.list('incident');
    const savedOwnerHistory = store.list('ownerMessage');
    const controls = store.taskEvents(stale.id).filter((event) => event.control);
    store.close();
    store = new Store(file);
    remote = new Remote(store);
    const engine = new Engine(store, remote, new Workspaces('must-not-open', store), root, () => {
      throw new Error('Model forbidden');
    });
    try {
      for (let repeat = 0; repeat < 2; repeat++) {
        assert.equal(pendingExternalMerge(store.task(stale.id)), true);
        assert.equal(store.claimNext(), undefined);
        assert.throws(() => store.control(stale.id, 'resume'), /远端已合并/);
        assert.throws(() => store.run('dev', stale.projectId, 'backend', stale), /远端已合并/);
        assert.throws(() => store.run('review', stale.projectId, 'review', stale), /远端已合并/);
        assert.throws(
          () =>
            store.ensureRecoverySuccessor(recovery.id, {
              role: 'dev',
              profile: 'backend',
              task: stale,
            }),
          /远端已合并/,
        );
        await engine.resumeRecovery(stale.projectId, recovery.id);
        await assert.rejects(engine.resume(stale.id), /远端已合并/);
        await assert.rejects(
          engine.reassign(stale.id, { source: 'user', reason: 'retry' }),
          /远端已合并/,
        );
      }
      assert.deepEqual(store.get('recovery', recovery.id), savedRecovery);
      assert.deepEqual(store.list('incident'), savedIncidents);
      assert.deepEqual(store.list('ownerMessage'), savedOwnerHistory);
      assert.deepEqual(
        store.taskEvents(stale.id).filter((event) => event.control),
        controls,
      );
      assert.equal(store.task(stale.id).ownerRunId, oldRun.id);
      assert.equal(incidentAttention(savedIncidents[0], store.task(stale.id)).actionable, true);
      assert.deepEqual(
        teamView(store.snapshot(), stale.projectId).waiting.map((request) => request.id),
        [incident.id],
      );
      const scheduling = store.explainScheduling(stale.projectId);
      const reasons = scheduling.tasks.find((task) => task.taskId === stale.id)!.reasons;
      assert.ok(reasons.some((reason) => reason.detail?.includes('待团队核对')));
      assert.ok(
        scheduling.tasks
          .find((task) => task.taskId === dependent.id)!
          .reasons.some((reason) => reason.code === 'dependency'),
      );
      assert.equal(store.list('run').length, 1, 'no successor or assessment was created');
      const pm = store.run('pm', stale.projectId, 'pm', store.task(stale.id));
      assert.equal(pm.role, 'pm', 'read-only PM coordination stays available');
    } finally {
      store.close();
    }
  });
}

for (const settled of [false, true]) {
  for (const action of ['resolved', 'paused', 'waiting_user'] as const) {
    test(
      `external ${settled ? 'done' : 'hold'} records Incident ${action} ` + 'without resuming work',
      async () => {
        const store = new Store(':memory:');
        const seed = seedAdapterTask(store);
        const task = seed.task();
        const repo = store.repo(task.repoId);
        const primary = {
          repoId: repo.id,
          repository: repo.github,
          pr: 9,
          head: 'a'.repeat(40),
          base: 'c'.repeat(40),
          baseRef: repo.defaultBranch,
          mergeCommit: 'd'.repeat(40),
          mergedAt: '2026-11-10T08:47:41Z',
          checkedAt: new Date().toISOString(),
        };
        const engine = new Engine(
          store,
          new GitHub(store),
          new Workspaces('must-not-open', store),
          'must-not-open',
          () => {
            throw new Error('Model forbidden');
          },
        );
        try {
          const old = store.createIncident({
            projectId: task.projectId,
            taskId: task.id,
            phase: 'validation',
            message: 'Original validation failure',
          });
          store.updateTask(task.id, {
            stage: 'developing',
            issue: 1,
            issueState: 'completed',
            pr: 9,
            prState: 'merged',
            remoteMerge: primary,
            head: 'b'.repeat(40),
            base: 'c'.repeat(40),
            control: 'paused',
            pausedByUser: true,
          });
          if (settled) {
            store.completeExternalTask(task.id, {
              primary,
              closing: primary,
              issue: 1,
              closedAt: primary.mergedAt,
              checkedAt: primary.checkedAt,
              relationship: {
                primaryReferencesIssue: true,
                closingReferencesIssue: true,
                closureEventAt: primary.mergedAt,
              },
            });
            const historical = store.get('incident', old.id);
            assert.throws(
              () => engine.resolveIncident(task.projectId, old.id, action, 'Rewrite history'),
              /保留供查阅/,
            );
            assert.deepEqual(store.get('incident', old.id), historical);
          }
          const original = store.get('incident', old.id);
          const fresh = store.createIncident({
            projectId: task.projectId,
            taskId: task.id,
            phase: 'validation',
            message: 'New delivery issue',
          });
          if (settled) assert.notEqual(fresh.id, old.id);
          const before = store.task(task.id);
          const controls = store.taskEvents(task.id).filter((event) => event.control);
          const result = engine.resolveIncident(task.projectId, fresh.id, action, 'New decision');
          assert.equal(result.status, action === 'paused' ? 'assessing' : action);
          assert.equal(result.message, 'New decision');
          if (settled) assert.deepEqual(store.get('incident', old.id), original);
          assert.deepEqual(store.task(task.id), before);
          assert.deepEqual(
            store.taskEvents(task.id).filter((event) => event.control),
            controls,
          );
          assert.equal(store.claimNext(), undefined);
          assert.equal(store.list('run').length, 0);
        } finally {
          await engine.stop();
          store.close();
        }
      },
    );
  }
}

for (const change of ['none', 'repository', 'event', 'number', 'time'] as const) {
  test(`external completion rechecks closing event identity (${change})`, async () => {
    const store = new Store(':memory:');
    const seed = seedAdapterTask(store);
    const at = '2026-11-10T08:47:42Z';
    store.updateTask(seed.task().id, {
      stage: 'developing',
      issue: 1,
      pr: 9,
      issueState: 'completed',
      head: 'b'.repeat(40),
      base: 'c'.repeat(40),
      control: 'paused',
      pausedByUser: true,
    });
    let relationReads = 0;
    class Remote extends GitHub {
      override async gh(args: string[], input?: string): Promise<GhResult> {
        let response: unknown;
        if (args[1] === 'graphql') {
          const query = JSON.parse(input!);
          assert.doesNotMatch(query.query, /mutation/);
          assert.equal(query.variables.pr, ++relationReads === 1 ? 9 : 10);
          const second = relationReads === 2;
          response = {
            data: {
              repository: {
                pullRequest: {
                  number: query.variables.pr,
                  closingIssuesReferences: {
                    nodes: [{ number: 1, repository: { nameWithOwner: 'example/repo' } }],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
                issue: {
                  number: 1,
                  state: 'CLOSED',
                  stateReason: 'COMPLETED',
                  timelineItems: {
                    nodes: [
                      {
                        __typename: second && change === 'event' ? 'ReopenedEvent' : 'ClosedEvent',
                        createdAt: second && change === 'time' ? '2026-11-10T09:00:00Z' : at,
                        closer: {
                          __typename: 'PullRequest',
                          number: second && change === 'number' ? 11 : 10,
                          repository: {
                            nameWithOwner:
                              second && change === 'repository' ? 'other/repo' : 'example/repo',
                          },
                        },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          };
        } else {
          assert.equal(args[args.indexOf('--method') + 1], 'GET');
          assert.match(args[1], /^repos\/example\/repo\/pulls\/(9|10)$/);
          response = {
            ...pullFixture({
              number: args[1].endsWith('/9') ? 9 : 10,
              slug: 'example/repo',
              branch: 'external-branch',
              merged: true,
              headSha: 'a'.repeat(40),
              baseSha: 'c'.repeat(40),
            }),
            merged: true,
            merge_commit_sha: args[1].endsWith('/9') ? 'd'.repeat(40) : 'e'.repeat(40),
          };
        }
        return { stdout: JSON.stringify(response), stderr: '', code: 0 };
      }
    }
    try {
      const remote = new Remote(store);
      await remote.pull(seed.task());
      const before = seed.task();
      const settle = async () => {
        const evidence = await remote.externalCompletionEvidence(seed.task(), {
          state: 'closed',
          state_reason: 'completed',
          closed_at: at,
        });
        return store.completeExternalTask(before.id, evidence);
      };
      if (change === 'none') {
        const settled = await settle();
        assert.equal(settled.stage, 'done');
        assert.equal(settled.completion?.source, 'external');
        assert.equal(settled.completion?.closing.pr, 10);
      } else {
        await assert.rejects(settle(), /核对期间 Issue 关闭关系发生变化/);
        assert.equal(seed.task().stage, 'developing');
        assert.equal(seed.task().completion, undefined);
        assert.equal(
          store.events().filter((event) => event.type === 'external-completion').length,
          0,
        );
      }
      assert.equal(relationReads, 2);
      for (const key of ['head', 'base', 'control', 'pausedByUser', 'tests', 'reviews'] as const)
        assert.deepEqual(seed.task()[key], before[key]);
    } finally {
      store.close();
    }
  });
}

test('merge observations reject PR, repository, branch and binding drift', async () => {
  const store = new Store(':memory:');
  const seed = seedAdapterTask(store);
  store.updateTask(seed.task().id, { pr: 9 });
  const response = {
    ...pullFixture({
      number: 9,
      slug: 'example/repo',
      branch: 'other',
      merged: true,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
    }),
    merged: true,
    merge_commit_sha: 'c'.repeat(40),
  };
  let mutate = () => {};
  class Remote extends GitHub {
    override async gh() {
      mutate();
      return { stdout: JSON.stringify(response), stderr: '', code: 0 };
    }
  }
  const remote = new Remote(store);
  try {
    for (const kind of ['number', 'repository', 'branch', 'binding']) {
      response.number = kind === 'number' ? 10 : 9;
      response.base.repo = { full_name: kind === 'repository' ? 'elsewhere/repo' : 'example/repo' };
      response.base.ref = kind === 'branch' ? 'other' : 'main';
      mutate =
        kind === 'binding'
          ? () => {
              store.updateTask(seed.task().id, { pr: 10 });
            }
          : () => {};
      await assert.rejects(remote.pull(seed.task()), /身份或目标仓库/);
      assert.equal(seed.task().remoteMerge, undefined);
      assert.equal(seed.task().prState, undefined);
    }
  } finally {
    store.close();
  }
});
