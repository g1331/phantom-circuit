import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { GitHub, isTransientGitHubError } from '../src/server/github.ts';

test('transient classification excludes permissions, validation and unrelated parsing failures', () => {
  for (const message of [
    'gh (1): gh: HTTP 502',
    'GitHub GraphQL query: Error: gh (1): gh: HTTP 504',
    'gh (1): unexpected end of JSON input',
  ])
    assert.equal(isTransientGitHubError(new Error(message)), true);
  for (const message of [
    'gh (1): HTTP 403 Forbidden',
    'gh (1): HTTP 401 Unauthorized',
    'gh (1): HTTP 422 Validation failed',
    'unexpected end of JSON input',
    'GitHub Issue 正文发生变化',
  ])
    assert.equal(isTransientGitHubError(new Error(message)), false);
});

test('unknown external outcome is reconciled before any second write', async () => {
  const s = new Store(':memory:');
  const gh = new GitHub(s);
  let writes = 0;
  let remote: undefined | { number: number };
  await assert.rejects(
    gh.operation(
      'issue:a',
      'issue',
      async () => undefined,
      async () => {
        writes++;
        remote = { number: 42 };
        throw new Error('Connection dropped after server accepted');
      },
    ),
  );
  const actual = await gh.operation(
    'issue:a',
    'issue',
    async () => remote,
    async () => {
      writes++;
      return { number: 43 };
    },
  );
  assert.deepEqual(actual, { number: 42 });
  assert.equal(writes, 1);
  s.close();
});
test('uncertain operation with no visible remote result is never blindly repeated', async () => {
  const s = new Store(':memory:');
  const gh = new GitHub(s);
  let writes = 0;
  await assert.rejects(
    gh.operation(
      'x',
      'issue',
      async () => undefined,
      async () => {
        writes++;
        throw new Error('Network');
      },
    ),
  );
  await assert.rejects(
    gh.operation(
      'x',
      'issue',
      async () => undefined,
      async () => {
        writes++;
        return 1;
      },
    ),
    /结果不明/,
  );
  assert.equal(writes, 1);
  s.close();
});

test('parallel callers for one external object result in one creation', async () => {
  const s = new Store(':memory:');
  const gh = new GitHub(s);
  let writes = 0;
  const create = () =>
    gh.operation(
      'shared-project',
      'project',
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        return undefined;
      },
      async () => {
        writes++;
        return { id: 'one' };
      },
    );
  const results = await Promise.all([create(), create(), create()]);
  assert.equal(writes, 1);
  assert.deepEqual(results, [{ id: 'one' }, { id: 'one' }, { id: 'one' }]);
  s.close();
});

function issueFixture() {
  const store = new Store(':memory:');
  const project = store.createProject('Completion', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'repo',
    path: '.',
    github: 'example/repo',
    authorized: true,
    defaultBranch: 'main',
  });
  const message = store.addMessage(project.id, 'user', 'Implement', 'implement');
  const task = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: message.id,
    title: 'Task',
    spec: 'Keep this unrelated checkbox: - [ ] manual',
    acceptance: ['First criterion', 'Second criterion'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  const body = `<!-- phantom-task:${task.id} -->\n## What to build\nKeep this unrelated checkbox: - [ ] manual\n\n## Acceptance criteria\n- [ ] First criterion\n- [ ] Second criterion\n\n## Blocked by\nNone (can start immediately)\n`;
  store.updateTask(task.id, { issue: 1, issueBody: body, head: 'head', base: 'base' });
  let remote = { body, state: 'open' };
  let writes = 0;
  let loseResponse = false;
  class IssueGitHub extends GitHub {
    override async api<T = any>(_endpoint: string, method = 'GET', data?: any): Promise<T> {
      if (method === 'PATCH') {
        writes++;
        remote = { ...remote, ...data };
        if (loseResponse) throw new Error('Connection lost after write');
      }
      return { ...remote } as T;
    }
  }
  return {
    store,
    task: () => store.task(task.id),
    github: () => new IssueGitHub(store),
    remote: () => remote,
    edit: (body: string) => {
      remote.body = body;
    },
    writes: () => writes,
    loseResponse: () => {
      loseResponse = true;
    },
  };
}

