import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { devFixture, hang, until } from './dev-fixture.ts';

test('a Dev blocked on ask_pm is answered before user messages that are still queued', async () => {
  const { root, store, project, github } = await devFixture('phantom-pm-queue-');
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let devAnswer: unknown;
  class Model extends Codex {
    writable = false;
    handler?: Parameters<Codex['thread']>[0]['toolHandler'];
    override async start() {}
    override async stop() {}
    override async thread(options: Parameters<Codex['thread']>[0]) {
      this.writable = options.writable;
      this.handler = options.toolHandler;
      return this.writable ? 'dev' : 'pm';
    }
    override async turn(_thread: string, prompt: string, _profile: any, signal?: AbortSignal) {
      if (this.writable) {
        devAnswer = await this.handler!('ask_pm', { question: 'Which module owns it?' });
        return hang(signal);
      }
      const label = /Which module owns it\?/.test(prompt)
        ? 'dev-question'
        : /FIRST-USER/.test(prompt.slice(-200))
          ? 'first-user'
          : 'second-user';
      order.push(label);
      if (label === 'first-user') await gate;
      return `answer:${label}`;
    }
  }
  const engine = new Engine(
    store,
    github,
    new Workspaces(join(root, 'ws'), store),
    root,
    () => new Model(),
  );
  try {
    await engine.start();
    const first = engine.chat(store.addMessage(project.id, 'user', 'FIRST-USER', 'discuss'));
    await until(() => order.length === 1, 'first PM turn running');
    const second = engine.chat(store.addMessage(project.id, 'user', 'SECOND-USER', 'discuss'));
    await engine.tick();
    await until(
      () => store.list('run').some((run) => run.role === 'dev' && !!run.threadId),
      'dev asked the PM',
    );
    await new Promise((r) => setTimeout(r, 50));
    release();
    await Promise.all([first, second]);
    await until(() => devAnswer !== undefined, 'dev received an answer');
    assert.deepEqual(order, ['first-user', 'dev-question', 'second-user']);
    assert.deepEqual(devAnswer, { answer: 'answer:dev-question' });
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
