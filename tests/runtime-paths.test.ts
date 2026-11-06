import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('installed role prompts and skill catalog do not depend on the launch directory', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'phantom-runtime-path-'));
  try {
    const module = new URL('../src/server/prompts.ts', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        '--input-type=module',
        '-e',
        `const { instructions } = await import(${JSON.stringify(module)});
         const text = await instructions('dev');
         if (!text.includes('Task Developer') || !text.includes('SKILL.md')) process.exit(2);`,
      ],
      { cwd, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
