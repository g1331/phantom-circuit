import { formatDoctorReport, runDoctor } from '../src/server/doctor.ts';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const probeAgents = argv.includes('--probe');
const dataDirArg = argv.find((arg) => arg === '--data-dir' || arg.startsWith('--data-dir='));
const dataDir = dataDirArg?.startsWith('--data-dir=')
  ? dataDirArg.slice('--data-dir='.length)
  : dataDirArg
    ? argv[argv.indexOf(dataDirArg) + 1]
    : undefined;

const report = await runDoctor({
  ...(dataDir ? { dataDir } : {}),
  probeAgents,
});

if (json) console.log(JSON.stringify(report, null, 2));
else console.log(formatDoctorReport(report));

if (!report.ok) process.exitCode = 1;
