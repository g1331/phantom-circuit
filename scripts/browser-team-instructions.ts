import { checkRetrospective } from './browser-retrospective.ts';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { Store } from '../src/server/store.ts';
import { Engine } from '../src/server/engine.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Previews } from '../src/server/preview.ts';
import { createApp } from '../src/server/app.ts';
import { profileProtocol } from '../tests/profile-protocol.ts';
import { choosePreference } from './browser-preferences.ts';

export async function checkTeamInstructions() {
  const store = new Store(':memory:');
  const project = store.createProject('团队说明验证', '查看、修改和恢复项目团队的工作约定。');
  const sections = {
    repository: '遵循仓库的 conventional commits。',
    engineering: '先验证失败，再修复问题。\n使用真实临时 Git 仓库检查完整生命周期。',
    delivery: '附上验证结果与用户可见的变化。',
  };
  store.saveTeamInstructions(project.id, sections, { source: 'team', baseVersion: 0 });
  const run = store.run('dev', project.id, 'backend');
  store.finishRun(run.id, 'completed');
  store.saveTeamInstructions(
    project.id,
    { ...sections, delivery: '附上验证结果、提交哈希和界面截图。' },
    { source: 'user', baseVersion: 1 },
  );
  const ws = new Workspaces(resolve('.phantom/browser-team-instructions'), store);
  const engine = new Engine(
    store,
    new GitHub(store),
    ws,
    resolve('.phantom/browser-team-instructions'),
  );
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
  const artifacts = resolve('test-results');
  await mkdir(artifacts, { recursive: true });
  try {
    const context = await browser.newContext({ locale: 'zh-CN', reducedMotion: 'reduce' });
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
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${origin}/#/p/${project.id}/project`);
    const panel = page.getByRole('region', { name: '团队说明', exact: true });
    await panel.getByRole('button', { name: '编辑说明' }).click();
    await panel.getByLabel('工程做法', { exact: true }).fill('通过界面保存的新工程做法。');
    await panel.getByRole('button', { name: '保存新版本' }).click();
    await panel.getByText('通过界面保存的新工程做法。', { exact: true }).waitFor();
    assert.equal(store.currentTeamInstructions(project.id).version, 3);
    await panel.getByRole('button', { name: '编辑说明' }).click();
    await panel.getByLabel('工程做法', { exact: true }).fill('x'.repeat(16001));
    assert.equal(await panel.getByRole('button', { name: '保存新版本' }).isDisabled(), true);
    await panel.getByRole('button', { name: '取消', exact: true }).click();
    await panel.locator('summary').filter({ hasText: '版本历史' }).click();
    await panel.locator('summary').filter({ hasText: /^v1 ·/ }).click();
    await panel.getByRole('button', { name: '将 v1 恢复为新版本', exact: true }).click();
    await panel
      .locator('summary')
      .filter({ hasText: '当前说明' })
      .getByText('v4', { exact: true })
      .waitFor();
    assert.deepEqual(store.currentTeamInstructions(project.id).sections, sections);
    // History stays immutable, including the version previously used by the Dev.
    assert.equal(store.runTeamInstructions(run).version, 1);
    await panel.locator('summary').filter({ hasText: '比较版本' }).click();
    await panel.getByLabel('修改前', { exact: true }).selectOption('2');
    await panel.getByLabel('修改后', { exact: true }).selectOption('4');
    await panel.locator('.team-instruction-comparison').waitFor();
    for (const width of [1440, 1366, 1280, 390]) {
      for (const theme of ['dark', 'light']) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        await choosePreference(page, 'theme', theme);
        await panel.scrollIntoViewIfNeeded();
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${width}/${theme}: no horizontal overflow`,
        );
        for (const part of ['current', 'history', 'diff']) {
          const label = { current: '当前说明', history: '版本历史', diff: '比较版本' }[part]!;
          const fold = panel
            .locator(':scope > details')
            .filter({ has: page.locator('summary').filter({ hasText: label }) });
          await fold
            .locator(':scope > summary')
            .evaluate((element) => element.scrollIntoView({ block: 'start' }));
          await page.screenshot({
            path: resolve(artifacts, `team-instructions-${width}-${theme}-${part}.png`),
            fullPage: false,
          });
        }
        await panel.getByRole('button', { name: '编辑说明' }).click();
        await panel
          .locator('form')
          .evaluate((element) => element.scrollIntoView({ block: 'start' }));
        await page.screenshot({
          path: resolve(artifacts, `team-instructions-${width}-${theme}-editor.png`),
          fullPage: false,
        });
        await panel.getByRole('button', { name: '取消', exact: true }).click();
      }
    }
    await checkRetrospective(page, store, project.id, origin, artifacts);
    // The version and its historical text are available in the Run itself.
    await page.goto(`${origin}/#/p/${project.id}/project/runs`);
    await page.locator('.run-row > details > summary, .run-log .fold > summary').first().click();
    const used = page.locator('summary').filter({ hasText: '本次运行使用的团队说明' });
    await used.click();
    await page.getByText(sections.delivery, { exact: true }).waitFor();
    await page.screenshot({
      path: resolve(artifacts, 'team-instructions-run-version.png'),
      fullPage: false,
    });
    assert.deepEqual(errors, []);
    console.log(
      'Team instructions browser checks passed: edit, length limit, history, restore, comparisons, pinned Run text; 1440/1366/1280/390 dark and light screenshots.',
    );
  } finally {
    await browser.close();
    await app.close();
    await engine.stop();
    store.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await checkTeamInstructions();
