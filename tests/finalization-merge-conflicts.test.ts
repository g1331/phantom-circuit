import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from '../src/server/process.ts';
import { fixture, conflictingTask } from './finalization-fixture.ts';

test('legacy target base in MERGE_HEAD is resolved by editing only before installation', async (t) => {
  const f = await fixture(t, async (cwd) => {
    assert.match((await command('git', ['status', '--porcelain'], cwd)).stdout, /UU value.txt/);
    await writeFile(join(cwd, 'value.txt'), 'after');
  });
  await writeFile(join(f.path, 'value.txt'), 'task implementation');
  await f.git(f.path, ['add', '.']);
  await f.git(f.path, ['commit', '-m', 'Original implementation']);
  const oldHead = (await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(f.source, 'value.txt'), 'default implementation');
  await writeFile(join(f.source, 'retained.txt'), 'default feature');
  await f.git(f.source, ['add', '.']);
  await f.git(f.source, ['commit', '-m', 'Default changes']);
  await f.git(f.source, ['push', 'origin', 'main']);
  await f.ws.mirror(f.store.repo(f.repo.id));
  const target = (await f.git(f.source, ['rev-parse', 'HEAD'])).stdout.trim();
  await command('git', ['merge', '--no-edit', target], f.path, undefined, 120000, false);
  f.store.patchRepo(f.repo.id, {
    commands: {
      install:
        "node -e \"const c=require('node:child_process');if(c.spawnSync('git',['rev-parse','--verify','MERGE_HEAD']).status===0)process.exit(9)\"",
      build: '',
      test: 'node verify.cjs',
      start: '',
      port: 3000,
    },
  });
  f.store.updateTask(f.task().id, {
    stage: 'developing',
    control: 'paused',
    devPhase: 'finalize',
    base: target,
    head: oldHead,
    retries: 2,
  });
  await f.engine.resume(f.task().id);
  const result = await f.run();
  assert.equal(result.stage, 'reviewing', result.blocked);
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 1);
  assert.equal(
    (await f.git(f.path, ['show', '-s', '--format=%P', 'HEAD'])).stdout.trim(),
    `${oldHead} ${target}`,
  );
  assert.equal((await f.git(f.path, ['status', '--porcelain'])).stdout, '');
  assert.equal(await readFile(join(f.path, 'retained.txt'), 'utf8'), 'default feature');
  assert.equal(result.tests[0].head, result.head);
});

for (const source of ['default', 'task'] as const) {
  test(`${source} conflict stops installation and another merge; repeated resume does not repeat Dev`, async (t) => {
    const f = await conflictingTask(t, async () => {}, source);
    f.store.patchRepo(f.repo.id, {
      commands: {
        install: "node -e \"require('node:fs').writeFileSync('installed.txt','bad')\"",
        build: '',
        test: 'node verify.cjs',
        start: '',
        port: 3000,
      },
    });
    const result = await f.run();
    assert.equal(result.control, 'paused', result.blocked);
    assert.match(result.blocked!, /冲突.*value.txt/);
    assert.equal(result.retries, 2);
    assert.equal(f.turns(), 1);
    assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
    assert.equal((await f.git(f.path, ['rev-parse', 'MERGE_HEAD'])).stdout.trim(), f.incoming);
    await assert.rejects(readFile(join(f.path, 'installed.txt')), /ENOENT/);
    if (source === 'task') await assert.rejects(readFile(join(f.path, 'later.txt')), /ENOENT/);
    await f.engine.resume(result.id);
    const resumed = await f.run();
    assert.equal(resumed.control, 'paused');
    assert.equal(resumed.retries, 2);
    assert.equal(f.turns(), 1);
  });
}

