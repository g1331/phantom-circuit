import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Codex } from './codex.ts';
import { OmpBackend } from './omp.ts';
import { bounded, redact } from './redaction.ts';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  status: 'ok' | 'warn' | 'fail';
  checkedAt: string;
  platform: NodeJS.Platform;
  dataDir: string;
  checks: DoctorCheck[];
}

export interface DoctorExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DoctorProbeSummary {
  models: number;
  allowance?: string;
}

export interface DoctorDependencies {
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  exec?: (cmd: string, args: string[], timeoutMs?: number) => Promise<DoctorExecResult>;
  pathExists?: (target: string) => Promise<boolean>;
  readFile?: (target: string) => Promise<string>;
  probeOmp?: () => Promise<DoctorProbeSummary>;
  probeCodex?: () => Promise<DoctorProbeSummary>;
}

export interface DoctorOptions {
  dataDir?: string;
  projectRoot?: string;
  probeAgents?: boolean;
  deps?: DoctorDependencies;
}

const configSchema = z.object({ port: z.number().int().min(1024).max(65535) });

async function runSpawn(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<DoctorExecResult & { errnoCode?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: 'pipe',
      shell: false,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: 124, stdout, stderr: `Timed out running ${binary}` });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: error.code === 'ENOENT' ? 127 : 1,
        stdout,
        stderr: error.message,
        errnoCode: error.code,
      });
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function defaultExec(
  cmd: string,
  args: string[],
  timeoutMs = 15000,
): Promise<DoctorExecResult> {
  const first = await runSpawn(cmd, args, timeoutMs);
  if (
    process.platform === 'win32' &&
    (first.errnoCode === 'ENOENT' || first.errnoCode === 'EINVAL')
  ) {
    // npm-installed shims (for example codex.cmd) need cmd.exe on Windows without DEP0190 shell:true.
    const fallback = await runSpawn('cmd.exe', ['/d', '/s', '/c', cmd, ...args], timeoutMs);
    return { code: fallback.code, stdout: fallback.stdout, stderr: fallback.stderr };
  }
  return { code: first.code, stdout: first.stdout, stderr: first.stderr };
}

