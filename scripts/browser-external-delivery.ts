import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';
import { Store } from '../src/server/store.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { Previews } from '../src/server/preview.ts';
import { createApp } from '../src/server/app.ts';
import type { Task } from '../src/shared/types.ts';
import { pagesEn, pagesZh } from '../src/web/locale/pages.ts';
import { choosePreference } from './browser-preferences.ts';
import { openPage, openSection, openTask } from './browser-pages.ts';

type ExternalEvidence = Parameters<Store['completeExternalTask']>[1];

function syntheticExternalFixtures(store: Store) {
  const project = store.createProject('Synthetic external delivery', 'Browser regression fixture');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'Synthetic external repository',
    path: '/synthetic/external-delivery',
    github: 'synthetic/external-delivery',
    defaultBranch: 'main',
    authorized: true,
  });
  const source = store.addMessage(project.id, 'user', 'Synthetic delivery request', 'implement');
  const task = (title: string) =>
    store.createTask({
      projectId: project.id,
      repoId: repo.id,
      sourceMessageId: source.id,
      title,
      spec: 'Synthetic fixture. No real repository or remote facts are used.',
      acceptance: ['Deliver the synthetic change'],
      dependencies: [],
      kind: 'frontend',
      complexity: 'normal',
      priority: 0,
    });
  const oldHead = 'a'.repeat(40);
  const remoteHead = 'b'.repeat(40);
  const at = new Date().toISOString();
  const observation = (pr: number) => ({
    repoId: repo.id,
    repository: repo.github,
    pr,
    head: remoteHead,
    base: 'c'.repeat(40),
    baseRef: 'main',
    mergeCommit: (pr === 81 ? 'd' : 'e').repeat(40),
    mergedAt: at,
    checkedAt: at,
  });
  const evidence = (pr: number): ExternalEvidence => ({
    primary: observation(pr),
    closing: observation(82),
    issue: 74,
    closedAt: at,
    checkedAt: at,
    relationship: {
      primaryReferencesIssue: true,
      closingReferencesIssue: true,
      closureEventAt: at,
    },
  });
  const prepare = (item: Task, pr: number | undefined) =>
    store.updateTask(item.id, {
      stage: 'developing',
      control: 'paused',
      pausedByUser: true,
      head: oldHead,
      base: 'c'.repeat(40),
      issue: 74,
      issueUrl: `https://github.com/${repo.github}/issues/74`,
      issueState: 'completed',
      pr,
      prUrl: pr ? `https://github.com/${repo.github}/pull/${pr}` : undefined,
      prState: pr ? 'merged' : undefined,
      remoteMerge: observation(pr ?? 82),
      tests: [{ command: 'synthetic-old-test', head: oldHead, at, exitCode: 0, output: 'old' }],
      reviews: [
        {
          axis: 'primary',
          head: oldHead,
          base: 'c'.repeat(40),
          approved: true,
          summary: 'Synthetic approval at the old local head',
          findings: [],
        },
      ],
    });
  const done = prepare(task('Synthetic external delivery with local history'), 81);
  const oldIncident = store.createIncident({
    projectId: project.id,
    taskId: done.id,
    phase: 'sync',
    message: 'Synthetic old incident superseded by external delivery',
  });
  store.updateIncident(oldIncident.id, { status: 'waiting_user' });
  const dependent = task('Synthetic dependency released by external completion');
  store.updateTask(dependent.id, { dependencies: [done.id] });
  const dependencyReasons = () =>
    store.explainScheduling(project.id).tasks.find((entry) => entry.taskId === dependent.id)!
      .reasons;
  assert.ok(dependencyReasons().some((reason) => reason.code === 'dependency'));
  store.completeExternalTask(done.id, evidence(81));
  assert.equal(
    dependencyReasons().some((reason) => reason.code === 'dependency'),
    false,
  );
  const issueOnly = prepare(task('Synthetic issue-only external delivery'), undefined);
  store.completeExternalTask(issueOnly.id, evidence(82));
  assert.equal(store.task(issueOnly.id).pr, undefined);
  const unknown = prepare(task('Synthetic unknown delivery relationship'), 81);
  store.updateTask(unknown.id, {
    externalCompletionPendingReason: 'Synthetic relationship read unavailable',
    prReadFailure: { status: 'unknown', checkedAt: at, reason: 'Synthetic read unavailable' },
  });
  const issueUnknown = task('Synthetic completed Issue with unknown merge result');
  store.updateTask(issueUnknown.id, {
    stage: 'developing',
    control: 'paused',
    issue: 75,
    issueState: 'completed',
    externalCompletionPendingReason: 'Synthetic closer proof unavailable',
  });
  const later = prepare(task('Synthetic external delivery with later incident'), 81);
  store.completeExternalTask(later.id, evidence(81));
  const freshIncident = store.createIncident({
    projectId: project.id,
    taskId: later.id,
    phase: 'sync',
    message: 'Synthetic new incident after external delivery',
  });
  store.updateIncident(freshIncident.id, { status: 'waiting_user' });
  return { project, done, issueOnly, unknown, issueUnknown, later, repo, oldHead, remoteHead };
}

