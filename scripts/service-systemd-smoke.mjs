import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { renderUnit } from './service.mjs';

if (!process.argv[2])
  throw new Error('Usage: node scripts/service-systemd-smoke.mjs /absolute/release');
const release = resolve(process.argv[2]);
const root = await mkdtemp('/tmp/opencode/phantom-systemd space 100% "$HOME"-');
const dataDir = join(root, '.phantom');
const name = `phantom-circuit-verify-${randomUUID()}`;
const unitPath = join(root, `${name}.service`);
const current = join(dataDir, '.service', name, 'current');
await mkdir(join(dataDir, '.service', name), { recursive: true });
await symlink(release, current);
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((done) => probe.close(done));
await writeFile(join(dataDir, 'config.json'), JSON.stringify({ port }));
await writeFile(unitPath, renderUnit({ dataDir, name }));
const origin = `http://127.0.0.1:${port}`;
function ctl(...args) {
  const result = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function ownsUnit() {
  const owner = spawnSync('systemctl', ['--user', 'show', name, '-p', 'FragmentPath', '--value'], {
    encoding: 'utf8',
  });
  if (owner.status !== 0 || !owner.stdout.trim()) return false;
  try {
    return (await realpath(owner.stdout.trim())) === (await realpath(unitPath));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function ready(previous = '') {
  for (let n = 0; n < 200; n++) {
    const pid = ctl('show', name, '-p', 'MainPID', '--value');
    if (pid !== '0' && pid !== previous) {
      try {
        const response = await fetch(`${origin}/api/session`);
        if (response.ok)
          return {
            pid,
            cookie: response.headers.get('set-cookie').split(';')[0],
            csrf: (await response.json()).csrf,
          };
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    }
    await delay(100);
  }
  throw new Error('systemd did not restore HTTP readiness');
}
let linked = false;
try {
  ctl('link', unitPath);
  linked = true;
  assert.equal(await ownsUnit(), true, 'Refusing a supervisor unit owned by another installation');
  ctl('start', name);
  let session = await ready();
  const status = await readFile(`/proc/${session.pid}/status`, 'utf8');
  const parent = status.match(/^PPid:\s+(\d+)/m)[1];
  assert.match(await readFile(`/proc/${parent}/comm`, 'utf8'), /systemd/);
  const created = await fetch(`${origin}/api/projects`, {
    method: 'POST',
    headers: {
      Cookie: session.cookie,
      'X-Phantom-CSRF': session.csrf,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Supervised verification' }),
  });
  assert.equal(created.status, 200);
  const project = await created.json();
  for (let interruption = 0; interruption < 2; interruption++) {
    const pid = session.pid;
    ctl('kill', '--signal=SIGKILL', '--kill-whom=main', name);
    session = await ready(pid);
    const state = await (
      await fetch(`${origin}/api/state`, { headers: { Cookie: session.cookie } })
    ).json();
    assert.ok(state.projects.some((item) => item.id === project.id));
    assert.equal(state.runs.length, 0);
  }
  ctl('stop', name);
  assert.equal(ctl('show', name, '-p', 'MainPID', '--value'), '0');
  console.log(
    'VERIFIED actual systemd user supervision, systemd-owned server PID, literal special-character paths, two automatic crash restarts, retained data, stop; no model turns or repositories.',
  );
} finally {
  if (linked) {
    if (await ownsUnit()) {
      spawnSync('systemctl', ['--user', 'stop', name]);
      spawnSync('systemctl', ['--user', 'disable', name]);
      spawnSync('systemctl', ['--user', 'reset-failed', name]);
      spawnSync('systemctl', ['--user', 'daemon-reload']);
    } else console.error('Skipped supervisor cleanup because unit ownership changed.');
  }
  await rm(root, { recursive: true, force: true });
}
