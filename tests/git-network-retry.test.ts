import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryNetworkRead } from '../src/server/workspaces.ts';

const sslBlip = new Error(
  "git (128): fatal: unable to access 'https://github.com/o/r.git/': OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443",
);

test('a read-only git network call survives a transient connection failure', async () => {
  let calls = 0;
  const out = await retryNetworkRead(
    ['fetch', 'origin'],
    async () => {
      if (++calls < 3) throw sslBlip;
      return 'ok';
    },
    [0, 0],
  );
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
});

test('non-network failures and writes are not retried', async () => {
  for (const [args, error] of [
    [['fetch', 'origin'], new Error("git (128): fatal: couldn't find remote ref main")],
    [['push', 'origin', 'HEAD'], sslBlip],
  ] as const) {
    let calls = 0;
    await assert.rejects(
      retryNetworkRead(
        [...args],
        async () => {
          calls++;
          throw error;
        },
        [0, 0],
      ),
    );
    assert.equal(calls, 1, args.join(' '));
  }
});

test('a persistent outage still fails after the bounded retries', async () => {
  let calls = 0;
  await assert.rejects(
    retryNetworkRead(
      ['ls-remote', 'origin'],
      async () => {
        calls++;
        throw sslBlip;
      },
      [0, 0],
    ),
    /SSL_ERROR_SYSCALL/,
  );
  assert.equal(calls, 3);
});
