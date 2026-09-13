import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { isMerged, parsePullPage } from '../src/server/github.ts';
import { FakeGitHub, pullFixture, seedAdapterTask } from './fake-github.ts';

/**
 * Publication reconciliation at the adapter boundary, against a local fake GitHub. Every case
 * here exists because the host must be able to tell "the remote object was never created" apart
 * from "a related remote object exists but cannot be adopted", and must never turn the second
 * into a duplicate creation.
 */
function prFixture() {
  const store = new Store(':memory:');
  const seed = seedAdapterTask(store);
  const github = new FakeGitHub(store);
  const key = `pr:${seed.task().id}`;
  return {
    ...seed,
    github,
    key,
    /** The remote rejected the request outright: it holds no PR for this task. */
    transportFailure: (message = 'gh (1): gh: Server Error (HTTP 502)') => {
      github.failWrite = new Error(message);
    },
    /** The remote applied the creation and then lost the response. */
    lostResponse: () => {
      github.loseWriteResponse = true;
    },
  };
}
type Fixture = ReturnType<typeof prFixture>;

/** Drive the fixture into the real Task #32 state: one create-pr whose outcome is unknown. */
async function unconfirmed(f: Fixture) {
  f.transportFailure();
  await assert.rejects(f.github.publishPR(f.task()), /HTTP 502/);
  f.github.failWrite = undefined;
  assert.equal(f.operation()!.status, 'uncertain');
  assert.equal(f.operation()!.result, undefined);
  assert.equal(f.github.posted.length, 1, 'the original request was attempted exactly once');
  assert.equal(f.github.writes, 0, 'the fake remote never accepted it');
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

/**
 * `count` PRs that are related to no task, enough to push a real candidate past GitHub's first
 * page. The adapter asks for 20 per page, so exactly 20 of these fill page 1.
 */
function unrelated(count: number, start = 100) {
  return Array.from({ length: count }, (_, i) =>
    pullFixture({ number: start + i, slug: 'example/repo', branch: 'phantom/other' }),
  );
}

test('a create-pr response lost after the remote creation is adopted without a second write', async () => {
  const f = prFixture();
  try {
    f.lostResponse();
    await assert.rejects(f.github.publishPR(f.task()), /unexpected end of JSON input/);
    assert.equal(f.operation()!.status, 'uncertain');
    assert.equal(f.github.posted.length, 1);
    assert.equal(f.github.writes, 1);
    const pr = await f.github.publishPR(f.task());
    assert.equal(pr.number, 41);
    assert.equal(f.github.posted.length, 1, 'a visible remote PR must never be created twice');
    assert.equal(f.task().pr, 41);
    assert.equal(f.operation()!.status, 'done');
  } finally {
    f.store.close();
  }
});

test('a proven-absent creation is authorized once and a repeat failure cannot loop', async () => {
  const f = prFixture();
  try {
    await unconfirmed(f);
    await assert.rejects(f.github.publishPR(f.task()), /结果不明/);
    assert.equal(f.github.posted.length, 1);

    const reconciliation = await f.github.authorizeTaskPRRetry(f.task(), 'pm');
    assert.equal(reconciliation.action, 'authorize');
    const authorization = f.operation()!.reconciliation!;
    assert.equal(authorization.verdict, 'absent');
    assert.equal(authorization.actor, 'pm');
    assert.equal(authorization.observedOperation.status, 'uncertain');
    assert.equal(typeof authorization.taskRevision, 'string');
    assert.ok(authorization.taskRevision.length > 0);

    // The controlled retry fails again: the authorization is spent and cannot loop.
    f.transportFailure();
    await assert.rejects(f.github.publishPR(f.task()), /HTTP 502/);
    assert.equal(f.github.posted.length, 2, 'the authorized retry runs exactly once');
    assert.equal(f.operation()!.status, 'uncertain');
    assert.equal(f.operation()!.reconciliation, undefined, 'the authorization is consumed');
    await assert.rejects(f.github.publishPR(f.task()), /结果不明/);
    await assert.rejects(f.github.publishPR(f.task()), /结果不明/);
    assert.equal(f.github.posted.length, 2, 'an unresolved outcome is never blindly repeated');

    // Only another explicit coordination can try once more, and then it succeeds.
    f.github.failWrite = undefined;
    assert.equal((await f.github.authorizeTaskPRRetry(f.task(), 'pm')).action, 'authorize');
    const pr = await f.github.publishPR(f.task());
    assert.equal(pr.number, 41);
    assert.equal(f.github.posted.length, 3);
    assert.equal(f.operation()!.status, 'done');
    assert.equal((await f.github.authorizeTaskPRRetry(f.task(), 'pm')).action, 'none');
  } finally {
    f.store.close();
  }
});

test('a same-branch PR whose marker was stripped blocks instead of authorizing a duplicate', async () => {
  const f = prFixture();
  try {
    await unconfirmed(f);
    const edited = 'Maintainer rewrote this PR body by hand.\n';
    f.github.pulls = [
      pullFixture({ number: 7, slug: 'example/repo', branch: 'phantom/task', body: edited }),
    ];
    await assert.rejects(f.github.authorizeTaskPRRetry(f.task(), 'pm'), /需要人工核对.*缺少任务标记/);
    assert.equal(f.operation()!.reconciliation, undefined);
    await assert.rejects(f.github.publishPR(f.task()), /需要人工核对/);
    assert.equal(f.github.posted.length, 1, 'a marker-less same-branch PR is never re-created');
    assert.equal(f.github.pulls[0].body, edited, 'the human body is never overwritten');
    assert.equal(f.task().pr, undefined);
  } finally {
    f.store.close();
  }
});

test('a same-branch PR whose marker was edited is not read as absent either', async () => {
  const f = prFixture();
  try {
    await unconfirmed(f);
    // Same task id, hand-edited marker syntax: it must not be treated as ours or as nothing.
    const near = `<!--phantom-task:${f.task().id}-->\n`;
    f.github.pulls = [
      pullFixture({ number: 8, slug: 'example/repo', branch: 'phantom/task', body: near }),
    ];
    await assert.rejects(f.github.authorizeTaskPRRetry(f.task(), 'pm'), /需要人工核对/);
    assert.equal(f.operation()!.reconciliation, undefined);
    assert.equal(f.github.posted.length, 1);
    assert.equal(f.github.pulls[0].body, near);
  } finally {
    f.store.close();
  }
});

test('a closed but unmerged PR on the task branch blocks instead of authorizing', async () => {
  const f = prFixture();
  try {
    await unconfirmed(f);
    f.github.pulls = [
      pullFixture({
        number: 5,
        slug: 'example/repo',
        branch: 'phantom/task',
        marker: f.marker,
        state: 'closed',
        merged: false,
      }),
    ];
    await assert.rejects(f.github.authorizeTaskPRRetry(f.task(), 'pm'), /已关闭但未合并/);
    assert.equal(f.operation()!.reconciliation, undefined);
    await assert.rejects(f.github.publishPR(f.task()), /需要人工核对/);
    assert.equal(f.github.posted.length, 1);
  } finally {
    f.store.close();
  }
});

test('an already merged marker PR is adopted without any write', async () => {
  const f = prFixture();
  try {
    await unconfirmed(f);
    f.github.pulls = [
      pullFixture({
        number: 4,
        slug: 'example/repo',
        branch: 'phantom/task',
        marker: f.marker,
        state: 'closed',
        merged: true,
      }),
    ];
    const reconciliation = await f.github.authorizeTaskPRRetry(f.task(), 'user');
    assert.equal(reconciliation.action, 'adopt');
    assert.equal(f.operation()!.reconciliation, undefined, 'adoption needs no authorization');
    const pr = await f.github.publishPR(f.task());
    assert.equal(pr.number, 4);
    assert.equal(isMerged(pr), true, 'merged state is read from the listing shape');
    assert.equal(f.github.posted.length, 1, 'a merged delivery is adopted, never duplicated');
    assert.equal(f.task().pr, 4);
  } finally {
    f.store.close();
  }
});

test('a retargeted marker PR blocks instead of authorizing', async () => {
  const f = prFixture();
  try {
    await unconfirmed(f);
    f.github.pulls = [
      pullFixture({
        number: 6,
        slug: 'example/repo',
        branch: 'phantom/task',
        baseRef: 'release',
        marker: f.marker,
      }),
    ];
    await assert.rejects(f.github.authorizeTaskPRRetry(f.task(), 'pm'), /目标分支为 release/);
    assert.equal(f.operation()!.reconciliation, undefined);
    assert.equal(f.github.posted.length, 1);
  } finally {
    f.store.close();
  }
});

test('a marker PR from another repository or branch blocks instead of authorizing', async () => {
  for (const [label, pull] of [
    [
      'foreign head repository',
      pullFixture({ number: 5, slug: 'example/repo', branch: 'phantom/task', headRepo: 'fork/repo', marker: '' }),
    ],
    ['moved head branch', pullFixture({ number: 5, slug: 'example/repo', branch: 'phantom/task', headRef: 'phantom/older' })],
  ] as const) {
    const f = prFixture();
    try {
      await unconfirmed(f);
      f.github.pulls = [{ ...pull, body: `${f.marker}\n` }];
      await assert.rejects(f.github.authorizeTaskPRRetry(f.task(), 'pm'), /需要人工核对/);
      assert.equal(f.operation()!.reconciliation, undefined, label);
      assert.equal(f.github.posted.length, 1, label);
    } finally {
      f.store.close();
    }
  }
});

test('multiple related candidates block instead of authorizing', async () => {
  const f = prFixture();
  try {
    await unconfirmed(f);
    f.github.pulls = [
      pullFixture({ number: 5, slug: 'example/repo', branch: 'phantom/task', marker: f.marker }),
      pullFixture({
        number: 6,
        slug: 'example/repo',
        branch: 'phantom/task',
        marker: f.marker,
        state: 'closed',
      }),
    ];
    await assert.rejects(f.github.authorizeTaskPRRetry(f.task(), 'pm'), /存在 2 个与本任务相关的 PR/);
    assert.equal(f.operation()!.reconciliation, undefined);
    await assert.rejects(f.github.publishPR(f.task()), /需要人工核对/);
    assert.equal(f.github.posted.length, 1);
  } finally {
    f.store.close();
  }
});

test('a candidate on a later page is found, and a page-1 miss never reads as absent', async () => {
  const f = prFixture();
  try {
    await unconfirmed(f);
    // A full first page of unrelated PRs, so the candidate really is on page 2.
    f.github.pulls = [
      ...unrelated(20),
      pullFixture({ number: 9, slug: 'example/repo', branch: 'phantom/task', marker: f.marker }),
    ];
    const reconciliation = await f.github.authorizeTaskPRRetry(f.task(), 'pm');
    assert.equal(reconciliation.action, 'adopt', 'a later-page candidate is still found');
    assert.equal(f.operation()!.reconciliation, undefined);
    const pr = await f.github.publishPR(f.task());
    assert.equal(pr.number, 9);
    assert.equal(f.github.posted.length, 1, 'pagination misses must never authorize a creation');
  } finally {
    f.store.close();
  }
});

test('a full page is followed by another request until the listing is confirmed finished', async () => {
  const f = prFixture();
  try {
    await unconfirmed(f);
    // Exactly one full page and no related PR anywhere. The reader may only conclude "absent"
    // after the empty page that follows the full one confirms the listing really ended.
    f.github.pulls = unrelated(20);
    const reconciliation = await f.github.authorizeTaskPRRetry(f.task(), 'pm');
    assert.equal(reconciliation.action, 'authorize');
    assert.equal(f.operation()!.reconciliation!.verdict, 'absent');
    const pr = await f.github.publishPR(f.task());
    assert.equal(pr.number, 41);
    assert.equal(f.github.posted.length, 2, 'exactly one authorized retry');
  } finally {
    f.store.close();
  }
});

test('a second related candidate on a later page is never missed', async () => {
  const f = prFixture();
  try {
    await unconfirmed(f);
    // The adoptable candidate is the 20th entry of page 1; a second related PR sits on page 2.
    // Concluding at the first match would adopt it and hide the ambiguity.
    f.github.pulls = [
      ...unrelated(19),
      pullFixture({ number: 9, slug: 'example/repo', branch: 'phantom/task', marker: f.marker }),
      pullFixture({ number: 10, slug: 'example/repo', branch: 'phantom/task', marker: f.marker }),
    ];
    await assert.rejects(f.github.authorizeTaskPRRetry(f.task(), 'pm'), /存在 2 个与本任务相关的 PR/);
    assert.equal(f.operation()!.reconciliation, undefined);
    await assert.rejects(f.github.publishPR(f.task()), /存在 2 个与本任务相关的 PR/);
    assert.equal(f.github.posted.length, 1, 'an ambiguous listing never creates anything');
  } finally {
    f.store.close();
  }
});

test('a related candidate beyond the first page blocks instead of authorizing', async () => {
  const f = prFixture();
  try {
    await unconfirmed(f);
    f.github.pulls = [
      ...unrelated(20),
      pullFixture({
        number: 9,
        slug: 'example/repo',
        branch: 'phantom/task',
        headRef: 'phantom/older',
        marker: f.marker,
      }),
    ];
    await assert.rejects(f.github.authorizeTaskPRRetry(f.task(), 'pm'), /源分支为 phantom\/older/);
    assert.equal(f.operation()!.reconciliation, undefined);
    assert.equal(f.github.posted.length, 1);
  } finally {
    f.store.close();
  }
});

test('a failing, partial or malformed read authorizes nothing', async () => {
  const cases: { label: string; expected: RegExp; prepare: (f: Fixture) => void }[] = [
    {
      label: 'every read fails',
      expected: /HTTP 502/,
      prepare: (f) => (f.github.failRead = new Error('gh (1): gh: Server Error (HTTP 502)')),
    },
    {
      label: 'only the branch query fails',
      expected: /HTTP 503/,
      prepare: (f) => (f.github.failBranchRead = new Error('gh (1): gh: Server Error (HTTP 503)')),
    },
    {
      label: 'a page response is cut off mid-JSON',
      expected: /核对后恢复/,
      prepare: (f) => (f.github.readBody = () => '[{"number":1},{"number":2}'),
    },
    {
      label: 'the response is not a page',
      expected: /核对后恢复/,
      prepare: (f) => (f.github.readBody = () => '{"message":"Bad credentials"}'),
    },
    {
      label: 'the response is a whole slurped listing, not one page',
      expected: /核对后恢复/,
      prepare: (f) => (f.github.readBody = () => '[[{"number":1}]]'),
    },
    {
      label: 'entries lack an identity',
      expected: /核对后恢复/,
      prepare: (f) => (f.github.readBody = () => '[{"title":"no number"}]'),
    },
    {
      label: 'a page exceeds the process output limit',
      expected: /核对后恢复/,
      prepare: (f) => {
        f.github.pulls = unrelated(1);
        f.github.truncatePage = 1;
      },
    },
    {
      label: 'a later page fails',
      expected: /HTTP 502/,
      prepare: (f) => {
        f.github.pulls = unrelated(21);
        f.github.failPage = 2;
      },
    },
    {
      label: 'a later page exceeds the process output limit',
      expected: /核对后恢复/,
      prepare: (f) => {
        f.github.pulls = unrelated(21);
        f.github.truncatePage = 2;
      },
    },
  ];
  for (const { label, expected, prepare } of cases) {
    const f = prFixture();
    try {
      await unconfirmed(f);
      prepare(f);
      await assert.rejects(f.github.authorizeTaskPRRetry(f.task(), 'pm'), expected, label);
      assert.equal(f.operation()!.reconciliation, undefined, label);
      await assert.rejects(f.github.publishPR(f.task()), expected, label);
      assert.equal(f.github.posted.length, 1, label);
      assert.equal(f.github.writes, 0, label);
    } finally {
      f.store.close();
    }
  }
});

test('an incomplete read neither consumes nor replaces an outstanding authorization', async () => {
  for (const unreadable of ['later page fails', 'later page is truncated', 'page bound'] as const) {
    const f = prFixture();
    try {
      await unconfirmed(f);
      assert.equal((await f.github.authorizeTaskPRRetry(f.task(), 'pm')).action, 'authorize');
      const granted = f.operation()!.reconciliation!;
      // The listing becomes unreadable after the authorization was issued.
      if (unreadable === 'page bound') f.github.endlessPages = true;
      else {
        f.github.pulls = unrelated(21);
        if (unreadable === 'later page fails') f.github.failPage = 2;
        else f.github.truncatePage = 2;
      }
      await assert.rejects(f.github.publishPR(f.task()), /HTTP 502|核对后恢复/, unreadable);
      const live = f.operation()!;
      assert.equal(live.reconciliation!.id, granted.id, unreadable);
      assert.equal(live.reconciliation!.verdict, 'absent', unreadable);
      assert.equal(live.status, 'uncertain', unreadable);
      assert.equal(f.github.posted.length, 1, unreadable);

      // Once the listing can be read again the same single-use authorization still works.
      f.github.failPage = undefined;
      f.github.truncatePage = undefined;
      f.github.endlessPages = false;
      assert.equal((await f.github.publishPR(f.task())).number, 41, unreadable);
      assert.equal(f.github.posted.length, 2, unreadable);
      assert.equal(f.operation()!.status, 'done', unreadable);
      assert.equal(f.operation()!.reconciliation, undefined, unreadable);
    } finally {
      f.store.close();
    }
  }
});

test('page parsing rejects anything that cannot prove a complete page', () => {
  assert.deepEqual(
    parsePullPage('[{"number":1},{"number":2}]').map((x) => x.number),
    [1, 2],
    'a page yields its entries in order',
  );
  assert.deepEqual(parsePullPage('[]'), [], 'a genuinely empty page is an empty page');
  for (const malformed of [
    '[{"number":1},{"number":2}',
    '{"message":"Bad credentials"}',
    '[[{"number":1}]]',
    '[{"title":"no number"}]',
    '[[]',
    '',
  ])
    assert.throws(() => parsePullPage(malformed), /核对后恢复/, JSON.stringify(malformed));
});

test('two concurrent reconciliations issue at most one authorization', async () => {
  const f = prFixture();
  try {
    await unconfirmed(f);
    const spentBefore = f.operation()!.attempt;
    const pending = gate();
    f.github.readGate = pending.promise;
    const first = f.github.authorizeTaskPRRetry(f.task(), 'pm');
    const second = f.github.authorizeTaskPRRetry(f.task(), 'user');
    pending.release();
    const results = await Promise.allSettled([first, second]);
    // Both may report an authorization, but they must agree on the single one that is recorded:
    // the loser re-affirms what it finds rather than stacking a second grant or failing outright.
    const granted = results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<any>).value)
      .filter((v) => v.action === 'authorize');
    assert.ok(granted.length >= 1, 'at least one reconciliation is granted');
    assert.equal(
      new Set(granted.map((v) => v.evidence)).size,
      1,
      'concurrent reconciliations agree on one authorization',
    );
    const recorded = f.operation()!.reconciliation;
    assert.ok(recorded, 'exactly one authorization is recorded');
    assert.equal(recorded.verdict, 'absent');
    assert.equal(f.operation()!.attempt, spentBefore, 'coordination alone spends no attempt');
    // One authorization still yields exactly one controlled write, and then no more.
    const pr = await f.github.publishPR(f.task());
    assert.equal(pr.number, 41);
    assert.equal(f.github.posted.length, 2, 'one authorization, one write');
    assert.equal(f.operation()!.status, 'done');
    assert.equal((await f.github.publishPR(f.task())).number, 41);
    assert.equal(f.github.posted.length, 2);
  } finally {
    f.store.close();
  }
});

