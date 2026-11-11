import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import { Store } from '../src/server/store.ts';
import { Engine } from '../src/server/engine.ts';
import { Codex } from '../src/server/codex.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Previews } from '../src/server/preview.ts';
import { createApp } from '../src/server/app.ts';
import { profileProtocol } from '../tests/profile-protocol.ts';
import type { Message, Project, Repo } from '../src/shared/types.ts';
import { pagesEn, pagesZh } from '../src/web/locale/pages.ts';
import { clickInSidebar, openPage, openTask } from './browser-pages.ts';
import { choosePreference } from './browser-preferences.ts';

export async function checkClientAttention({
  page,
  store,
  project,
  repo,
  source,
  artifacts,
}: {
  page: Page;
  store: Store;
  project: Project;
  repo: Repo;
  source: Message;
  artifacts: string;
}) {
  const tasks = [
    '登记结果待核对',
    '验证排查已启动',
    '等待排查名额',
    '发布范围待确认',
    '暂缓新入口',
  ].map((title) =>
    store.createTask({
      projectId: project.id,
      repoId: repo.id,
      sourceMessageId: source.id,
      title,
      spec: 'Synthetic client-attention UI fixture',
      acceptance: [],
      dependencies: [],
      kind: 'frontend',
      complexity: 'normal',
      priority: 0,
    }),
  );
  const [blocked, running, queued, question, paused] = tasks;
  for (const task of tasks)
    store.updateTask(task.id, {
      stage: 'developing',
      control: 'paused',
      blocked: 'Synthetic diagnostic retained verbatim',
      pausedByUser: task.id === paused.id,
    });
  const legacy = store.createIncident({
    projectId: project.id,
    taskId: blocked.id,
    phase: 'sync',
    message: 'Synthetic registration outcome uncertain',
  });
  store.updateIncident(legacy.id, { status: 'waiting_user' });
  const validation = store.createIncident({
    projectId: project.id,
    taskId: running.id,
    phase: 'validation',
    message: 'Synthetic failed validation',
  });
  store.run('dev', project.id, 'frontend', store.task(running.id), { incidentId: validation.id });
  const interrupted = store.run('dev', project.id, 'frontend', store.task(queued.id));
  store.finishRun(interrupted.id, 'interrupted');
  store.put('recovery', 'client-attention-recovery', {
    id: 'client-attention-recovery',
    projectId: project.id,
    taskId: queued.id,
    oldRunId: interrupted.id,
    runId: interrupted.id,
    status: 'pending',
    policy: 'automatic',
    pauseProvenance: 'runtime',
    createdAt: queued.createdAt,
    updatedAt: queued.updatedAt,
  });
  const clarification = store.createClarification({
    projectId: project.id,
    taskId: question.id,
    sourceMessageId: source.id,
    sourceIntent: 'implement',
    questions: [{ id: 'scope', question: '本次先向哪些用户开放？' }],
  });
  await page.reload();
  await openPage(page, 'conversation');
  await page.locator('.project-actions .clarification-card textarea').waitFor();
  assert.equal(
    await page
      .locator('.project-actions .action-record:not(.clarification-card) textarea:visible')
      .count(),
    0,
    'everyday conversation keeps internal diagnostic guidance behind technical records',
  );
  assert.equal(
    await page
      .locator('.project-actions .action-record:not(.clarification-card) button:visible')
      .count(),
    0,
    'automatic recovery does not request manual handling in everyday conversation',
  );
  for (const locale of ['zh-CN', 'en'] as const) {
    await choosePreference(page, 'language', locale);
    const copy = locale === 'en' ? pagesEn : pagesZh;
    for (const theme of ['light', 'dark'] as const) {
      await choosePreference(page, 'theme', theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        const capture = async (view: string) => {
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          await page.screenshot({
            path: resolve(artifacts, `attention-${view}-${width}-${locale}-${theme}.png`),
          });
        };
        await openPage(page, 'conversation');
        await page.locator('.project-actions .clarification-card textarea').waitFor();
        assert.equal(
          await page
            .locator('.project-actions .action-record:not(.clarification-card) button:visible')
            .count(),
          0,
        );
        await capture('home');
        await openPage(page, 'work');
        await page.locator('.group-needs_you .work-row').waitFor();
        assert.equal(await page.locator('.group-needs_you .work-row').count(), 1);
        assert.equal(
          await page.locator('.project-pages:visible .page-work .page-badge').textContent(),
          '1',
        );
        assert.ok(
          (await page.locator('.group-needs_you .work-row').textContent())?.includes(
            '本次先向哪些用户开放？',
          ),
        );
        for (const [task, hold] of [
          [blocked, 'blocked'],
          [running, 'running'],
          [queued, 'queued'],
        ] as const) {
          const row = page.locator('.work-row').filter({ hasText: task.title });
          assert.ok((await row.textContent())?.includes(copy[`work.hold.${hold}`]));
          assert.ok((await row.getAttribute('class'))?.includes('group-moving'));
        }
        await capture('work');
        await page.evaluate((id) => {
          location.hash = `#/p/${id}/brief`;
        }, project.id);
        await page.locator('.brief-page .brief-needs .brief-request').waitFor();
        assert.equal(await page.locator('.brief-page .brief-needs .brief-request').count(), 1);
        assert.ok(
          !(await page.locator('.brief-page .brief-needs').textContent())?.includes(blocked.title),
        );
        await capture('brief');
        await openPage(page, 'team');
        await page.locator('.team-request').waitFor();
        assert.equal(await page.locator('.team-request').count(), 1);
        await capture('team');
        for (const [task, hold] of [
          [blocked, 'blocked'],
          [running, 'running'],
          [queued, 'queued'],
        ] as const) {
          await openTask(page, task.title);
          await page
            .locator('.task-page')
            .getByRole('heading', { name: copy[`work.hold.${hold}`], exact: true })
            .waitFor();
          await capture(hold);
        }
        await openTask(page, question.title);
        await page.locator('.task-decisions').getByText('本次先向哪些用户开放？').waitFor();
        assert.equal((await page.locator('.project-actions textarea').count()) > 0, true);
        await capture('question');
        await openTask(page, paused.title);
        await page
          .locator('.task-page')
          .getByRole('heading', { name: copy['task.progress.paused'], exact: true })
          .waitFor();
        await page.locator('.task-controls > summary').click();
        await page
          .locator('.task-page')
          .getByRole('button', { name: locale === 'en' ? 'Resume task' : '恢复任务', exact: true })
          .waitFor();
        await capture('paused');
      }
    }
  }
  await openTask(page, blocked.title);
  await page.locator('.task-blocker > summary').click();
  await page
    .locator('.task-blocker')
    .getByText('Synthetic diagnostic retained verbatim', { exact: true })
    .waitFor();
  await openTask(page, question.title);
  await page.locator('.task-workspace .clarification-card textarea').fill('Internal testers first');
  const answered = page.waitForResponse((r) =>
    r.url().endsWith(`/clarifications/${clarification.id}/answer`),
  );
  await page.locator('.task-workspace .clarification-card .primary-button').click();
  assert.equal((await answered).ok(), true);
  assert.equal(store.get('clarification', clarification.id)?.status, 'answered');
  await openTask(page, paused.title);
  await page.locator('.task-controls > summary').click();
  const resumed = page.waitForResponse((r) => r.url().includes(`/tasks/${paused.id}/resume`));
  await page
    .locator('.task-page')
    .getByRole('button', { name: 'Resume task', exact: true })
    .click();
  assert.equal((await resumed).ok(), true);
  assert.equal(store.task(paused.id).control, 'active');
  await checkProjectQuestion(page, store, artifacts);
  await checkBriefProjectIsolation(page, store, artifacts);
  console.log('Client attention: synthetic question/internal hold/user pause matrix passed.');
}

