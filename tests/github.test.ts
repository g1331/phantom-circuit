import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { GitHub } from '../src/server/github.ts';

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
