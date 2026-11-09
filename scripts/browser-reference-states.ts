import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import type { Store } from '../src/server/store.ts';
import type { Task } from '../src/shared/types.ts';
import { choosePreference } from './browser-preferences.ts';
import { openPage, openTask } from './browser-pages.ts';

export async function checkReferenceStates(
  page: Page,
  store: Store,
  task: Task,
  artifacts: string,
) {
  await choosePreference(page, 'language', 'zh-CN');
  const prUrl = 'https://github.com/fixture/workspace/pull/42';
  const issueUrl = 'https://github.com/fixture/workspace/issues/71';
  store.updateTask(task.id, {
    stage: 'developing',
    pr: 42,
    prUrl,
    issue: 71,
    issueUrl,
    completionSyncedAt: undefined,
  });
  await page.reload();
  await openTask(page, task.title);
  await page.locator('.task-receipt-details > summary').click();
  await page.locator('.receipt').waitFor();
  for (const [prState, label] of [
    [undefined, '状态未知'],
    ['open', '开放'],
    ['closed', '已关闭'],
    ['draft', '草稿'],
    ['merged', '已合并'],
  ] as const) {
    store.updateTask(task.id, { prState });
    // Store events feed the existing SSE refresh; the page remains mounted.
    await page.locator('.receipt').getByRole('img', { name: label, exact: true }).waitFor();
    assert.equal(
      await page.locator('.receipt a.engineering-reference').getAttribute('href'),
      prUrl,
    );
  }
  const controls = page.locator('.task-controls');
  await controls.locator(':scope > summary').click();
  for (const [issueState, label] of [
    [undefined, '状态未知'],
    ['open', '开放'],
    ['completed', '已完成关闭'],
    ['not_planned', '未计划关闭'],
    ['closed', '已关闭'],
  ] as const) {
    store.updateTask(task.id, { issueState });
    await controls.locator(`a[href="${issueUrl}"]`).getByRole('img', { name: label }).waitFor();
  }
  assert.equal(await controls.locator(`a[href="${prUrl}"]`).getAttribute('target'), '_blank');
  assert.equal(await controls.locator(`a[href="${issueUrl}"]`).getAttribute('target'), '_blank');
  await page
    .context()
    .route('https://github.com/fixture/workspace/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Engineering link</title>' }),
    );
  for (const url of [prUrl, issueUrl]) {
    const opened = page.waitForEvent('popup');
    await controls.locator(`a[href="${url}"]`).click();
    const popup = await opened;
    await popup.waitForLoadState();
    assert.equal(popup.url(), url);
    await popup.close();
  }
  await page.context().unroute('https://github.com/fixture/workspace/**');
  store.updateTask(task.id, { stage: 'done', issueState: 'completed' });
  await page.locator('.task-status.group-delivered').waitFor();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['dark', 'light'] as const) {
      await choosePreference(page, 'theme', theme);
      await page.locator('.task-page').evaluate((el) => (el.scrollTop = 0));
      await page.screenshot({ path: resolve(artifacts, `references-task-${width}-${theme}.png`) });
      await page.locator('.receipt').screenshot({
        path: resolve(artifacts, `references-receipt-${width}-${theme}.png`),
      });
      const colors = await page.locator('.receipt').evaluate((el) => ({
        merged: getComputedStyle(el.querySelector('.reference-merged')!).color,
        delivery: getComputedStyle(document.documentElement).getPropertyValue('--delivery').trim(),
      }));
      assert.equal(colors.merged, theme === 'dark' ? 'rgb(196, 161, 245)' : 'rgb(121, 66, 188)');
      assert.equal(
        await page.locator('.task-page').evaluate((el) => el.scrollWidth <= el.clientWidth),
        true,
      );
      await openPage(page, 'work');
      await page.locator('.work-row .reference-merged').waitFor();
      await page.screenshot({ path: resolve(artifacts, `references-work-${width}-${theme}.png`) });
      await openPage(page, width === 390 ? 'brief' : 'home');
      await page.screenshot({ path: resolve(artifacts, `references-brief-${width}-${theme}.png`) });
      await openTask(page, task.title);
      await page.locator('.task-receipt-details > summary').click();
    }
  }
  // A legacy done stage and a link alone carry no remote state evidence.
  store.updateTask(task.id, { prState: undefined, issueState: undefined });
  await page.locator('.receipt').getByRole('img', { name: '状态未知' }).waitFor();
  store.updateTask(task.id, { completionSyncedAt: new Date().toISOString() });
  await page.locator('.receipt').getByRole('img', { name: '已合并' }).waitFor();
  const empty = store.createProject('Empty status fixture', '');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['dark', 'light'] as const) {
      await choosePreference(page, 'theme', theme);
      await page.goto(`${new URL(page.url()).origin}/?empty=${width}-${theme}#/p/${empty.id}/work`);
      await page.locator('.work-page .empty-state').waitFor();
      await page.screenshot({ path: resolve(artifacts, `references-empty-${width}-${theme}.png`) });
    }
  }
}
