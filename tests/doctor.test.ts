import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatDoctorReport,
  runDoctor,
  type DoctorDependencies,
  type DoctorReport,
} from '../src/server/doctor.ts';
import { Store } from '../src/server/store.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { Previews } from '../src/server/preview.ts';
import { createApp } from '../src/server/app.ts';

function healthyDeps(files: Record<string, string | true> = {}): DoctorDependencies {
  return {
    nodeVersion: 'v24.19.0',
    platform: 'linux',
    exec: async (cmd, args) => {
      if (cmd === 'git' && args[0] === '--version')
        return { code: 0, stdout: 'git version 2.45.2\n', stderr: '' };
      if (cmd === 'gh' && args[0] === '--version')
        return { code: 0, stdout: 'gh version 2.83.1\n', stderr: '' };
      if (cmd === 'gh' && args[0] === 'auth')
        return { code: 0, stdout: 'Logged in to github.com\n', stderr: '' };
      if (cmd === 'omp' && args[0] === '--version')
        return { code: 0, stdout: 'omp/19.1.0\n', stderr: '' };
      if (cmd === 'codex' && args[0] === '--version')
        return { code: 0, stdout: 'codex-cli 0.172.0\n', stderr: '' };
      return { code: 1, stdout: '', stderr: `unexpected command: ${cmd}` };
    },
    pathExists: async (target) => target in files,
    readFile: async (target) => {
      const value = files[target];
      if (typeof value !== 'string') throw new Error(`ENOENT: ${target}`);
      return value;
    },
  };
}

test('doctor returns ok report when runtime, auth, build and data dir are healthy', async () => {
  const root = join('/workspace', 'repo');
  const dataDir = join('/home', 'user', '.phantom');
  const files: Record<string, string | true> = {
    [join(root, 'dist', 'index.html')]: '<!doctype html>',
    [dataDir]: true,
    [join(dataDir, 'phantom.sqlite')]: true,
    [join(dataDir, 'config.json')]: JSON.stringify({ port: 4317 }),
  };

  const report = await runDoctor({
    dataDir,
    projectRoot: root,
    deps: healthyDeps(files),
  });
  assert.equal(report.ok, true);
  assert.equal(report.status, 'ok');
  assert.equal(report.checks.every((check) => check.status === 'pass'), true);
  assert.match(formatDoctorReport(report), /Phantom Circuit Doctor \(OK\)/);
});

test('doctor reports unauthenticated gh as warn, missing gh as fail, and redacts tokens', async () => {
  const root = join('/workspace', 'repo');
  const dataDir = join('/home', 'user', '.phantom');
  const files: Record<string, string | true> = {
    [join(root, 'dist', 'index.html')]: true,
    [dataDir]: true,
  };
  const base = healthyDeps(files);

  const unauthed = await runDoctor({
    dataDir,
    projectRoot: root,
    deps: {
      ...base,
      exec: async (cmd, args) => {
        if (cmd === 'gh' && args[0] === 'auth') {
          return {
            code: 1,
            stdout: '',
            stderr: 'token ghp_abcdefghijklmnopqrstuvwxyz123456 is expired',
          };
        }
        return base.exec!(cmd, args);
      },
    },
  });
  const ghWarn = unauthed.checks.find((c) => c.id === 'gh')!;
  assert.equal(ghWarn.status, 'warn');
  assert.equal(unauthed.ok, true);
  assert.equal(ghWarn.detail.includes('ghp_abcdefghijklmnopqrstuvwxyz123456'), false);
  assert.match(ghWarn.hint ?? '', /gh auth login/);

  const missingGh = await runDoctor({
    dataDir,
    projectRoot: root,
    deps: {
      ...base,
      exec: async (cmd, args) => {
        if (cmd === 'gh') return { code: 127, stdout: '', stderr: 'gh not found' };
        return base.exec!(cmd, args);
      },
    },
  });
  assert.equal(missingGh.checks.find((c) => c.id === 'gh')?.status, 'fail');
  assert.equal(missingGh.ok, false);
});

