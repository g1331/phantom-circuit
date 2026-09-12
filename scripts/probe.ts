import { Codex } from '../src/server/codex.ts';
import { defaults } from '../src/server/store.ts';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const c = new Codex();
try {
  await c.start();
  const models = await c.models();
  for (const [name, p] of Object.entries(defaults.profiles)) {
    await c.validate(p);
    console.log(`${name}: ${p.model} / ${p.effort} available`);
  }
  console.log(`Handshake OK; ${models.length} models.`);
  if (process.argv.includes('--turn')) {
    const cwd = resolve('.cache/protocol-smoke');
    await mkdir(cwd, { recursive: true });
    const profile = defaults.profiles.frontend;
    const options = {
      cwd,
      profile,
      instructions:
        'This is a protocol smoke test. Do not use tools or change files. Follow the requested output exactly.',
      writable: false,
    };
    const threadId = await c.thread(options);
    const response = await c.turn(
      threadId,
      'Remember the marker PHANTOM-CIRCUIT-TEST. Reply only ACK.',
      profile,
    );
    if (!response.includes('ACK')) throw new Error('Unexpected turn response');
    await c.stop();
    const resumed = new Codex();
    try {
      await resumed.start();
      await resumed.thread({ ...options, threadId });
      const reply = await resumed.turn(
        threadId,
        'Reply only with the marker I asked you to remember.',
        profile,
      );
      if (!reply.includes('PHANTOM-CIRCUIT-TEST')) throw new Error('Resume lost context');
      console.log('Actual model turn, process restart and thread resume: passed.');
    } finally {
      await resumed.stop();
    }
  } else
    console.log(
      'No model turn or repository mutation performed. Add --turn for a metered runtime smoke test.',
    );
} finally {
  await c.stop();
}
