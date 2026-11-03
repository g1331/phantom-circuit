import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Workspaces } from '../src/server/workspaces.ts';
import { devFixture } from './dev-fixture.ts';

async function verifyWith(prefix: string, script: string) {
  const f = await devFixture(prefix);
  const ws = new Workspaces(join(f.root, 'ws'), f.store);
  const prepared = await ws.prepare(f.task);
  await writeFile(join(f.root, 'out.cjs'), script);
  f.store.patchRepo(f.repo.id, {
    commands: {
      install: '',
      build: '',
      test: `node "${join(f.root, 'out.cjs')}"`,
      start: '',
      port: 3000,
    },
  });
  const head = await ws.git(prepared.worktree!, ['rev-parse', 'HEAD']);
  const task = f.store.updateTask(f.task.id, { head });
  const result = await ws.verify(task).then(
    (evidence) => ({ evidence }),
    (error: unknown) => ({ error: String(error) }),
  );
  return { ...f, result };
}

test('a failing suite whose passing test titles mention EPERM is a test failure, not an environment block', async () => {
  const f = await verifyWith(
    'phantom-classify-title-',
    [
      `console.log('✔ host validation environment failure pauses with evidence: Error: spawn taskkill EPERM (22ms)');`,
      `console.log('ok 7 - pauses on Reason: Access is denied.');`,
      `console.log('✖ an ordinary assertion failed (3ms)');`,
      'process.exit(1);',
    ].join('\n'),
  );
  try {
    assert.ok('evidence' in f.result, `classified as: ${(f.result as { error?: string }).error}`);
    assert.equal(f.result.evidence.at(-1)?.exitCode, 1);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('validation evidence records the command wall-clock so reviews can check speed targets', async () => {
  const f = await verifyWith('phantom-classify-duration-', 'setTimeout(() => {}, 300);');
  try {
    assert.ok('evidence' in f.result, `classified as: ${(f.result as { error?: string }).error}`);
    assert.ok((f.result.evidence.at(-1)?.durationMs ?? 0) >= 300);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a real nested process failure is still an environment block', async () => {
  const f = await verifyWith(
    'phantom-classify-real-',
    `console.error('Error: spawn taskkill EPERM');\nprocess.exit(1);`,
  );
  try {
    assert.match((f.result as { error?: string }).error ?? '', /宿主正式验证环境阻塞/);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
