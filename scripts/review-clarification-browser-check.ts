import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Store } from '../src/server/store.ts';
import { Engine } from '../src/server/engine.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Previews } from '../src/server/preview.ts';
import { createApp } from '../src/server/app.ts';

/** Real HTTP answers with the same Clarification card in Project and Task views. */
export async function checkReviewClarification() {
  const root = await mkdtemp(join(tmpdir(), 'phantom-review-browser-'));
  const store = new Store(join(root, 'db.sqlite'));
  const project = store.createProject('Review clarification', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'fixture',
    path: root,
    github: 'fixture/review',
    defaultBranch: 'main',
    authorized: true,
  });
  const source = store.addMessage(project.id, 'user', 'Implement retention', 'implement');
  store.updateMessage(source.id, { status: 'completed', draftStatus: 'completed' });
  const task = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: source.id,
    title: 'Retention policy task',
    spec: 'Retain audit records',
    acceptance: ['Honor user retention policy'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  const pinned = store.updateTask(task.id, {
    stage: 'reviewing',
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    tests: [{ command: 'test', exitCode: 0, output: '', head: 'a'.repeat(40), at: '2026-01-01' }],
  });
  const run = store.run('review', project.id, 'review', pinned, { reviewAxis: 'primary' });
  const clarification = store.recordReviewClarification(run.id, {
    approved: false,
    verdict: 'needs_user',
    summary: 'Retention policy missing',
    findings: [],
    head: pinned.head,
    base: pinned.base,
    questions: [
      { question: 'How long must audit records be retained?' },
      { question: 'Who may read the archive?' },
    ],
  });
  const ws = new Workspaces(join(root, 'workspaces'), store);
  const engine = new Engine(store, new GitHub(store), ws, root);
  const app = createApp(store, engine, new Previews(store, ws), 4329);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 4329 });
    browser = await chromium.launch({
      headless: true,
      channel: process.platform === 'win32' ? 'msedge' : undefined,
    });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 900 },
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // The host serves the built UI itself, as in the main check, so 5173 stays free for `npm run dev`.
    await page.goto('http://127.0.0.1:4329');
    const projectCard = page.locator('.conversation-content .clarification-card');
    await projectCard.getByText('需要用户', { exact: true }).waitFor();
    await projectCard
      .getByText('How long must audit records be retained?', { exact: true })
      .waitFor();
    assert.ok((await projectCard.innerText()).includes(pinned.head!));
    await projectCard.getByRole('button', { name: task.title, exact: true }).click();
    const dialog = page.getByRole('dialog');
    const card = dialog.locator('.clarification-card');
    await card.getByText('Who may read the archive?', { exact: true }).waitFor();
    await card.locator('textarea').first().fill('保留七年');
    await card.getByRole('button', { name: '提交已填写的回答', exact: true }).click();
    assert.equal(store.get('clarification', clarification.id)?.status, 'open');
    await card.locator('textarea').last().fill('仅限管理员');
    await card.getByRole('button', { name: '提交已填写的回答', exact: true }).click();
    await card.getByText('已回答', { exact: true }).waitFor();
    await card
      .getByText('答案已保存，将作为固定版本复审的输入；仍需评审通过。', { exact: true })
      .waitFor();
    assert.equal(await card.locator('textarea').first().inputValue(), '保留七年');
    assert.equal(await card.locator('textarea').last().isDisabled(), true);
    await page.keyboard.press('Escape');
    await projectCard.getByText('已回答', { exact: true }).waitFor();
    assert.deepEqual(
      store.get('clarification', clarification.id)?.answers?.map((a) => a.value),
      ['保留七年', '仅限管理员'],
    );
    assert.equal(store.task(task.id).control, 'paused');
    assert.equal(store.task(task.id).retries, 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await app.close();
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}
