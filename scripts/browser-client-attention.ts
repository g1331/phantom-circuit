import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
import { openPage, openTask } from './browser-pages.ts';
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
  await openPage(page, 'home');
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
        await openPage(page, 'home');
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
          .getByRole('heading', { name: copy['task.progress.paused'], exact: true })
          .waitFor();
        await page.locator('.task-controls > summary').click();
        await page
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
  await page.getByRole('button', { name: 'Resume task', exact: true }).click();
  assert.equal((await resumed).ok(), true);
  assert.equal(store.task(paused.id).control, 'active');
  console.log('Client attention: synthetic question/internal hold/user pause matrix passed.');
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
