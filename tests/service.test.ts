import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/service.mjs', import.meta.url));
const supervisorSmoke = fileURLToPath(
  new URL('../scripts/service-systemd-smoke.mjs', import.meta.url),
);
const name = 'isolated';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'phantom-service-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, '.service', name);
  const bin = join(dir, 'bin');
  const config = join(dir, 'config home');
  const unit = join(config, 'systemd', 'user', `${name}.service`);
  await mkdir(bin);
  await mkdir(join(config, 'systemd', 'user'), { recursive: true });
  await mkdir(join(root, 'releases', 'old'), { recursive: true });
  await symlink('releases/old', join(root, 'current'));
  await writeFile(join(root, 'releases', 'old', 'sentinel'), 'release');
  await writeFile(join(dir, 'config.json'), '{"port":4317}\n');
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: config,
    PATH: bin,
    SERVICE_TEST_LOG: join(dir, 'calls'),
  };
  const run = (command: string, entry = script) =>
    spawnSync(process.execPath, [entry, command, `--data-dir=${dir}`, `--name=${name}`], {
      encoding: 'utf8',
      env,
    });
  const systemctl = async (body: string) => {
    await writeFile(join(bin, 'systemctl'), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, 'systemctl'), 0o755);
  };
  return { dir, root, unit, run, systemctl };
}

function unitText(dataDir: string, serviceName = name, node = process.execPath) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    const { renderUnit } = await import(${JSON.stringify(new URL('../scripts/service.mjs', import.meta.url).href)});
    process.stdout.write(renderUnit({ dataDir: ${JSON.stringify(dataDir)}, name: ${JSON.stringify(serviceName)}, node: ${JSON.stringify(node)}, path: '/home/me/.local/bin:/usr/bin' }));
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test(
  'supervisor smoke never cleans up an unrelated unit after link fails',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = await fixture(t);
    await f.systemctl('printf "%s\\n" "$*" >> "$SERVICE_TEST_LOG"; exit 1');
    const result = f.run(join(f.root, 'releases', 'old'), supervisorSmoke);
    assert.equal(result.status, 1);
    const calls = (await readFile(join(f.dir, 'calls'), 'utf8')).trim().split('\n');
    assert.equal(calls.length, 1, 'failed linking must not stop, disable or reset any unit');
    assert.match(calls[0], /^--user link /);
  },
);

test('CLI rejects unsafe names, relative data directories and unsupported port flags', () => {
  for (const flag of ['--name=../other', '--data-dir=relative', '--port=4318']) {
    const result = spawnSync(process.execPath, [script, 'stage', flag], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Service error:/);
  }
});

test(
  'supervisor smoke refuses to start or clean up a unit with another fragment',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = await fixture(t);
    await writeFile(f.unit, '[Service]\nExecStart=/bin/true\n');
    await f.systemctl(`printf "%s\\n" "$*" >> "$SERVICE_TEST_LOG"
case "$2" in
  link) exit 0 ;;
  show) printf "%s\\n" ${JSON.stringify(f.unit)}; exit 0 ;;
  *) exit 1 ;;
esac`);
    const result = f.run(join(f.root, 'releases', 'old'), supervisorSmoke);
    assert.equal(result.status, 1);
    const calls = (await readFile(join(f.dir, 'calls'), 'utf8')).trim().split('\n');
    assert.equal(calls.length, 3);
    assert.ok(calls.every((line) => /^--user (link|show) /.test(line)));
    assert.equal(await readFile(f.unit, 'utf8'), '[Service]\nExecStart=/bin/true\n');
  },
);

test(
  'failed CLI stage preserves current and user state and releases its lock',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = await fixture(t);
    const scripts = join(f.dir, 'incomplete-source', 'scripts');
    await mkdir(scripts, { recursive: true });
    await copyFile(script, join(scripts, 'service.mjs'));
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = f.run('stage', join(scripts, 'service.mjs'));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /ENOENT/);
    }
    assert.equal(await readlink(join(f.root, 'current')), 'releases/old');
    assert.equal(await readFile(join(f.dir, 'config.json'), 'utf8'), '{"port":4317}\n');
  },
);

test(
  'CLI refuses an active installed service before building or switching current',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = await fixture(t);
    await writeFile(f.unit, unitText(f.dir));
    await f.systemctl('printf "active\\n"');
    const result = f.run('stage');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Stop isolated.service before staging \(state: active\)/);
    assert.equal(await readlink(join(f.root, 'current')), 'releases/old');
  },
);

test(
  'CLI refuses unrelated units without changing them',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = await fixture(t);
    await writeFile(f.unit, '[Service]\nExecStart=/bin/true\n');
    for (const command of ['stage', 'install', 'uninstall']) {
      const result = f.run(command);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Refusing unrelated unit/);
    }
    assert.equal(await readFile(f.unit, 'utf8'), '[Service]\nExecStart=/bin/true\n');
  },
);

test(
  'CLI uninstall removes only its unit and retains user data and old releases',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = await fixture(t);
    await writeFile(f.unit, unitText(f.dir));
    await f.systemctl('printf "%s\\n" "$*" >> "$SERVICE_TEST_LOG"');
    const result = f.run('uninstall');
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(readFile(f.unit), /ENOENT/);
    assert.equal(await readFile(join(f.dir, 'config.json'), 'utf8'), '{"port":4317}\n');
    assert.equal(await readFile(join(f.root, 'releases', 'old', 'sentinel'), 'utf8'), 'release');
    assert.equal(
      await readFile(join(f.dir, 'calls'), 'utf8'),
      '--user stop isolated.service\n--user disable isolated.service\n--user daemon-reload\n',
    );
  },
);

test(
  'generated unit preserves literal paths and passes the actual systemd parser',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = await fixture(t);
    const text = unitText('/tmp/a space/100%/$HOME/"quoted"');
    assert.ok(text.includes('100%%/$$HOME/\\"quoted\\"'));
    assert.ok(text.includes('Environment="PATH=/home/me/.local/bin:/usr/bin"'));
    assert.ok(!text.includes('API_KEY'));
    await writeFile(f.unit, text);
    const available = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
    if (available.error) return t.skip('systemd-analyze unavailable');
    const result = spawnSync('systemd-analyze', ['--user', 'verify', f.unit], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  },
);

test(
  'systemd resolves a Node executable containing a literal dollar sign',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = await fixture(t);
    const node = join(f.dir, 'node$literal');
    await symlink(process.execPath, node);
    await writeFile(f.unit, unitText(f.dir, name, node));
    const available = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
    if (available.error) return t.skip('systemd-analyze unavailable');
    const result = spawnSync('systemd-analyze', ['--user', 'verify', f.unit], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  },
);