export async function checkBriefProjectIsolation(page: Page, store: Store, artifacts: string) {
  const first = store.createProject('Seen project', '');
  const second = store.createProject('New delivery project', '');
  const repo = store.createRepo({
    projectId: second.id,
    name: 'Brief fixture',
    path: `/fixture/brief-${second.id}`,
    github: `fixture/brief-${second.id}`,
    defaultBranch: 'main',
    authorized: true,
  });
  const source = store.addMessage(second.id, 'user', 'Deliver this request', 'implement');
  const task = store.createTask({
    projectId: second.id,
    repoId: repo.id,
    sourceMessageId: source.id,
    title: 'Delivery since the last visit',
    spec: 'Synthetic delivery',
    acceptance: [],
    dependencies: [],
    kind: 'frontend',
    complexity: 'normal',
    priority: 0,
  });
  store.updateTask(task.id, { stage: 'done' });
  await page.evaluate(
    ({ first, second }) => {
      localStorage.setItem(`phantom.seen.${first}`, '2099-01-01T00:00:00.000Z');
      localStorage.setItem(`phantom.seen.${second}`, '2000-01-01T00:00:00.000Z');
    },
    { first: first.id, second: second.id },
  );
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/?brief-isolation-fixture=1#/p/${first.id}`);
  await openPage(page, 'brief');
  await page.locator('.brief-page .brief').waitFor();
  await clickInSidebar(page, second.name);
  await page.locator('.workspace-header > strong').filter({ hasText: second.name }).waitFor();
  await page.locator('.drawer-scrim').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.home-brief').count(), 0);
  await openPage(page, 'brief');
  await page.locator('.brief-page .brief-delivered li').waitFor();
  assert.equal(await page.locator('.brief-page .brief-delivered li').count(), 1);
  await page.screenshot({ path: resolve(artifacts, 'brief-project-isolation.png') });
  await page.locator('.brief-page .brief-seen').click();
  await page.locator('.brief-page .brief-last').waitFor();
  assert.notEqual(
    await page.evaluate((id) => localStorage.getItem(`phantom.seen.${id}`), second.id),
    '2000-01-01T00:00:00.000Z',
    'acknowledging the selected project records its new visit',
  );
  const seen = await page.evaluate((id) => localStorage.getItem(`phantom.seen.${id}`), first.id);
  assert.equal(
    seen,
    '2099-01-01T00:00:00.000Z',
    'acknowledging one project leaves the other unchanged',
  );
}

