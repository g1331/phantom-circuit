import { chromium } from 'playwright';
import { mkdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { Previews } from '../src/server/preview.ts';
import { createApp } from '../src/server/app.ts';
import { Codex } from '../src/server/codex.ts';

const artifacts = resolve('test-results');
await mkdir(artifacts, { recursive: true });
const store = new Store(':memory:');
const imageState = await mkdtemp(join(tmpdir(), 'phantom-browser-images-'));
const ws = new Workspaces(resolve('.cache/browser-workspaces'), store);
class OfflinePM extends Codex {
  override async start() {
    throw new Error('Browser fixture: PM offline');
  }
}
const engine = new Engine(store, new GitHub(store), ws, imageState, () => new OfflinePM());
const app = createApp(store, engine, new Previews(store, ws), 4318);
await app.listen({ host: '127.0.0.1', port: 4318 });
const browser = await chromium.launch({
  headless: true,
  channel: process.platform === 'win32' ? 'msedge' : undefined,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
  reducedMotion: 'reduce',
});
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto('http://127.0.0.1:4318');
  await page.getByText('从一个项目开始。').waitFor();
  await page.screenshot({ path: resolve(artifacts, '01-empty-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await page.getByLabel('项目名称', { exact: true }).fill('Orbit Studio');
  await page.getByLabel('项目目标').fill('让每一次产品迭代，都从明确的需求开始。');
  await page.getByRole('dialog').getByRole('button', { name: '创建项目', exact: true }).click();
  await page.getByRole('heading', { name: 'Orbit Studio', exact: true }).waitFor();
  const project = store.list('project')[0];
  const imageFile = {
    name: 'screenshot.png',
    mimeType: 'image/png',
    buffer: await readFile(resolve(artifacts, '01-empty-desktop.png')),
  };
  await page.getByLabel('选择图片').setInputFiles(imageFile);
  await page.getByRole('img', { name: '待发送：screenshot.png' }).waitFor();
  await page.getByRole('button', { name: '移除 screenshot.png' }).click();
  assert.equal(await page.getByRole('img', { name: '待发送：screenshot.png' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '发送消息' }).isDisabled(), true);
  await page
    .getByLabel('选择图片')
    .setInputFiles([imageFile, { ...imageFile, name: 'second.png' }]);
  assert.equal(await page.locator('.image-drafts img').count(), 2);
  let uploads = 0;
  let releaseUpload!: () => void;
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  await page.route('**/api/projects/*/messages', async (route) => {
    uploads++;
    await uploadGate;
    await route.continue();
  });
  await page.getByRole('button', { name: '发送消息' }).click();
  assert.equal(await page.getByRole('button', { name: '发送消息' }).isDisabled(), true);
  await page.keyboard.press('Control+Enter');
  assert.equal(uploads, 1);
  releaseUpload();
  await page.locator('.message-images img').first().waitFor();
  await page.unroute('**/api/projects/*/messages');
  await page.reload();
  await page.locator('.message-images img').first().waitFor();
  assert.equal(await page.locator('.message-images img').count(), 2);
  assert.equal(
    await page
      .locator('.message-images img')
      .first()
      .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    true,
  );
  await page.getByRole('button', { name: '重新发送' }).first().click();
  assert.equal(await page.locator('.message-images img').count(), 2);
  await page
    .getByLabel('选择图片')
    .setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('broken') });
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.getByText('图片损坏、格式不支持或超过 2500 万像素限制', { exact: true }).waitFor();
  assert.equal(await page.locator('.message-images img').count(), 2);
  await page.getByRole('button', { name: '移除 broken.png' }).click();
  await page
    .getByLabel('选择图片')
    .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') });
  await page.getByText('仅支持 PNG、JPEG、WebP 图片', { exact: true }).waitFor();
  assert.equal(await page.locator('.image-drafts img').count(), 0);
  await page.getByLabel('给 PM 的消息').fill('图片说明');
  await page.getByLabel('选择图片').setInputFiles(imageFile);
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.getByText('图片说明', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(artifacts, '07-images-desktop.png'), fullPage: true });
  const repo = store.createRepo({
    projectId: project.id,
    name: 'orbit-web',
    path: '/fixture/web',
    github: 'example/orbit-web',
    authorized: true,
    defaultBranch: 'main',
  });
  store.createRepo({
    projectId: project.id,
    name: 'orbit-service-long-repository-name',
    path: '/fixture/service',
    github: 'example/very-long-repository-name-for-responsive-validation',
    authorized: true,
    defaultBranch: 'main',
  });
  store.addMessage(
    project.id,
    'user',
    '我想让新用户更容易完成第一次项目创建。我们先讨论体验。',
    'discuss',
  );
  store.addMessage(
    project.id,
    'assistant',
    '可以。我们先明确用户第一次进入时，最需要完成什么。\n\n我建议先聚焦“创建项目 → 接入仓库 → 提出第一个需求”。仓库保持关闭，我们把体验聊清楚后再开工。',
  );
  const source = store.addMessage(
    project.id,
    'user',
    '请实现项目创建流程，并简化接入仓库的提示。',
    'implement',
  );
  const makeTask = (title: string) =>
    store.createTask({
      projectId: project.id,
      repoId: repo.id,
      sourceMessageId: source.id,
      title,
      spec: '让用户可以完成项目创建并理解下一步。',
      acceptance: ['可以创建项目', '空状态引导清晰'],
      dependencies: [],
      kind: 'frontend',
      complexity: 'normal',
      priority: 0,
    });
  const done = makeTask('完成首次项目创建体验');
  store.updateTask(done.id, { stage: 'done' });
  const task = makeTask('简化仓库接入与授权提示');
  store.updateTask(task.id, { stage: 'developing' });
  store.run('dev', project.id, 'frontend', task);
  makeTask('支持体验反馈与持续迭代');
  store.event('fixture', '浏览器验证场景已准备', { projectId: project.id });
  await page.getByRole('switch', { name: 'orbit-web 开工开关', exact: true }).waitFor();
  await page.screenshot({ path: resolve(artifacts, '02-workspace-dark.png'), fullPage: true });
  await page.getByRole('switch', { name: 'orbit-web 开工开关', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="orbit-web 开工开关"]')?.getAttribute('aria-checked') ===
      'true',
  );
  await page.getByRole('switch', { name: 'orbit-web 开工开关', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="orbit-web 开工开关"]')?.getAttribute('aria-checked') ===
      'false',
  );
  assert.equal(store.repo(repo.id).enabled, false);
  assert.equal(store.activeRuns().filter((r) => r.role === 'dev').length, 1);
  await page.getByRole('tab', { name: '任务', exact: false }).click();
  await page.getByRole('button', { name: /简化仓库接入与授权提示/ }).click();
  await page.getByRole('heading', { name: '验收条件' }).waitFor();
  await page.screenshot({ path: resolve(artifacts, '03-task-detail.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭窗口' }).click();
  await page.getByLabel('搜索任务').fill('不会匹配');
  await page.getByText('还没有匹配的任务').waitFor();
  await page.getByLabel('搜索任务').fill('');
  await page.getByRole('tab', { name: '与 PM 讨论' }).click();
  await page.getByRole('button', { name: '浅色外观' }).click();
  await page.screenshot({ path: resolve(artifacts, '04-workspace-light.png'), fullPage: true });
  await page.getByRole('button', { name: '运行设置' }).click();
  await page.getByLabel('全局 Dev 上限').fill('3');
  await page.getByRole('button', { name: '保存设置' }).click();
  assert.equal(store.settings().globalDevLimit, 3);
  await page.reload();
  await page.getByRole('heading', { name: 'Orbit Studio', exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByLabel('选择图片')
    .setInputFiles(
      Array.from({ length: 4 }, (_, i) => ({
        ...imageFile,
        name: `手机截图-${i}-很长的文件名用于验证换行.png`,
      })),
    );
  assert.equal(await page.locator('.image-drafts img').count(), 4);
  await page.screenshot({
    path: resolve(artifacts, '08-images-mobile-preview.png'),
    fullPage: true,
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByLabel('给 PM 的消息').fill('窄屏图片反馈');
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.getByText('窄屏图片反馈', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(artifacts, '05-mobile-light.png'), fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    'mobile must not overflow horizontally',
  );
  await page.getByRole('button', { name: '深色外观' }).click();
  await page.getByRole('button', { name: '运行设置' }).click();
  await page.screenshot({
    path: resolve(artifacts, '06-mobile-settings.png'),
    fullPage: false,
    animations: 'disabled',
  });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Browser checks passed: image preview/removal, image-only and text/image send, upload errors, duplicate prevention, retry, reload, four-image 390px layout; project creation, claim switch/drain, task details, search, settings, dark/light. Screenshots in test-results/.',
  );
} finally {
  await page.close();
  await browser.close();
  await app.close();
  await engine.stop();
  store.close();
  await rm(imageState, { recursive: true, force: true });
}
