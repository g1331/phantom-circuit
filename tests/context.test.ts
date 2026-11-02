import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { domainContext } from '../src/server/prompts.ts';
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

test('role instructions list skills as an on-demand library instead of inlining every body', async () => {
  const { instructions } = await import('../src/server/prompts.ts');
  const { access } = await import('node:fs/promises');
  const dev = await instructions('dev');
  assert.doesNotMatch(dev, /TDD is the red → green loop/, 'skill bodies are not inlined');
  assert.doesNotMatch(dev, /Commit your work/, 'no skill step contradicts host finalization');
  assert.doesNotMatch(dev, /Find the primary sources/, 'merge guidance only appears for conflicts');
  const paths = [...dev.matchAll(/— (\S+SKILL\.md)$/gm)].map((match) => match[1]);
  assert.deepEqual(
    paths.map((path) => basename(dirname(path))),
    ['tdd', 'codebase-design', 'diagnosing-bugs'],
  );
  for (const path of paths) await access(path);
  assert.match(dev, /override/i);
  const conflicted = await instructions('dev', { conflict: true });
  assert.match(conflicted, /Find the primary sources/);
  assert.ok(conflicted.length > dev.length);
  assert.match(await instructions('pm'), /domain-modeling — Build and sharpen/);
});
