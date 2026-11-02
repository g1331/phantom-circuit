import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
try {
  let dataDir = join(homedir(), '.phantom');
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Usage: npm run report -- [--data-dir <directory>]\nDefault: ~/.phantom (read-only; no migration).',
    );
  } else {
    if (args.length) {
      if (args.length === 2 && args[0] === '--data-dir' && args[1] && !args[1].startsWith('--'))
        dataDir = args[1];
      else if (args.length === 1 && args[0].startsWith('--data-dir=') && args[0].slice(11))
        dataDir = args[0].slice(11);
      else throw new Error('用法：npm run report -- [--data-dir <directory>]');
    }
    // An independent parent can terminate synchronous SQLite reads too. execFile's callback
    // waits for child exit; publish stdout only after the complete report succeeds.
    const child = execFile(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('./report-worker.ts', import.meta.url)),
        resolve(dataDir),
      ],
      { timeout: 10_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          console.error(
            error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
              ? '报告失败：输出超过 16 MiB 上限；未生成报告。'
              : error.killed
                ? '报告失败：只读快照/报告超过 10 秒上限，读取进程已终止；未生成报告。'
                : stderr.trim() || `报告失败：读取进程退出 (${error.code})`,
          );
          process.exitCode = 1;
        } else process.stdout.write(stdout);
      },
    );
    process.once('SIGINT', () => {
      child.kill();
      process.exitCode = 1;
    });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