test('doctor treats single installed agent as warn and neither agent installed as fail', async () => {
  const root = join('/workspace', 'repo');
  const dataDir = join('/home', 'user', '.phantom');
  const files: Record<string, string | true> = {
    [join(root, 'dist', 'index.html')]: true,
    [dataDir]: true,
  };
  const base = healthyDeps(files);

  const ompOnly = await runDoctor({
    dataDir,
    projectRoot: root,
    deps: {
      ...base,
      exec: async (cmd, args) => {
        if (cmd === 'codex') return { code: 127, stdout: '', stderr: 'codex not found' };
        return base.exec!(cmd, args);
      },
    },
  });
  assert.equal(ompOnly.checks.find((c) => c.id === 'agent-omp')?.status, 'pass');
  assert.equal(ompOnly.checks.find((c) => c.id === 'agent-codex')?.status, 'warn');
  assert.equal(ompOnly.ok, true);

  const noAgents = await runDoctor({
    dataDir,
    projectRoot: root,
    deps: {
      ...base,
      exec: async (cmd, args) => {
        if (cmd === 'omp' || cmd === 'codex')
          return { code: 127, stdout: '', stderr: `${cmd} not found` };
        return base.exec!(cmd, args);
      },
    },
  });
  assert.equal(noAgents.checks.find((c) => c.id === 'agent-omp')?.status, 'fail');
  assert.equal(noAgents.checks.find((c) => c.id === 'agent-codex')?.status, 'fail');
  assert.equal(noAgents.ok, false);
});

test('doctor inspects data-dir read-only for missing, valid, and corrupt config.json', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'phantom-doctor-test-'));
  try {
    const missingDir = join(tmp, 'missing');
    const base = healthyDeps({ [join(process.cwd(), 'dist', 'index.html')]: true });
    const missingReport = await runDoctor({
      dataDir: missingDir,
      projectRoot: process.cwd(),
      deps: { ...base, pathExists: undefined, readFile: undefined },
    });
    const missingCheck = missingReport.checks.find((c) => c.id === 'data-dir')!;
    assert.equal(missingCheck.status, 'warn');

    const validDir = join(tmp, 'valid');
    await mkdir(validDir, { recursive: true });
    await writeFile(join(validDir, 'config.json'), JSON.stringify({ port: 4317 }));
    const validReport = await runDoctor({
      dataDir: validDir,
      projectRoot: process.cwd(),
      deps: { ...base, pathExists: undefined, readFile: undefined },
    });
    assert.equal(validReport.checks.find((c) => c.id === 'data-dir')?.status, 'pass');

    const corruptDir = join(tmp, 'corrupt');
    await mkdir(corruptDir, { recursive: true });
    await writeFile(join(corruptDir, 'config.json'), '{not json');
    const corruptReport = await runDoctor({
      dataDir: corruptDir,
      projectRoot: process.cwd(),
      deps: { ...base, pathExists: undefined, readFile: undefined },
    });
    assert.equal(corruptReport.checks.find((c) => c.id === 'data-dir')?.status, 'fail');
    assert.equal(corruptReport.ok, false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('formatDoctorReport renders statuses and hints clearly', async () => {
  const report = await runDoctor({
    dataDir: join('/tmp', 'missing'),
    projectRoot: join('/tmp', 'no-dist'),
    deps: {
      nodeVersion: 'v22.0.0',
      platform: 'win32',
      exec: async () => ({ code: 127, stdout: '', stderr: 'not found' }),
      pathExists: async () => false,
    },
  });
  const text = formatDoctorReport(report);
  assert.match(text, /\[FAIL\] Node\.js runtime/);
  assert.match(text, /hint: Install Node\.js >= 24\.0\.0/);
  assert.match(text, /\[WARN\] Web UI build/);
});

test('GET /api/doctor enforces same-site session and returns DoctorReport', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'phantom-doctor-http-'));
  const store = new Store(':memory:');
  const ws = new Workspaces(dataDir, store);
  const engine = new Engine(store, new GitHub(store), ws, dataDir);
  const app = createApp(store, engine, new Previews(store, ws));
  t.after(async () => {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const unauthed = await app.inject({
    url: '/api/doctor',
    headers: { host: '127.0.0.1:4317' },
  });
  assert.equal(unauthed.statusCode, 401);

  const init = await app.inject({
    url: '/api/session',
    headers: { host: '127.0.0.1:4317' },
  });
  const headers = {
    host: '127.0.0.1:4317',
    cookie: String(init.headers['set-cookie']).split(';')[0],
  };

  const res = await app.inject({ url: '/api/doctor', headers });
  assert.equal(res.statusCode, 200);
  const report = res.json<DoctorReport>();
  assert.equal(report.dataDir, dataDir);
  assert.equal(typeof report.ok, 'boolean');
  assert.equal(Array.isArray(report.checks), true);
  assert.ok(report.checks.some((check) => check.id === 'node'));
  assert.ok(report.checks.some((check) => check.id === 'data-dir'));
});