test('an operation that changes while the reconciliation read runs is never overwritten', async () => {
  for (const injected of [
    { id: 'done' as const },
    { id: 'pending' as const },
  ]) {
    const f = prFixture();
    try {
      await unconfirmed(f);
      const pending = gate();
      f.github.readGate = pending.promise;
      const verifying = f.github.authorizeTaskPRRetry(f.task(), 'pm');
      // A competing publisher moved the record on while the remote read was in flight.
      const replacement =
        injected.id === 'done'
          ? { id: f.key, kind: 'create-pr', status: 'done' as const, result: { number: 77 } }
          : { id: f.key, kind: 'create-pr', status: 'pending' as const };
      f.store.put('operation', f.key, replacement);
      pending.release();
      if (injected.id === 'done') {
        // A settled operation needs no coordination at all, and certainly no stale conclusion.
        assert.equal((await verifying).action, 'none', injected.id);
      } else {
        // An attempt in flight must be refused, never overwritten by a conclusion about before it.
        await assert.rejects(verifying, /外部操作|状态已变化/, injected.id);
      }
      assert.equal(f.operation()!.reconciliation, undefined, injected.id);
      assert.deepEqual(f.operation(), replacement, injected.id);
    } finally {
      f.store.close();
    }
  }
});

test('a related PR that appears after the authorization is adopted, not duplicated', async () => {
  const f = prFixture();
  try {
    await unconfirmed(f);
    assert.equal((await f.github.authorizeTaskPRRetry(f.task(), 'pm')).action, 'authorize');
    // Somebody publishes the task PR between the authorization and the controlled retry.
    f.github.pulls = [
      pullFixture({ number: 42, slug: 'example/repo', branch: 'phantom/task', marker: f.marker }),
    ];
    const pr = await f.github.publishPR(f.task());
    assert.equal(pr.number, 42);
    assert.equal(f.github.posted.length, 1, 'the late PR is adopted before any write is attempted');
    assert.equal(f.task().pr, 42);
  } finally {
    f.store.close();
  }
});

