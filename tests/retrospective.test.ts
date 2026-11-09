import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Codex as CodexType } from '../src/server/codex.ts';
import { Store } from '../src/server/store.ts';

test('record-only suggestions preserve instructions until adopted and keep provenance after restore', () => {
  const store = new Store(':memory:');
  try {
    const p = store.createProject('Team', '');
    const repo = store.createRepo({
      projectId: p.id,
      name: 'repo',
      path: '/tmp/repo',
      github: 'test/repo',
      defaultBranch: 'main',
      authorized: true,
    });
    const source = store.addMessage(p.id, 'user', 'Implement', 'implement');
    const task = store.createTask({
      projectId: p.id,
      repoId: repo.id,
      sourceMessageId: source.id,
      title: 'Port fix',
      spec: 'fix',
      acceptance: ['works'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    const first = store.saveTeamInstructions(
      p.id,
      { repository: '', engineering: 'Run checks.', delivery: '' },
      { source: 'user', baseVersion: 0 },
    );
    const suggestion = store.recordRetrospective(task.id, {
      baseVersion: 1,
      category: 'port_conflict',
      interruptionIds: ['incident:port'],
      reason: 'Resolve port conflicts internally.',
      sections: { ...first.sections, engineering: 'Use an available port before asking the user.' },
    });
    assert.equal(store.currentTeamInstructions(p.id).version, 1);
    const adopted = store.decideSuggestion(p.id, suggestion.id, 'adopt');
    assert.equal(adopted.status, 'adopted');
    assert.equal(store.currentTeamInstructions(p.id).taskId, task.id);
    assert.deepEqual(store.currentTeamInstructions(p.id).interruptionCategories, ['port_conflict']);
    store.restoreTeamInstructions(p.id, 1, 2);
    assert.equal(store.get('suggestion', suggestion.id)?.status, 'reverted');
    assert.equal(store.teamInstructionsHistory(p.id)[1].suggestionId, suggestion.id);
  } finally {
    store.close();
  }
});

for (const scenario of ['port', 'product', 'malformed', 'auto', 'ignored', 'omp'] as const)
  test(`Engine post-merge retrospective: ${scenario}`, async () => {
    const { devFixture, until } = await import('./dev-fixture.ts');
    const { Engine } = await import('../src/server/engine.ts');
    const { Codex } = await import('../src/server/codex.ts');
    const { Workspaces } = await import('../src/server/workspaces.ts');
    const { rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { root, store, project, task, github } = await devFixture('phantom-retro-');
    store.updateTask(task.id, {
      stage: 'done',
      head: 'head',
      base: 'base',
      pr: 2,
      completionDeliveryPending: false,
      cleanup: { requested: true, status: 'completed' },
    });
    if (scenario === 'omp') {
      store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'omp' });
      store.updateTask(task.id, { worktree: join(root, 'removed-task-worktree') });
    }
    if (scenario === 'auto') store.setAutoAdoptInstructions(project.id, true);
    if (scenario === 'ignored') {
      const earlier = store.createTask({
        projectId: project.id,
        repoId: task.repoId,
        sourceMessageId: task.sourceMessageId,
        title: 'Earlier port incident',
        spec: 'fix',
        acceptance: ['works'],
        dependencies: [],
        kind: 'backend',
        complexity: 'normal',
        priority: 0,
      });
      store.updateTask(earlier.id, { stage: 'cancelled' });
      const prior = store.recordRetrospective(earlier.id, {
        baseVersion: 0,
        category: 'port_conflict',
        interruptionIds: ['message:earlier'],
        reason: 'Previously declined',
        sections: {
          repository: '',
          engineering: 'Use a free port before asking the user.',
          delivery: '',
        },
      });
      store.decideSuggestion(project.id, prior.id, 'ignore');
    }
    const intervention = store.addMessage(
      project.id,
      'user',
      `For ${task.id}, port 3000 is occupied; use a free port.`,
      'discuss',
    );
    store.updateMessage(intervention.id, { status: 'completed' });
    if (scenario === 'product') {
      store.updateMessage(intervention.id, { content: 'Product answer without a Task reference.' });
      store.createClarification({
        projectId: project.id,
        taskId: task.id,
        sourceMessageId: task.sourceMessageId,
        questions: [{ id: 'color', question: 'Which color?' }],
      });
    }
    store.put('operation', `merge:${task.id}:head`, {
      id: `merge:${task.id}:head`,
      kind: 'merge-pr',
      status: 'done',
      result: {
        number: 2,
        merged: true,
        merged_at: new Date(Date.now() + 1000).toISOString(),
        head: { sha: 'head' },
        base: { sha: 'base', repo: { full_name: 'fixture/source' } },
      },
    });
    let calls = 0;
    class Model extends Codex {
      override async start() {}
      override async stop() {}
      override async thread(options: Parameters<CodexType['thread']>[0]) {
        assert.equal(options.writable, false);
        assert.deepEqual(options.tools, []);
        return 'retro';
      }
      override async turn(_thread: string, prompt: string) {
        calls++;
        assert.ok(prompt.length < 40000);
        assert.match(prompt, /port 3000/);
        if (scenario === 'ignored') assert.match(prompt, /\"status\":\"ignored\"/);
        if (scenario === 'malformed') return 'invalid response';
        return JSON.stringify({
          category: 'port_conflict',
          interruptionIds: [`message:${intervention.id}`],
          reason: 'Use a free port before escalating.',
          change: { section: 'engineering', text: 'Use a free port before asking the user.' },
        });
      }
    }
    const engine = new Engine(store, github, new Workspaces(join(root, 'ws'), store), root, () => {
      const model = new Model();
      if (scenario !== 'omp') return model;
      return {
        start: async (options?: unknown) => {
          const config = options as { cwd: string; allowedTools: string[] };
          assert.equal(config.cwd, store.repo(task.repoId).path);
          assert.deepEqual(config.allowedTools, []);
        },
        stop: async () => {},
        thread: model.thread.bind(model),
        turn: model.turn.bind(model),
        forkReadOnlyThread: model.forkReadOnlyThread.bind(model),
      };
    });
    try {
      store.put('project', project.id, {
        ...store.project(project.id),
        pmThreadId: 'liaison-session',
      });
      await engine.start();
      await engine.tick();
      await until(
        () => store.list('suggestion').some((s) => s.taskId === task.id && s.status !== 'running'),
        'recorded retrospective',
      );
      const expected =
        scenario === 'product' || scenario === 'ignored'
          ? 'no_change'
          : scenario === 'malformed'
            ? 'failed'
            : scenario === 'auto'
              ? 'adopted'
              : 'pending';
      assert.equal(store.list('suggestion').find((s) => s.taskId === task.id)?.status, expected);
      assert.equal(store.currentTeamInstructions(project.id).version, scenario === 'auto' ? 1 : 0);
      const suggestion = store.list('suggestion').find((s) => s.taskId === task.id)!;
      if (scenario !== 'product')
        assert.deepEqual(suggestion.interruptionIds, [`message:${intervention.id}`]);
      else assert.equal(suggestion.sections, undefined);
      await engine.tick();
      assert.equal(calls, scenario === 'product' ? 0 : 1);
      assert.equal(store.project(project.id).pmThreadId, 'liaison-session');
      if (scenario === 'auto')
        assert.equal(
          store
            .list('message')
            .filter((m) => m.role === 'assistant' && m.content.includes('更新团队说明')).length,
          1,
        );
    } finally {
      await engine.stop();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

test('ignored suggestions are not repeated after unrelated instruction edits; stale adoption is rejected', () => {
  const store = new Store(':memory:');
  try {
    const p = store.createProject('Team', '');
    const repo = store.createRepo({
      projectId: p.id,
      name: 'r',
      path: '/tmp/r',
      github: 't/r',
      defaultBranch: 'main',
      authorized: true,
    });
    const source = store.addMessage(p.id, 'user', 'Implement', 'implement');
    let serial = 0;
    const task = () =>
      store.createTask({
        projectId: p.id,
        repoId: repo.id,
        sourceMessageId: source.id,
        title: `Port ${++serial}`,
        spec: 'fix',
        acceptance: ['works'],
        dependencies: [],
        kind: 'backend',
        complexity: 'normal',
        priority: 0,
      });
    const a = task();
    const first = store.recordRetrospective(a.id, {
      baseVersion: 0,
      category: 'port_conflict',
      interruptionIds: ['message:a'],
      reason: 'Use a free port',
      sections: { repository: '', engineering: 'Use a free port.', delivery: '' },
    });
    store.decideSuggestion(p.id, first.id, 'ignore');
    store.saveTeamInstructions(
      p.id,
      { repository: 'New convention', engineering: '', delivery: '' },
      { source: 'user', baseVersion: 0 },
    );
    const next = store.recordRetrospective(task().id, {
      baseVersion: 1,
      category: 'port_conflict',
      interruptionIds: ['message:b'],
      reason: 'Use a free port',
      sections: { repository: 'New convention', engineering: 'Use a free port.', delivery: '' },
    });
    assert.equal(next.status, 'no_change');
    const stale = store.recordRetrospective(task().id, {
      baseVersion: 1,
      category: 'missing_evidence',
      interruptionIds: ['message:c'],
      reason: 'Attach results',
      sections: { repository: 'New convention', engineering: 'Attach results.', delivery: '' },
    });
    store.saveTeamInstructions(
      p.id,
      { repository: 'Newer convention', engineering: '', delivery: '' },
      { source: 'user', baseVersion: 1 },
    );
    assert.throws(() => store.decideSuggestion(p.id, stale.id, 'adopt'), /重新载入/);
    assert.equal(store.currentTeamInstructions(p.id).sections.repository, 'Newer convention');
    assert.equal(store.get('suggestion', stale.id)?.status, 'pending');
  } finally {
    store.close();
  }
});

test('HTTP decisions require a write session and the suggestion project', async () => {
  const { createApp } = await import('../src/server/app.ts');
  const { Engine } = await import('../src/server/engine.ts');
  const { GitHub } = await import('../src/server/github.ts');
  const { Workspaces } = await import('../src/server/workspaces.ts');
  const { Previews } = await import('../src/server/preview.ts');
  const store = new Store(':memory:');
  const ws = new Workspaces('/test', store);
  const app = createApp(
    store,
    new Engine(store, new GitHub(store), ws, '/test'),
    new Previews(store, ws),
  );
  try {
    const project = store.createProject('Team', '');
    const other = store.createProject('Other', '');
    const repo = store.createRepo({
      projectId: project.id,
      name: 'r',
      path: '/tmp/r',
      github: 't/r',
      defaultBranch: 'main',
      authorized: true,
    });
    const source = store.addMessage(project.id, 'user', 'Implement', 'implement');
    const task = store.createTask({
      projectId: project.id,
      repoId: repo.id,
      sourceMessageId: source.id,
      title: 'Port',
      spec: 'fix',
      acceptance: ['works'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    const suggestion = store.recordRetrospective(task.id, {
      baseVersion: 0,
      category: 'port_conflict',
      interruptionIds: ['message:port'],
      reason: 'Use a free port',
      sections: { repository: '', engineering: 'Use a free port.', delivery: '' },
    });
    const path = `/api/projects/${project.id}/team-instructions/suggestions/${encodeURIComponent(suggestion.id)}`;
    assert.equal(
      (await app.inject({ method: 'POST', url: path, payload: { action: 'adopt' } })).statusCode,
      403,
    );
    const session = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
    const headers = {
      host: '127.0.0.1:4317',
      cookie: String(session.headers['set-cookie']).split(';')[0],
      'x-phantom-csrf': session.json().csrf,
    };
    const cross = await app.inject({
      method: 'POST',
      url: path.replace(project.id, other.id),
      headers,
      payload: { action: 'adopt' },
    });
    assert.equal(cross.statusCode, 404, cross.body);
    const adopt = await app.inject({
      method: 'POST',
      url: path,
      headers,
      payload: { action: 'adopt' },
    });
    assert.equal(adopt.statusCode, 200, adopt.body);
    assert.equal(store.currentTeamInstructions(project.id).source, 'team');
    assert.equal(
      (await app.inject({ method: 'POST', url: path, headers, payload: { action: 'adopt' } }))
        .statusCode,
      409,
    );
  } finally {
    await app.close();
    store.close();
  }
});

test('restart records an interrupted retrospective without scheduling a successor model run', () => {
  const store = new Store(':memory:');
  try {
    const p = store.createProject('Team', '');
    const repo = store.createRepo({
      projectId: p.id,
      name: 'r',
      path: '/tmp/r',
      github: 't/r',
      defaultBranch: 'main',
      authorized: true,
    });
    const source = store.addMessage(p.id, 'user', 'Implement', 'implement');
    const task = store.createTask({
      projectId: p.id,
      repoId: repo.id,
      sourceMessageId: source.id,
      title: 'Port',
      spec: 'fix',
      acceptance: ['works'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    const suggestion = store.recordRetrospective(
      task.id,
      {
        baseVersion: 0,
        category: 'no_rule',
        interruptionIds: ['message:port'],
        reason: 'Reviewing',
      },
      'running',
    );
    const run = store.run('pm', p.id, 'pm', task);
    store.put('run', run.id, { ...run, purpose: 'retrospective' });
    const recoveries = store.recover();
    assert.equal(store.get('suggestion', suggestion.id)?.status, 'failed');
    assert.equal(store.get('run', run.id)?.status, 'failed');
    assert.equal(
      recoveries.some((item) => item.oldRunId === run.id),
      false,
    );
    assert.equal(store.currentTeamInstructions(p.id).version, 0);
  } finally {
    store.close();
  }
});