test('successful remote task conflict preserves the PR and integrates default afterward', async (t) => {
  const f = await conflictingTask(
    t,
    async (cwd) => {
      await writeFile(join(cwd, 'value.txt'), 'after');
    },
    'task',
  );
  const result = await f.run();
  assert.equal(result.stage, 'reviewing', result.blocked);
  assert.equal(result.pr, 2);
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 1);
  assert.equal(await readFile(join(f.path, 'incoming.txt'), 'utf8'), 'preserved incoming feature');
  assert.equal(await readFile(join(f.path, 'later.txt'), 'utf8'), 'default branch must wait');
  assert.equal((await f.git(f.path, ['merge-base', '--is-ancestor', f.oldHead, 'HEAD'])).code, 0);
  assert.equal((await f.git(f.path, ['merge-base', '--is-ancestor', f.incoming, 'HEAD'])).code, 0);
  assert.equal(result.tests[0].head, result.head);
});

for (const resolution of ['valid', 'markers', 'invalid-json'] as const) {
  test(`legacy manifest and lockfile conflict with ${resolution} resolution is checked before install`, async (t) => {
    const f = await conflictingTask(
      t,
      async (cwd) => {
        await writeFile(join(cwd, 'value.txt'), 'after');
        if (resolution === 'markers') return;
        for (const path of ['package.json', 'package-lock.json'])
          await writeFile(
            join(cwd, path),
            resolution === 'valid'
              ? '{"name":"fixture","taskFeature":true,"defaultFeature":true}\n'
              : '{invalid json}',
          );
      },
      'default',
      true,
      true,
    );
    const installed = join(f.root, 'installed.txt');
    f.store.patchRepo(f.repo.id, {
      commands: {
        install: `node -e "const f=require('node:fs');const c=require('node:child_process');if(c.spawnSync('git',['rev-parse','--verify','MERGE_HEAD']).status===0)process.exit(9);JSON.parse(f.readFileSync('package.json'));JSON.parse(f.readFileSync('package-lock.json'));f.writeFileSync('${installed.replaceAll('\\', '/')}', 'installed');"`,
        build: '',
        test: 'node verify.cjs',
        start: '',
        port: 3000,
      },
    });
    const result = await f.run();
    assert.equal(result.retries, 2);
    if (resolution === 'valid') {
      assert.equal(result.stage, 'reviewing', result.blocked);
      assert.equal(await readFile(installed, 'utf8'), 'installed');
      assert.deepEqual(JSON.parse(await readFile(join(f.path, 'package-lock.json'), 'utf8')), {
        name: 'fixture',
        taskFeature: true,
        defaultFeature: true,
      });
    } else {
      assert.equal(result.control, 'paused');
      assert.match(
        result.blocked!,
        resolution === 'markers' ? /冲突标记.*package/ : /不可解析.*package/,
      );
      await assert.rejects(readFile(installed), /ENOENT/);
      assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
      assert.match((await f.git(f.path, ['status', '--porcelain'])).stdout, /UU package-lock.json/);
    }
  });
}

for (const field of ['headRepo', 'baseRepo', 'branch'] as const) {
  test(`remote Task merge requires the original PR ${field} identity`, async (t) => {
    const f = await conflictingTask(t, async () => {}, 'task');
    f.prIdentity[field] = 'unrelated';
    const result = await f.run();
    assert.equal(result.control, 'paused');
    assert.match(result.blocked!, /原 PR.*归属不匹配/);
    assert.equal(result.retries, 2);
    assert.equal(f.turns(), 0);
    assert.equal((await f.git(f.path, ['rev-parse', 'HEAD'])).stdout.trim(), f.oldHead);
  });
}

test('PM guidance can authorize a new conflict editing attempt without product rework', async (t) => {
  let attempts = 0;
  const f = await conflictingTask(t, async (cwd) => {
    if (++attempts === 2) await writeFile(join(cwd, 'value.txt'), 'after');
  });
  const first = await f.run();
  assert.equal(first.control, 'paused');
  const previousRun = first.pendingMerge!.runId!;
  await f.engine.resume(first.id, {
    guidance: 'Preserve incoming.txt and implement the agreed value after in value.txt.',
    upgrade: false,
  });
  const result = await f.run();
  assert.equal(result.stage, 'reviewing', result.blocked);
  assert.equal(result.retries, 2);
  assert.equal(f.turns(), 2);
  assert.deepEqual(result.mergeHistory![0].previousRunIds, [previousRun]);
});