test('an authorization recorded for another task revision is superseded, never reused', async () => {
  const f = prFixture();
  try {
    await unconfirmed(f);
    assert.equal((await f.github.authorizeTaskPRRetry(f.task(), 'pm')).action, 'authorize');
    const stale = f.operation()!.reconciliation!;
    // The task moved on: the verified absence no longer describes this revision.
    f.store.updateTask(f.task().id, { head: 'moved-head' });
    await assert.rejects(f.github.publishPR(f.task()), /核对结论与当前任务版本不一致/);
    assert.equal(f.github.posted.length, 1, 'a stale conclusion never authorizes a write');
    assert.equal(f.operation()!.reconciliation!.id, stale.id, 'a refusal does not burn it');

    // Reconciling again re-reads the remote for the new revision and replaces the stale grant.
    assert.equal((await f.github.authorizeTaskPRRetry(f.task(), 'pm')).action, 'authorize');
    const fresh = f.operation()!.reconciliation!;
    assert.notEqual(fresh.id, stale.id);
    // The fresh grant is bound to the moved revision, so the controlled retry is allowed.
    assert.notEqual(fresh.taskRevision, stale.taskRevision);
    const pr = await f.github.publishPR(f.task());
    assert.equal(pr.number, 41);
    assert.equal(f.github.posted.length, 2, 'the moved revision publishes exactly once');
    assert.equal(f.operation()!.status, 'done');
  } finally {
    f.store.close();
  }
});