test('checks reads every check-run and status page before readiness', async () => {
  for (const hidden of ['failure', 'in_progress', 'status-failure', 'success', 'unreadable']) {
    const f = issueFixture();
    const requested: string[] = [];
    class Checks extends GitHub {
      override async api<T = any>(endpoint: string): Promise<T> {
        requested.push(endpoint);
        const later = endpoint.includes('page=2');
        if (hidden === 'unreadable' && later) throw new Error('page unavailable');
        if (endpoint.includes('check-runs'))
          return {
            total_count: 101,
            check_runs: later
              ? [
                  {
                    name: 'last-check',
                    status: hidden === 'in_progress' ? 'in_progress' : 'completed',
                    conclusion:
                      hidden === 'in_progress'
                        ? null
                        : hidden === 'status-failure'
                          ? 'success'
                          : hidden,
                  },
                ]
              : Array.from({ length: 100 }, (_, i) => ({
                  name: `check-${i}`,
                  status: 'completed',
                  conclusion: 'success',
                })),
          } as T;
        return {
          total_count: 101,
          statuses: later
            ? [
                {
                  context: 'last-status',
                  state: hidden === 'status-failure' ? 'failure' : 'success',
                },
              ]
            : Array.from({ length: 100 }, (_, i) => ({ context: `status-${i}`, state: 'success' })),
        } as T;
      }
    }
    try {
      const github = new Checks(f.store);
      if (hidden === 'unreadable') {
        await assert.rejects(github.checks(f.task()), /page unavailable/);
      } else {
        assert.equal((await github.checks(f.task())).ready, hidden === 'success', hidden);
        assert.ok(
          requested.some(
            (endpoint) => endpoint.includes('check-runs') && endpoint.includes('page=2'),
          ),
        );
        assert.ok(
          requested.some(
            (endpoint) => endpoint.includes('/status?') && endpoint.includes('page=2'),
          ),
        );
      }
    } finally {
      f.store.close();
    }
  }
});

test('checks refuses a short response that cannot account for the advertised total', async () => {
  const f = issueFixture();
  class Incomplete extends GitHub {
    override async api<T = any>(endpoint: string): Promise<T> {
      return (
        endpoint.includes('check-runs')
          ? {
              total_count: 101,
              check_runs: [{ name: 'only-check', status: 'completed', conclusion: 'success' }],
            }
          : { total_count: 0, statuses: [] }
      ) as T;
    }
  }
  try {
    await assert.rejects(new Incomplete(f.store).checks(f.task()), /未完整|不完整/);
  } finally {
    f.store.close();
  }
});

test('remote squash revision is retained only for the pinned merged delivery', async () => {
  const f = issueFixture();
  const head = 'a'.repeat(40);
  const commit = 'b'.repeat(40);
  const remote = {
    number: 7,
    html_url: 'https://github.com/example/repo/pull/7',
    state: 'closed',
    merged: true,
    merge_commit_sha: commit,
    head: { sha: head },
    base: { sha: 'base' },
    body: '',
  };
  class Remote extends GitHub {
    override async gh() {
      return { stdout: JSON.stringify(remote), stderr: '', code: 0 };
    }
  }
  const github = new Remote(f.store);
  try {
    f.store.updateTask(f.task().id, { pr: 7, head });
    await github.pull(f.task());
    assert.deepEqual(f.task().deliveryRevision, { head, commit });
    remote.head.sha = 'c'.repeat(40);
    remote.merge_commit_sha = 'd'.repeat(40);
    await github.pull(f.task());
    assert.deepEqual(f.task().deliveryRevision, { head, commit }, 'drift cannot rebind evidence');
  } finally {
    f.store.close();
  }
});

