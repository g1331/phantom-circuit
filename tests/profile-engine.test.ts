import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { Store } from '../src/server/store.ts';
import { Providers } from '../src/server/providers.ts';
import { Engine } from '../src/server/engine.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { GitHub } from '../src/server/github.ts';

test('first upstream request failures retain configuration and identify the pinned Run', async () => {
  const store = new Store(':memory:');
  const project = store.createProject('Runtime failure', '');
  class FailingModel extends Codex {
    override async start() {}
    override async stop() {}
    override async thread() {
      return 'runtime-thread';
    }
    override async turn(): Promise<string> {
      throw new Error('Upstream Responses API rejected reasoning effort');
    }
  }
  const engine = new Engine(
    store,
    new GitHub(store),
    new Workspaces(resolve('.phantom/test'), store),
    resolve('.phantom/test'),
    () => new FailingModel(),
  );
  try {
    await assert.rejects(
      engine.chat(store.addMessage(project.id, 'user', 'Start', 'discuss')),
      /Upstream Responses API rejected/,
    );
    const run = store.list('run')[0];
    assert.equal(run.status, 'failed');
    assert.match(run.error!, /Upstream Responses API rejected/);
    assert.deepEqual(store.project(project.id).profiles, project.profiles);
    assert.deepEqual(run.profileConfig, project.profiles.pm);
  } finally {
    await engine.stop();
    store.close();
  }
});

test('PM Provider switches start a fresh thread with durable context and keep active Runs pinned', async () => {
  await mkdir(resolve('.phantom/test'), { recursive: true });
  const root = await mkdtemp(resolve('.phantom/test/profile-engine-'));
  const store = new Store(join(root, 'state.sqlite'));
  const providers = new Providers(store);
  const custom = await providers.save({
    name: 'PM upstream',
    baseUrl: 'http://localhost:9999/v1',
    apiKey: 'pm-fixture-key',
  });
  const project = store.createProject('Durable project', 'Retain product decisions');
  const threads: (string | undefined)[] = [];
  const starts: (string | undefined)[] = [];
  const prompts: string[] = [];
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  class Model extends Codex {
    override async start(connection?: Parameters<Codex['start']>[0]) {
      starts.push(connection?.id);
    }
    override async stop() {}
    override async thread(options: Parameters<Codex['thread']>[0]) {
      threads.push(options.threadId);
      if (threads.length === 1) {
        entered();
        await barrier;
      }
      return `thread-${threads.length}`;
    }
    override async turn(_thread: string, prompt: string) {
      prompts.push(prompt);
      return 'Durable decision: use blue.';
    }
  }
  const engine = new Engine(
    store,
    new GitHub(store),
    new Workspaces(root, store),
    root,
    () => new Model(),
  );
  try {
    const first = engine.chat(
      store.addMessage(project.id, 'user', 'Remember the blue decision', 'discuss'),
    );
    await waiting;
    const profiles = structuredClone(project.profiles);
    profiles.pm = { providerId: custom.id, model: 'other-model', effort: 'low', customModel: true };
    store.saveProjectProfiles(project.id, profiles);
    release();
    await first;
    assert.equal(store.project(project.id).pmThreadId, undefined);
    await engine.chat(store.addMessage(project.id, 'user', 'Continue', 'discuss'));
    assert.deepEqual(starts, [undefined, custom.id]);
    assert.deepEqual(threads, [undefined, undefined]);
    assert.match(prompts[1], /Remember the blue decision/);
    assert.match(prompts[1], /Durable decision: use blue/);
    const runs = store.list('run');
    assert.equal(runs[0].profileConfig?.providerId, 'codex');
    assert.equal(runs[1].profileConfig?.model, 'other-model');
    assert.ok(!JSON.stringify(store.snapshot()).includes('pm-fixture-key'));
  } finally {
    release();
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