test('reconciling the same revision twice re-affirms one single-use authorization', async () => {
  const f = prFixture();
  try {
    await unconfirmed(f);
    assert.equal((await f.github.authorizeTaskPRRetry(f.task(), 'pm')).action, 'authorize');
    const first = f.operation()!.reconciliation!;
    assert.equal((await f.github.authorizeTaskPRRetry(f.task(), 'user')).action, 'authorize');
    assert.equal(f.operation()!.reconciliation!.id, first.id, 'no second authorization is stacked');
    // Arm the retry to fail, so the single consumed authorization is observable.
    f.transportFailure();
    await assert.rejects(f.github.publishPR(f.task()), /HTTP 502/);
    assert.equal(f.github.posted.length, 2, 'one authorization still yields one write');
    assert.equal(f.operation()!.reconciliation, undefined, 'and it is consumed');
    await assert.rejects(f.github.publishPR(f.task()), /结果不明/);
    assert.equal(f.github.posted.length, 2);
  } finally {
    f.store.close();
  }
});

test('an interrupted write is never treated as a write that never happened', async () => {
  for (const remote of [false, true]) {
    const f = prFixture();
    try {
      // A crash between recording `pending` and the write: acceptance is unknowable from here.
      f.store.put('operation', f.key, { id: f.key, kind: 'create-pr', status: 'pending' });
      if (remote)
        f.github.pulls = [
          pullFixture({ number: 12, slug: 'example/repo', branch: 'phantom/task', marker: f.marker }),
        ];
      if (remote) {
        assert.equal((await f.github.publishPR(f.task())).number, 12);
        assert.equal(f.github.posted.length, 0, 'an interrupted write is reconciled, not repeated');
        assert.equal(f.operation()!.status, 'done');
      } else {
        await assert.rejects(f.github.publishPR(f.task()), /结果不明/);
        assert.equal(f.github.posted.length, 0, 'pending is undecided, not "not yet performed"');
        assert.equal(f.operation()!.status, 'pending', 'the undecided record is left undecided');
        // Only a verified-absence coordination can move it forward.
        assert.equal((await f.github.authorizeTaskPRRetry(f.task(), 'pm')).action, 'authorize');
        assert.equal((await f.github.publishPR(f.task())).number, 41);
        assert.equal(f.github.posted.length, 1);
      }
    } finally {
      f.store.close();
    }
  }
});

