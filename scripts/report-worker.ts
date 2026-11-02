import { readReportSnapshot, renderReport } from '../src/server/report.ts';

try {
  const snapshot = readReportSnapshot(process.argv[2]);
  process.stdout.write(renderReport(snapshot));
} catch (error) {
  console.error(`报告失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
