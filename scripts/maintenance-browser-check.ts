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
import {
  backToWork,
  clickInSidebar,
  closeDrawer,
  openPage,
  openSection,
  openTask,
} from './browser-pages.ts';

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
  const artifacts = resolve(process.env.PHANTOM_BROWSER_ARTIFACTS ?? 'test-results');
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
    const keyWarnings: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && /same key|unique.*key/i.test(message.text()))
        keyWarnings.push(message.text());
    });
    page.setDefaultTimeout(10000);
    const scripts: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'script') scripts.push(request.url());
    });
    await page.goto(origin);
    await page.getByLabel('Message to PM').waitFor();
    assert.equal(
      await page.locator('.project-actions .action-record').count(),
      0,
      'the exact historical evidence Incident does not ask for current intervention',
    );
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
    const refreshed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/state',
    );
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

    // Work is grouped by what it asks of the user: delivered history and a user pause land apart.
    await openPage(page, 'work');
    const group = (name: string) => page.getByRole('region', { name, exact: true });
    const workRow = (title: string) =>
      page
        .locator('.work-page')
        .getByRole('link')
        .filter({ has: page.locator('strong').getByText(title, { exact: true }) });
    const card = workRow(history.title);
    await group('Delivered').getByRole('link').filter({ hasText: history.title }).waitFor();
    assert.equal(await card.locator('em').count(), 0);
    await group('Paused').getByRole('link').filter({ hasText: userPause.title }).waitFor();
    await group('Paused').getByText('You paused it', { exact: true }).waitFor();
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
    await backToWork(page);
    await card.click();
    releaseDetail();
    const dialog = page.locator('.task-page');
    await dialog.locator('.historical-completion').waitFor();
    await page.unroute('**/assets/task-detail-*.js');
    assert.equal(await dialog.locator('.historical-completion .muted').innerText(), reason);
    const historicalIncidents = dialog.locator('.historical-incidents');
    await historicalIncidents.locator(':scope > summary').click();
    await historicalIncidents.getByText(`Incident ${incident.id}`, { exact: false }).waitFor();
    await historicalIncidents.locator('details > summary').click();
    assert.deepEqual(
      JSON.parse(await historicalIncidents.locator('pre').innerText()),
      incident,
      'the original Incident, status, evidence and references remain inspectable',
    );
    assert.equal(await historicalIncidents.locator('button').count(), 0);
    assert.equal(await dialog.locator('.inline-warning').count(), 0);
    assert.equal(await dialog.getByRole('button', { name: /Resume|Pause/ }).count(), 0);
    await dialog.locator('.task-controls > summary').click();
    const historicalPR = dialog
      .locator('.task-interventions')
      .getByRole('link', { name: 'Status unknown PR #7', exact: true });
    await historicalPR.getByRole('img', { name: 'Status unknown', exact: true }).waitFor();
    assert.equal(
      await historicalPR.getAttribute('href'),
      'https://github.com/example/history/pull/7',
    );
    await openSection(page, 'task.tab.spec');
    await dialog.getByText('External delivery:', { exact: false }).waitFor();
    assert.ok(scripts.some((url) => /\/task-detail-/.test(url)));
    const originalDialog = await dialog.elementHandle();
    await dialog.getByRole('button', { name: 'Copy', exact: true }).first().focus();
    const originalFocus = await dialog
      .getByRole('button', { name: 'Copy', exact: true })
      .first()
      .elementHandle();
    // A short window makes the specification section scroll.
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: viewport.width, height: 360 });
    await dialog.evaluate((element) => {
      element.scrollTop = 140;
    });
    const detailScroll = await dialog.evaluate((element) => element.scrollTop);
    assert.ok(detailScroll > 0, 'the work page scrolls');
    const update = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/state',
    );
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
    assert.equal(await dialog.evaluate((element) => element.scrollTop), detailScroll);
    await page.setViewportSize(viewport);
    await backToWork(page);
    await card.click();
    await dialog.locator('.historical-completion').waitFor();
    await backToWork(page);
    // A current failure on delivered work stays actionable on its page.
    await openTask(page, actionable.title);
    await dialog.locator('.inline-warning').waitFor();
    assert.equal(
      await dialog.locator('.historical-completion').count(),
      0,
      'new evidence failure with identical prose remains an actionable warning',
    );
    await dialog.locator('.task-receipt-details > summary').click();
    await dialog
      .getByRole('region', { name: 'Delivery receipt', exact: true })
      .getByText('1 check failed', { exact: false })
      .waitFor();
    await backToWork(page);
    await openTask(page, drift.title);
    await dialog
      .locator('.inline-warning')
      .getByText(/GitHub/)
      .waitFor();
    await backToWork(page);
    const search = page.getByLabel('Search work', { exact: true });
    await search.fill(history.title);
    assert.equal(await page.locator('.work-page').getByRole('link').count(), 1);
    await card.waitFor();
    await search.fill('');

    for (const width of [1440, 390])
      for (const locale of ['en', 'zh-CN'])
        for (const theme of ['light', 'dark']) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
          await choosePreference(page, 'language', locale);
          await choosePreference(page, 'theme', theme);
          await card.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: resolve(artifacts, `maintenance-work-${width}-${locale}-${theme}.png`),
          });
          await card.click();
          const note = dialog.locator('.historical-completion');
          await note.waitFor();
          await note.locator('.historical-incidents > summary').click();
          assert.ok(
            (await note.innerText()).includes(
              locale === 'en' ? 'Historical completion record' : '历史完成记录，旧验收证据不完整',
            ),
          );
          await note.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: resolve(artifacts, `maintenance-history-${width}-${locale}-${theme}.png`),
          });
          await backToWork(page);
          await clickInSidebar(page, locale === 'en' ? 'Runtime settings' : '运行设置');
          await page.getByLabel(locale === 'en' ? 'Global Dev limit' : '全局 Dev 上限').waitFor();
          await page.screenshot({
            path: resolve(artifacts, `maintenance-settings-${width}-${locale}-${theme}.png`),
          });
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          await page.keyboard.press('Escape');
          await closeDrawer(page);
        }
    // Every page has an address: a reload lands on the same page, whose entry points stay usable.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await choosePreference(page, 'language', 'en');
    await page.reload();
    await card.click();
    await dialog.locator('.historical-completion').waitFor();
    await openPage(page, 'project');
    await page.getByRole('button', { name: 'Project model settings', exact: true }).click();
    await page.locator('.runtime-settings').waitFor();
    await page.keyboard.press('Escape');
    // Classify each Incident independently, even when several belong to the same Task.
    await openPage(page, 'home');
    let currentIncidents = 0;
    const openTechnicalActions = async () => {
      const summary = page
        .locator('.project-actions > details > summary')
        .filter({ hasText: 'Technical records' });
      await summary.waitFor();
      if (!(await summary.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
        await summary.click();
      await summary.locator('xpath=..').locator(':scope > .fold-body').waitFor();
    };
    const incidentCases = [
      {
        phase: 'finalize',
        message: reason,
        descriptor: { code: 'incident_finalize' },
        historical: true,
      },
      {
        phase: 'sync',
        message: reason.slice('Error: '.length),
        descriptor: { code: 'incident_paused' },
        historical: true,
      },
      {
        phase: 'finalize',
        message: reason,
        descriptor: { code: 'completion_evidence_invalid' },
        historical: false,
      },
      {
        phase: 'finalize',
        message: reason,
        descriptor: { code: 'unknown_specific_failure' },
        historical: false,
      },
      { phase: 'unknown-phase', message: reason, descriptor: undefined, historical: false },
      {
        phase: 'finalize',
        message: `${reason}; another failure`,
        descriptor: undefined,
        historical: false,
      },
      {
        phase: 'finalize',
        message: 'HTTP 403: delivery permission denied',
        descriptor: { code: 'incident_finalize' },
        historical: false,
      },
    ];
    for (const [index, sample] of incidentCases.entries()) {
      const run = store.run('review', project.id, 'review', store.task(history.id));
      store.finishRun(run.id, 'failed', `Incident fixture ${index}`);
      const added = store.createIncident({
        projectId: project.id,
        taskId: history.id,
        runId: run.id,
        phase: sample.phase,
        message: sample.message,
        descriptor: sample.descriptor,
        evidence: `Original evidence ${index}`,
      });
      if (!sample.historical) currentIncidents++;
      if (currentIncidents) await openTechnicalActions();
      await page.waitForFunction(
        (count) => document.querySelectorAll('.project-actions .action-record').length === count,
        currentIncidents,
      );
      // Work rows carry no runtime badges; the run log still marks each current Incident.
      if (sample.historical) {
        await openTask(page, history.title);
        await dialog.locator('.historical-incidents > summary').click();
        await dialog.getByText(`Incident ${added.id}`, { exact: false }).waitFor();
      }
      await openPage(page, 'project');
      await openSection(page, 'project.tab.runs');
      const runRow = page
        .getByRole('region', { name: 'Run log', exact: true })
        .locator('.run-row')
        .filter({ hasText: `Incident fixture ${index}` });
      await runRow.waitFor();
      assert.equal(
        await runRow.locator('.runtime-badge.warning').count(),
        sample.historical ? 0 : 1,
      );
      await openPage(page, 'home');
      assert.deepEqual(store.get('incident', added.id), added);
    }
    const orphan = store.createIncident({ projectId: project.id, phase: 'sync', message: reason });
    currentIncidents++;
    await openTechnicalActions();
    await page.waitForFunction(
      (count) => document.querySelectorAll('.project-actions .action-record').length === count,
      currentIncidents,
    );
    const actions = page.locator('.project-actions');
    await actions.getByText('HTTP 403: delivery permission denied', { exact: true }).waitFor();
    assert.equal(
      await actions.getByRole('button', { name: 'Mark resolved', exact: true }).count(),
      currentIncidents,
      'real and uncertain Incidents retain their existing actions',
    );
    const otherProject = store.createProject('Other Incident project', '');
    const foreign = store.createIncident({
      projectId: otherProject.id,
      phase: 'sync',
      message: reason,
    });
    await page.getByRole('button', { name: otherProject.name, exact: true }).click();
    await page.getByRole('heading', { name: otherProject.name, exact: true }).waitFor();
    await openTechnicalActions();
    await page.waitForFunction(
      () => document.querySelectorAll('.project-actions .action-record').length === 1,
    );
    assert.equal(
      await page.locator('.project-actions .action-record').count(),
      1,
      'matching prose in another Project without a historical Task stays actionable',
    );
    assert.deepEqual(store.get('incident', foreign.id), foreign);
    assert.deepEqual(store.get('incident', orphan.id), orphan);
    await page.getByRole('button', { name: 'Background refresh happened', exact: true }).click();
    await page.getByRole('heading', { name: 'Background refresh happened', exact: true }).waitFor();
    await openTechnicalActions();
    assert.equal(await page.locator('.project-actions').count(), 1);
    assert.equal(await page.locator('.project-actions .action-record').count(), currentIncidents);
    await page.getByLabel('Message to PM').fill('Draft after project switch');
    assert.equal(await page.getByLabel('Message to PM').inputValue(), 'Draft after project switch');
    const raw = await (await page.request.get(`${origin}/api/state`)).json();
    assert.deepEqual(
      raw.incidents.find((item: { id: string }) => item.id === incident.id),
      incident,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(keyWarnings, []);
    assert.deepEqual(store.get('incident', incident.id), incident);
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
        let recoveredRequests = 0;
        await failure.route(`**/assets/${panel}-*.js*`, (route) => {
          if (reject) return route.abort('failed');
          recoveredRequests++;
          return route.continue();
        });
        await failure.goto(origin);
        const retainedDraft = `Draft survives ${panel} ${recovery}`;
        await failure.getByLabel('Message to PM').fill(retainedDraft);
        const open = async () => {
          if (panel === 'settings-panel')
            await failure.getByRole('button', { name: 'Runtime settings', exact: true }).click();
          else await openTask(failure, history.title);
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
          // Leave the failed panel the way its surface is left: close the dialog, or go back.
          if (panel === 'settings-panel') await failure.keyboard.press('Escape');
          else await backToWork(failure);
          await open();
        }
        await failure
          .locator(panel === 'settings-panel' ? '.runtime-settings' : '.historical-completion')
          .waitFor();
        assert.ok(recoveredRequests > 0, 'recovery fetches a fresh production module URL');
        if (panel === 'settings-panel') {
          await failure.keyboard.press('Escape');
          assert.equal(await failure.getByLabel('Message to PM').inputValue(), retainedDraft);
        }
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