test('reconciliation refuses an operation that already has a result', async () => {
  const f = prFixture();
  try {
    await f.github.publishPR(f.task());
    assert.throws(
      () =>
        f.github.reconcileAbsent(f.key, {
          actor: 'user',
          evidence: '核对',
          taskRevision: 'revision',
          observed: { status: 'uncertain', attempt: 1 },
        }),
      /不需要重新创建/,
    );
    assert.throws(
      () =>
        f.github.reconcileAbsent('pr:missing', {
          actor: 'user',
          evidence: '核对',
          taskRevision: 'revision',
          observed: { status: 'uncertain', attempt: 1 },
        }),
      /不存在/,
    );
  } finally {
    f.store.close();
  }
});

test('a stale reconciliation cannot authorize an attempt that already ran and failed', async () => {
  const f = prFixture();
  try {
    await unconfirmed(f);
    // Resume A's remote read parks; its snapshot predates everything below.
    const parked = gate();
    f.github.readGate = parked.promise;
    const stale = f.github.authorizeTaskPRRetry(f.task(), 'pm');
    // Resume B reconciles for real, and its controlled retry fails again with the same error,
    // so the record returns to exactly the status and error resume A observed.
    f.github.readGate = undefined;
    assert.equal((await f.github.authorizeTaskPRRetry(f.task(), 'user')).action, 'authorize');
    f.transportFailure();
    await assert.rejects(f.github.publishPR(f.task()), /HTTP 502/);
    assert.equal(f.operation()!.status, 'uncertain');
    assert.equal(f.operation()!.reconciliation, undefined);
    const spent = f.operation()!.attempt;

    // Resume A's read returns now. Its absence conclusion predates the attempt that already ran.
    parked.release();
    await assert.rejects(stale, /状态已变化/);
    assert.equal(f.operation()!.reconciliation, undefined, 'no stale grant is recorded');
    assert.equal(f.operation()!.attempt, spent);
    assert.equal(f.github.posted.length, 2, 'only the authorized retry ever wrote');
  } finally {
    f.store.close();
  }
});

