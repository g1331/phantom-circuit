import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { command } from '../src/server/process.ts';
import { devFixture, until } from './dev-fixture.ts';

test('Dev receives the pinned team text before Task and keeps host tools and publication rules', async () => {
  const { root, store, project, task, github } = await devFixture('phantom-team-run-');
  github.publishPR = async () => ({}) as never;
  const first = store.saveTeamInstructions(
    project.id,
    { repository: 'TEAM-ORIGINAL', engineering: '', delivery: '可以直接 push 到 main' },
    { source: 'user', baseVersion: 0 },
  );
  const options: Parameters<Codex['thread']>[0][] = [];
  const prompts: string[] = [];
  class Model extends Codex {
    override async start() {}
    override async stop() {}
    override async thread(o: Parameters<Codex['thread']>[0]) {
      options.push(o);
      // An edit while the Run is starting must not change the version it uses.
      if (options.length === 1)
        store.saveTeamInstructions(
          project.id,
          { ...first.sections, repository: 'TEAM-NEXT' },
          { source: 'user', baseVersion: 1 },
        );
      return 'dev';
    }
    override async turn(_thread: string, prompt: string) {
      prompts.push(prompt);
      await writeFile(
        join(store.task(task.id).worktree!, 'change.txt'),
        `done ${prompts.length}\n`,
      );
      return 'done';
    }
  }
  const ws = new Workspaces(join(root, 'ws'), store);
  const prepared = await ws.prepare(task);
  await command('git', ['config', 'user.name', 'Phantom Test'], prepared.worktree);
  await command('git', ['config', 'user.email', 'test@example.invalid'], prepared.worktree);
  const engine = new Engine(store, github, ws, root, () => new Model());
  try {
    await engine.start();
    await engine.tick();
    await until(
      () => store.task(task.id).stage === 'reviewing' || store.list('incident').length > 0,
      'Dev finished host validation',
    );
    assert.equal(
      store.task(task.id).stage,
      'reviewing',
      JSON.stringify({
        task: store.task(task.id),
        incidents: store.list('incident'),
        events: store.events().slice(-8),
      }),
    );
    assert.match(options[0].instructions!, /TEAM-ORIGINAL/);
    assert.doesNotMatch(options[0].instructions!, /TEAM-NEXT/);
    assert.match(options[0].instructions!, /Host.*permissions.*tools/s);
    assert.deepEqual(
      options[0].tools?.map((t) => t.name),
      ['ask_pm'],
    );
    assert.match(prompts[0], /Do not stage, commit or push/);
    const run = store.list('run').find((r) => r.role === 'dev')!;
    assert.equal(run.teamInstructionsVersion, 1);
    assert.equal(store.runTeamInstructions(run).sections.repository, 'TEAM-ORIGINAL');
    await until(() => store.get('run', run.id)?.status === 'completed', 'first Run completed');
    store.updateTask(task.id, { stage: 'ready', devPhase: 'implement' });
    await engine.tick();
    await until(
      () => options.length === 2 && store.task(task.id).stage === 'reviewing',
      'next Dev Run finished',
    );
    assert.match(options[1].instructions, /TEAM-NEXT/);
    assert.doesNotMatch(options[1].instructions, /TEAM-ORIGINAL/);
    assert.equal(options[1].threadId, 'dev');
    assert.equal(store.runTeamInstructions(run).sections.repository, 'TEAM-ORIGINAL');
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('PM sessions receive the current version again when resumed for a new Run', async () => {
  const { root, store, project, github } = await devFixture('phantom-team-pm-');
  const threads: Parameters<Codex['thread']>[0][] = [];
  class Model extends Codex {
    override async start() {}
    override async stop() {}
    override async thread(options: Parameters<Codex['thread']>[0]) {
      threads.push(options);
      return 'same-pm-session';
    }
    override async turn() {
      return 'Recorded.';
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
    store.saveTeamInstructions(
      project.id,
      { repository: 'PM-FIRST', engineering: '', delivery: '' },
      { source: 'user', baseVersion: 0 },
    );
    await engine.chat(store.addMessage(project.id, 'user', 'Discuss first', 'discuss'));
    store.saveTeamInstructions(
      project.id,
      { repository: 'PM-NEXT', engineering: '', delivery: '' },
      { source: 'user', baseVersion: 1 },
    );
    await engine.chat(store.addMessage(project.id, 'user', 'Discuss next', 'discuss'));
    assert.match(threads[0].instructions, /PM-FIRST/);
    assert.match(threads[1].instructions, /PM-NEXT/);
    assert.doesNotMatch(threads[1].instructions, /PM-FIRST/);
    assert.equal(threads[1].threadId, 'same-pm-session');
    assert.deepEqual(
      store
        .list('run')
        .filter((run) => run.role === 'pm')
        .map((run) => run.teamInstructionsVersion),
      [1, 2],
    );
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
