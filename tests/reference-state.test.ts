import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { GitHub, type GhResult } from '../src/server/github.ts';
import { seedAdapterTask, pullFixture } from './fake-github.ts';

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