test('a re-affirmation that loses the race never cites a grant that is gone', async () => {
  for (const variant of ['settled-done', 'consumed-then-failed-again'] as const) {
    const f = prFixture();
    try {
      await unconfirmed(f);
      assert.equal((await f.github.authorizeTaskPRRetry(f.task(), 'pm')).action, 'authorize');
      const spent = f.operation()!.reconciliation!.id;

      // A re-affirmation whose remote read parks, so its view of the operation goes stale.
      const parked = gate();
      f.github.readGate = parked.promise;
      const readback = f.github.authorizeTaskPRRetry(f.task(), 'pm');
      f.github.readGate = undefined;
      if (variant === 'settled-done') {
        f.store.put('operation', f.key, {
          id: f.key,
          kind: 'create-pr',
          status: 'done',
          result: { number: 41 },
          attempt: 2,
        });
      } else {
        // The outstanding grant is consumed and its controlled retry fails again identically.
        f.transportFailure();
        await assert.rejects(f.github.publishPR(f.task()), /HTTP 502/);
        assert.equal(f.operation()!.reconciliation, undefined);
        assert.equal(f.operation()!.attempt, 2);
      }
      parked.release();

      if (variant === 'settled-done') {
        assert.equal((await readback).action, 'none', 'a settled operation is not re-authorized');
      } else {
        await assert.rejects(readback, /状态已变化/, 'a spent conclusion is not re-applied');
      }
      const live = f.operation()!;
      assert.notEqual(
        live.reconciliation?.id,
        spent,
        `${variant}: the consumed authorization is never re-affirmed`,
      );
    } finally {
      f.store.close();
    }
  }
});
