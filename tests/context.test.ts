import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { domainContext, instructions } from '../src/server/prompts.ts';
import { Codex } from '../src/server/codex.ts';

test('PM context contains actual accepted ADR decisions, not only filenames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-context-'));
  await mkdir(join(root, 'docs/adr'), { recursive: true });
  await writeFile(
    join(root, 'docs/adr/0001-boundary.md'),
    '# Ownership\nBilling exclusively owns invoices.\n',
  );
  assert.match(await domainContext([root]), /Billing exclusively owns invoices/);
});

test('resuming a thread rejects an effective model different from the requested profile', async () => {
  class Protocol extends Codex {
    override async models() {
      return [
        {
          id: 'requested',
          model: 'requested',
          displayName: 'Requested',
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
        },
      ];
    }
    override async request() {
      return { thread: { id: 'thread' }, model: 'substituted', reasoningEffort: 'low' };
    }
  }
  await assert.rejects(
    new Protocol().thread({
      cwd: '.',
      profile: { model: 'requested', effort: 'low' },
      instructions: '',
      writable: false,
      threadId: 'thread',
    }),
    /模型|model/,
  );
});

test('thread setup rejects a mismatched or missing effective reasoning effort', async () => {
  for (const effort of ['medium', null, undefined]) {
    class Protocol extends Codex {
      override async models() {
        return [
          {
            id: 'requested',
            model: 'requested',
            displayName: 'Requested',
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
          },
        ];
      }
      override async request() {
        return { thread: { id: 'thread' }, model: 'requested', reasoningEffort: effort };
      }
    }
    await assert.rejects(
      new Protocol().thread({
        cwd: '.',
        profile: { model: 'requested', effort: 'low' },
        instructions: '',
        writable: false,
        threadId: 'thread',
      }),
      /推理档位/,
    );
  }
});

test('role instructions contain only the host role prompt without a bundled method library', async () => {
  for (const role of ['pm', 'dev', 'review', 'oncall'] as const) {
    const base = await readFile(new URL(`../prompts/${role}.md`, import.meta.url), 'utf8');
    assert.equal(await instructions(role), base, role);
  }
});
