import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { devFixture, until } from './dev-fixture.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Collaborations } from '../src/server/collaboration.ts';
import { FollowUps } from '../src/server/follow-ups.ts';
import { Engine } from '../src/server/engine.ts';
import { Codex } from '../src/server/codex.ts';
import { OmpBackend } from '../src/server/omp.ts';
import type { AgentToolHandler } from '../src/server/agent-backend.ts';
import type { Collaboration } from '../src/shared/collaboration.ts';

// A real Git workspace proves that contributions stay separate until their owner accepts them.
test('owner integrates an isolated contribution once and rejects conflicts', async () => {
  const f = await devFixture('phantom-contribution-');
  const ws = new Workspaces(join(f.root, 'ws'), f.store);
  try {
    const task = await ws.prepare(f.task);
    const owner = f.store.run('dev', task.projectId, task.profile, task);
    f.store.bindRunThread(owner, 'persistent-owner');
    const assignments = new Collaborations(f.store, ws.root);
    const request = {
      requestKey: 'frontend',
      objective: 'Add the screen',
      profile: 'frontend',
      mode: 'write',
    };
    await writeFile(join(task.worktree!, 'owner.txt'), 'Uncommitted owner work\n');
    const first = await assignments.create(owner, request);
    const prepared = await assignments.prepare(first);
    assert.equal(
      (await readFile(join(prepared.worktree!, 'owner.txt'), 'utf8')).replace(/\r\n/g, '\n'),
      'Uncommitted owner work\n',
    );
    await writeFile(join(prepared.worktree!, 'index.cjs'), 'module.exports = 2;\n');
    assignments.update(first.id, { status: 'completed', result: 'Changed index.cjs' });
    assert.equal(
      (await readFile(join(task.worktree!, 'index.cjs'), 'utf8')).replace(/\r\n/g, '\n'),
      'module.exports = 1;\n',
    );
    await assignments.integrate(owner, first.id);
    await assignments.integrate(owner, first.id);
    assert.equal(
      (await readFile(join(task.worktree!, 'index.cjs'), 'utf8')).replace(/\r\n/g, '\n'),
      'module.exports = 2;\n',
    );
    assert.equal((await assignments.create(owner, request)).id, first.id);
    assert.equal(f.store.list('collaboration').length, 1);
    const second = await assignments.prepare(
      await assignments.create(owner, {
        ...request,
        requestKey: 'second',
      }),
    );
    await writeFile(join(second.worktree!, 'index.cjs'), 'module.exports = 3;\n');
    assignments.update(second.id, { status: 'completed' });
    await writeFile(join(task.worktree!, 'index.cjs'), 'module.exports = 4;\n');
    await assert.rejects(assignments.integrate(owner, second.id));
    assert.equal(
      (await readFile(join(task.worktree!, 'index.cjs'), 'utf8')).replace(/\r\n/g, '\n'),
      'module.exports = 4;\n',
    );
    f.store.updateTask(task.id, { control: 'paused', pausedByUser: true });
    await assert.rejects(assignments.create(owner, { ...request, requestKey: 'late' }));
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('follow-ups preserve owner sessions across profile changes and recovery', async () => {
  const f = await devFixture('phantom-owner-followup-');
  const ws = new Workspaces(join(f.root, 'ws'), f.store);
  const inbox = new FollowUps(f.store);
  let engine: Engine | undefined;
  try {
    const task = await ws.prepare(f.task);
    const first = f.store.run('dev', task.projectId, task.profile, task);
    f.store.bindRunThread(first, 'original-owner');
    f.store.finishRun(first.id, 'completed');
    f.store.saveProjectAgentSelection(task.projectId, { mode: 'override', agent: 'omp' });
    const message = {
      source: 'web' as const,
      kind: 'comment' as const,
      nativeId: 'request-one',
      revision: '1',
      author: 'user',
      body: 'Is this within scope?',
    };
    const passedCheck = inbox.receive(task.id, {
      ...message,
      kind: 'check',
      nativeId: 'passed-check',
      checkConclusion: 'success',
      body: 'Tests: success',
    });
    const input = inbox.receive(task.id, message);
    assert.equal(inbox.receive(task.id, message).id, input.id);
    inbox.claim(input.id, 'interrupted-feedback');
    f.store.recover();
    assert.equal(inbox.queued(task.id).length, 2);
    let resumed = false;
    class Owner extends Codex {
      override async start() {}
      override async stop() {}
      override async thread(options: Parameters<Codex['thread']>[0]) {
        assert.equal(options.threadId, 'original-owner');
        assert.equal(options.writable, false);
        resumed = true;
        return 'original-owner';
      }
      override async turn() {
        return JSON.stringify({ action: 'ignore', reason: 'Already covered by this work.' });
      }
    }
    engine = new Engine(f.store, f.github, ws, f.root, () => new Owner());
    await engine.start();
    await engine.tick();
    await until(
      () => f.store.get('followUp', input.id)?.status === 'resolved',
      'feedback resolved',
    );
    assert.equal(resumed, true);
    assert.equal(f.store.get('followUp', passedCheck.id)?.status, 'resolved');
    assert.equal(f.store.list('run').filter((run) => run.purpose === 'followup').length, 1);
    assert.equal(f.store.task(task.id).ownerRunId, first.id);
    assert.equal(f.store.list('run').filter((run) => run.role === 'pm').length, 0);
  } finally {
    await engine?.stop();
    f.store.close();
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('owner commissions and integrates a contributor without changing ownership', async () => {
  const f = await devFixture('phantom-owner-delegation-');
  const ws = new Workspaces(join(f.root, 'ws'), f.store);
  let integrated = false;
  class Model extends Codex {
    cwd = '';
    contributor = false;
    handler?: AgentToolHandler;
    override async start() {}
    override async stop() {}
    override async thread(options: Parameters<Codex['thread']>[0]) {
      this.cwd = options.cwd;
      this.handler = options.toolHandler;
      this.contributor = options.instructions.includes('temporary contributor');
      return this.contributor ? 'contributor-session' : 'owner-session';
    }
    override async turn(
      _thread: string,
      _prompt: string,
      _profile: unknown,
      _signal?: AbortSignal,
    ) {
      const handler = this.handler;
      if (this.contributor) {
        await writeFile(join(this.cwd, 'index.cjs'), 'module.exports = 42;\n');
        return 'Implemented the requested value.';
      }
      const contribution = (await handler!('delegate_work', {
        requestKey: 'value',
        objective: 'Change exported value to 42',
        profile: 'backend',
        mode: 'write',
      })) as Collaboration;
      assert.equal(contribution.status, 'completed', contribution.error);
      await handler!('collaboration', { id: contribution.id, action: 'integrate' });
      assert.equal(
        (await readFile(join(this.cwd, 'index.cjs'), 'utf8')).replace(/\r\n/g, '\n'),
        'module.exports = 42;\n',
      );
      const owner = f.store.get('run', f.store.task(f.task.id).ownerRunId!);
      assert.equal(owner?.threadId, 'owner-session');
      assert.notEqual(contribution.runId, owner?.id);
      integrated = true;
      f.store.updateTask(f.task.id, { control: 'paused', pausedByUser: true });
      return 'Integrated and checked the contribution.';
    }
  }
  const engine = new Engine(f.store, f.github, ws, f.root, () => new Model());
  try {
    await engine.start();
    await engine.tick();
    await until(() => integrated || !!f.store.list('incident').length, 'contribution finished');
    assert.equal(integrated, true, JSON.stringify(f.store.list('incident')));
  } finally {
    await engine.stop();
    f.store.close();
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('OMP read-only permissions and retryable sessions survive shutdown', async () => {
  const f = await devFixture('phantom-contribution-shutdown-');
  const ws = new Workspaces(join(f.root, 'ws'), f.store);
  f.store.saveProjectAgentSelection(f.project.id, { mode: 'override', agent: 'omp' });
  let started = false;
  let allowedTools: unknown;
  class Model extends OmpBackend {
    handler?: AgentToolHandler;
    contributor = false;
    tools: unknown;
    override async start(options?: unknown) {
      this.tools = (options as { allowedTools: string[] }).allowedTools;
    }
    override async stop() {}
    override async thread(options: Parameters<OmpBackend['thread']>[0]) {
      this.handler = options.toolHandler;
      this.contributor = options.instructions.includes('temporary contributor');
      if (this.contributor) allowedTools = this.tools;
      return this.contributor ? 'contributor-session' : 'owner-session';
    }
    override async turn(
      _thread: string,
      _prompt: string,
      _profile?: unknown,
      signal?: AbortSignal,
    ): Promise<string> {
      if (this.contributor) {
        started = true;
        return new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(new Error('Interrupted')), { once: true });
        });
      }
      await this.handler!('delegate_work', {
        requestKey: 'inspect',
        objective: 'Inspect the existing code',
        profile: 'backend',
        mode: 'read',
      });
      return 'Inspection returned.';
    }
  }
  const engine = new Engine(f.store, f.github, ws, f.root, () => new Model());
  try {
    await engine.start();
    await engine.tick();
    await until(() => started, 'contributor started');
    await engine.stop();
    assert.deepEqual(allowedTools, ['read', 'grep', 'glob']);
    const assignment = f.store.list('collaboration')[0];
    assert.equal(assignment.status, 'failed');
    const owner = f.store.run('dev', f.project.id, f.task.profile, f.store.task(f.task.id));
    f.store.bindRunThread(owner, 'owner-session');
    const retry = new Collaborations(f.store, ws.root).retry(owner, assignment.id);
    assert.equal(retry.status, 'queued');
    assert.equal(retry.worktree, assignment.worktree);
    assert.equal(f.store.get('run', retry.runId!)?.threadId, 'contributor-session');
  } finally {
    await engine.stop();
    f.store.close();
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
