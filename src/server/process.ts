import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { win32 } from 'node:path';
import { Fault, redact } from './store.ts';

/** A Windows system tool by absolute path: Git's Unix tools on PATH can shadow `whoami.exe`. */
export const systemTool = (name: string) =>
  win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name);

/**
 * Stops a child and what it started. Windows kills the process tree; elsewhere a child spawned
 * `detached` leads its own process group, so the whole group is signalled: a shell wrapper alone
 * would die and leave the server it started running.
 */
export async function terminate(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await command(
      'taskkill',
      ['/PID', String(child.pid), '/T', '/F'],
      undefined,
      undefined,
      15000,
      false,
    );
    return;
  }
  const pid = child.pid;
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name);
    } catch (e) {
      // No group led by this pid: the child was not spawned detached.
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
      child.kill(name);
    }
  };
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  signal('SIGTERM');
  // Like taskkill's /F after its timeout: a child that ignores SIGTERM is killed outright.
  const force = setTimeout(() => signal('SIGKILL'), 15000);
  await exited;
  clearTimeout(force);
}
/**
 * How much stdout a single command may return. Output past this is dropped from the front, so a
 * structured read that receives `truncated` cannot be parsed as if it were complete.
 */
export const OUTPUT_LIMIT = 2_000_000;
export function command(
  binary: string,
  args: string[],
  cwd?: string,
  input?: string,
  timeout = 120000,
  throwOnError = true,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number; truncated: boolean }> {
  if (signal?.aborted) return Promise.reject(new Fault('执行已暂停', 409));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, windowsHide: true, stdio: 'pipe', shell: false });
    let stdout = '',
      stderr = '',
      received = 0;
    // Decode through StringDecoder so a multi-byte character split across two chunks is not
    // mangled, which would corrupt structured output for no reason.
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    let settled = false;
    let stopError: Error | undefined;
    const timer = setTimeout(() => {
      stopError = new Fault(`命令超时：${binary}`, 504);
      void terminate(child).then(
        () => done(stopError),
        (e) => done(e),
      );
    }, timeout);
    const abort = () => {
      stopError = new Fault('执行已暂停', 409);
      void terminate(child).then(
        () => done(stopError),
        (e) => done(e),
      );
    };
    function done(error?: Error, code = 1) {
      error ??= stopError;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // Flush any bytes the decoders were still holding once all output has arrived.
      const outTail = outDecoder.end();
      received += outTail.length;
      stdout = (stdout + outTail).slice(-OUTPUT_LIMIT);
      stderr = (stderr + errDecoder.end()).slice(-100_000);
      if (error) reject(error);
      else if (throwOnError && code !== 0)
        reject(new Fault(redact(`${binary} (${code}): ${stderr || stdout}`).slice(-8000), 502));
      else resolve({ stdout, stderr, code, truncated: received > OUTPUT_LIMIT });
    }
    child.stdout.on('data', (d) => {
      const text = outDecoder.write(d);
      received += text.length;
      stdout = (stdout + text).slice(-OUTPUT_LIMIT);
    });
    child.stderr.on('data', (d) => (stderr = (stderr + errDecoder.write(d)).slice(-100_000)));
    child.on('error', (e) => done(e));
    child.on('close', (code) => done(undefined, code ?? -1));
    child.stdin.on('error', () => {});
    if (input) child.stdin.end(input);
    else child.stdin.end();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
export async function shellCommand(
  text: string,
  cwd: string,
  signal?: AbortSignal,
  timeout = 600000,
) {
  // These commands are materialized project configuration, not interpolated model output.
  return process.platform === 'win32'
    ? command(
        'pwsh.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference='Stop'; ${text}; if ($LASTEXITCODE) { exit $LASTEXITCODE }`,
        ],
        cwd,
        undefined,
        timeout,
        false,
        signal,
      )
    : command('/bin/sh', ['-c', text], cwd, undefined, timeout, false, signal);
}
/**
 * Listening TCP ports and their owning processes, for read-only on-call diagnosis of collisions
 * with work outside the host (another checkout's browser check held a fixed port during #65).
 */
export async function listeners(): Promise<{ port: number; pid: number; command: string }[]> {
  const rows: { port: number; pid: number; command: string }[] = [];
  if (process.platform === 'win32') {
    const script =
      '$p = @{}; Get-CimInstance Win32_Process | ForEach-Object { $p[[string]$_.ProcessId] = $_.CommandLine }; ' +
      'Get-NetTCPConnection -State Listen | ForEach-Object { [pscustomobject]@{ port = $_.LocalPort; pid = $_.OwningProcess; command = $p[[string]$_.OwningProcess] } } | ConvertTo-Json -Compress';
    const r = await command(
      'pwsh.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      undefined,
      undefined,
      30000,
      false,
    );
    const parsed: unknown = r.stdout.trim() ? JSON.parse(r.stdout) : [];
    for (const row of Array.isArray(parsed) ? parsed : [parsed])
      rows.push({
        port: Number(row.port),
        pid: Number(row.pid),
        command: String(row.command ?? ''),
      });
  } else {
    const r = await command(
      'lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN'],
      undefined,
      undefined,
      30000,
      false,
    );
    for (const line of r.stdout.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      const port = Number(/:(\d+)$/.exec(cols[8] ?? '')?.[1]);
      if (port) rows.push({ port, pid: Number(cols[1]), command: cols[0] ?? '' });
    }
  }
  const seen = new Set<string>();
  return rows
    .filter((row) => !seen.has(`${row.port}:${row.pid}`) && seen.add(`${row.port}:${row.pid}`))
    .map((row) => ({ ...row, command: redact(row.command).slice(0, 300) }))
    .sort((a, b) => a.port - b.port);
}
