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

function prFixture() {
  const store = new Store(':memory:');
  const project = store.createProject('Publication', '');
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
    spec: 'Spec',
    acceptance: ['Criterion'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  store.updateTask(task.id, { branch: 'phantom/task', head: 'head', base: 'base' });
  const marker = `<!-- phantom-task:${task.id} -->`;
  let remote: any[] = [];
  let reads = 0;
  let writes = 0;
  let failRead = false;
  let failWrite = false;
  let loseResponse = false;
  class PublicationGitHub extends GitHub {
    override async paged(_endpoint: string): Promise<any[]> {
      reads++;
      if (failRead) throw new Error('gh (1): gh: Server Error (HTTP 502)');
      return remote;
    }
    override async api<T = any>(_endpoint: string, _method = 'GET', body?: unknown): Promise<T> {
      writes++;
      if (failWrite) throw new Error('gh (1): gh: Server Error (HTTP 502)');
      const created = {
        number: 41,
        html_url: 'https://github.com/example/repo/pull/41',
        state: 'open',
        merged: false,
        mergeable: true,
        mergeable_state: 'clean',
        head: { sha: 'head' },
        base: { sha: 'base' },
        body: (body as { body: string }).body,
      };
      remote = [created];
      if (loseResponse) {
        loseResponse = false;
        throw new Error('gh (1): unexpected end of JSON input');
      }
      return created as T;
    }
  }
  return {
    store,
    marker,
    task: () => store.task(task.id),
    github: () => new PublicationGitHub(store),
    operation: () => store.get('operation', `pr:${task.id}`),
    remote: () => remote,
    reads: () => reads,
    writes: () => writes,
    failRead: (value: boolean) => {
      failRead = value;
    },
    failWrite: (value: boolean) => {
      failWrite = value;
    },
    loseResponse: () => {
      loseResponse = true;
    },
  };
}

test('a create-pr response lost after the remote creation is adopted without a second write', async () => {
  const f = prFixture();
  try {
    f.loseResponse();
    await assert.rejects(f.github().publishPR(f.task()), /unexpected end of JSON input/);
    assert.equal(f.operation()!.status, 'uncertain');
    assert.equal(f.writes(), 1);
    const pr = await f.github().publishPR(f.task());
    assert.equal(pr.number, 41);
    assert.equal(f.writes(), 1);
    assert.equal(f.task().pr, 41);
    assert.equal(f.operation()!.status, 'done');
  } finally {
    f.store.close();
  }
});

test('a temporarily failing remote read authorizes no retry and repeats no write', async () => {
  const f = prFixture();
  try {
    f.failWrite(true);
    await assert.rejects(f.github().publishPR(f.task()), /HTTP 502/);
    assert.equal(f.writes(), 1);
    f.failRead(true);
    await assert.rejects(f.github().authorizeTaskPRRetry(f.task(), 'pm'), /HTTP 502/);
    assert.equal(f.operation()!.reconciliation, undefined);
    f.failRead(false);
    await assert.rejects(f.github().publishPR(f.task()), /结果不明/);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('a verified-absent creation authorizes one controlled retry and never a duplicate', async () => {
  const f = prFixture();
  try {
    f.failWrite(true);
    await assert.rejects(f.github().publishPR(f.task()), /HTTP 502/);
    assert.equal(f.writes(), 1);
    await assert.rejects(f.github().publishPR(f.task()), /结果不明/);
    assert.equal(f.writes(), 1);
    f.failWrite(false);
    assert.equal(await f.github().authorizeTaskPRRetry(f.task(), 'pm'), true);
    const pr = await f.github().publishPR(f.task());
    assert.equal(pr.number, 41);
    assert.equal(f.writes(), 2);
    assert.equal(f.operation()!.status, 'done');
    assert.equal((await f.github().publishPR(f.task())).number, 41);
    assert.equal(f.writes(), 2);
  } finally {
    f.store.close();
  }
});

test('a PR that exists after all is adopted instead of authorizing a retry', async () => {
  const f = prFixture();
  try {
    f.loseResponse();
    await assert.rejects(f.github().publishPR(f.task()), /unexpected end of JSON input/);
    assert.equal(await f.github().authorizeTaskPRRetry(f.task(), 'user'), false);
    assert.equal(f.operation()!.reconciliation, undefined);
    assert.equal((await f.github().publishPR(f.task())).number, 41);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('a controlled retry that fails again consumes its authorization and cannot loop', async () => {
  const f = prFixture();
  try {
    f.failWrite(true);
    await assert.rejects(f.github().publishPR(f.task()), /HTTP 502/);
    assert.equal(await f.github().authorizeTaskPRRetry(f.task(), 'pm'), true);
    await assert.rejects(f.github().publishPR(f.task()), /HTTP 502/);
    assert.equal(f.writes(), 2);
    assert.equal(f.operation()!.status, 'uncertain');
    assert.equal(f.operation()!.reconciliation, undefined);
    await assert.rejects(f.github().publishPR(f.task()), /结果不明/);
    assert.equal(f.writes(), 2);
  } finally {
    f.store.close();
  }
});

test('reconciliation refuses an operation that already has a result', async () => {
  const f = prFixture();
  try {
    await f.github().publishPR(f.task());
    assert.throws(
      () => f.github().reconcileAbsent(`pr:${f.task().id}`, { actor: 'user', evidence: '核对' }),
      /不需要重新创建/,
    );
    assert.throws(
      () => f.github().reconcileAbsent('pr:missing', { actor: 'user', evidence: '核对' }),
      /不存在/,
    );
  } finally {
    f.store.close();
  }
});
