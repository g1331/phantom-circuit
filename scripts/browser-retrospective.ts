import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import type { Store } from '../src/server/store.ts';
import { choosePreference } from './browser-preferences.ts';

export async function checkRetrospective(
  page: Page,
  store: Store,
  projectId: string,
  origin: string,
  artifacts: string,
) {
  const repo = store.createRepo({
    projectId,
    name: '复盘仓库',
    path: '/tmp/retrospective-fixture',
    github: 'fixture/retrospective',
    defaultBranch: 'main',
    authorized: true,
  });
  const source = store.addMessage(projectId, 'user', '修复预览服务并交付验证结果。', 'implement');
  const makeTask = (title: string) => {
    const task = store.createTask({
      projectId,
      repoId: repo.id,
      sourceMessageId: source.id,
      title,
      spec: title,
      acceptance: ['服务可用'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    store.updateTask(task.id, { stage: 'done', completionDeliveryPending: false });
    return task;
  };
  const task = makeTask('预览端口冲突后改进');
  const interruption = store.addMessage(
    projectId,
    'user',
    `任务 ${task.id} 的 3000 端口已占用，请团队自行找可用端口。`,
    'discuss',
  );
  const base = store.currentTeamInstructions(projectId);
  const proposed = {
    ...base.sections,
    engineering: '启动预览前检查端口；遇到占用时自行选择可用端口并验证。',
  };
  const first = store.recordRetrospective(task.id, {
    baseVersion: base.version,
    category: 'port_conflict',
    interruptionIds: [`message:${interruption.id}`],
    reason: '端口冲突由团队处理，减少用户打扰。',
    sections: proposed,
  });
  const other = makeTask('验证证据后改进');
  store.recordRetrospective(other.id, {
    baseVersion: base.version,
    category: 'missing_evidence',
    interruptionIds: [`message:${interruption.id}`],
    reason: '交付时附上已经完成的验证。',
    sections: { ...base.sections, delivery: '交付时附上已经完成的验证。' },
  });
  await page.goto(`${origin}/#/p/${projectId}/brief`);
  await page.getByRole('link', { name: '查看团队说明修改建议' }).waitFor();
  assert.match(await page.locator('.brief-needs:visible h3').innerText(), /1/);
  assert.equal(await page.getByRole('link', { name: '查看团队说明修改建议' }).count(), 1);
  for (const width of [1440, 1366, 1280, 390])
    for (const theme of ['dark', 'light']) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await choosePreference(page, 'theme', theme);
      await page
        .locator('.brief-page')
        .evaluate((e) => e.scrollIntoView({ block: 'start', behavior: 'instant' }));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({
        path: resolve(artifacts, `retrospective-brief-${width}-${theme}.png`),
      });
    }
  await page.getByRole('link', { name: '查看团队说明修改建议' }).click();
  const panel = page.getByRole('region', { name: '团队说明', exact: true });
  const fold = panel
    .locator(':scope > details')
    .filter({ has: page.locator(':scope > summary').filter({ hasText: '任务后改进' }) });
  await fold.locator('summary').filter({ hasText: '预览端口冲突后改进' }).click();
  await fold.getByText(interruption.content, { exact: true }).waitFor();
  assert.equal(store.currentTeamInstructions(projectId).version, base.version);
  for (const width of [1440, 1366, 1280, 390])
    for (const theme of ['dark', 'light']) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await choosePreference(page, 'theme', theme);
      await fold
        .locator(':scope > summary')
        .evaluate((e) => e.scrollIntoView({ block: 'start', behavior: 'instant' }));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({
        path: resolve(artifacts, `retrospective-${width}-${theme}-suggestions.png`),
      });
      await fold.getByRole('button', { name: '采用', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({
        path: resolve(artifacts, `retrospective-${width}-${theme}-decision.png`),
      });
    }
  await fold.getByRole('button', { name: '采用', exact: true }).click();
  await fold.getByText(`v${base.version + 1} · 已采用`, { exact: true }).waitFor();
  assert.equal(store.currentTeamInstructions(projectId).suggestionId, first.id);
  const history = panel
    .locator(':scope > details')
    .filter({ has: page.locator(':scope > summary').filter({ hasText: '版本历史' }) });
  await history.locator(':scope > summary').click();
  await history
    .locator('summary')
    .filter({ hasText: new RegExp(`^v${base.version + 1} ·`) })
    .click();
  await history.getByRole('link', { name: task.title, exact: true }).waitFor();

  await fold.locator('summary').filter({ hasText: '验证证据后改进' }).click();
  await fold.getByRole('button', { name: '忽略', exact: true }).click();
  await fold
    .locator('summary')
    .filter({ hasText: '验证证据后改进' })
    .getByText('已忽略', { exact: true })
    .waitFor();
  const autoSaved = page.waitForResponse(
    (response) => response.url().endsWith('/auto-adopt') && response.status() === 200,
  );
  await fold.getByRole('checkbox', { name: '自动采用今后的建议' }).check();
  await autoSaved;
  assert.equal(store.project(projectId).autoAdoptInstructions, true);
  await page.goto(`${origin}/#/p/${projectId}/brief`);
  assert.equal(await page.getByRole('link', { name: '查看团队说明修改建议' }).count(), 0);
  console.log(
    'Retrospective browser checks passed: one brief item, evidence, before/after, ' +
      'adopt, ignore, auto-adopt; 1440/1366/1280/390 dark/light screenshots.',
  );
}