test('Issue completion checks only managed criteria, closes and persists the canonical body', async () => {
  const f = issueFixture();
  try {
    await f.github().completeIssue(f.task());
    assert.match(f.remote().body, /- \[x\] First criterion\n- \[x\] Second criterion/);
    assert.match(f.remote().body, /- \[ \] manual/);
    assert.equal(f.remote().state, 'closed');
    assert.equal(f.task().issueBody, f.remote().body);
    await f.github().completeIssue(f.task());
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('external publication redacts diagnostic paths and credentials without changing local context or reconciliation', async () => {
  const f = issueFixture();
  const path = String.raw`D:\owner\private\worktree\main.ts`;
  try {
    f.store.updateTask(f.task().id, {
      spec: `Inspect "${path}"\nAuthorization: Bearer external-secret\npsql postgresql://alice:external-db-secret@localhost/app\ncurl --user alice:external-basic-secret https://example.invalid\n$env:API_KEY=external-ps-api; tool https://example.invalid\n$env:TOKEN = 'external-ps-token'; tool https://example.invalid`,
    });
    await f.github().reviseIssue(f.task());
    assert.ok(!f.remote().body.includes(path));
    assert.ok(!f.remote().body.includes('external-secret'));
    assert.ok(!f.remote().body.includes('external-db-secret'));
    assert.ok(!f.remote().body.includes('external-basic-secret'));
    assert.ok(!f.remote().body.includes('external-ps-api'));
    assert.ok(!f.remote().body.includes('external-ps-token'));
    assert.ok(f.remote().body.includes('; tool https://example.invalid'));
    assert.ok(f.remote().body.includes('https://example.invalid'));
    assert.ok(f.task().spec.includes(path));
    await f.github().completeIssue(f.task());
    assert.equal(f.remote().state, 'closed');
    assert.equal(f.task().issueBody, f.remote().body);
  } finally {
    f.store.close();
  }
});

test('Issue completion preserves external edits and the last known body', async () => {
  const f = issueFixture();
  try {
    const original = f.task().issueBody;
    f.edit('Maintainer changed the requirements');
    await assert.rejects(f.github().completeIssue(f.task()), /PM/);
    assert.equal(f.writes(), 0);
    assert.equal(f.task().issueBody, original);
    assert.equal(f.remote().body, 'Maintainer changed the requirements');
  } finally {
    f.store.close();
  }
});

test('lost Issue completion response is reconciled by a new adapter without a second write', async () => {
  const f = issueFixture();
  try {
    const original = f.task().issueBody;
    f.loseResponse();
    await assert.rejects(f.github().completeIssue(f.task()), /Connection lost/);
    assert.equal(f.task().issueBody, original);
    assert.equal(f.remote().state, 'closed');
    await f.github().completeIssue(f.task());
    assert.equal(f.task().issueBody, f.remote().body);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('completed operation cache cannot hide subsequent external Issue edits', async () => {
  const f = issueFixture();
  try {
    await f.github().completeIssue(f.task());
    f.edit('Maintainer edited after completion');
    await assert.rejects(f.github().completeIssue(f.task()), /PM/);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('Project status sync reads the field once and writes only when the status changes', async () => {
  const s = new Store(':memory:');
  const p = s.createProject('Board', '');
  const repo = s.createRepo({
    projectId: p.id,
    name: 'r',
    path: '.',
    github: 'example/r',
    authorized: true,
    defaultBranch: 'main',
  });
  s.put('project', p.id, { ...s.project(p.id), githubProjectId: 'PVT_1' });
  const m = s.addMessage(p.id, 'user', 'Implement', 'implement');
  const task = s.createTask({
    projectId: p.id,
    repoId: repo.id,
    sourceMessageId: m.id,
    title: 'T',
    spec: 'S',
    acceptance: ['A'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  s.updateTask(task.id, { projectItemId: 'ITEM_1', stage: 'developing' });
  const calls: string[] = [];
  class Board extends GitHub {
    override async gql<T = any>(query: string, variables: any = {}): Promise<T> {
      if (query.startsWith('mutation')) {
        calls.push(`write:${variables.o}`);
        return {} as T;
      }
      calls.push('read');
      return {
        node: {
          fields: {
            nodes: [
              {
                id: 'F',
                name: 'Status',
                options: [
                  { id: 'todo', name: 'Todo' },
                  { id: 'doing', name: 'In Progress' },
                  { id: 'done', name: 'Done' },
                ],
              },
            ],
          },
        },
      } as T;
    }
  }
  const gh = new Board(s);
  await gh.syncStatus(s.task(task.id));
  await gh.syncStatus(s.task(task.id));
  s.updateTask(task.id, { stage: 'reviewing' });
  await gh.syncStatus(s.task(task.id));
  s.updateTask(task.id, { stage: 'done' });
  await gh.syncStatus(s.task(task.id));
  assert.deepEqual(calls, ['read', 'write:doing', 'write:done']);
  s.close();
});
