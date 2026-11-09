import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Codex } from '../src/server/codex.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { command } from '../src/server/process.ts';
import { pullRequestBody, pullRequestTitle } from '../src/server/task-naming.ts';
import { devFixture, until } from './dev-fixture.ts';

const template = '## What changed\n\n## How it was tested\n';

/** Give the fixture's origin a gitmoji history and a pull request template. */
async function gitmojiRepository(source: string) {
  const git = (args: string[]) => command('git', args, source);
  await mkdir(join(source, '.github', 'workflows'), { recursive: true });
  await writeFile(join(source, '.github', 'pull_request_template.md'), template);
  await writeFile(
    join(source, '.github', 'workflows', 'ci.yml'),
    [
      'on: push',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: npm ci',
      '      - run: npm test',
    ].join('\n') + '\n',
  );
  await git(['add', '.']);
  await git(['commit', '-m', '🔧 Add CI and PR template']);
  for (const [file, subject] of [
    ['a.txt', '✨ Add greeting'],
    ['b.txt', '🐛 Fix empty greeting'],
    ['c.txt', '📝 Document greeting'],
  ]) {
    await writeFile(join(source, file), `${subject}\n`);
    await git(['add', '.']);
    await git(['commit', '-m', subject]);
  }
  await git(['push', 'origin', 'main']);
}

function deliveringModel(reply: (n: number) => string, worktree: () => string) {
  const instructions: string[] = [];
  const prompts: string[] = [];
  class Model extends Codex {
    override async start() {}
    override async stop() {}
    override async thread(o: Parameters<Codex['thread']>[0]) {
      instructions.push(o.instructions!);
      return 'dev';
    }
    override async turn(_thread: string, prompt: string) {
      prompts.push(prompt);
      await writeFile(join(worktree(), 'change.txt'), `done ${prompts.length}\n`);
      return reply(prompts.length);
    }
  }
  return { Model, instructions, prompts };
}

