import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Codex } from '../src/server/codex.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';

/** PM context is bounded: recent records inline, everything else recalled through a host tool. */
test('PM turns inline a bounded project summary and recall full records on demand', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-pm-context-'));
  const store = new Store(':memory:');
  const project = store.createProject('Context', 'A product with a long history');
  store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
  const other = store.createProject('Other', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'repo',
    path: root,
    github: 'example/repo',
    authorized: true,
    defaultBranch: 'main',
  });
  const ancient = store.addMessage(
    project.id,
    'user',
    'ANCIENT-DECISION: billing stays out',
    'discuss',
  );
  for (let i = 0; i < 40; i++) store.addMessage(project.id, 'assistant', `Routine update ${i}`);
  store.addMessage(project.id, 'assistant', `Recent long note ${'x'.repeat(5000)} LONG-TAIL`);
  const foreign = store.addMessage(other.id, 'user', 'FOREIGN-PROJECT-SECRET', 'discuss');
  const request = store.addMessage(project.id, 'user', 'Implement the open work', 'implement');
  const taskInput = (title: string) => ({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: request.id,
    title,
    spec: `Spec for ${title}`,
    acceptance: ['Works'],
    dependencies: [],
    kind: 'backend' as const,
    complexity: 'normal' as const,
    priority: 0,
  });
  const done: string[] = [];
  for (let i = 0; i < 20; i++) {
    const task = store.createTask(taskInput(`Finished ${i}`));
    store.updateTask(task.id, {
      stage: 'done',
      tests: [
        {
          command: 'npm test',
          exitCode: 0,
          output: `HUGE-TEST-OUTPUT ${'y'.repeat(20000)}`,
          head: 'h',
          at: 'now',
        },
      ],
    });
    done.push(task.id);
  }
  const open = store.createTask(taskInput('Open work'));
  const doc = store.recordDocument(project.id, {
    repoId: repo.id,
    path: 'docs/adr/0001-scope.md',
    content: `# Scope\nDOCUMENT-BODY ${'z'.repeat(8000)}`,
    accepted: true,
  });
  const prompts: string[] = [];
  const recalled: any[] = [];
  let toolNames: string[] = [];
  class Model extends Codex {
    handler?: Parameters<Codex['thread']>[0]['toolHandler'];
    override async start() {}
    override async stop() {}
    override async thread(options: Parameters<Codex['thread']>[0]) {
      toolNames = (options.tools ?? []).map((tool) => tool.name);
      this.handler = options.toolHandler;
      return 'pm';
    }
    override async turn(_thread: string, prompt: string) {
      prompts.push(prompt);
      recalled.push(
        await this.handler!('read_project_records', {
          kind: 'message',
          ids: [ancient.id, foreign.id],
        }),
        await this.handler!('read_project_records', { kind: 'task', ids: [done[0]] }),
        await this.handler!('read_project_records', { kind: 'document', ids: [doc.id] }),
        await this.handler!('read_project_records', { kind: 'message', before: ancient.id }),
        await this.handler!('read_project_records', { kind: 'task', limit: 50 }),
      );
      return 'ok';
    }
  }
  class LocalWorkspaces extends Workspaces {
    override async view() {
      return root;
    }
  }
  const engine = new Engine(
    store,
    new GitHub(store),
    new LocalWorkspaces(join(root, 'ws'), store),
    root,
    () => new Model(),
  );
  try {
    await engine.chat(store.addMessage(project.id, 'user', 'What is next?', 'discuss'));
    const [prompt] = prompts;
    assert.ok(toolNames.includes('read_project_records'));
    assert.ok(prompt.length < 30000, `prompt stays bounded, got ${prompt.length}`);
    assert.match(prompt, /What is next\?/);
    assert.match(prompt, /Routine update 39/);
    assert.match(prompt, /Recent long note/);
    assert.doesNotMatch(prompt, /LONG-TAIL/, 'long messages are clipped');
    assert.doesNotMatch(prompt, /ANCIENT-DECISION/, 'old messages are spilled');
    assert.doesNotMatch(prompt, /HUGE-TEST-OUTPUT/);
    assert.doesNotMatch(prompt, /DOCUMENT-BODY/);
    assert.match(prompt, /docs\/adr\/0001-scope\.md/);
    assert.ok(prompt.includes(open.id), 'unfinished tasks are always inline');
    assert.match(prompt, /read_project_records/);

    const [messages, tasks, docs, earlier, taskPage] = recalled;
    assert.match(JSON.stringify(messages), /ANCIENT-DECISION/);
    assert.doesNotMatch(JSON.stringify(messages), /FOREIGN-PROJECT-SECRET/);
    assert.deepEqual(messages.missing, [foreign.id]);
    assert.equal(tasks.records[0].id, done[0]);
    assert.match(tasks.records[0].tests[0].output, /HUGE-TEST-OUTPUT/);
    assert.ok(tasks.records[0].tests[0].output.length < 5000, 'recalled evidence is still clipped');
    assert.match(docs.records[0].content, /DOCUMENT-BODY/);
    assert.deepEqual(earlier.records, [], 'nothing precedes the first message');
    assert.equal(taskPage.records.length, 21);
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
