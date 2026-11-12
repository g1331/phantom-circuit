import { choosePreference, settingsPage } from './browser-preferences.ts';
import assert from 'node:assert/strict';
import { checkTyping } from './composer-browser-check.ts';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Store } from '../src/server/store.ts';
import { createServer } from 'vite';
import { stageLabels, type Stage } from '../src/shared/types.ts';
import { clickInSidebar, closeDrawer, openDrawer, openPage, openTask } from './browser-pages.ts';

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
      `Final answer ${index}\n\n` +
        'Readable **answer** with [a link](https://example.com).\n\n'.repeat(20),
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
      constructor() {
        super();
        window.addEventListener('fixture-change', this.changed);
        setTimeout(() => this.dispatchEvent(new MessageEvent('ready')), 0);
      }
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
  await page.route(`**/api/repos/${repo.id}`, (route) => {
    assert.equal(route.request().method(), 'PATCH');
    const { enabled } = route.request().postDataJSON();
    assert.equal(typeof enabled, 'boolean');
    return route.fulfill({ json: store.patchRepo(repo.id, { enabled }) });
  });
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
        events: store.taskEvents(new URL(route.request().url()).pathname.split('/')[3]),
        coverage: { available: 0, total: 0 },
        durationMs: 0,
        elapsedMs: null,
      },
    }),
  );
  let stateGate: Promise<void> | undefined;
  let stateStarted: (() => void) | undefined;
  await page.route('**/api/state?messages=none', async (route) => {
    const snapshot = store.snapshot({ conversation: 'bounded' });
    const gate = stateGate;
    stateGate = undefined;
    stateStarted?.();
    if (gate) await gate;
    await route.fulfill({ json: snapshot });
  });
  await page.route(/\/api\/projects\/[^/]+\/messages(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const projectId = url.pathname.split('/')[3];
    const before = url.searchParams.get('before');
    const after = url.searchParams.get('after');
    const ids = url.searchParams.get('ids');
    return route.fulfill({
      json: store.conversationPage(
        projectId,
        ids ? { ids: ids.split(',') } : after ? { after } : { before: before ?? undefined },
      ),
    });
  });
  await page.route('**/api/projects/*/workflow?*', (route) =>
    route.fulfill({ json: { sources: [], admissionPaused: false, inputs: [] } }),
  );
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
    await mkdir(resolve(process.env.PHANTOM_BROWSER_ARTIFACTS ?? 'test-results'), {
      recursive: true,
    });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('http://127.0.0.1:4329', { waitUntil: 'domcontentloaded' });
    await page.locator('.workspace-project-picker select').selectOption(project.id);
    await openPage(page, 'project');
    for (const locale of ['zh-CN', 'en']) {
      await choosePreference(page, 'language', locale);
      const label = locale === 'zh-CN' ? '允许认领新任务' : 'Allow new task claims';
      const paused =
        locale === 'zh-CN'
          ? '已暂停认领，排队任务等待开启'
          : 'Claims paused; queued tasks will wait until enabled';
      const row = page.locator('.repo-control').filter({ hasText: 'fixture-repo' });
      const toggle = row.getByRole('switch', { name: `fixture-repo ${label}`, exact: true });
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 768 });
        for (const enabled of [false, true]) {
          if (enabled) {
            await toggle.focus();
            await page.keyboard.press('Space');
          }
          await row.getByText(label, { exact: true }).waitFor();
          await toggle.and(page.locator(`[aria-checked="${enabled}"]`)).waitFor();
          assert.equal(await toggle.evaluate((el) => el.classList.contains('on')), enabled);
          assert.equal(store.repo(repo.id).enabled, enabled);
          assert.equal(await row.getByText(paused, { exact: true }).count(), enabled ? 0 : 1);
          if (!enabled) {
            assert.equal(
              await page
                .locator(`[id="${await toggle.getAttribute('aria-describedby')}"]`)
                .innerText(),
              paused,
            );
          }
          await page.reload();
          await toggle.and(page.locator(`[aria-checked="${enabled}"]`)).waitFor();
          await row.getByText(label, { exact: true }).waitFor();
          assert.equal(await row.getByText(paused, { exact: true }).count(), enabled ? 0 : 1);
          await toggle.scrollIntoViewIfNeeded();
          const bounds = await toggle.boundingBox();
          assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
          assert.equal(
            await row.evaluate((el) => el.scrollWidth <= el.clientWidth),
            true,
            `${width}px repository switch and hint fit`,
          );
          await page.screenshot({
            path: resolve(
              process.env.PHANTOM_BROWSER_ARTIFACTS ?? 'test-results',
              `repo-claims-${locale}-${width}-${enabled ? 'on' : 'off'}.png`,
            ),
          });
        }
        await toggle.click();
        await toggle.and(page.locator('[aria-checked="false"]')).waitFor();
        assert.equal(store.repo(repo.id).enabled, false);
      }
    }
    await page
      .locator('.workspace-project-picker select')
      .selectOption({ label: 'Conversation fixture' });
    await openPage(page, 'conversation');
    for (const locale of ['zh-CN', 'en']) {
      await choosePreference(page, 'language', locale);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 768 });
        const drawer = await openDrawer(page);
        const rail = page.locator('.sidebar');
        assert.equal(await rail.locator('.project-link').count(), 0);
        assert.notEqual(await page.locator('.workspace-project-picker select').inputValue(), '');
        const controls = await rail
          .locator(
            '.sidebar-bottom > :is(.language-control, .sidebar-action, .theme-control):visible',
          )
          .evaluateAll((rows) =>
            rows.map((row) => {
              const box = row.getBoundingClientRect();
              return { width: box.width, height: box.height };
            }),
          );
        assert.equal(controls.length, width <= 660 ? 4 : 3);
        for (const control of controls) {
          assert(control.width >= 40 && control.height >= 40);
        }
        await rail.screenshot({
          path: resolve(
            process.env.PHANTOM_BROWSER_ARTIFACTS ?? 'test-results',
            `rail-${width}-${locale}.png`,
          ),
        });
        if (drawer) await closeDrawer(page);
      }
    }
    await page.setViewportSize({ width: 1366, height: 768 });
    await choosePreference(page, 'language', 'zh-CN');
    for (const theme of ['dark', 'light']) {
      await choosePreference(page, 'theme', theme);
      for (const width of [1366, 390]) {
        await page.setViewportSize({ width, height: 768 });
        const drawer = await openDrawer(page);
        for (const preference of ['language', 'theme']) {
          const trigger = page.locator(`.sidebar .${preference}-control`);
          await trigger.click();
          const menu = page.locator('.preference-menu:popover-open');
          await menu.waitFor();
          assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
          assert.equal(
            await trigger.evaluate((element) => getComputedStyle(element).outlineStyle),
            'none',
            'pointer clicks do not add a focus outline',
          );
          const bounds = await menu.boundingBox();
          assert.ok(
            bounds &&
              bounds.x >= 0 &&
              bounds.y >= 0 &&
              bounds.x + bounds.width <= width &&
              bounds.y + bounds.height <= 768,
            'preference menu fits the viewport',
          );
          const colors = await menu.evaluate((element) => {
            const item = element.querySelector('button')!;
            return {
              foreground: getComputedStyle(item).color,
              background: getComputedStyle(element).backgroundColor,
            };
          });
          function luminance(color: string) {
            const rgb = color
              .match(/\d+/g)!
              .slice(0, 3)
              .map(Number)
              .map((value) => value / 255)
              .map((value) =>
                value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
              );
            return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
          }
          const light = luminance(colors.foreground),
            dark = luminance(colors.background);
          assert.ok(
            (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05) >= 4.5,
            'menu text has readable contrast',
          );
          assert.equal(
            await menu.locator('[aria-checked="true"]').count(),
            1,
            'one selected option',
          );
          await menu.locator('button').last().hover();
          await page.screenshot({
            path: resolve(
              process.env.PHANTOM_BROWSER_ARTIFACTS ?? 'test-results',
              `preference-menu-${preference}-${width}-${theme}.png`,
            ),
          });
          await page.mouse.click(3, 3);
          await menu.waitFor({ state: 'hidden' });
          await page.locator(`.sidebar .${preference}-control[aria-expanded="false"]`).waitFor();
          assert.equal(
            await trigger.getAttribute('aria-expanded'),
            'false',
            'outside click dismisses the menu',
          );
        }
        if (drawer) await closeDrawer(page);
      }
    }
    await page.setViewportSize({ width: 1366, height: 768 });
    const languageTrigger = page.locator('.sidebar .language-control');
    await page.locator('.sidebar .theme-control').focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(
      await languageTrigger.evaluate((element) => element.matches(':focus-visible')),
      true,
      'keyboard focus remains visible',
    );
    await page.keyboard.press('ArrowDown');
    const languageMenu = page.locator('.preference-menu:popover-open');
    await languageMenu.waitFor();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.equal(
      await page.locator('html').getAttribute('lang'),
      'en',
      'keyboard selection switches locale',
    );
    await page.keyboard.press('ArrowDown');
    await languageMenu.waitFor();
    await page.keyboard.press('Escape');
    await languageMenu.waitFor({ state: 'hidden' });
    assert.equal(
      await languageTrigger.evaluate((element) => document.activeElement === element),
      true,
      'Escape returns focus to the trigger',
    );
    await choosePreference(page, 'language', 'zh-CN');
    await choosePreference(page, 'theme', 'system');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await choosePreference(page, 'theme', 'light');
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.equal(
      await page.getByRole('button', { name: '外观', exact: true }).getAttribute('data-value'),
      'light',
      'explicit theme survives reload',
    );
    const completedRun = store
      .list('run')
      .filter((run) => run.projectId === conversationProject.id && run.status === 'completed')
      .at(-1)!;
    const firstProcess = page.locator(`.pm-process[data-run-id="${completedRun.id}"]`);
    const liveProcess = page.locator(`.pm-process[data-run-id="${pendingRun.id}"]`);
    await liveProcess.locator(':scope > summary').waitFor();
    await checkTyping(page);
    assert.equal(await liveProcess.evaluate((el: HTMLDetailsElement) => el.open), false);
    assert.equal(await firstProcess.evaluate((el: HTMLDetailsElement) => el.open), false);
    assert.equal(
      await page.getByText('Intermediate 50', { exact: true }).isVisible(),
      false,
      'completed intermediate prose folds with the tools',
    );
    assert.equal(
      await page.getByText(/^Final answer 50\b/).isVisible(),
      true,
      'final answer is retained',
    );
    await page.setViewportSize({ width: 1600, height: 768 });
    const turnMarks = page.locator('.turn-mark');
    await turnMarks.nth((await turnMarks.count()) - 2).focus();
    await page.getByRole('tooltip').getByText('Question 50', { exact: true }).waitFor();
    await page.keyboard.press('Enter');
    await firstProcess.locator(':scope > summary').click();
    assert.equal(await page.getByText('Intermediate 50', { exact: true }).isVisible(), true);
    const firstQuestion = page
      .getByRole('region', { name: '与协调者讨论', exact: true })
      .getByText('Question 50', { exact: true });
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
      'untouched live activity remains collapsed after normal completion',
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
      path: resolve(
        process.env.PHANTOM_BROWSER_ARTIFACTS ?? 'test-results',
        'conversation-navigation-light.png',
      ),
    });
    await choosePreference(page, 'theme', 'dark');
    await page.screenshot({
      animations: 'disabled',
      path: resolve(
        process.env.PHANTOM_BROWSER_ARTIFACTS ?? 'test-results',
        'conversation-navigation-dark.png',
      ),
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
    await page
      .getByRole('region', { name: '与协调者讨论', exact: true })
      .getByText('Reading a live reply', { exact: true })
      .waitFor();
    await page.locator('.turn-mark').last().click();
    const readingProcess = page.locator(`.pm-process[data-run-id="${readingRun.id}"]`);
    assert.equal(await readingProcess.evaluate((el: HTMLDetailsElement) => el.open), false);
    await readingProcess.locator(':scope > summary').click();
    const liveExplanation = page
      .getByRole('region', { name: '与协调者讨论', exact: true })
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
    await page
      .getByRole('region', { name: '与协调者讨论', exact: true })
      .getByText('New final answer', { exact: true })
      .waitFor();
    assert.equal(
      await liveExplanation.isVisible(),
      true,
      'manual expansion keeps the reply visible when it moves into the completed process',
    );
    assert.equal(await readingProcess.evaluate((el: HTMLDetailsElement) => el.open), true);
    await page.setViewportSize({ width: 1366, height: 768 });
    // The fixed rail keeps a common icon axis across desktop widths and reloads.
    const railCenters = () =>
      page.locator('.sidebar').evaluate((sidebar) =>
        [...sidebar.querySelectorAll('svg')]
          .map((icon) => icon.getBoundingClientRect())
          .filter((box) => box.width > 0)
          .map((box) => Math.round(box.left + box.width / 2)),
      );
    const assertRailAligned = async (label: string) => {
      const centers = await railCenters();
      assert.ok(
        Math.max(...centers) - Math.min(...centers) <= 1,
        `${label}: sidebar icons are centered on one axis, got ${centers.join(', ')}`,
      );
    };
    await assertRailAligned('desktop rail');
    await page.setViewportSize({ width: 760, height: 768 });
    await assertRailAligned('760px rail');
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.reload();
    await assertRailAligned('reloaded rail');
    await page.setViewportSize({ width: 390, height: 500 });
    await page.getByRole('button', { name: '对话目录', exact: true }).click();
    const directory = page.getByRole('dialog', { name: '对话目录' });
    await directory.getByRole('button', { name: /^\d+ Question 50$/, exact: true }).click();
    await directory.waitFor({ state: 'hidden' });
    assert.ok(
      await page
        .getByRole('region', { name: '与协调者讨论', exact: true })
        .getByText('Question 50', { exact: true })
        .isVisible(),
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({
      animations: 'disabled',
      path: resolve(
        process.env.PHANTOM_BROWSER_ARTIFACTS ?? 'test-results',
        'conversation-navigation-mobile.png',
      ),
    });
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.locator('.workspace-project-picker select').selectOption({ label: 'UI fixture' });
    // Work is grouped by what it asks of the user, in a fixed order, instead of by host stage.
    await openPage(page, 'work');
    const workPage = page.locator('.work-page');
    const titlesIn = (group: string) =>
      page
        .getByRole('region', { name: group, exact: true })
        .locator('.work-row strong')
        .allTextContents()
        .then((titles) => titles.sort());
    await workPage.getByRole('heading', { name: /^进行中/ }).waitFor();
    assert.deepEqual(
      (await workPage.locator('.work-group > :is(h2, summary)').allInnerTexts()).map((text) =>
        text.replace(/\s+/g, ' '),
      ),
      ['进行中 3', '排队中 3', '已交付 1', '已取消 1'],
      'groups follow the order of attention and count their work',
    );
    assert.equal(await workPage.getByRole('heading', { name: /^等你处理/ }).count(), 0);
    assert.deepEqual(await titlesIn('进行中'), [
      'Stage developing',
      'Stage merging',
      'Stage reviewing',
    ]);
    assert.deepEqual(await titlesIn('排队中'), [
      'Persistent task',
      'Stage clarifying',
      'Stage ready',
    ]);
    assert.deepEqual(await titlesIn('已交付'), ['Stage done']);
    const cancelled = workPage.locator('details.work-group');
    assert.equal(await cancelled.evaluate((el: HTMLDetailsElement) => el.open), false);
    await cancelled.locator('summary').click();
    await cancelled.getByText('Stage cancelled', { exact: true }).waitFor();
    await page
      .getByRole('region', { name: '排队中', exact: true })
      .getByText('等待：Persistent task', { exact: true })
      .first()
      .waitFor();
    const unchanged = JSON.stringify(store.snapshot());
    const search = page.getByLabel('搜索工作', { exact: true });
    // The search covers titles and specifications; matching cancelled work is shown, not folded.
    await search.fill('Original specification');
    assert.equal(await workPage.locator('.work-row').count(), 7);
    await page.getByRole('region', { name: '已取消', exact: true }).waitFor();
    await search.fill('developing');
    assert.equal(await workPage.locator('.work-row').count(), 1);
    await workPage.locator('.work-row').focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { level: 1, name: 'Stage developing', exact: true }).waitFor();
    await page.goBack();
    assert.equal(
      await search.inputValue(),
      'developing',
      'the search survives opening a piece of work and coming back',
    );
    await search.fill('');
    // The work page is an address: a reload stays on it.
    await page.reload();
    await workPage.getByRole('heading', { name: /^进行中/ }).waitFor();
    assert.equal(
      JSON.stringify(store.snapshot()),
      unchanged,
      'browsing and searching work must not mutate server state',
    );
    // The claim order lives on the project page.
    await openPage(page, 'project');
    await page.locator('.claim-order time').waitFor();
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
    const stableClaims = await page.locator('.claim-order').boundingBox();
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
      'background refresh must not flash transient text in the claim order',
    );
    assert.equal(
      (await page.locator('.claim-order').boundingBox())?.y,
      stableClaims?.y,
      'refresh must not move the claim order',
    );
    release();
    hold = undefined;
    // A background update keeps the work page's search focused and its place.
    await openPage(page, 'work');
    await search.fill('Persistent');
    const stableScroll = await workPage.evaluate((element) => element.scrollTop);
    store.updateTask(task.id, { title: 'Persistent task revised' });
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-change')));
    await workPage
      .locator('.work-row strong')
      .getByText('Persistent task revised', { exact: true })
      .waitFor();
    assert.equal(await workPage.evaluate((element) => element.scrollTop), stableScroll);
    assert.equal(await search.evaluate((element) => element === document.activeElement), true);
    await openTask(page, 'Persistent task revised');
    await page.locator('.task-scheduling > summary').click();
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
    await page.screenshot({
      path: resolve(
        process.env.PHANTOM_BROWSER_ARTIFACTS ?? 'test-results',
        'usability-detail-refresh.png',
      ),
    });
    release();
    hold = undefined;
    await openPage(page, 'project');
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
    await page.locator('.workspace-project-picker select').selectOption(secondProject.id);
    await openPage(page, 'project');
    await page.locator('.claim-order time').waitFor();
    assert.equal((await page.locator('.claim-order').innerText()).includes(project.name), false);
    release();
    hold = undefined;
    await page.waitForTimeout(100);
    assert.equal((await page.locator('.claim-order').innerText()).includes(project.name), false);
    await page.locator('.workspace-project-picker select').selectOption(project.id);
    await openPage(page, 'work');
    await search.fill('');
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
    await workPage
      .locator('.work-row strong')
      .getByText('Latest task revision', { exact: true })
      .waitFor();
    releaseState();
    await page.waitForTimeout(100);
    assert.equal(
      await workPage
        .locator('.work-row strong')
        .getByText('Latest task revision', { exact: true })
        .count(),
      1,
      'late state responses must not overwrite newer state',
    );
    await choosePreference(page, 'language', 'en');
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.equal(await page.title(), 'Phantom Circuit · Local workspace');
    await workPage.getByRole('heading', { name: /^In progress/ }).waitFor();
    await page.reload();
    await workPage.getByRole('heading', { name: 'Work', exact: true }).waitFor();
    await mkdir(resolve(process.env.PHANTOM_BROWSER_ARTIFACTS ?? 'test-results'), {
      recursive: true,
    });
    const views = [
      { page: 'home', name: 'Workbench' },
      { page: 'conversation', name: 'Conversation' },
      { page: 'brief', name: 'Brief' },
      { page: 'work', name: 'Work' },
      { page: 'team', name: 'Team' },
      { page: 'project', name: 'Project' },
    ] as const;
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 1366, height: 768 },
      { width: 1280, height: 1000 },
      { width: 390, height: 844 },
      { width: 390, height: 500 },
    ]) {
      await page.setViewportSize(viewport);
      for (const theme of ['dark', 'light']) {
        if ((await page.locator('html').getAttribute('data-theme')) !== theme)
          await choosePreference(page, 'theme', theme);
        for (const view of views) {
          await openPage(page, view.page);
          await page.locator('.workspace-header').waitFor();
          assert.equal(
            await page.locator('.workspace-menu').isVisible(),
            viewport.width <= 660,
            'workspace menu appears only on phone',
          );
          if (view.page === 'conversation') {
            assert.equal(await page.locator('.home-brief').count(), 0);
            assert.equal(await page.locator('.message .mini-avatar').count(), 0);
          } else if (view.page === 'brief') {
            await page.locator('.brief-page .brief').waitFor();
          }
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
            `${viewport.width} ${view.name} page width`,
          );
          if (viewport.width > 660) {
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1),
              true,
              `${view.name} must fit desktop height`,
            );
            if (view.page === 'conversation') {
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
          if (view.page === 'work') {
            // Keyboard: the last row opens its page, and the browser's back button returns.
            await workPage.locator('.work-row:visible').last().focus();
            await page.keyboard.press('Enter');
            const taskPage = page.locator('.task-page');
            await taskPage.waitFor();
            const canvas = page.locator('.canvas-viewport');
            assert.equal(
              await canvas.isVisible(),
              viewport.width > 660,
              'inspection retains desktop source context and focuses the task on phone',
            );
            if (viewport.width > 660) {
              const canvasBox = await canvas.boundingBox();
              const detailBox = await taskPage.boundingBox();
              assert.ok(
                canvasBox &&
                  detailBox &&
                  detailBox.x > canvasBox.x &&
                  detailBox.x + detailBox.width <= viewport.width + 1,
                'desktop inspector leaves source context visible and fits the viewport',
              );
            }
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              true,
              `${viewport.width}px task workspace overflow`,
            );
            await page.screenshot({
              path: resolve(
                process.env.PHANTOM_BROWSER_ARTIFACTS ?? 'test-results',
                `usability-task-${viewport.width}x${viewport.height}-${theme}.png`,
              ),
            });
            await page.goBack();
            await workPage.evaluate((element) => {
              element.scrollTop = 0;
            });
            const titleBox = await workPage.getByRole('heading', { level: 1 }).boundingBox();
            const groupBox = await workPage.locator('.work-group > h2').first().boundingBox();
            const rowsBox = await workPage.locator('.work-rows').first().boundingBox();
            assert.ok(
              titleBox &&
                groupBox &&
                rowsBox &&
                Math.abs(titleBox.x - groupBox.x) < 1 &&
                Math.abs(rowsBox.x - titleBox.x) < 1,
              'page title, group headings and rows share the same page gutter',
            );
          } else if (view.page === 'conversation') {
            await page.getByLabel('Message to Coordinator').focus();
            await page.locator('.composer').scrollIntoViewIfNeeded();
          }
          await page.screenshot({
            path: resolve(
              process.env.PHANTOM_BROWSER_ARTIFACTS ?? 'test-results',
              `usability-${viewport.width}x${viewport.height}-${theme}-${view.name}.png`,
            ),
          });
        }
      }
    }
    async function captureModal(name: string, width: number, theme: string) {
      const modal = page.locator('.modal');
      await modal.waitFor();
      // Measure relative to the dialog: lazy content and entrance motion can move its frame.
      // Read both rectangles in one browser task so loading cannot move the frame between reads.
      const headerOffset = () =>
        modal.evaluate((element) => {
          const header = element.querySelector('header');
          return header
            ? header.getBoundingClientRect().y - element.getBoundingClientRect().y
            : undefined;
        });
      const header = await headerOffset();
      // Settings start with their page list; other dialogs with their first field.
      const firstField = modal.locator('.modal-body :is(.settings-nav, .form label)').first();
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
      const scrolledHeader = await headerOffset();
      assert.ok(
        header !== undefined &&
          scrolledHeader !== undefined &&
          Math.abs(header - scrolledHeader) < 1,
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
        path: resolve(
          process.env.PHANTOM_BROWSER_ARTIFACTS ?? 'test-results',
          `audit-${name}-${width}-${theme}.png`,
        ),
      });
      await modal.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await modal.waitFor({ state: 'detached' });
    }
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      for (const theme of ['light', 'dark']) {
        await choosePreference(page, 'theme', theme);
        if (width <= 660) await clickInSidebar(page, 'New project');
        else
          await page
            .locator('.workspace-project-picker')
            .getByRole('button', { name: 'New project', exact: true })
            .click();
        await captureModal('new-project', width, theme);
        // Project facts are a page now, not a dialog: it scrolls with the page and never overflows.
        await openPage(page, 'project');
        const projectPage = page.locator('.project-page');
        assert.equal(
          await projectPage.evaluate((element) => element.scrollWidth <= element.clientWidth),
          true,
          `${width}px project page overflow`,
        );
        await page.screenshot({
          path: resolve(
            process.env.PHANTOM_BROWSER_ARTIFACTS ?? 'test-results',
            `audit-project-page-${width}-${theme}.png`,
          ),
        });
        await projectPage
          .getByRole('button', { name: 'Configure fixture-repo', exact: true })
          .click();
        await captureModal('repository-commands', width, theme);
        await projectPage.getByRole('button', { name: 'Connect repository', exact: true }).click();
        await captureModal('connect-repository', width, theme);
        await projectPage
          .getByRole('button', { name: 'Project model settings', exact: true })
          .click();
        await captureModal('project-settings', width, theme);
        await clickInSidebar(page, 'Runtime settings');
        await captureModal('global-settings', width, theme);
        await clickInSidebar(page, 'Runtime settings');
        await settingsPage(page.locator('.modal'), 'providers');
        await page.getByLabel('Select provider', { exact: true }).selectOption('ui-provider');
        await captureModal('provider-settings', width, theme);
        await closeDrawer(page);
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
