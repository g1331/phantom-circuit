import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const release = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node scripts/service-smoke.mjs /absolute/release');
const root = await mkdtemp('/tmp/opencode/phantom-service-smoke-');
const data = join(root, '.phantom');
await mkdir(data);
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const address = probe.address();
assert.ok(address && typeof address !== 'string');
const port = address.port;
await new Promise((done, fail) => probe.close((error) => (error ? fail(error) : done())));
await writeFile(join(data, 'config.json'), JSON.stringify({ port }));
const origin = `http://127.0.0.1:${port}`;
const loader = pathToFileURL(join(release, 'node_modules/tsx/dist/loader.mjs')).href;
let child;
let output = '';
let cookie = '';
let csrf = '';

async function start() {
  output = '';
  child = spawn(
    process.execPath,
    ['--import', loader, join(release, 'src/server/main.ts'), `--data-dir=${data}`],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (chunk) => {
    output = (output + chunk).slice(-20000);
  });
  child.stderr.on('data', (chunk) => {
    output = (output + chunk).slice(-20000);
  });
  child.on('error', (error) => {
    output += String(error);
  });
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Release exited before ready: ${output}`);
    try {
      const response = await fetch(`${origin}/api/session`);
      if (response.ok && output.includes('Phantom Circuit ready')) {
        cookie = response.headers.get('set-cookie').split(';')[0];
        csrf = (await response.json()).csrf;
        return;
      }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await delay(100);
  }
  throw new Error(`Release did not become ready: ${output}`);
}

async function stop(signal) {
  const exited = once(child, 'exit');
  child.kill(signal);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    const [code, killed] = await exited;
    if (signal === 'SIGTERM')
      assert.equal(code, 0, `Graceful shutdown failed (${killed}): ${output}`);
  } finally {
    clearTimeout(timeout);
    child = undefined;
  }
}

async function state() {
  const response = await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  return response.json();
}

try {
  const manifest = JSON.parse(await readFile(join(release, 'package.json'), 'utf8'));
  assert.ok(manifest.dependencies.tsx, 'tsx must survive production pruning');
  assert.equal(
    existsSync(join(release, 'node_modules/typescript')),
    false,
    'Run this check against a production-pruned release, not a development checkout',
  );
  const prompts = spawn(
    process.execPath,
    [
      '--import',
      loader,
      '--input-type=module',
      '-e',
      `const {instructions}=await import(${JSON.stringify(pathToFileURL(join(release, 'src/server/prompts.ts')).href)});
       if (!(await instructions('dev')).includes('Task Developer')) process.exit(2);`,
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let promptError = '';
  prompts.stderr.on('data', (chunk) => {
    promptError += chunk;
  });
  assert.equal((await once(prompts, 'exit'))[0], 0, promptError);
  await start();
  const index = await fetch(origin);
  assert.equal(index.status, 200);
  const html = await index.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map((match) => match[1]);
  assert.ok(assets.length > 0, 'Release must serve built UI, not a setup placeholder');
  for (const asset of assets) assert.equal((await fetch(origin + asset)).status, 200, asset);
  const created = await fetch(`${origin}/api/projects`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-Phantom-CSRF': csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Installed release smoke',
      description: 'No repositories or model turns',
    }),
  });
  assert.equal(created.status, 200);
  const project = await created.json();
  await stop('SIGTERM');
  await start();
  assert.ok((await state()).projects.some((item) => item.id === project.id));
  for (let interruption = 0; interruption < 2; interruption++) {
    await stop('SIGKILL');
    await start();
    assert.ok((await state()).projects.some((item) => item.id === project.id));
  }
  assert.equal((await state()).runs.length, 0, 'Smoke must never make model calls');
  await stop('SIGTERM');
  console.log(
    'VERIFIED: production release, foreign CWD, prompts/UI assets, HTTP writes, graceful restart, two crash restarts, persisted project; no model or GitHub calls.',
  );
} finally {
  if (child) await stop('SIGKILL');
  await rm(root, { recursive: true, force: true });
}
