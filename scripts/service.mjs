import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const commands = ['stage', 'install', 'start', 'stop', 'status', 'logs', 'uninstall'];
const help = `Usage: node scripts/service.mjs <${commands.join('|')}> [--data-dir=/absolute/path] [--name=phantom-circuit]

Defaults: --data-dir=${join(homedir(), '.phantom')} --name=phantom-circuit
install stages and registers a systemd user unit; it does not start or enable it.
uninstall stops and removes only the unit; all releases and user data remain.
`;

export function serviceOptions(args, env = process.env) {
  const [command, ...flags] = args;
  if (!commands.includes(command))
    throw new Error(`Unknown command: ${command ?? '(missing)'}\n${help}`);
  let dataDir = join(homedir(), '.phantom');
  let name = 'phantom-circuit';
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    const equal = flag.indexOf('=');
    const key = equal === -1 ? flag : flag.slice(0, equal);
    if (key !== '--data-dir' && key !== '--name') throw new Error(`Unsupported option: ${key}`);
    const value = equal === -1 ? flags[++i] : flag.slice(equal + 1);
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (key === '--data-dir') dataDir = value;
    else name = value;
  }
  if (!isAbsolute(dataDir)) throw new Error('--data-dir must be absolute');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name))
    throw new Error('Invalid service name (use 1–64 letters, digits, underscores or hyphens)');
  dataDir = resolve(dataDir);
  if (/[\x00-\x1f\x7f]/.test(dataDir))
    throw new Error('Data directory contains control characters');
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  if (!isAbsolute(configHome)) throw new Error('XDG_CONFIG_HOME must be absolute');
  return {
    command,
    dataDir,
    name,
    root: join(dataDir, '.service', name),
    unitPath: join(configHome, 'systemd', 'user', `${name}.service`),
  };
}

function quote(value, exec = false) {
  if (/[\x00-\x1f\x7f]/.test(value))
    throw new Error('Unit values cannot contain control characters');
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')
    .replaceAll('$', () => (exec ? '$$' : '$'))}"`;
}

function marker(dataDir, name) {
  return `# phantom-circuit-service ${JSON.stringify({ dataDir, name })}`;
}

