import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { GitHub, type GhResult } from '../src/server/github.ts';
import { seedAdapterTask, pullFixture } from './fake-github.ts';
import { devFixture } from './dev-fixture.ts';
import { Engine } from '../src/server/engine.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { join } from 'node:path';

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
      ['unrecognized', false, null, undefined],
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
