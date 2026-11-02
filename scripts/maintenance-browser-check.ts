import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Engine } from '../src/server/engine.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Previews } from '../src/server/preview.ts';
import { createApp } from '../src/server/app.ts';
import { profileProtocol } from '../tests/profile-protocol.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { choosePreference } from './browser-preferences.ts';

/** Exercises the built production assets, never a Vite development server. */
export async function checkMaintenance() {
  const store = new Store(':memory:');
  const project = store.createProject('Maintenance fixture', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'Fixture repo',
    path: '/fixture',
    github: 'example/history',
    defaultBranch: 'main',
    authorized: true,
  });
  const source = store.addMessage(project.id, 'user', 'Implement fixture', 'implement');
  store.updateMessage(source.id, { status: 'completed' });
  const createTask = (title: string) =>
    store.createTask({
      projectId: project.id,
      repoId: repo.id,
      sourceMessageId: source.id,
      title,
      spec: '## Historical specification\n\nPreserved **Markdown**.',
      acceptance: ['Evidence stays incomplete'],
      dependencies: [],
      kind: 'frontend',
      complexity: 'normal',
      priority: 0,
    });
  const history = createTask('Delivered history');
  const reason =
    'Error: 历史 Task 完成同步缺少固定 revision 的测试、双轴 Review 或 PM 验收证据，需要 PM 核对';
  store.updateTask(history.id, {
    stage: 'done',
    control: 'paused',
    pausedByUser: false,
    completionDeliveryPending: false,
    blocked: reason,
    pr: 7,
    prUrl: 'https://github.com/example/history/pull/7',
    feedback: ['External delivery: https://github.com/example/history/pull/7'],
  });
  const actionable = createTask('Current verification failure');
  store.updateTask(actionable.id, {
    stage: 'done',
    control: 'paused',
    completionDeliveryPending: false,
    blocked: reason,
    blockedDescriptor: { code: 'completion_evidence_invalid' },
    tests: [
      {
        command: 'npm test',
        head: 'current',
        exitCode: 1,
        output: 'Real verification failed',
        at: 'now',
      },
    ],
  });
  const userPause = createTask('User paused work');
  store.updateTask(userPause.id, { stage: 'developing', control: 'paused', pausedByUser: true });
  const drift = createTask('GitHub drift');
  store.updateTask(drift.id, {
    stage: 'done',
    completionDeliveryPending: false,
    blocked: 'GitHub 需求发生变化，PM 正在核对',
  });
  const incident = store.createIncident({
    projectId: project.id,
    taskId: history.id,
    phase: 'sync',
    message: reason,
    evidence: 'Preserved original incident',
  });
  const ws = new Workspaces(resolve('.cache/maintenance-workspaces'), store);
  const engine = new Engine(store, new GitHub(store), ws, resolve('.cache/maintenance'));
  const port = 4333;
  const app = createApp(store, engine, new Previews(store, ws), port, profileProtocol);
  const origin = await app.listen({ host: '127.0.0.1', port });
  const browser = await chromium.launch({
    headless: true,
    channel: process.platform === 'win32' ? 'msedge' : undefined,
  });
  const artifacts = resolve('test-results');
  await mkdir(artifacts, { recursive: true });
  try {
    const context = await browser.newContext({
      locale: 'en-US',
      viewport: { width: 1440, height: 1000 },
      reducedMotion: 'reduce',
    });
    await context.addInitScript(
      ({ id }) => {
        localStorage.setItem('phantom.project', id);
        if (!localStorage.getItem('phantom.locale')) localStorage.setItem('phantom.locale', 'en');
      },
      { id: project.id },
    );
    await context.route('**/api/agents/*/models', (route) =>
      route.fulfill({
        json: { available: true, models: [] },
      }),
    );
    await context.route('**/api/providers/*/models', (route) =>
      route.fulfill({ json: { ok: true, models: [] } }),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.setDefaultTimeout(10000);
    const scripts: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'script') scripts.push(request.url());
    });
    await page.goto(origin);
    await page.getByLabel('Message to PM').waitFor();
    const initial = [...scripts];
    assert.equal(
      initial.some((url) => /\/(settings-panel|task-detail)-/.test(url)),
      false,
      'neither low-frequency module is fetched by the production entry',
    );
    const pmDraft = 'Keep this PM draft 中文';
    await page.getByLabel('Message to PM').fill(pmDraft);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/assets/settings-panel-*.js', async (route) => {
      await gate;
      await route.continue();
    });
    await page.getByRole('button', { name: 'Runtime settings', exact: true }).click();
    await page.getByRole('status').getByText('Loading panel…', { exact: true }).waitFor();
    await page.screenshot({ path: resolve(artifacts, 'maintenance-loading.png') });
    release();
    await page.getByLabel('Global Dev limit').waitFor();
    assert.ok(
      scripts.some((url) => /\/settings-panel-/.test(url)),
      'opening settings fetches its production module',
    );
    assert.equal(
      scripts.some((url) => /\/task-detail-/.test(url)),
      false,
    );
    await page.unroute('**/assets/settings-panel-*.js');
    await page.getByLabel('Global Dev limit').fill('9');
    const settingsInput = await page.getByLabel('Global Dev limit').elementHandle();
    const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/state'));
    store.transaction(() =>
      store.put('project', project.id, {
        ...store.project(project.id),
        name: 'Background refresh happened',
      }),
    );
    await refreshed;
    // Wait for the refreshed snapshot to reach React, then check the exact focused DOM input.
    await page.getByRole('heading', { name: 'Background refresh happened', exact: true }).waitFor();
    assert.equal(await page.getByLabel('Global Dev limit').inputValue(), '9');
    assert.equal(
      await settingsInput!.evaluate(
        (element) => document.activeElement === element && element.isConnected,
      ),
      true,
    );
    await page.keyboard.press('Escape');
    assert.equal(await page.getByLabel('Message to PM').inputValue(), pmDraft);
    const loaded = scripts.length;
    await page.getByRole('button', { name: 'Runtime settings', exact: true }).click();
    await page.getByLabel('Global Dev limit').waitFor();
    assert.equal(scripts.length, loaded, 'reopening uses the loaded module');
    await page.keyboard.press('Escape');

    await page.getByRole('tab', { name: /^Tasks(?:\s+\d+)?$/ }).click();
    const card = page.locator('.task-card').filter({ hasText: history.title });
    await card.waitFor();
    assert.match((await card.getAttribute('class')) ?? '', /tone-done/);
    assert.equal(await card.locator('em').count(), 0);
    assert.equal(
      await card.locator('.runtime-badge.warning').count(),
      1,
      'existing Incident remains visible',
    );
    assert.match(
      (await page
        .locator('.task-card')
        .filter({ hasText: actionable.title })
        .getAttribute('class')) ?? '',
      /tone-blocked/,
    );
    assert.match(
      (await page
        .locator('.task-card')
        .filter({ hasText: userPause.title })
        .getAttribute('class')) ?? '',
      /tone-paused/,
    );
    assert.match(
      (await page.locator('.task-card').filter({ hasText: drift.title }).getAttribute('class')) ??
        '',
      /tone-blocked/,
    );
    let releaseDetail!: () => void;
    const detailGate = new Promise<void>((resolve) => {
      releaseDetail = resolve;
    });
    await page.route('**/assets/task-detail-*.js', async (route) => {
      await detailGate;
      await route.continue();
    });
    await card.click();
    await page.getByRole('status').getByText('Loading panel…', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await card.click();
    releaseDetail();
    const dialog = page.getByRole('dialog', { name: history.title, exact: true });
    await dialog.locator('.historical-completion').waitFor();
    await page.unroute('**/assets/task-detail-*.js');
    assert.equal(await dialog.locator('.historical-completion .muted').innerText(), reason);
    assert.equal(await dialog.locator('.inline-warning').count(), 0);
    assert.equal(await dialog.getByRole('button', { name: /Resume|Pause/ }).count(), 0);
    assert.equal(
      await dialog.getByRole('link', { name: 'PR', exact: true }).getAttribute('href'),
      'https://github.com/example/history/pull/7',
    );
    await dialog.getByText('External delivery:', { exact: false }).waitFor();
    assert.ok(scripts.some((url) => /\/task-detail-/.test(url)));
    const originalDialog = await dialog.elementHandle();
    await dialog.getByRole('button', { name: 'Copy', exact: true }).first().focus();
    const originalFocus = await dialog
      .getByRole('button', { name: 'Copy', exact: true })
      .first()
      .elementHandle();
    await dialog.locator('.modal-body').evaluate((element) => {
      element.scrollTop = 140;
    });
    const detailScroll = await dialog
      .locator('.modal-body')
      .evaluate((element) => element.scrollTop);
    const update = page.waitForResponse((response) => response.url().endsWith('/api/state'));
    store.updateTask(history.id, {
      feedback: [
        'External delivery: https://github.com/example/history/pull/7',
        'Background history update',
      ],
    });
    await update;
    await dialog.getByText('Background history update', { exact: true }).waitFor();
    assert.equal(await originalDialog!.evaluate((element) => element.isConnected), true);
    assert.equal(
      await originalFocus!.evaluate((element) => document.activeElement === element),
      true,
    );
    assert.equal(
      await dialog.locator('.modal-body').evaluate((element) => element.scrollTop),
      detailScroll,
    );
    await page.keyboard.press('Escape');
    await card.click();
    await dialog.locator('.historical-completion').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.task-card').filter({ hasText: actionable.title }).click();
    const currentFailure = page.getByRole('dialog', { name: actionable.title, exact: true });
    await currentFailure.locator('.inline-warning').waitFor();
    assert.equal(
      await currentFailure.locator('.historical-completion').count(),
      0,
      'new evidence failure with identical prose remains an actionable warning',
    );
    await currentFailure.locator('.test-evidence.failed').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'List', exact: true }).click();
    const row = page.locator('.task-row').filter({ hasText: history.title });
    assert.match((await row.getAttribute('class')) ?? '', /tone-done/);
    assert.equal(await row.locator('em').count(), 0);
    await page.getByLabel('Filter execution control').selectOption('paused');
    assert.equal(await row.count(), 0);
    await page.getByLabel('Filter execution control').selectOption('all');

    for (const width of [1440, 390])
      for (const locale of ['en', 'zh-CN'])
        for (const theme of ['light', 'dark']) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
          await choosePreference(page, 'language', locale);
          await choosePreference(page, 'theme', theme);
          await page
            .getByRole('button', { name: locale === 'en' ? 'Board' : '看板', exact: true })
            .click();
          await card.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: resolve(artifacts, `maintenance-board-${width}-${locale}-${theme}.png`),
          });
          await page
            .getByRole('button', { name: locale === 'en' ? 'List' : '列表', exact: true })
            .click();
          await page.screenshot({
            path: resolve(artifacts, `maintenance-list-${width}-${locale}-${theme}.png`),
          });
          await row.click();
          const note = dialog.locator('.historical-completion');
          await note.waitFor();
          assert.ok(
            (await note.innerText()).includes(
              locale === 'en' ? 'Historical completion record' : '历史完成记录，旧验收证据不完整',
            ),
          );
          await note.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: resolve(artifacts, `maintenance-history-${width}-${locale}-${theme}.png`),
          });
          await page.keyboard.press('Escape');
          await page
            .getByRole('button', {
              name: locale === 'en' ? 'Runtime settings' : '运行设置',
              exact: true,
            })
            .click();
          await page.getByLabel(locale === 'en' ? 'Global Dev limit' : '全局 Dev 上限').waitFor();
          await page.screenshot({
            path: resolve(artifacts, `maintenance-settings-${width}-${locale}-${theme}.png`),
          });
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          await page.keyboard.press('Escape');
        }
    // Existing navigation is in-memory. Refresh preserves the selected Project and list preference;
    // the existing task-card and project-settings entry points remain usable after a direct URL load.
    await choosePreference(page, 'language', 'en');
    await page.reload();
    await page.getByRole('tab', { name: /^Tasks(?:\s+\d+)?$/ }).click();
    await row.click();
    await dialog.locator('.historical-completion').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.context-trigger').click();
    await page.getByRole('button', { name: 'Project model settings', exact: true }).click();
    await page.locator('.runtime-settings').waitFor();
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
    assert.equal(store.get('incident', incident.id)?.status, 'open');
    assert.deepEqual(store.task(history.id).tests, []);
    assert.deepEqual(store.task(history.id).reviews, []);
    await writeFile(
      resolve(artifacts, 'maintenance-network.json'),
      JSON.stringify({ initial, accessed: scripts }, null, 2),
    );
    await page.close();
    await context.close();

    // Use a fresh module map for each failure, with real failed production chunk requests.
    for (const panel of ['settings-panel', 'task-detail'])
      for (const recovery of ['retry', 'reopen']) {
        const failure = await browser.newPage({ locale: 'en-US' });
        await failure.addInitScript((id) => {
          localStorage.setItem('phantom.project', id);
          localStorage.setItem('phantom.locale', 'en');
        }, project.id);
        await failure.route('**/api/agents/*/models', (route) =>
          route.fulfill({ json: { available: true, models: [] } }),
        );
        await failure.route('**/api/providers/*/models', (route) =>
          route.fulfill({ json: { ok: true, models: [] } }),
        );
        let reject = true;
        await failure.route(`**/assets/${panel}-*.js`, (route) =>
          reject ? route.abort('failed') : route.continue(),
        );
        await failure.goto(origin);
        const open = async () => {
          if (panel === 'settings-panel')
            await failure.getByRole('button', { name: 'Runtime settings', exact: true }).click();
          else {
            await failure.getByRole('tab', { name: /^Tasks(?:\s+\d+)?$/ }).click();
            await failure
              .locator('.task-card, .task-row')
              .filter({ hasText: history.title })
              .click();
          }
        };
        await open();
        await failure
          .getByRole('alert')
          .getByText('Could not load this panel.', { exact: true })
          .waitFor();
        await failure.screenshot({
          path: resolve(artifacts, `maintenance-${panel}-failed-${recovery}.png`),
        });
        reject = false;
        if (recovery === 'retry')
          await failure.getByRole('button', { name: 'Try again', exact: true }).click();
        else {
          await failure.keyboard.press('Escape');
          await open();
        }
        await failure
          .locator(panel === 'settings-panel' ? '.runtime-settings' : '.historical-completion')
          .waitFor();
        await failure.close();
      }
    console.log(
      'Production maintenance browser checks passed: cold/first/repeated lazy requests, loading/failed chunk retry and reopen, draft/focus/reading position, historical and actionable diagnostics, desktop/390px zh-CN/en light/dark. Evidence: test-results/maintenance-*.',
    );
  } finally {
    await browser.close();
    await app.close();
    await engine.stop();
    store.close();
  }
}

if (process.argv[1]?.endsWith('maintenance-browser-check.ts')) await checkMaintenance();