export function renderUnit({
  dataDir,
  name,
  node = process.execPath,
  path = process.env.PATH ?? '',
}) {
  const current = join(dataDir, '.service', name, 'current');
  return `${marker(dataDir, name)}
[Unit]
Description=Phantom Circuit (${name})
After=network.target

[Service]
Type=simple
WorkingDirectory=${current.replaceAll('%', '%%')}
ExecStart=${quote(node)} --import tsx ${quote(join(current, 'src/server/main.ts'), true)} ${quote(`--data-dir=${dataDir}`, true)}
Environment=${quote(`PATH=${path}`)}
Restart=on-failure
RestartSec=5
TimeoutStopSec=120
KillMode=mixed
UMask=0077

[Install]
WantedBy=default.target
`;
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { stdio: 'inherit', ...options });
  if (result.error) throw new Error(`Cannot run ${program}: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`${program} ${args.join(' ')} failed (${result.signal ?? result.status})`);
  return result;
}

async function ownedUnit(options) {
  try {
    const text = await readFile(options.unitPath, 'utf8');
    if (text.split('\n')[0] !== marker(options.dataDir, options.name))
      throw new Error(`Refusing unrelated unit: ${options.unitPath}`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function requireInactive(options) {
  const result = spawnSync(
    'systemctl',
    ['--user', 'show', `${options.name}.service`, '--property=ActiveState', '--value'],
    { encoding: 'utf8' },
  );
  if (result.error || result.status !== 0)
    throw new Error(`Cannot determine service state: ${result.error?.message ?? result.stderr}`);
  const state = result.stdout.trim();
  if (!['inactive', 'failed'].includes(state))
    throw new Error(`Stop ${options.name}.service before staging (state: ${state})`);
}

async function currentLink(options) {
  try {
    const current = join(options.root, 'current');
    if (!(await lstat(current)).isSymbolicLink())
      throw new Error(`Refusing to replace non-symlink: ${current}`);
    return await readlink(current);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function stageRelease(options, source = sourceRoot) {
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const lock = join(options.root, 'stage.lock');
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(`Another stage is running, or a previous stage was interrupted: ${lock}`);
    throw error;
  }
  try {
    if (await ownedUnit(options)) requireInactive(options);
    await currentLink(options);
    const id = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID()}`;
    const release = join(options.root, 'releases', id);
    await mkdir(release, { recursive: true, mode: 0o700 });
    for (const entry of [
      'src',
      'scripts',
      'tests',
      'prompts',
      '.agents/skills',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'vite.config.ts',
      'index.html',
    ]) {
      await cp(join(source, entry), join(release, entry), { recursive: true, dereference: true });
    }
    const git = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const dirty = spawnSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' });
    await writeFile(
      join(release, 'release.json'),
      JSON.stringify(
        {
          id,
          stagedAt: new Date().toISOString(),
          source,
          node: process.version,
          commit: git.status === 0 ? git.stdout.trim() : null,
          dirty: dirty.status === 0 ? Boolean(dirty.stdout.trim()) : null,
          lockSha256: createHash('sha256')
            .update(await readFile(join(release, 'package-lock.json')))
            .digest('hex'),
        },
        null,
        2,
      ) + '\n',
    );
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    run(npm, ['ci', '--include=dev'], { cwd: release });
    run(npm, ['run', 'build'], { cwd: release });
    run(npm, ['prune', '--omit=dev'], { cwd: release });
    if (!(await lstat(join(release, 'node_modules'))).isDirectory())
      throw new Error('Release node_modules must be a real directory');
    const smoke = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(release, 'src/server/main.ts'), '--help'],
      {
        cwd: release,
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    if (smoke.error || smoke.status !== 0 || !/usage:/i.test(smoke.stdout))
      throw new Error(
        `Production --help verification failed: ${smoke.error?.message ?? smoke.stderr}`,
      );
    // Recheck after the build: an operator may have started the installed unit meanwhile.
    if (await ownedUnit(options)) requireInactive(options);
    const pending = join(options.root, `current-${id}`);
    await symlink(join('releases', id), pending);
    await rename(pending, join(options.root, 'current'));
    console.log(`Staged ${release}`);
    return release;
  } finally {
    await rmdir(lock);
  }
}

export async function manageService(options) {
  if (process.platform !== 'linux')
    throw new Error('Service management requires Linux and systemd. Use npm start on Windows.');
  const unit = `${options.name}.service`;
  if (options.command === 'stage') return stageRelease(options);
  if (options.command === 'install') {
    await ownedUnit(options);
    await stageRelease(options);
    await mkdir(dirname(options.unitPath), { recursive: true });
    const path = [
      ...new Set([
        join(homedir(), '.local/bin'),
        dirname(process.execPath),
        ...(process.env.PATH ?? '/usr/bin:/bin').split(':'),
      ]),
    ].join(':');
    const text = renderUnit({ ...options, path });
    // Exclusive creation prevents clobbering an unrelated unit created during the build.
    if (!(await ownedUnit(options)))
      await writeFile(options.unitPath, text, { flag: 'wx', mode: 0o600 });
    else await writeFile(options.unitPath, text, { mode: 0o600 });
    run('systemctl', ['--user', 'daemon-reload']);
    console.log(
      `Installed ${options.unitPath}; start explicitly with: node scripts/service.mjs start --data-dir=${JSON.stringify(options.dataDir)} --name=${options.name}`,
    );
    return;
  }
  if (!(await ownedUnit(options))) throw new Error(`Service is not installed: ${options.unitPath}`);
  if (options.command === 'logs')
    return run('journalctl', ['--user', '--unit', unit, '--lines=100', '--follow']);
  if (options.command === 'uninstall') {
    run('systemctl', ['--user', 'stop', unit]);
    run('systemctl', ['--user', 'disable', unit]);
    await unlink(options.unitPath);
    run('systemctl', ['--user', 'daemon-reload']);
    console.log('Unit removed. User data and all releases retained.');
    return;
  }
  return run('systemctl', ['--user', options.command, unit]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).includes('--help')) console.log(help);
    else await manageService(serviceOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(`Service error: ${error.message}`);
    process.exitCode = 1;
  }
}
