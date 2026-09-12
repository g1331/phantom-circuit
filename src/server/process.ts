import { spawn, type ChildProcess } from 'node:child_process';
import { Fault, redact } from './store.ts';

export async function terminate(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await command(
      'taskkill',
      ['/PID', String(child.pid), '/T', '/F'],
      undefined,
      undefined,
      15000,
      false,
    );
  } else child.kill('SIGTERM');
}
export function command(
  binary: string,
  args: string[],
  cwd?: string,
  input?: string,
  timeout = 120000,
  throwOnError = true,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, windowsHide: true, stdio: 'pipe', shell: false });
    let stdout = '',
      stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      void terminate(child);
      done(new Fault(`命令超时：${binary}`, 504));
    }, timeout);
    const abort = () => {
      void terminate(child);
      done(new Fault('执行已暂停', 409));
    };
    function done(error?: Error, code = 1) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (throwOnError && code !== 0)
        reject(new Fault(redact(`${binary} (${code}): ${stderr || stdout}`).slice(-8000), 502));
      else resolve({ stdout, stderr, code });
    }
    child.stdout.on('data', (d) => (stdout = (stdout + d.toString()).slice(-2_000_000)));
    child.stderr.on('data', (d) => (stderr = (stderr + d.toString()).slice(-100_000)));
    child.on('error', (e) => done(e));
    child.on('close', (code) => done(undefined, code ?? 1));
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
        'powershell.exe',
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
