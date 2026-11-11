import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { createServer as createHTTPServer } from 'node:http';
import { chromium } from 'playwright';
import { Store } from '../src/server/store.ts';
import { Engine } from '../src/server/engine.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Previews } from '../src/server/preview.ts';
import { createApp } from '../src/server/app.ts';
import { profileProtocol } from '../tests/profile-protocol.ts';
import { openPage, openSection, openTask } from './browser-pages.ts';
import { choosePreference } from './browser-preferences.ts';
import { legacyCompletionGap } from '../src/shared/task-history.ts';
import { checkReferenceStates } from './browser-reference-states.ts';
import { completionNotice } from '../src/server/delivery-runtime.ts';

export async function checkWorkspace() {
  const store = new Store(':memory:');
  const project = store.createProject('Client workspace', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'Project web',
    path: '/fixture',
    github: 'fixture/workspace',
    defaultBranch: 'main',
    authorized: true,
  });
  const source = store.addMessage(
    project.id,
    'user',
    'Build the onboarding experience',
    'implement',
  );
  const task = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: source.id,
    title: '让首次创建项目更清楚',
    spec: '## 需求说明\n\n保留完整需求与 **Markdown**。',
    acceptance: ['创建完成后显示下一步', '窄屏也能找到项目入口'],
    dependencies: [],
    kind: 'frontend',
    complexity: 'normal',
    priority: 0,
  });
  store.updateTask(task.id, { stage: 'developing', worktree: resolve('.'), devPhase: 'finalize' });
  for (let index = 0; index < 24; index++) {
    const run = store.run('dev', project.id, 'frontend', store.task(task.id));
    store.finishRun(run.id, 'completed');
  }
  for (let index = 0; index < 157; index++)
    store.event('task', `完整历史记录 ${index + 1}`, { projectId: project.id, taskId: task.id });
  for (let index = 0; index < 30; index++) {
    const question = store.addOwnerMessage(
      task.id,
      `历史问题 ${index + 1} ${'原始需求上下文。'.repeat(8)}`,
    );
    store.ownerReply(
      question,
      `历史答复 ${index + 1} ${'完整答复保持可查。'.repeat(10)}`,
      'fixture',
    );
  }
  const live = store.run('dev', project.id, 'frontend', store.task(task.id));
  const ws = new Workspaces(resolve('.phantom/browser-workspace'), store);
  const engine = new Engine(store, new GitHub(store), ws, resolve('.phantom/browser-workspace'));
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer().once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture port');
      probe.close(() => resolve(address.port));
    });
  });
  const app = createApp(store, engine, new Previews(store, ws), port, profileProtocol);
  const origin = await app.listen({ host: '127.0.0.1', port });
  const previewServer = createHTTPServer((_request, response) => response.end('Delivered result'));
  await new Promise<void>((done) => previewServer.listen(0, '127.0.0.1', done));
  const previewAddress = previewServer.address();
  if (!previewAddress || typeof previewAddress === 'string')
    throw new Error('Missing preview port');
  const previewUrl = `http://127.0.0.1:${previewAddress.port}/`;
  const browser = await chromium.launch({
    headless: true,
    channel: process.platform === 'win32' ? 'msedge' : undefined,
  });
  const artifacts = resolve(process.env.PHANTOM_BROWSER_ARTIFACTS ?? 'test-results');
  await mkdir(artifacts, { recursive: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    });
    await context.addInitScript((id) => {
      localStorage.setItem('phantom.project', id);
      localStorage.setItem('phantom.locale', 'zh-CN');
    }, project.id);
    await context.route('**/api/agents/*/models', (route) =>
      route.fulfill({ json: { available: true, models: [] } }),
    );
    await context.route('**/api/agents/*/allowance?*', (route) =>
      route.fulfill({ json: { state: 'unknown' } }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let messages = 0;
    await page.route('**/api/projects/*/messages', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      messages++;
      await route.fulfill({ json: {} });
    });
    await page.goto(origin);
    await page.getByLabel('给 PM 的消息', { exact: true }).waitFor();
    await openTask(page, task.title);
    await page.getByRole('button', { name: '讨论调整', exact: true }).click();
    const draft = page.getByLabel('给 PM 的消息', { exact: true });
    assert.ok((await draft.inputValue()).includes(task.title));
    assert.equal(
      await page.getByRole('button', { name: '聊一聊', exact: true }).getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(messages, 0, 'discussion only prefills, it never sends or authorizes work');
    await page.goBack();
    await page.locator('.task-workspace').waitFor();
    await page.getByRole('region', { name: '和负责人对话', exact: true }).waitFor();
    assert.equal(
      await page.locator('.owner-line').count(),
      60,
      'all owner history remains available',
    );
    const sectionOrder = (actionSelector: string) =>
      page.locator('.task-workspace').evaluate((workspace, selector) => {
        const receipt = workspace.querySelector('.task-receipt-details');
        const action = workspace.querySelector(selector);
        const owner = workspace.querySelector('.owner-conversation');
        return !!(
          receipt &&
          action &&
          owner &&
          receipt.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING &&
          action.compareDocumentPosition(owner) & Node.DOCUMENT_POSITION_FOLLOWING
        );
      }, actionSelector);
    assert.equal(
      await sectionOrder('.task-collaborate'),
      true,
      'receipt, collaboration and owner follow reading order',
    );
    const ownerInput = page.locator('.owner-conversation textarea');
    await ownerInput.scrollIntoViewIfNeeded();
    await ownerInput.focus();
    assert.equal(await ownerInput.evaluate((input) => input === document.activeElement), true);
    await openSection(page, 'task.tab.spec');
    await page.reload();
    await page.getByRole('heading', { name: '需求说明', exact: true }).waitFor();
    await page.goBack();
    await page.locator('.task-workspace').waitFor();
    store.finishRun(live.id, 'completed');
    store.updateTask(task.id, {
      stage: 'done',
      completionDeliveryPending: false,
      head: 'workspace-delivery-head',
    });
    await page.reload();
    await page.getByRole('heading', { name: '体验与反馈', exact: true }).waitFor();
    const experience = page.locator('.task-experience');
    await experience.waitFor();
    assert.equal(
      await sectionOrder('.task-experience'),
      true,
      'receipt, experience and owner follow reading order',
    );
    assert.equal(await experience.getByRole('link').count(), 0);
    assert.equal(await experience.getByRole('button').count(), 1, 'feedback remains available');
    store.transaction(() =>
      store.put('repo', repo.id, {
        ...store.repo(repo.id),
        commands: { ...store.repo(repo.id).commands, start: 'npm run dev', port: 4310 },
      }),
    );
    await page.reload();
    let starts = 0;
    await page.route('**/api/repos/*/preview/start', async (route) => {
      starts++;
      store.transaction(() =>
        store.put('repo', repo.id, { ...store.repo(repo.id), preview: { status: 'starting' } }),
      );
      await route.fulfill({ json: {} });
    });
    assert.equal(await experience.getByRole('link').count(), 0);
    assert.equal(starts, 0, 'opening a delivery never starts a service');
    store.transaction(() =>
      store.put('repo', repo.id, {
        ...store.repo(repo.id),
        preview: { status: 'failed', error: 'Fixture port unavailable' },
      }),
    );
    await page.reload();
    assert.equal(await experience.getByRole('link').count(), 0);
    assert.equal(await experience.getByText('Fixture port unavailable').count(), 0);
    store.transaction(() =>
      store.put('repo', repo.id, {
        ...store.repo(repo.id),
        preview: {
          status: 'running',
          url: previewUrl,
          revision: 'workspace-preview-revision',
          taskHeads: ['workspace-delivery-head'],
        },
      }),
    );
    await page.reload();
    assert.equal(
      await experience.getByRole('link', { name: '打开预览', exact: true }).getAttribute('href'),
      previewUrl,
    );
    const opened = context.waitForEvent('page');
    await experience.getByRole('link', { name: '打开预览', exact: true }).click();
    const resultPage = await opened;
    await resultPage.getByText('Delivered result', { exact: true }).waitFor();
    await resultPage.close();
    await experience.getByRole('button', { name: '提反馈', exact: true }).click();
    assert.ok((await draft.inputValue()).includes(task.title));
    assert.equal(
      await page
        .getByRole('button', { name: '体验反馈', exact: true })
        .getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(messages, 0, 'feedback remains an unsent draft');
    await page.goBack();
    await page.getByText('体验与反馈', { exact: true }).waitFor();
    await page.locator('.task-controls > summary').click();
    await page.getByRole('button', { name: '撤销这次交付', exact: true }).click();
    assert.equal(
      await page
        .getByRole('button', { name: '交给 PM 做', exact: true })
        .getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(messages, 0);
    await page.goBack();
    for (const state of ['delivered', 'delivered-no-preview', 'checking'] as const) {
      if (state === 'delivered-no-preview')
        store.patchRepo(repo.id, { preview: { status: 'stopped' } });
      if (state === 'checking') {
        store.updateTask(task.id, { stage: 'developing' });
        store.run('dev', project.id, 'frontend', store.task(task.id));
      }
      await page.reload();
      await page.locator('.task-workspace').waitFor();
      for (const locale of ['zh-CN', 'en'] as const) {
        await choosePreference(page, 'language', locale);
        for (const theme of ['dark', 'light'] as const) {
          await choosePreference(page, 'theme', theme);
          for (const width of [1280, 390]) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
            await page.locator('.task-page').evaluate((el) => {
              el.scrollTop = 0;
            });
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              true,
              `${state} ${width} ${locale} ${theme}`,
            );
            assert.equal(
              await page.locator('.task-page').evaluate((el) => el.scrollWidth <= el.clientWidth),
              true,
            );
            const owner = await page.locator('.owner-conversation').boundingBox();
            assert.ok(
              owner && owner.height < 700,
              'long owner history does not stretch the work page',
            );
            await page.screenshot({
              path: resolve(artifacts, `client-workspace-${state}-${width}-${locale}-${theme}.png`),
            });
          }
        }
      }
    }
    await choosePreference(page, 'language', 'zh-CN');
    await openPage(page, 'project');
    assert.equal(await page.locator('.preview-row').count(), 0);
    assert.equal(await page.getByRole('button', { name: /启动.*体验|停止.*体验/ }).count(), 0);
    assert.equal(await (await fetch(previewUrl)).text(), 'Delivered result');
    assert.equal(starts, 0, 'day-to-day navigation leaves the existing service alone');
    await openTask(page, task.title);
    await openSection(page, 'task.tab.process');
    await page.locator('.task-process .event-record').first().waitFor();
    assert.equal(
      store.snapshot().events.filter((event) => event.taskId === task.id).length >= 157,
      true,
    );
    assert.equal(store.snapshot().runs.filter((run) => run.taskId === task.id).length >= 24, true);
    while (await page.locator('.task-process .record-more').count())
      await page.locator('.task-process .record-more').first().click();
    await page.getByText('完整历史记录 1', { exact: true }).waitFor();
    await page.getByText('完整历史记录 157', { exact: true }).waitFor();
    await openSection(page, 'task.tab.overview');
    for (const run of store.activeRuns()) store.finishRun(run.id, 'completed');
    store.updateTask(task.id, { stage: 'developing', control: 'paused', pausedByUser: true });
    await page.reload();
    await page.getByRole('heading', { name: '你暂停了这项工作', exact: true }).waitFor();
    await page.locator('.task-controls > summary').click();
    await page.getByRole('button', { name: '恢复任务', exact: true }).waitFor();
    await page.getByRole('button', { name: '取消任务', exact: true }).waitFor();
    await page.getByRole('button', { name: '换一位开发接手', exact: true }).waitFor();
    store.updateTask(task.id, {
      pausedByUser: false,
      blocked: 'The team is checking a fixture failure',
    });
    await page.reload();
    await page.getByRole('heading', { name: '团队受阻', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('heading', { name: '有个决定需要你', exact: true }).count(),
      0,
    );
    const incident = store.createIncident({
      projectId: project.id,
      taskId: task.id,
      phase: 'sync',
      message: '是否保留原来的入口？',
      evidence: 'Synthetic product choice',
    });
    store.transaction(() =>
      store.put('incident', incident.id, {
        ...incident,
        status: 'waiting_user',
        descriptor: { code: 'incident_waiting_user' },
      }),
    );
    await page.reload();
    await page.getByRole('heading', { name: '有个决定需要你', exact: true }).waitFor();
    await page
      .locator('.task-decisions')
      .getByText('是否保留原来的入口？', { exact: true })
      .waitFor();
    store.updateTask(task.id, {
      stage: 'done',
      completionDeliveryPending: false,
      blocked: legacyCompletionGap,
    });
    store.transaction(() =>
      store.put('incident', incident.id, {
        ...incident,
        status: 'waiting_user',
        message: legacyCompletionGap,
      }),
    );
    await page.reload();
    await page.locator('.task-status-group').getByText('已交付', { exact: true }).waitFor();
    assert.equal(
      await page.locator('.task-decisions').count(),
      0,
      'historical completion problems are not new decisions',
    );
    await page.locator('.historical-completion').waitFor();
    if (!(await page.locator('.task-receipt-details').evaluate((el) => el.hasAttribute('open'))))
      await page.locator('.task-receipt-details > summary').click();
    await page.getByRole('region', { name: '交付回执', exact: true }).waitFor();
    store.updateTask(task.id, { stage: 'reviewing', control: 'active', blocked: undefined });
    store.transaction(() =>
      store.put('incident', incident.id, { ...incident, status: 'resolved' }),
    );
    await page.reload();
    await page.getByRole('heading', { name: '等待独立评审', exact: true }).waitFor();
    const review = store.run('review', project.id, 'review', store.task(task.id));
    await page.reload();
    await page.getByRole('heading', { name: '正在独立评审', exact: true }).waitFor();
    store.finishRun(review.id, 'completed');
    const queued = store.createTask({
      projectId: project.id,
      repoId: repo.id,
      sourceMessageId: source.id,
      title: '还未接手的需求',
      spec: 'Queued fixture',
      acceptance: [],
      dependencies: [],
      kind: 'frontend',
      complexity: 'normal',
      priority: 0,
    });
    await openTask(page, queued.title);
    await page.getByRole('heading', { name: '等待开发接手', exact: true }).waitFor();
    await page.getByRole('heading', { name: '还没有负责人对话', exact: true }).waitFor();
    assert.equal(
      await page.locator('.owner-compose, .task-experience').count(),
      0,
      'queued work has no fake owner or delivery',
    );
    store.updateTask(queued.id, { stage: 'cancelled' });
    await page.reload();
    await page.locator('.task-status-group').getByText('已取消', { exact: true }).waitFor();
    assert.equal(
      await page.locator('.task-experience').count(),
      0,
      'cancelled work offers no delivery preview',
    );
    await openPage(page, 'work');
    await checkReferenceStates(page, store, store.task(task.id), artifacts);
    const notice = await completionNotice(
      { ...store.task(task.id), stage: 'done' },
      store.repo(repo.id),
      { kind: 'checkout', source: process.cwd() },
    );
    const delivery = store.addMessage(project.id, 'assistant', notice.content);
    store.updateMessage(delivery.id, { descriptor: notice.descriptor });
    await page.goto(`${origin}/#/p/${project.id}`);
    await choosePreference(page, 'language', 'zh-CN');
    const notification = page.locator(`#message-${delivery.id} .message-content`);
    await notification.getByText(`已交付「${task.title}」。`, { exact: false }).waitFor();
    await choosePreference(page, 'language', 'en');
    await notification.getByText(`Delivered “${task.title}”.`, { exact: false }).waitFor();
    assert.doesNotMatch(await notification.innerText(), /preview|running application|体验环境/);
    assert.deepEqual(errors, []);
    console.log(
      'Client workspace: verified previews, feedback, bilingual delivery and history passed.',
    );
  } finally {
    await browser.close();
    await app.close();
    await new Promise<void>((done, fail) =>
      previewServer.close((error) => (error ? fail(error) : done())),
    );
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await checkWorkspace();