test('a gitmoji repository with a PR template shapes the Task commit and pull request', async () => {
  const { root, store, project, repo, task, github } = await devFixture('phantom-conventions-');
  github.publishPR = async () => ({}) as never;
  await gitmojiRepository(repo.path);
  const devMessage = '✨ Add change file\n\nWrites the change the Task asked for.';
  const devBody = '## What changed\nAdded change.txt.\n\n## How it was tested\nnode -e 0';
  const model = deliveringModel(
    () =>
      `Done.\n\`\`\`json\n${JSON.stringify({ commitMessage: devMessage, pullRequestBody: devBody })}\n\`\`\``,
    () => store.task(task.id).worktree!,
  );
  const ws = new Workspaces(join(root, 'ws'), store);
  const engine = new Engine(store, github, ws, root, () => new model.Model());
  try {
    const learned = await engine.learnConventions(repo.id);
    const current = store.currentTeamInstructions(project.id);
    assert.equal(current.version, 1);
    assert.equal(current.source, 'team');
    assert.match(current.sections.repository, /#### fixture\/source/);
    assert.match(current.sections.repository, /gitmoji/);
    assert.match(current.sections.repository, /\.github\/pull_request_template\.md/);
    assert.match(current.sections.repository, /npm test/);
    assert.match(learned.summary, /gitmoji/);
    const told = store.list('message').filter((m) => m.role === 'assistant');
    assert.equal(told.at(-1)?.content, learned.summary);

    const prepared = await ws.prepare(task);
    await command('git', ['config', 'user.name', 'Phantom Test'], prepared.worktree!);
    await command('git', ['config', 'user.email', 'test@example.invalid'], prepared.worktree!);
    await engine.start();
    await engine.tick();
    await until(
      () => store.task(task.id).stage === 'reviewing' || store.list('incident').length > 0,
      'Dev finished host validation',
    );
    assert.equal(store.task(task.id).stage, 'reviewing');
    assert.match(model.instructions[0], /gitmoji/);
    assert.match(model.prompts[0], /commitMessage/);
    assert.match(model.prompts[0], /pullRequestBody/);
    const committed = (
      await command('git', ['log', '-1', '--format=%B'], store.task(task.id).worktree!)
    ).stdout.trim();
    assert.equal(committed, devMessage);
    const delivered = store.task(task.id);
    assert.equal(pullRequestTitle(delivered), '✨ Add change file');
    const body = pullRequestBody(delivered);
    assert.ok(body.startsWith(`<!-- phantom-task:${task.id} -->\n${devBody}`), body);
    assert.match(body, /Closes #1/);
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a repository without conventions keeps the default commit and pull request format', async () => {
  const { root, store, project, repo, task, github } = await devFixture('phantom-no-conventions-');
  github.publishPR = async () => ({}) as never;
  // Even a delivery block the Dev volunteers is ignored when there is nothing to follow.
  const model = deliveringModel(
    () =>
      `Done.\n\`\`\`json\n${JSON.stringify({ commitMessage: 'x', pullRequestBody: 'y' })}\n\`\`\``,
    () => store.task(task.id).worktree!,
  );
  const ws = new Workspaces(join(root, 'ws'), store);
  const engine = new Engine(store, github, ws, root, () => new model.Model());
  try {
    const learned = await engine.learnConventions(repo.id);
    assert.equal(store.currentTeamInstructions(project.id).version, 0);
    assert.match(learned.summary, /默认格式/);
    const prepared = await ws.prepare(task);
    await command('git', ['config', 'user.name', 'Phantom Test'], prepared.worktree!);
    await command('git', ['config', 'user.email', 'test@example.invalid'], prepared.worktree!);
    await engine.start();
    await engine.tick();
    await until(
      () => store.task(task.id).stage === 'reviewing' || store.list('incident').length > 0,
      'Dev finished host validation',
    );
    assert.doesNotMatch(model.prompts[0], /commitMessage/);
    const committed = (
      await command('git', ['log', '-1', '--format=%B'], store.task(task.id).worktree!)
    ).stdout.trim();
    assert.equal(committed, `Implement task ${task.id}: Fixture task`);
    assert.equal(pullRequestTitle(store.task(task.id)), 'Fixture task');
    assert.match(pullRequestBody(store.task(task.id)), /## Validation/);
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('learning again replaces only that repository block and keeps the user text', async () => {
  const { root, store, project, repo, github } = await devFixture('phantom-relearn-');
  const engine = new Engine(store, github, new Workspaces(join(root, 'ws'), store), root);
  try {
    await gitmojiRepository(repo.path);
    await engine.learnConventions(repo.id);
    const learned = store.currentTeamInstructions(project.id);
    store.saveTeamInstructions(
      project.id,
      {
        ...learned.sections,
        repository: `Squash before merging.\n\n${learned.sections.repository}`,
      },
      { source: 'user', baseVersion: learned.version },
    );
    const git = (args: string[]) => command('git', args, repo.path);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      await writeFile(join(repo.path, `conv-${n}.txt`), `${n}\n`);
      await git(['add', '.']);
      await git(['commit', '-m', `feat(greeting): step ${n}`]);
    }
    await git(['push', 'origin', 'main']);
    await engine.learnConventions(repo.id);
    const next = store.currentTeamInstructions(project.id);
    assert.equal(next.version, 3);
    assert.match(next.sections.repository, /^Squash before merging\./);
    assert.match(next.sections.repository, /Conventional Commits/);
    assert.doesNotMatch(next.sections.repository, /gitmoji/);
    assert.equal(next.sections.repository.match(/#### fixture\/source/g)?.length, 1);
    // Nothing new to learn: no empty version is appended.
    await engine.learnConventions(repo.id);
    assert.equal(store.currentTeamInstructions(project.id).version, 3);
  } finally {
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the Project page can ask the team to read the repositories again', async () => {
  const { createApp } = await import('../src/server/app.ts');
  const { Previews } = await import('../src/server/preview.ts');
  const { root, store, project, repo, github } = await devFixture('phantom-relearn-http-');
  const ws = new Workspaces(join(root, 'ws'), store);
  const engine = new Engine(store, github, ws, root);
  const app = createApp(store, engine, new Previews(store, ws));
  try {
    const session = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
    const headers = {
      host: '127.0.0.1:4317',
      cookie: String(session.headers['set-cookie']).split(';')[0],
      'x-phantom-csrf': session.json().csrf,
    };
    const empty = store.createProject('Empty', '');
    const none = await app.inject({
      method: 'POST',
      url: `/api/projects/${empty.id}/team-instructions/learn`,
      headers,
    });
    assert.equal(none.statusCode, 400);
    await gitmojiRepository(repo.path);
    const learned = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/team-instructions/learn`,
      headers,
    });
    assert.equal(learned.statusCode, 200, learned.body);
    assert.match(learned.json().summaries[0], /gitmoji/);
    const current = store.currentTeamInstructions(project.id);
    assert.equal(current.source, 'team');
    assert.match(current.sections.repository, /gitmoji/);
  } finally {
    await app.close();
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
