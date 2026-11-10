import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

test('installed role prompts work without bundled skills from a foreign launch directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-runtime-path-'));
  try {
    const release = join(root, 'release');
    const cwd = join(root, 'outside');
    await mkdir(join(release, 'src/server'), { recursive: true });
    await mkdir(cwd);
    for (const name of ['prompts.ts', 'runtime-paths.ts'])
      await cp(
        new URL(`../src/server/${name}`, import.meta.url),
        join(release, 'src/server', name),
      );
    await cp(new URL('../prompts', import.meta.url), join(release, 'prompts'), { recursive: true });
    await writeFile(join(release, 'package.json'), JSON.stringify({ type: 'module' }));
    const module = pathToFileURL(join(release, 'src/server/prompts.ts')).href;
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        '--input-type=module',
        '-e',
        `const { instructions } = await import(${JSON.stringify(module)});
         for (const role of ['pm', 'dev', 'review', 'oncall']) {
           const text = await instructions(role);
           const { readFile } = await import('node:fs/promises');
           const base = await readFile(new URL('../../prompts/' + role + '.md',
             ${JSON.stringify(module)}), 'utf8');
           if (text !== base) process.exit(2);
         }`,
      ],
      { cwd, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