async function expandReceipt(page: Page) {
  const fold = page.locator('.task-receipt-details');
  if (!(await fold.evaluate((element) => element.hasAttribute('open'))))
    await fold.locator(':scope > summary').click();
  await page.locator('.receipt').waitFor();
}

async function assertDevelopmentControlsClosed(page: Page) {
  const controls = page.locator('.task-controls');
  if (!(await controls.evaluate((element) => element.hasAttribute('open'))))
    await controls.locator(':scope > summary').click();
  await controls.locator('.task-interventions').waitFor({ state: 'attached' });
  assert.equal(
    await controls
      .getByRole('button', {
        name: /恢复任务|换人|取消任务|Resume task|Reassign|Cancel task/,
      })
      .count(),
    0,
  );
}

export async function checkExternalDelivery(
  artifacts = resolve(process.env.PHANTOM_BROWSER_ARTIFACTS ?? 'test-results'),
) {
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), 'phantom-browser-external-'));
  const store = new Store(':memory:');
  const fixtures = syntheticExternalFixtures(store);
  let remoteCalls = 0;
  let agentCalls = 0;
  class OfflineGitHub extends GitHub {
    override async api<T = unknown>(): Promise<T> {
      remoteCalls++;
      throw new Error('Synthetic browser fixture forbids GitHub access');
    }
  }
  const denyAgent = (): never => {
    agentCalls++;
    throw new Error('Synthetic browser fixture forbids model access');
  };
  const ws = new Workspaces(join(root, 'workspaces'), store);
  const engine = new Engine(store, new OfflineGitHub(store), ws, root, denyAgent);
  const previews = new Previews(store, ws);
  const port = await new Promise<number>((done, fail) => {
    const probe = createServer().once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      assert.ok(address && typeof address !== 'string');
      probe.close((error) => (error ? fail(error) : done(address.port)));
    });
  });
  const app = createApp(store, engine, previews, port, denyAgent, denyAgent);
  app.addHook('onRequest', async (request, reply) => {
    if (/^\/api\/(agents\/|health(?:\?|$))/.test(request.url))
      return reply.code(403).send({ error: 'Synthetic fixture disables agent probes' });
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const errors: string[] = [];
  try {
    const origin = await app.listen({ host: '127.0.0.1', port });
    browser = await chromium.launch({
      headless: true,
      channel: process.platform === 'win32' ? 'msedge' : undefined,
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/#/p/${fixtures.project.id}`);
    await page.locator('.workspace-header > strong').waitFor();
    for (const locale of ['zh-CN', 'en'] as const) {
      await choosePreference(page, 'language', locale);
      const copy = locale === 'en' ? pagesEn : pagesZh;
      for (const theme of ['light', 'dark'] as const) {
        await choosePreference(page, 'theme', theme);
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
          const capture = async (view: string) => {
            if (view !== 'list') await page.locator('.task-header').scrollIntoViewIfNeeded();
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              true,
              `synthetic ${view}/${width}/${locale}/${theme} fits viewport`,
            );
            await page.screenshot({
              path: resolve(
                artifacts,
                `external-synthetic-${view}-${width}-${locale}-${theme}.png`,
              ),
            });
          };
          await openPage(page, 'work');
          for (const item of [fixtures.done, fixtures.issueOnly]) {
            const row = page.locator('.work-row').filter({ hasText: item.title });
            assert.match((await row.getAttribute('class')) ?? '', /group-delivered/);
          }
          await capture('list');
          for (const [item, pr] of [
            [fixtures.done, 81],
            [fixtures.issueOnly, 82],
          ] as const) {
            await openTask(page, item.title);
            const taskPage = page.locator('.task-page');
            assert.equal(
              await taskPage.locator('.task-status-group').innerText(),
              copy['receipt.external'],
            );
            await expandReceipt(page);
            const receipt = page.locator('.receipt');
            await receipt.getByRole('heading', { name: copy['receipt.external'] }).waitFor();
            assert.equal(await receipt.locator('.test-evidence').count(), 0);
            assert.equal(await receipt.locator('.receipt-review').count(), 0);
            assert.equal(
              await receipt.getByText(copy['receipt.notRecorded'], { exact: true }).count(),
              2,
            );
            assert.ok((await receipt.innerText()).includes(fixtures.remoteHead.slice(0, 7)));
            const prUrl = `https://github.com/${fixtures.repo.github}/pull/${pr}`;
            assert.ok(await receipt.locator(`a[href="${prUrl}"]`).count());
            assert.equal(await taskPage.locator('.task-experience a').getAttribute('href'), prUrl);
            const controls = taskPage.locator('.task-controls');
            if (!(await controls.evaluate((element) => element.hasAttribute('open'))))
              await controls.locator(':scope > summary').click();
            await controls.locator(`a[href="${prUrl}"]`).waitFor();
            assert.equal(
              await taskPage
                .getByRole('button', {
                  name: /恢复任务|换人|取消任务|Resume task|Reassign|Cancel task/,
                })
                .count(),
              0,
            );
            assert.equal(await taskPage.locator('.task-owner-context textarea').count(), 0);
            assert.equal(
              await taskPage
                .locator('.task-receipt-details .runtime-badge')
                .filter({ hasText: /Recovery pending|等待恢复|Open incident|有待处理事件/ })
                .count(),
              0,
              'superseded history creates no current incident or recovery badge',
            );
            await capture(pr === 81 ? 'done' : 'issue-only');
          }
          await openTask(page, fixtures.unknown.title);
          const status = page.locator('.task-status');
          assert.equal(await status.getAttribute('data-external-pending'), 'true');
          assert.ok((await status.innerText()).includes(copy['task.remoteMerged']));
          assert.equal(await status.getAttribute('data-hold'), 'blocked');
          assert.equal(
            await status.locator('.task-status-group').evaluate((element) => {
              const probe = document.createElement('span');
              probe.style.color = 'var(--warning)';
              document.body.append(probe);
              const expected = getComputedStyle(probe).color;
              probe.remove();
              return getComputedStyle(element).color === expected;
            }),
            true,
            'unknown relationship uses the warning tone',
          );
          await assertDevelopmentControlsClosed(page);
          await capture('unknown');
          await openTask(page, fixtures.issueUnknown.title);
          await expandReceipt(page);
          await page.locator('.receipt').getByText(copy['receipt.mergeUnknown']).waitFor();
          assert.equal(
            await page
              .locator('.receipt')
              .getByText(copy['receipt.notMerged'], { exact: true })
              .count(),
            0,
          );
          await assertDevelopmentControlsClosed(page);
          await capture('issue-unknown');
        }
      }
    }
    await choosePreference(page, 'language', 'en');
    await openPage(page, 'conversation');
    await page
      .getByText(/was delivered externally/i)
      .first()
      .waitFor();
    await openTask(page, fixtures.done.title);
    await openSection(page, 'task.tab.process');
    assert.equal(await page.locator('.task-owner-context textarea').count(), 0);
    await openPage(page, 'conversation');
    await page
      .locator('.project-actions > details > summary')
      .getByText('Technical records', { exact: true })
      .click();
    await page
      .locator('.project-actions')
      .getByText('Synthetic new incident after external delivery')
      .first()
      .waitFor();
    await openTask(page, fixtures.later.title);
    await page
      .locator('.task-receipt-details .runtime-badge')
      .filter({ hasText: 'Open incident' })
      .waitFor();
    const originalDelivery = structuredClone(store.task(fixtures.later.id));
    const decision = store.createIncident({
      projectId: fixtures.project.id,
      taskId: fixtures.later.id,
      phase: 'synthetic-followup-decision',
      message: 'Synthetic follow-up decision after external delivery',
    });
    store.updateIncident(decision.id, {
      status: 'waiting_user',
      descriptor: { code: 'incident_waiting_user' },
    });
    await page.reload();
    const decisionCard = page.locator(`#project-request-${decision.id}`);
    await decisionCard.getByRole('button', { name: 'Mark resolved', exact: true }).waitFor();
    const response = page.waitForResponse((value) =>
      value.url().endsWith(`/incidents/${decision.id}/resolve`),
    );
    await decisionCard.getByRole('button', { name: 'Mark resolved', exact: true }).click();
    assert.equal((await response).status(), 200);
    assert.equal(store.get('incident', decision.id)?.status, 'resolved');
    assert.deepEqual(store.task(fixtures.later.id), originalDelivery);
    assert.equal(store.task(fixtures.unknown.id).stage, 'developing');
    assert.equal(store.task(fixtures.unknown.id).control, 'paused');
    assert.equal(remoteCalls, 0);
    assert.equal(agentCalls, 0);
    assert.deepEqual(errors, []);
    console.log('External delivery browser checks passed with explicitly synthetic fixtures.');
  } finally {
    await browser?.close();
    await app.close();
    await previews.close();
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await checkExternalDelivery();
