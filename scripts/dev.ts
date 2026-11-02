// Starts the watched backend and the Vite dev server together; extra arguments go to the backend.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

const backend = process.argv.includes('--debug')
  ? ['--inspect=127.0.0.1:9229', 'src/server/main.ts', '--pretty-logs', '--log-level=debug']
  : ['src/server/main.ts', '--pretty-logs'];
const args = process.argv.slice(2).filter((arg) => arg !== '--debug');
const node = (script: string, params: string[]) =>
  spawn(process.execPath, [script, ...params], { stdio: 'inherit' });

const children: ChildProcess[] = [
  node('node_modules/tsx/dist/cli.mjs', ['watch', '--clear-screen=false', ...backend, ...args]),
  node('node_modules/vite/bin/vite.js', ['--host', '127.0.0.1']),
];

let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null || !child.pid) continue;
    // tsx watch runs the server in a grandchild; Windows needs a tree kill to release port 4317.
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill();
  }
  process.exit(code);
}
for (const child of children) child.on('exit', (code) => stop(code ?? 1));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