export async function checkProjectQuestion(page: Page, store: Store, artifacts: string) {
  const project = store.createProject('Project question', 'A decision before tasks exist');
  const source = store.addMessage(project.id, 'user', 'Choose the audience', 'discuss');
  for (let index = 0; index < 80; index++)
    store.addMessage(project.id, 'assistant', `Earlier discussion ${index}`);
  const question = store.createClarification({
    projectId: project.id,
    sourceMessageId: source.id,
    sourceIntent: 'discuss',
    questions: [{ id: 'audience', question: 'Which audience starts first?' }],
  });
  const repo = store.createRepo({
    projectId: project.id,
    name: 'Question fixture',
    path: `/fixture/project-question-${project.id}`,
    github: `fixture/project-question-${project.id}`,
    defaultBranch: 'main',
    authorized: true,
  });
  const cancelledSource = store.addMessage(project.id, 'user', 'Cancel this request', 'implement');
  const cancelled = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: cancelledSource.id,
    title: 'Cancelled request',
    spec: 'Synthetic cancelled request',
    acceptance: [],
    dependencies: [],
    kind: 'frontend',
    complexity: 'normal',
    priority: 0,
  });
  store.updateTask(cancelled.id, { stage: 'cancelled' });
  const original = store.list('message').filter((message) => message.projectId === project.id);
  const alternate = store.createProject('Question route staging', '');
  const origin = new URL(page.url()).origin;
  let visit = 0;
  const viewportChecks: Record<
    string,
    { top: number; bottom: number; viewportTop: number; viewportBottom: number }
  > = {};
  const openQuestionEntry = async (entryPoint: 'work' | 'brief' | 'team') => {
    // Start from a mounted conversation at its latest messages, then leave and follow the
    // request link. A cold page with no reading anchor misses this regression.
    await page.goto(`${origin}/?question-entry=${++visit}#/p/${project.id}/conversation`);
    await page.getByText('Earlier discussion 79', { exact: true }).waitFor();
    await page.locator('.history-control [role="status"]').waitFor({ state: 'detached' });
    await page.waitForFunction(() => {
      const conversation = document.querySelector('.conversation');
      return (
        conversation &&
        conversation.scrollHeight - conversation.clientHeight - conversation.scrollTop <= 1
      );
    });
    await page.evaluate((id) => {
      location.hash = `#/p/${id}/team`;
    }, alternate.id);
    await page.locator('.team-empty').first().waitFor();
    await page.evaluate(
      ({ id, entryPoint }) => {
        location.hash = `#/p/${id}/${entryPoint}`;
      },
      { id: project.id, entryPoint },
    );
  };
  await page.goto(`${origin}/?project-question-fixture=1#/p/${project.id}/work`);
  for (const locale of ['zh-CN', 'en'] as const) {
    await choosePreference(page, 'language', locale);
    const copy = locale === 'en' ? pagesEn : pagesZh;
    for (const theme of ['light', 'dark'] as const) {
      await choosePreference(page, 'theme', theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        await openQuestionEntry('work');
        const entry = page.locator('.group-needs_you .work-row');
        await entry
          .getByText('Which audience starts first?', { exact: true })
          .waitFor()
          .catch(async (error: unknown) => {
            console.error({
              url: page.url(),
              work: await page.locator('.work-page').textContent(),
              question: store.get('clarification', question.id),
            });
            await page.screenshot({ path: resolve(artifacts, 'project-question-failure.png') });
            throw error;
          });
        assert.equal(await entry.count(), 1);
        const search = page.getByLabel(copy['work.search'], { exact: true });
        await search.fill('no matching question');
        assert.equal(await entry.count(), 0);
        await search.fill('');
        await page.screenshot({
          path: resolve(artifacts, `project-question-work-${width}-${locale}-${theme}.png`),
        });
        await entry.click();
        const assertFocused = async (entryPoint: string) => {
          await page.waitForFunction(
            (id) => document.activeElement?.id === `project-request-${id}`,
            question.id,
          );
          await page.getByText('Earlier discussion 79', { exact: true }).waitFor();
          await page.locator('.history-control [role="status"]').waitFor({ state: 'detached' });
          // Check after the loaded history commits and layout observers have run. Focus alone
          // also passes when reading-anchor restoration has moved the form offscreen.
          await page.evaluate(
            () =>
              new Promise<void>((done) =>
                requestAnimationFrame(() => requestAnimationFrame(() => done())),
              ),
          );
          const bounds = await page
            .locator(`#project-request-${question.id} textarea`)
            .evaluate((input) => {
              const field = input.getBoundingClientRect();
              const viewport = input.closest('.conversation')!.getBoundingClientRect();
              return {
                top: field.top,
                bottom: field.bottom,
                viewportTop: viewport.top,
                viewportBottom: viewport.bottom,
              };
            });
          viewportChecks[`${entryPoint}-${width}-${locale}-${theme}`] = bounds;
          await page.screenshot({
            path: resolve(
              artifacts,
              `project-question-${entryPoint}-${width}-${locale}-${theme}.png`,
            ),
          });
          assert.ok(
            bounds.top >= bounds.viewportTop && bounds.bottom <= bounds.viewportBottom,
            `${entryPoint}: answer input must remain inside the conversation viewport: ` +
              JSON.stringify(bounds),
          );
        };
        await assertFocused('from-work');
        await page.screenshot({
          path: resolve(artifacts, `project-question-home-${width}-${locale}-${theme}.png`),
        });
        await openQuestionEntry('brief');
        await page.locator('.brief-page .brief-request .brief-link').waitFor();
        await page.screenshot({
          path: resolve(artifacts, `project-question-brief-${width}-${locale}-${theme}.png`),
        });
        await page.locator('.brief-page .brief-request .brief-link').click();
        await assertFocused('from-brief');
        await openQuestionEntry('team');
        const teamRequest = page.locator('.team-request');
        await teamRequest.waitFor();
        assert.equal(
          await page.locator('.team-more').count(),
          0,
          'cancelled work is not delivered',
        );
        const answer = teamRequest.getByRole('link', { name: copy['brief.inConversation'] });
        assert.equal(
          await answer.getAttribute('href'),
          `#/p/${project.id}/requests/${question.id}`,
        );
        await page.screenshot({
          path: resolve(artifacts, `project-question-team-${width}-${locale}-${theme}.png`),
        });
        await answer.click();
        await assertFocused('from-team');
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
      }
    }
  }
  await writeFile(
    resolve(artifacts, 'project-question-viewports.json'),
    JSON.stringify(viewportChecks, null, 2),
  );
  const card = page.locator(`#project-request-${question.id}`);
  await card.locator('textarea').fill('Internal testers');
  const answered = page.waitForResponse((response) =>
    response.url().endsWith(`/clarifications/${question.id}/answer`),
  );
  await card.locator('.primary-button').click();
  assert.equal((await answered).ok(), true);
  assert.equal(store.get('clarification', question.id)?.status, 'answered');
  await openPage(page, 'work');
  assert.equal(await page.locator('.group-needs_you').count(), 0);
  for (const message of original)
    assert.equal(store.get('message', message.id)?.content, message.content);
}

