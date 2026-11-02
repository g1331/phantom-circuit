import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './finalization-fixture.ts';

test('a host validation environment block names the matched line even under long output', async (t) => {
  const f = await fixture(t, async (cwd) => {
    await writeFile(join(cwd, 'value.txt'), 'after');
  });
  const failure = 'Error: EBUSY: resource busy or locked, unlink preview.log';
  f.store.patchRepo(f.repo.id, {
    commands: {
      install: '',
      build: 'node -e "process.exit(0)"',
      test: `node -e "console.error('${failure}');console.log('ok\\n'.repeat(9000));process.exit(1)"`,
      start: '',
      port: 3000,
    },
  });
  const result = await f.run();
  assert.equal(result.control, 'paused', JSON.stringify(result).slice(0, 500));
  assert.match(result.blocked!, /宿主正式验证环境阻塞/);
  assert.ok(result.blocked!.includes(failure), 'the matched line survives the output tail');
});

for (const failure of [
  'Error: spawn taskkill EPERM',
  'Error: EBUSY: resource busy or locked, unlink preview.log',
  'Error: EIO: i/o error, write',
  'Reason: Access is denied.',
]) {
  test(`host validation environment failure pauses with evidence: ${failure}`, async (t) => {
    const f = await fixture(t, async (cwd) => {
      await writeFile(join(cwd, 'value.txt'), 'after');
    });
    f.store.patchRepo(f.repo.id, {
      commands: {
        install: '',
        build: 'node -e "process.exit(0)"',
        test: `node -e "console.error('${failure}');process.exit(1)"`,
        start: '',
        port: 3000,
      },
    });
    const result = await f.run();
    assert.equal(result.control, 'paused', JSON.stringify(result));
    assert.equal(result.retries, 0);
    assert.match(result.blocked!, /宿主正式验证环境阻塞/);
    assert.ok(result.blocked!.includes(failure));
    assert.equal(result.tests.length, 2);
    assert.equal(result.tests[0].exitCode, 0);
    assert.equal(result.tests[0].head, result.head);
    assert.equal(result.tests[1].exitCode, 1);
    assert.equal(result.tests[1].head, result.head);
    assert.ok(result.tests[1].output.includes(failure));
    assert.equal(result.worktree, f.path);
    assert.equal((await f.git(f.path, ['status', '--porcelain'])).stdout, '');
    const runs = f.store.list('run').length;
    await f.engine.tick();
    assert.equal(f.store.list('run').length, runs);
    assert.equal(f.turns(), 1);
  });
}

test('an assertion failure remains product rework', async (t) => {
  const f = await fixture(t, async (cwd) => {
    await writeFile(join(cwd, 'value.txt'), 'wrong');
  });
  const result = await f.run();
  assert.equal(result.control, 'active');
  assert.equal(result.retries, 1);
  assert.match(result.feedback[0], /AssertionError/);
});

for (const detail of ['EPERM', 'EBUSY', 'EIO', 'Reason: Access is denied.']) {
  test(`mentioning ${detail} in an assertion is not environment evidence`, async (t) => {
    const f = await fixture(t, async (cwd) => {
      await writeFile(join(cwd, 'value.txt'), 'after');
    });
    f.store.patchRepo(f.repo.id, {
      commands: {
        install: '',
        build: '',
        test: `node -e "console.error('AssertionError: expected ${detail} but got success');process.exit(1)"`,
        start: '',
        port: 3000,
      },
    });
    const result = await f.run();
    assert.equal(result.control, 'active');
    assert.equal(result.retries, 1);
  });
}

for (const mutation of ['files', 'revision'] as const) {
  test(`formal validation rejects changed ${mutation} and retains its evidence`, async (t) => {
    const f = await fixture(t, async (cwd) => {
      await writeFile(join(cwd, 'value.txt'), 'after');
    });
    const testCommand =
      mutation === 'files'
        ? "node -e \"require('node:fs').writeFileSync('generated.txt','unexpected')\""
        : 'git commit --allow-empty -m unexpected';
    f.store.patchRepo(f.repo.id, {
      commands: { install: '', build: '', test: testCommand, start: '', port: 3000 },
    });
    const result = await f.run();
    assert.equal(result.control, 'paused');
    assert.equal(result.retries, 0);
    assert.match(result.blocked!, /验证过程改变/);
    assert.equal(result.tests[0].exitCode, 0);
    assert.equal(result.tests[0].head, result.head);
  });
}