async function defaultPathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function defaultProbeOmp(): Promise<DoctorProbeSummary> {
  const dir = await mkdtemp(join(tmpdir(), 'phantom-doctor-omp-'));
  const cwd = join(dir, 'workspace');
  const dataDir = join(dir, 'data');
  await mkdir(cwd, { recursive: true });
  const backend = new OmpBackend({ dataDir });
  try {
    const result = await backend.probe({ cwd, dataDir, allowedTools: [] });
    return { models: result.models.length, allowance: result.allowance?.status };
  } finally {
    await backend.dispose().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function defaultProbeCodex(): Promise<DoctorProbeSummary> {
  const backend = new Codex();
  try {
    const result = await backend.probe();
    return { models: result.models.length, allowance: result.allowance?.status };
  } finally {
    await backend.dispose().catch(() => {});
  }
}

function firstLine(text: string): string {
  const clean = redact(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return clean ? bounded(clean, 240) : '';
}

function sanitizeOutput(text: string): string {
  return bounded(redact(text.trim()), 240);
}

/**
 * Runs read-only environment diagnostics against Node, git, GitHub CLI, agent runtimes,
 * built UI assets, and the configured data directory without modifying runtime state.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const deps = options.deps ?? {};
  const nodeVersion = deps.nodeVersion ?? process.version;
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? defaultExec;
  const pathExists = deps.pathExists ?? defaultPathExists;
  const readText = deps.readFile ?? ((target: string) => readFile(target, 'utf8'));
  const probeOmp = deps.probeOmp ?? defaultProbeOmp;
  const probeCodex = deps.probeCodex ?? defaultProbeCodex;
  const dataDir = options.dataDir ?? join(homedir(), '.phantom');
  const projectRoot = options.projectRoot ?? process.cwd();
  const checks: DoctorCheck[] = [];

  const major = Number(nodeVersion.replace(/^v/i, '').split('.')[0] ?? 0);
  checks.push(
    Number.isFinite(major) && major >= 24
      ? { id: 'node', label: 'Node.js runtime', status: 'pass', detail: nodeVersion }
      : {
          id: 'node',
          label: 'Node.js runtime',
          status: 'fail',
          detail: `${nodeVersion} (< 24.0.0)`,
          hint: 'Install Node.js >= 24.0.0',
        },
  );

  const gitVersion = await exec('git', ['--version']);
  checks.push(
    gitVersion.code === 0
      ? {
          id: 'git',
          label: 'Git CLI',
          status: 'pass',
          detail: firstLine(gitVersion.stdout) || 'git available',
        }
      : {
          id: 'git',
          label: 'Git CLI',
          status: 'fail',
          detail: sanitizeOutput(gitVersion.stderr || gitVersion.stdout || 'git not found'),
          hint: 'Install Git and ensure git is on PATH',
        },
  );

  const ghVersion = await exec('gh', ['--version']);
  if (ghVersion.code !== 0) {
    checks.push({
      id: 'gh',
      label: 'GitHub CLI & auth',
      status: 'fail',
      detail: sanitizeOutput(ghVersion.stderr || ghVersion.stdout || 'gh not found'),
      hint: 'Install GitHub CLI (gh) and run gh auth login',
    });
  } else {
    const auth = await exec('gh', ['auth', 'status']);
    const ver = firstLine(ghVersion.stdout) || 'gh installed';
    if (auth.code === 0) {
      checks.push({
        id: 'gh',
        label: 'GitHub CLI & auth',
        status: 'pass',
        detail: `${ver}; authenticated`,
      });
    } else {
      const reason = sanitizeOutput(auth.stderr || auth.stdout || 'not authenticated');
      checks.push({
        id: 'gh',
        label: 'GitHub CLI & auth',
        status: 'warn',
        detail: `${ver}; auth check failed (${reason})`,
        hint: 'Run gh auth login to enable GitHub sync',
      });
    }
  }

  const [ompVer, codexVer] = await Promise.all([
    exec('omp', ['--version']),
    exec('codex', ['--version']),
  ]);
  const ompOk = ompVer.code === 0;
  const codexOk = codexVer.code === 0;

  let ompDetail = ompOk
    ? firstLine(ompVer.stdout) || 'omp available'
    : sanitizeOutput(ompVer.stderr || ompVer.stdout || 'omp not found');
  let ompProbeFailed = false;
  if (ompOk && options.probeAgents) {
    try {
      const probe = await probeOmp();
      ompDetail += `; probe OK (${probe.models} models, allowance=${probe.allowance ?? 'unknown'})`;
    } catch (error) {
      ompProbeFailed = true;
      ompDetail += `; probe failed (${sanitizeOutput(error instanceof Error ? error.message : String(error))})`;
    }
  }

  let codexDetail = codexOk
    ? firstLine(codexVer.stdout) || 'codex available'
    : sanitizeOutput(codexVer.stderr || codexVer.stdout || 'codex not found');
  let codexProbeFailed = false;
  if (codexOk && options.probeAgents) {
    try {
      const probe = await probeCodex();
      codexDetail += `; probe OK (${probe.models} models, allowance=${probe.allowance ?? 'unknown'})`;
    } catch (error) {
      codexProbeFailed = true;
      codexDetail += `; probe failed (${sanitizeOutput(error instanceof Error ? error.message : String(error))})`;
    }
  }

  const anyAgentInstalled = ompOk || codexOk;
  checks.push({
    id: 'agent-omp',
    label: 'Agent runtime: omp',
    status: ompOk ? (ompProbeFailed ? 'warn' : 'pass') : anyAgentInstalled ? 'warn' : 'fail',
    detail: ompDetail,
    ...(!ompOk ? { hint: 'Install omp CLI or rely on Codex backend' } : {}),
  });
  checks.push({
    id: 'agent-codex',
    label: 'Agent runtime: codex',
    status: codexOk ? (codexProbeFailed ? 'warn' : 'pass') : anyAgentInstalled ? 'warn' : 'fail',
    detail: codexDetail,
    ...(!codexOk ? { hint: 'Install Codex CLI or rely on OMP backend' } : {}),
  });

  const distIndex = join(projectRoot, 'dist', 'index.html');
  const distBuilt = await pathExists(distIndex);
  checks.push(
    distBuilt
      ? { id: 'build', label: 'Web UI build', status: 'pass', detail: 'dist/index.html present' }
      : {
          id: 'build',
          label: 'Web UI build',
          status: 'warn',
          detail: 'dist/index.html missing',
          hint: 'Run npm run build before npm start',
        },
  );

  const dirExists = await pathExists(dataDir);
  if (!dirExists) {
    checks.push({
      id: 'data-dir',
      label: 'Data directory',
      status: 'warn',
      detail: `${dataDir} (Not initialized yet; will be created on first start)`,
    });
  } else {
    const dbExists = await pathExists(join(dataDir, 'phantom.sqlite'));
    const configPath = join(dataDir, 'config.json');
    const configExists = await pathExists(configPath);
    if (configExists) {
      try {
        const parsed = configSchema.parse(JSON.parse(await readText(configPath)));
        checks.push({
          id: 'data-dir',
          label: 'Data directory',
          status: 'pass',
          detail: `${dataDir} (port=${parsed.port}, db=${dbExists ? 'present' : 'absent'})`,
        });
      } catch (error) {
        checks.push({
          id: 'data-dir',
          label: 'Data directory',
          status: 'fail',
          detail: `Invalid config.json in ${dataDir}: ${sanitizeOutput(error instanceof Error ? error.message : String(error))}`,
          hint: 'Fix config.json ({ "port": 4317 }) or remove it to regenerate defaults',
        });
      }
    } else {
      checks.push({
        id: 'data-dir',
        label: 'Data directory',
        status: 'pass',
        detail: `${dataDir} (db=${dbExists ? 'present' : 'absent'}, config.json=default)`,
      });
    }
  }

  const status: DoctorReport['status'] = checks.some((c) => c.status === 'fail')
    ? 'fail'
    : checks.some((c) => c.status === 'warn')
      ? 'warn'
      : 'ok';

  return {
    ok: status !== 'fail',
    status,
    checkedAt: new Date().toISOString(),
    platform,
    dataDir,
    checks,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `Phantom Circuit Doctor (${report.status.toUpperCase()}) [${report.platform}]`,
    `Data directory: ${report.dataDir}`,
    '',
  ];
  for (const check of report.checks) {
    const tag = `[${check.status.toUpperCase()}]`.padEnd(6);
    lines.push(`${tag} ${check.label}: ${check.detail}`);
    if (check.hint) lines.push(`       hint: ${check.hint}`);
  }
  return lines.join('\n');
}