export async function checkAttentionBrowser() {
  const root = await mkdtemp(resolve(tmpdir(), 'attention-'));
  const artifacts = resolve(process.env.PHANTOM_BROWSER_ARTIFACTS ?? root);
  await mkdir(artifacts, { recursive: true });
  const store = new Store(':memory:');
  const project = store.createProject('Client attention fixture', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'Fixture',
    path: root,
    github: 'fixture/client-attention',
    defaultBranch: 'main',
    authorized: true,
  });
  const source = store.addMessage(project.id, 'user', 'Build the new entry', 'implement');
  const ws = new Workspaces(resolve(root, 'workspaces'), store);
  class OfflinePM extends Codex {
    override async start() {
      throw new Error('Synthetic browser fixture: no model calls');
    }
  }
  const engine = new Engine(store, new GitHub(store), ws, root, () => new OfflinePM());
  const port = await new Promise<number>((done, fail) => {
    const probe = createServer().once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture port');
      probe.close(() => done(address.port));
    });
  });
  const app = createApp(store, engine, new Previews(store, ws), port, profileProtocol);
  const origin = await app.listen({ host: '127.0.0.1', port });
  const browser = await chromium.launch({
    headless: true,
    channel: process.platform === 'win32' ? 'msedge' : undefined,
  });
  try {
    const page = await browser.newPage({ locale: 'zh-CN', reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/agents/*/models', (route) =>
      route.fulfill({ json: { available: true, models: [] } }),
    );
    await page.route('**/api/agents/*/allowance?*', (route) =>
      route.fulfill({ json: { state: 'unknown' } }),
    );
    await page.goto(origin);
    await page.evaluate((id) => localStorage.setItem('phantom.project', id), project.id);
    await page.reload();
    for (const locale of ['zh-CN', 'en'] as const) {
      await choosePreference(page, 'language', locale);
      for (const theme of ['light', 'dark'] as const) {
        await choosePreference(page, 'theme', theme);
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 844 });
          await page.goto(`${origin}/#/p/${project.id}/brief`);
          await page.locator('.brief-page .brief-empty').waitFor();
          await page.screenshot({
            path: resolve(artifacts, `attention-empty-${width}-${locale}-${theme}.png`),
          });
        }
      }
    }
    await checkClientAttention({ page, store, project, repo, source, artifacts });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await checkAttentionBrowser();
