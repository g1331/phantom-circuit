import assert from 'node:assert/strict';
import { checkTyping } from './composer-browser-check.ts';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Store } from '../src/server/store.ts';
import { createServer } from 'vite';
import { stageLabels, type Stage } from '../src/shared/types.ts';

// Browser-only fixtures: no live database, repository work switch or model calls.
export async function checkUsability() {
  const store = new Store(':memory:');
  const project = store.createProject('UI fixture', '用户内容 stays unchanged');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'fixture-repo',
    path: '/fixture',
    github: 'fixture/repo',
    authorized: true,
    defaultBranch: 'main',
  });
  const source = store.addMessage(project.id, 'user', 'Original 用户内容', 'implement');
  const task = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: source.id,
    title: 'Persistent task',
    spec: '## Original markdown\n\n**用户内容**',
    acceptance: ['Visible result'],
    dependencies: [],
    kind: 'frontend',
    complexity: 'normal',
    priority: 0,
  });
  for (const stage of Object.keys(stageLabels) as Stage[]) {
    const item = store.createTask({
      projectId: project.id,
      repoId: repo.id,
      sourceMessageId: source.id,
      title: `Stage ${stage}`,
      spec: 'Original specification',
      acceptance: ['Visible result'],
      dependencies: [task.id],
      kind: 'frontend',
      complexity: 'normal',
      priority: 5,
    });
    store.updateTask(item.id, {
      stage,
      control: stage === 'developing' ? 'paused' : 'active',
      blocked: stage === 'reviewing' ? 'Dependency blocked' : undefined,
    });
  }
  const secondProject = store.createProject('Second project', 'Second project content');
  const conversationProject = store.createProject('Conversation fixture', 'Long conversation');
  for (let index = 1; index <= 50; index++) {
    const input = store.addMessage(conversationProject.id, 'user', `Question ${index}`, 'discuss');
    const run = store.run('pm', conversationProject.id, 'pm', { sourceMessageId: input.id });
    store.addMessage(
      conversationProject.id,
      'assistant',
      `Intermediate ${index}`,
      undefined,
      undefined,
      { runId: run.id },
    );
    store.activity(run, 'command', {
      kind: 'command',
      title: '执行命令',
      status: 'completed',
      details: { command: `echo step-${index}`, output: `Output ${index}` },
    });
    store.addMessage(
      conversationProject.id,
      'assistant',
      `Final answer ${index}\n\n${'Readable **answer** with [a link](https://example.com).\n\n'.repeat(20)}`,
      undefined,
      undefined,
      { runId: run.id, sourceMessageId: input.id },
    );
    store.finishRun(run.id, 'completed');
  }
  const pendingInput = store.addMessage(
    conversationProject.id,
    'user',
    'Latest question',
    'discuss',
  );
  const pendingRun = store.run('pm', conversationProject.id, 'pm', {
    sourceMessageId: pendingInput.id,
  });
  store.activity(pendingRun, 'live', {
    kind: 'command',
    title: 'Live command',
    status: 'running',
    details: { command: 'npm run check' },
  });
  for (let index = 0; index < 24; index++) {
    store.addMessage(
      project.id,
      'assistant',
      `## Message ${index}\n\nOriginal user content.\n\n- Readable detail\n- More detail`,
    );
    const run = store.run('pm', project.id, 'pm');
    store.finishRun(run.id, 'completed');
  }
  const server = await createServer({
    server: { host: '127.0.0.1', port: 4329, strictPort: true },
  });
  await server.listen();
  const browser = await chromium.launch({
    headless: true,
    channel: process.platform === 'win32' ? 'msedge' : undefined,
  });
  const page = await browser.newPage({
    viewport: { width: 1366, height: 768 },
    locale: 'zh-CN',
    reducedMotion: 'reduce',
  });
  const errors: string[] = [];
  page.setDefaultTimeout(8000);
  // Cold Vite module loading is separate from the UI behavior assertion budget.
  page.setDefaultNavigationTimeout(60_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(`(() => {
    class FixtureEvents extends EventTarget {
      onerror = null;
      changed = () => this.dispatchEvent(new MessageEvent('change', { data: '{}' }));
      constructor() { super(); window.addEventListener('fixture-change', this.changed); setTimeout(() => this.dispatchEvent(new MessageEvent('ready')), 0); }
      close() { window.removeEventListener('fixture-change', this.changed); }
    }
    Object.defineProperty(window, 'EventSource', { value: FixtureEvents });
  })()`);
  const auditModels = [
    { id: 'config-required', provider: 'fixture', reasoningEfforts: ['low', 'high'] },
  ];
  await page.route('**/api/agents/*/models', (route) =>
    route.fulfill({ json: { models: auditModels, available: true } }),
  );
  await page.route('**/api/providers/*/models', (route) =>
    route.fulfill({ json: { models: auditModels, ok: true } }),
  );
  await page.route('**/api/providers', (route) =>
    route.fulfill({
      json: [
        ...store.snapshot().providers,
        {
          id: 'ui-provider',
          kind: 'custom',
          name: 'UI provider',
          baseUrl: 'https://example.invalid/v1',
          hasKey: false,
        },
      ],
    }),
  );
  await page.route('**/api/session', (route) => route.fulfill({ json: { csrf: 'fixture' } }));
  await page.route('**/api/agents/*/allowance?*', (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      json: {
        agentKind: url.pathname.split('/')[3],
        providerId: url.searchParams.get('providerId'),
        state: 'unknown',
        capturedAt: '2026-09-21T10:00:00Z',
      },
    });
  });
  await page.route('**/api/tasks/*/usage', (route) =>
    route.fulfill({
      json: {
        usage: {},
        cost: null,
        runs: [],
        coverage: { available: 0, total: 0 },
        durationMs: 0,
        elapsedMs: null,
      },
    }),
  );
  let stateGate: Promise<void> | undefined;
  let stateStarted: (() => void) | undefined;
  await page.route('**/api/state', async (route) => {
    const snapshot = store.snapshot();
    const gate = stateGate;
    stateGate = undefined;
    stateStarted?.();
    if (gate) await gate;
    await route.fulfill({ json: snapshot });
  });
  await page.route('**/api/events', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: 'event: ready\ndata: {}\n\n' }),
  );
  let hold: Promise<void> | undefined;
  let started: (() => void) | undefined;
  let fail = false;
  await page.route('**/api/projects/*/scheduling', async (route) => {
    const id = route.request().url().split('/').at(-2)!;
    const result = {
      projectId: id,
      at: '2026-09-21T10:00:00Z',
      projectOrder: [id],
      candidates: id === project.id ? [task.id] : [],
      tasks:
        id === project.id
          ? [
              {
                taskId: task.id,
                title: store.task(task.id).title,
                priority: 0,
                stage: 'ready',
                reasons: [],
              },
            ]
          : [],
    };
    if (id === project.id) {
      started?.();
      if (hold) await hold;
    }
    await route.fulfill(
      fail ? { status: 503, json: { error: 'Fixture request failed' } } : { json: result },
    );
  });
  try {
    await mkdir(resolve('test-results'), { recursive: true });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('http://127.0.0.1:4329', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Conversation fixture', exact: true }).click();
    await page.getByLabel('外观', { exact: true }).selectOption('system');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.getByLabel('外观', { exact: true }).selectOption('light');
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.equal(
      await page.getByLabel('外观', { exact: true }).inputValue(),
      'light',
      'explicit theme survives reload',
    );
    const firstProcess = page.locator('.pm-process').first();
    const liveProcess = page.locator(`.pm-process[data-run-id="${pendingRun.id}"]`);
    await liveProcess.locator(':scope > summary').waitFor();
    await checkTyping(page);
    assert.equal(await liveProcess.evaluate((el: HTMLDetailsElement) => el.open), true);
    assert.equal(await firstProcess.evaluate((el: HTMLDetailsElement) => el.open), false);
    assert.equal(
      await page.getByText('Intermediate 1', { exact: true }).isVisible(),
      false,
      'completed intermediate prose folds with the tools',
    );
    assert.equal(
      await page.getByText(/^Final answer 1\b/).isVisible(),
      true,
      'final answer is retained',
    );
    await page.getByRole('button', { name: '跳转到第 1 轮', exact: true }).focus();
    await page.getByRole('tooltip').getByText('Question 1', { exact: true }).waitFor();
    await page.keyboard.press('Enter');
    await firstProcess.locator(':scope > summary').click();
    assert.equal(await page.getByText('Intermediate 1', { exact: true }).isVisible(), true);
    const firstQuestion = page
      .getByRole('region', { name: '与 PM 讨论', exact: true })
      .getByText('Question 1', { exact: true });
    const before = await firstQuestion.boundingBox();
    store.finishRun(pendingRun.id, 'completed');
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-change')));
    await page.waitForFunction(
      (id) =>
        document.querySelector(`.pm-process[data-run-id="${id}"]`)?.getAttribute('data-status') ===
        'completed',
      pendingRun.id,
    );
    assert.equal(
      await liveProcess.evaluate((el: HTMLDetailsElement) => el.open),
      false,
      'offscreen normal completion auto-collapses',
    );
    assert.equal(
      await firstProcess.evaluate((el: HTMLDetailsElement) => el.open),
      true,
      'manual expansion survives refresh',
    );
    const after = await firstQuestion.boundingBox();
    assert.ok(
      before && after && Math.abs(before.y - after.y) < 2,
      'history reading position is stable',
    );
    await page.screenshot({
      animations: 'disabled',
      path: resolve('test-results', 'conversation-navigation-light.png'),
    });
    await page.getByLabel('外观', { exact: true }).selectOption('dark');
    await page.screenshot({
      animations: 'disabled',
      path: resolve('test-results', 'conversation-navigation-dark.png'),
    });
    const readingInput = store.addMessage(
      conversationProject.id,
      'user',
      'Reading a live reply',
      'discuss',
    );
    const readingRun = store.run('pm', conversationProject.id, 'pm', {
      sourceMessageId: readingInput.id,
    });
    store.addMessage(
      conversationProject.id,
      'assistant',
      'Live explanation being read',
      undefined,
      undefined,
      { runId: readingRun.id },
    );
    store.activity(readingRun, 'read', {
      kind: 'search',
      title: '搜索资料',
      status: 'running',
      details: { summary: 'Relevant evidence' },
    });
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-change')));
    await page.getByRole('button', { name: '跳转到第 52 轮', exact: true }).click();
    const liveExplanation = page
      .getByRole('region', { name: '与 PM 讨论', exact: true })
      .getByText('Live explanation being read', { exact: true });
    await liveExplanation.scrollIntoViewIfNeeded();
    store.addMessage(
      conversationProject.id,
      'assistant',
      'New final answer',
      undefined,
      undefined,
      { runId: readingRun.id },
    );
    store.finishRun(readingRun.id, 'completed');
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-change')));
    await page.getByText('New final answer', { exact: true }).waitFor();
    assert.equal(
      await liveExplanation.isVisible(),
      true,
      'a reply moving into a completed process stays visible while being read',
    );
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 500 });
    await page.getByRole('button', { name: '对话目录', exact: true }).click();
    const directory = page.getByRole('dialog', { name: '对话目录' });
    await directory.getByRole('button', { name: '50 Question 50', exact: true }).click();
    await directory.waitFor({ state: 'hidden' });
    assert.ok(
      await page
        .getByRole('region', { name: '与 PM 讨论', exact: true })
        .getByText('Question 50', { exact: true })
        .isVisible(),
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({
      animations: 'disabled',
      path: resolve('test-results', 'conversation-navigation-mobile.png'),
    });
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.getByRole('button', { name: 'UI fixture', exact: true }).click();
    await page.getByRole('tab', { name: '任务' }).click();
    await page.locator('.claim-order time').waitFor();
    assert.equal(
      await page.locator('.board-column').count(),
      7,
      'board is the default and contains every stage',
    );
    const unchanged = JSON.stringify(store.snapshot());
    const expectedTitles = await page.locator('.task-card strong').allTextContents();
    await page.getByRole('button', { name: '列表', exact: true }).click();
    assert.deepEqual(
      (await page.locator('.task-row-main strong').allTextContents()).sort(),
      expectedTitles.sort(),
    );
    await page.reload();
    await page.getByRole('tab', { name: '任务' }).click();
    assert.equal(
      await page.getByRole('button', { name: '列表', exact: true }).getAttribute('aria-pressed'),
      'true',
    );
    for (const stage of Object.keys(stageLabels)) {
      await page.getByLabel('任务状态筛选').selectOption(stage);
      assert.equal(await page.locator('.task-row').count(), stage === 'ready' ? 2 : 1);
    }
    await page.getByLabel('任务状态筛选').selectOption('active');
    assert.equal(await page.locator('.task-row').count(), 6);
    await page.getByLabel('任务状态筛选').selectOption('all');
    await page.getByLabel('执行状态筛选').selectOption('paused');
    assert.equal(await page.locator('.task-row').count(), 1);
    await page.getByRole('button', { name: '看板', exact: true }).click();
    assert.equal(await page.locator('.task-card').count(), 1);
    await page.getByLabel('搜索任务').fill('developing');
    await page.locator('.task-card').focus();
    await page.keyboard.press('Enter');
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByLabel('搜索任务').inputValue(), 'developing');
    await page.getByLabel('执行状态筛选').selectOption('all');
    await page.getByLabel('搜索任务').fill('');
    assert.equal(
      JSON.stringify(store.snapshot()),
      unchanged,
      'view and filters must not mutate server state',
    );
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    await page.locator('.claim-order button').click();
    await Promise.race([
      requested,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Manual refresh request missing')), 8000),
      ),
    ]);
    try {
      assert.equal(
        await page.locator('.claim-order time').count(),
        1,
        'background refresh must retain the last successful schedule',
      );
    } finally {
      release();
      hold = undefined;
    }
    await page.getByLabel('搜索任务').fill('Persistent');
    const stableToolbar = await page.locator('.list-toolbar').boundingBox();
    const stableScroll = await page
      .locator('.task-workspace')
      .evaluate((element) => element.scrollTop);
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const background = new Promise<void>((resolve) => {
      started = resolve;
    });
    store.updateTask(task.id, { title: 'Persistent task updated' });
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-change')));
    await Promise.race([
      background,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Background refresh request missing')), 8000),
      ),
    ]);
    assert.equal(await page.locator('.claim-order time').count(), 1);
    assert.equal(
      await page.getByText('正在更新，显示上次成功结果', { exact: true }).count(),
      0,
      'background refresh must not flash transient text in the task workspace',
    );
    assert.equal(
      (await page.locator('.list-toolbar').boundingBox())?.y,
      stableToolbar?.y,
      'refresh must not collapse the schedule or move filters',
    );
    assert.equal(
      await page.locator('.task-workspace').evaluate((element) => element.scrollTop),
      stableScroll,
    );
    assert.equal(
      await page.getByLabel('搜索任务').evaluate((element) => element === document.activeElement),
      true,
    );
    await page
      .locator('.task-card strong')
      .getByText('Persistent task updated', { exact: true })
      .waitFor();
    release();
    hold = undefined;
    await page.locator('.task-card').click();
    await page.locator('.claim-conditions').waitFor();
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const detailRefresh = new Promise<void>((resolve) => {
      started = resolve;
    });
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-change')));
    await Promise.race([
      detailRefresh,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Detail refresh missing')), 8000),
      ),
    ]);
    assert.equal(
      await page.locator('.claim-conditions').count(),
      1,
      'detail conditions remain during unrelated state changes',
    );
    await page.screenshot({ path: resolve('test-results', 'usability-detail-refresh.png') });
    release();
    hold = undefined;
    await page.keyboard.press('Escape');
    fail = true;
    await page.locator('.claim-order button').click();
    await page.locator('.claim-order [role="alert"]').waitFor();
    assert.equal(await page.locator('.claim-order time').count(), 1);
    await page.getByText('更新失败，显示上次成功结果', { exact: true }).waitFor();
    fail = false;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recoveringSchedule = new Promise<void>((resolve) => {
      started = resolve;
    });
    await page.locator('.claim-order button').click();
    await Promise.race([
      recoveringSchedule,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Recovery refresh request missing')), 8000),
      ),
    ]);
    assert.equal(
      await page.getByText('更新失败，显示上次成功结果', { exact: true }).isVisible(),
      true,
      'a refresh error stays visible until a successful response replaces it',
    );
    release();
    hold = undefined;
    await page.locator('.claim-order [role="alert"]').waitFor({ state: 'hidden' });
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const oldProjectRequest = new Promise<void>((resolve) => {
      started = resolve;
    });
    await page.locator('.claim-order button').click();
    await Promise.race([
      oldProjectRequest,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Project request missing')), 8000),
      ),
    ]);
    await page.locator('.project-link').filter({ hasText: secondProject.name }).click();
    await page.locator('.claim-order time').waitFor();
    assert.equal((await page.locator('.claim-order').innerText()).includes(project.name), false);
    release();
    hold = undefined;
    await page.waitForTimeout(100);
    assert.equal((await page.locator('.claim-order').innerText()).includes(project.name), false);
    await page.locator('.project-link').filter({ hasText: project.name }).click();
    await page.getByLabel('搜索任务').fill('');
    let releaseState!: () => void;
    stateGate = new Promise<void>((resolve) => {
      releaseState = resolve;
    });
    const staleStateRequest = new Promise<void>((resolve) => {
      stateStarted = resolve;
    });
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-change')));
    await Promise.race([
      staleStateRequest,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('State refresh missing')), 8000),
      ),
    ]);
    store.updateTask(task.id, { title: 'Latest task revision' });
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-change')));
    await page
      .locator('.task-card strong')
      .getByText('Latest task revision', { exact: true })
      .waitFor();
    releaseState();
    await page.waitForTimeout(100);
    assert.equal(
      await page
        .locator('.task-card strong')
        .getByText('Latest task revision', { exact: true })
        .count(),
      1,
      'late state responses must not overwrite newer state',
    );
    await page.locator('.sidebar .language-control select').selectOption('en');
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.equal(await page.title(), 'Phantom Circuit · Local workspace');
    await page.getByRole('button', { name: 'Board', exact: true }).waitFor();
    await page.getByLabel('Filter task status').selectOption('reviewing');
    assert.equal(await page.locator('.board-column').count(), 1);
    await page.getByLabel('Filter task status').selectOption('all');
    await page.reload();
    await page.getByRole('tab', { name: 'Tasks' }).click();
    assert.equal(
      await page.getByRole('button', { name: 'Board', exact: true }).getAttribute('aria-pressed'),
      'true',
    );
    await mkdir(resolve('test-results'), { recursive: true });
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 1366, height: 768 },
      { width: 390, height: 844 },
      { width: 390, height: 500 },
    ]) {
      await page.setViewportSize(viewport);
      for (const theme of ['dark', 'light']) {
        if ((await page.locator('html').getAttribute('data-theme')) !== theme)
          await page.locator('.theme-control select').selectOption(theme);
        for (const view of ['Discuss with PM', 'Tasks', 'Runs']) {
          await page.getByRole('tab', { name: view, exact: view !== 'Tasks' }).click();
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
            `${viewport.width} ${view} page width`,
          );
          if (viewport.width > 660) {
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1),
              true,
              `${view} must fit desktop height`,
            );
            if (view === 'Discuss with PM') {
              const composer = await page.locator('.composer').boundingBox();
              assert.ok(composer && composer.y + composer.height <= viewport.height);
              assert.equal(
                await page
                  .locator('.conversation')
                  .evaluate((el) => el.scrollHeight > el.clientHeight),
                true,
              );
            }
          }
          if (view === 'Tasks') {
            await page.locator('.task-board').scrollIntoViewIfNeeded();
            await page.locator('.task-board').focus();
            await page.keyboard.press('End');
            await page.locator('.task-card').last().focus();
            await page.keyboard.press('Enter');
            await page.getByRole('dialog').waitFor();
            await page.keyboard.press('Escape');
            await page.locator('.task-board').evaluate((el) => {
              el.scrollLeft = 0;
            });
            await page.locator('.board-column h3').first().scrollIntoViewIfNeeded();
            await page.locator('.task-workspace').evaluate((element) => {
              element.scrollTop = 0;
            });
            const claimBox = await page.locator('.claim-order').boundingBox();
            const searchBox = await page.getByLabel('Search tasks').boundingBox();
            const cardBox = await page.locator('.task-card').first().boundingBox();
            assert.ok(
              claimBox &&
                searchBox &&
                cardBox &&
                Math.abs(claimBox.x - searchBox.x) < 1 &&
                Math.abs(cardBox.x - searchBox.x) < 1,
              'claim order, filters and first board card share the same page gutter after scrolling',
            );
          } else if (view === 'Discuss with PM') {
            await page.getByLabel('Message to PM').focus();
            await page.locator('.composer').scrollIntoViewIfNeeded();
          }
          await page.screenshot({
            path: resolve(
              'test-results',
              `usability-${viewport.width}x${viewport.height}-${theme}-${view.split(' ')[0]}.png`,
            ),
          });
        }
      }
    }
    async function captureModal(name: string, width: number, theme: string) {
      const modal = page.locator('.modal');
      await modal.waitFor();
      const header = await modal.locator('header').boundingBox();
      const firstField = modal.locator('.modal-body .form label').first();
      if (await firstField.count()) {
        const label = await firstField.boundingBox();
        const title = await modal.locator('header h2').boundingBox();
        assert.ok(
          label && title && Math.abs(label.x - title.x) < 1,
          'modal fields align with the header',
        );
      }
      await modal.locator('.modal-body').evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const scrolledHeader = await modal.locator('header').boundingBox();
      assert.ok(
        header && scrolledHeader && Math.abs(header.y - scrolledHeader.y) < 1,
        'modal header and close control stay visible while its body scrolls',
      );
      assert.equal(
        await modal.evaluate((element) => element.scrollWidth <= element.clientWidth),
        true,
      );
      await modal.locator('.modal-body').evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({
        path: resolve('test-results', `audit-${name}-${width}-${theme}.png`),
      });
      await modal.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await modal.waitFor({ state: 'detached' });
    }
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      for (const theme of ['light', 'dark']) {
        await page.locator('.theme-control select').selectOption(theme);
        await page.getByRole('button', { name: 'New project', exact: true }).click();
        await captureModal('new-project', width, theme);
        await page.locator('.context-trigger').click();
        await page.locator('#project-context').waitFor();
        const contextHeader = await page.locator('.context-heading').boundingBox();
        await page.locator('#project-context').evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        const scrolledContextHeader = await page.locator('.context-heading').boundingBox();
        assert.ok(
          contextHeader &&
            scrolledContextHeader &&
            Math.abs(contextHeader.y - scrolledContextHeader.y) < 1,
          'project overview keeps its title and close control visible while scrolling',
        );
        await page.locator('#project-context').evaluate((element) => {
          element.scrollTop = 0;
        });
        await page.screenshot({
          path: resolve('test-results', `audit-project-overview-${width}-${theme}.png`),
        });
        await page.getByRole('button', { name: 'Configure fixture-repo', exact: true }).click();
        await captureModal('repository-commands', width, theme);
        await page
          .locator('#project-context')
          .getByRole('button', { name: 'Connect repository', exact: true })
          .click();
        await captureModal('connect-repository', width, theme);
        await page.locator('.context-trigger').click();
        await page
          .locator('#project-context')
          .getByRole('button', { name: 'Project model settings', exact: true })
          .click();
        await captureModal('project-settings', width, theme);
        await page.getByRole('button', { name: 'Runtime settings', exact: true }).click();
        await captureModal('global-settings', width, theme);
        await page.getByRole('button', { name: 'Runtime settings', exact: true }).click();
        await page.locator('.provider-group > summary').click();
        await page.getByLabel('Select provider', { exact: true }).selectOption('ui-provider');
        await captureModal('provider-settings', width, theme);
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
    store.close();
  }
}

if (process.argv[1]?.endsWith('usability-browser-check.ts')) await checkUsability();
