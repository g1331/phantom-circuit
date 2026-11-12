import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { GitHub, type GhResult } from '../src/server/github.ts';
import { GitHubFollowUps } from '../src/server/github-follow-ups.ts';
import { FollowUps } from '../src/server/follow-ups.ts';

function fixture() {
  const store = new Store(':memory:');
  const project = store.createProject('Feedback', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'repo',
    path: '.',
    github: 'test/repo',
    defaultBranch: 'main',
    authorized: true,
  });
  store.patchRepo(repo.id, { followUpsEnabled: true });
  const message = store.addMessage(project.id, 'user', 'Add login', 'implement');
  const task = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: message.id,
    title: 'Login',
    spec: 'Email login',
    acceptance: ['Login works'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  const current = store.updateTask(task.id, { issue: 1 });
  const author = { id: 7, login: 'maintainer' };
  const comments = [
    {
      id: 10,
      body: 'Handle empty input',
      user: author,
      author_association: 'OWNER',
      updated_at: new Date().toISOString(),
      html_url: 'https://github.com/test/repo/issues/1#issuecomment-10',
    },
  ];
  let writes = 0;
  let lose = false;
  let unreadable = false;
  class Remote extends GitHub {
    override async gh(args: string[], input?: string): Promise<GhResult> {
      const endpoint = args[1];
      let result: unknown = [];
      if (endpoint === 'user') result = author;
      else if (endpoint.includes('/comments')) {
        if (args[args.indexOf('--method') + 1] === 'POST') {
          writes++;
          const response = {
            ...comments[0],
            id: 100 + writes,
            body: JSON.parse(input!).body,
            html_url: `https://github.com/test/repo/issues/1#issuecomment-${100 + writes}`,
          };
          comments.push(response);
          if (lose) throw new Error('Lost response');
          result = response;
        } else {
          if (unreadable) throw new Error('Network down');
          result = endpoint.includes('/issues/1/') ? comments : [];
        }
      } else if (endpoint.includes('/reviews'))
        result = [
          {
            id: 3,
            body: '',
            state: 'APPROVED',
            user: author,
            author_association: 'OWNER',
            submitted_at: new Date().toISOString(),
            html_url: 'https://github.com/test/repo/pull/2#pullrequestreview-3',
            commit_id: 'head',
          },
        ];
      else if (endpoint.includes('/check-runs'))
        result = {
          total_count: 1,
          check_runs: [
            {
              id: 4,
              name: 'Tests',
              status: 'completed',
              conclusion: 'failure',
              html_url: 'https://github.com/test/repo/actions/runs/4',
              completed_at: new Date().toISOString(),
              output: { title: 'Failed', summary: 'Empty input' },
            },
          ],
        };
      return { stdout: JSON.stringify(result), stderr: '', code: 0 };
    }
  }
  const github = new Remote(store);
  return {
    store,
    repo,
    task: current,
    comments,
    source: new GitHubFollowUps(store, github),
    lose: () => {
      lose = true;
    },
    unreadable: (value: boolean) => {
      unreadable = value;
    },
    writes: () => writes,
  };
}

test('Issue comments, edited revisions, bodyless reviews and pinned CI become durable follow-ups', async () => {
  const f = fixture();
  try {
    await f.source.collect(f.task);
    await f.source.collect(f.task);
    assert.equal(f.store.list('followUp').length, 1);
    f.comments[0] = {
      ...f.comments[0],
      body: 'Handle empty and whitespace input',
      updated_at: new Date(Date.now() + 1000).toISOString(),
    };
    await f.source.collect(f.task);
    assert.deepEqual(
      f.store.list('followUp').map((x) => x.body),
      ['Handle empty input', 'Handle empty and whitespace input'],
    );
    const withPR = f.store.updateTask(f.task.id, { pr: 2, head: 'head' });
    await f.source.collect(withPR);
    assert.ok(f.store.list('followUp').some((x) => x.kind === 'review' && x.body === 'APPROVED'));
    assert.ok(f.store.list('followUp').some((x) => x.kind === 'check' && x.head === 'head'));
    const count = f.store.list('followUp').length;
    f.store.patchRepo(f.repo.id, { followUpsEnabled: false });
    f.unreadable(true);
    await f.source.collect(withPR);
    assert.equal(
      f.store.list('followUp').length,
      count,
      'stopping intake is local and retains inputs',
    );
  } finally {
    f.store.close();
  }
});

test('lost follow-up replies reconcile to the original comment without another write', async () => {
  const f = fixture();
  try {
    await f.source.collect(f.task);
    const input = f.store.list('followUp')[0];
    const inbox = new FollowUps(f.store);
    inbox.claim(input.id, 'owner-run');
    inbox.settle(input.id, 'owner-run', { action: 'ignore', reason: 'Already handled.' });
    f.lose();
    await f.source.reply(input.id);
    assert.equal(f.store.get('followUp', input.id)?.reply?.status, 'uncertain');
    f.unreadable(true);
    await f.source.reply(input.id, true);
    assert.equal(f.writes(), 1);
    assert.equal(f.store.get('followUp', input.id)?.reply?.status, 'uncertain');
    f.unreadable(false);
    await f.source.reply(input.id, true);
    assert.equal(f.writes(), 1);
    assert.equal(f.store.get('followUp', input.id)?.reply?.status, 'sent');
    assert.equal(
      f.store.get('followUp', input.id)?.reply?.url,
      'https://github.com/test/repo/issues/1#issuecomment-101',
    );
  } finally {
    f.store.close();
  }
});
