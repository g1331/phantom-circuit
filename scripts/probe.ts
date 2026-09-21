import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { OmpBackend } from '../src/server/omp.ts';
import type { AgentProfile } from '../src/server/agent-backend.ts';

const argv = process.argv.slice(2);
const agentArg = argv.find((arg) => arg === '--agent' || arg.startsWith('--agent='));
const agent = agentArg?.startsWith('--agent=')
  ? agentArg.slice('--agent='.length)
  : agentArg
    ? argv[argv.indexOf(agentArg) + 1]
    : 'omp';
if (agent !== 'omp' && agent !== 'codex') throw new Error(`Unknown agent: ${agent}`);
const turn = argv.includes('--turn');
const sessionOnly = argv.includes('--session') && !turn;

const workspace = await mkdtemp(join(tmpdir(), 'phantom-circuit-probe-'));
const cwd = join(workspace, 'workspace');
const dataDir = join(workspace, 'data');
await mkdir(cwd, { recursive: true });

const codexProfile: AgentProfile = { model: 'gpt-5.6-luna', effort: 'max' };
const instructions =
  'This is an isolated protocol smoke test. Do not use tools, access the repository, or change files. Follow the requested output exactly.';

function isolatedOptions(profile?: AgentProfile) {
  return {
    cwd,
    dataDir,
    profile,
    instructions,
    writable: false,
    allowedTools: [] as string[],
  };
}

async function runOmp(): Promise<void> {
  let backend: OmpBackend | undefined;
  try {
    backend = new OmpBackend({ dataDir });
    const result = await backend.probe({ cwd, dataDir, allowedTools: [] });
    console.log(
      `OMP handshake OK; ${result.models.length} models; allowance=${result.allowance?.status ?? 'unknown'}.`,
    );
    if (!turn && sessionOnly) {
      const session = await backend.createSession(isolatedOptions());
      console.log(`OMP session setup OK; id=${session.id}.`);
      return;
    }
    if (!turn) {
      console.log(
        'No model turn or repository mutation performed. Add --turn for a metered runtime smoke test.',
      );
      return;
    }

    const session = await backend.createSession(isolatedOptions());
    const first = await session.prompt('Remember the marker PHANTOM-CIRCUIT-TEST. Reply only ACK.');
    if (!first.text.includes('ACK'))
      throw new Error('OMP smoke turn did not acknowledge the marker');
    const sessionId = session.id;
    await backend.dispose();
    backend = new OmpBackend({ dataDir });
    const resumed = await backend.resumeSession({ ...isolatedOptions(), sessionId });
    const second = await resumed.prompt('Reply only with the marker I asked you to remember.');
    if (!second.text.includes('PHANTOM-CIRCUIT-TEST')) throw new Error('OMP resume lost context');
    console.log(
      `OMP model turn, process restart and session resume: passed; usage=${first.usage ? 'reported' : 'unreported'}.`,
    );
  } finally {
    await backend?.dispose();
  }
}

async function runCodex(): Promise<void> {
  let backend: Codex | undefined;
  try {
    backend = new Codex();
    const result = await backend.probe();
    console.log(
      `Codex handshake OK; ${result.models.length} models; allowance=${result.allowance?.status ?? 'unknown'}.`,
    );
    if (!turn && sessionOnly) {
      await backend.start();
      const session = await backend.createSession(isolatedOptions(codexProfile));
      console.log(`Codex session setup OK; id=${session.id}.`);
      return;
    }
    if (!turn) {
      console.log(
        'No model turn or repository mutation performed. Add --turn for a metered runtime smoke test.',
      );
      return;
    }

    await backend.start();
    const session = await backend.createSession(isolatedOptions(codexProfile));
    const first = await session.prompt('Remember the marker PHANTOM-CIRCUIT-TEST. Reply only ACK.');
    if (!first.text.includes('ACK'))
      throw new Error('Codex smoke turn did not acknowledge the marker');
    const sessionId = session.id;
    await backend.dispose();
    backend = new Codex();
    await backend.start();
    const resumed = await backend.resumeSession({ ...isolatedOptions(codexProfile), sessionId });
    const second = await resumed.prompt('Reply only with the marker I asked you to remember.');
    if (!second.text.includes('PHANTOM-CIRCUIT-TEST')) throw new Error('Codex resume lost context');
    console.log(
      `Codex ${codexProfile.model}/${codexProfile.effort} model turn, process restart and thread resume: passed; usage=${first.usage ? 'reported' : 'unreported'}.`,
    );
  } finally {
    await backend?.dispose();
  }
}

try {
  if (agent === 'omp') await runOmp();
  else await runCodex();
} finally {
  await rm(workspace, { recursive: true, force: true });
}
