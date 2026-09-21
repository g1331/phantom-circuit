import type { Page } from 'playwright';
import type { Store } from '../src/server/store.ts';
import type { Task } from '../src/shared/types.ts';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function checkPriority(page: Page, store: Store, task: Task, artifacts: string) {
  await page.keyboard.press('Escape');
  store.updateTask(task.id, { priority: 1, control: 'paused', blocked: 'Delivery repair pending' });
  await page.getByRole('tab', { name: '任务', exact: false }).click();
  const row = page.locator('.task-row').filter({ hasText: task.title });
  await row.getByText('旧版优先级 1', { exact: false }).waitFor();
  await row.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('任务已暂停', { exact: true }).waitFor();
  await dialog.getByText('已有活动 Run', { exact: false }).waitFor();
  await dialog.getByLabel('选择优先级', { exact: true }).selectOption('high');
  await dialog.getByLabel('优先级原因', { exact: true }).fill('解除交付阻塞 / Unblock delivery');
  await dialog.getByRole('button', { name: '保存优先级', exact: true }).focus();
  await page.keyboard.press('Enter');
  await dialog.getByRole('status').getByText('优先级已保存', { exact: true }).waitFor();
  assert.equal(store.task(task.id).priority, 5);
  assert.equal(store.task(task.id).control, 'paused');
  const runs = store.activeRuns();
  await dialog.getByText('优先级历史', { exact: true }).click();
  await dialog.getByText(/旧版优先级 1.*高.*本地用户/).waitFor();
  // A concurrent writer must reject the stale editor instead of overwriting it.
  store.setTaskPriority(
    task.projectId,
    {
      taskId: task.id,
      level: 'low',
      reason: 'Concurrent PM decision',
      expectedVersion: 1,
      requestId: 'browser-concurrent',
    },
    { actor: 'pm' },
  );
  await dialog.getByLabel('选择优先级', { exact: true }).selectOption('urgent');
  await dialog.getByLabel('优先级原因', { exact: true }).fill('Confirmed delivery deadline');
  await dialog.getByRole('button', { name: '保存优先级', exact: true }).click();
  await dialog
    .getByRole('status')
    .getByText(/已被其他操作更新/)
    .waitFor();
  assert.equal(store.task(task.id).priority, -5);
  await page.route('**/task-priority', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Fixture write failure' }),
    }),
  );
  await dialog.getByRole('button', { name: '保存优先级', exact: true }).click();
  await dialog.getByRole('status').getByText('保存失败，请重试', { exact: true }).waitFor();
  await page.unroute('**/task-priority');
  await dialog.getByRole('button', { name: '保存优先级', exact: true }).click();
  await dialog.getByRole('status').getByText('优先级已保存', { exact: true }).waitFor();
  assert.deepEqual(store.activeRuns(), runs);
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('tab', { name: '任务', exact: false }).click();
  await row.getByText('优先级: 紧急', { exact: true }).waitFor();
  const makeCandidate = (title: string, priority: 'low' | 'high') =>
    store.createTask({
      projectId: task.projectId,
      repoId: task.repoId,
      sourceMessageId: task.sourceMessageId,
      title,
      spec: 'Candidate fixture',
      acceptance: ['Claimable'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority,
      priorityReason: 'Candidate order fixture',
    });
  store.patchRepo(task.repoId, { enabled: true, devLimit: 2 });
  const high = makeCandidate('高候选 / High candidate', 'high');
  const low = makeCandidate('低候选 / Low candidate', 'low');
  const order = page.getByRole('region', { name: '当前项目认领顺序', exact: true });
  await order
    .locator('ol > li')
    .first()
    .getByText('高候选 / High candidate', { exact: false })
    .waitFor();
  await page.locator('.task-row').filter({ hasText: low.title }).click();
  await dialog.getByLabel('选择优先级', { exact: true }).selectOption('urgent');
  await dialog.getByLabel('优先级原因', { exact: true }).fill('Immediate delivery impact');
  await dialog.getByRole('button', { name: '保存优先级', exact: true }).click();
  await dialog.getByRole('status').getByText('优先级已保存', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await order
    .locator('ol > li')
    .first()
    .getByText('低候选 / Low candidate', { exact: false })
    .waitFor();
  const claimed = store.claimNext()!;
  assert.equal(claimed.taskId, low.id);
  await page.getByRole('button', { name: '刷新认领顺序', exact: true }).click();
  await order.getByText('此刻没有可认领任务，请查看各任务的等待条件。', { exact: true }).waitFor();
  await page.locator('.task-row').filter({ hasText: high.title }).click();
  await dialog.getByText('等待仓库执行名额', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  store.finishRun(claimed.id, 'completed');
  store.updateTask(low.id, { stage: 'done' });
  await order
    .locator('ol > li')
    .first()
    .getByText('高候选 / High candidate', { exact: false })
    .waitFor();
  for (const locale of ['zh-CN', 'en']) {
    await page.locator('.sidebar .language-control select').selectOption(locale);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
        }, theme);
        const region = page.getByRole('region', {
          name: locale === 'en' ? 'Current project claim order' : '当前项目认领顺序',
          exact: true,
        });
        await region
          .getByText(locale === 'en' ? /not a promised start time/ : /不承诺开工时间/)
          .waitFor();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.locator('.claim-order').scrollIntoViewIfNeeded();
        await page.screenshot({
          path: resolve(artifacts, `priority-order-${locale}-${width}-${theme}.png`),
        });
        await row.click();
        await dialog
          .getByText(locale === 'en' ? 'Priority history' : '优先级历史', { exact: true })
          .click();
        await dialog.getByText('Confirmed delivery deadline', { exact: true }).last().waitFor();
        await dialog
          .getByText(locale === 'en' ? 'Task paused' : '任务已暂停', { exact: true })
          .waitFor();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: resolve(artifacts, `priority-detail-${locale}-${width}-${theme}.png`),
        });
        await dialog.locator('.claim-conditions').scrollIntoViewIfNeeded();
        await page.screenshot({
          path: resolve(artifacts, `priority-waiting-${locale}-${width}-${theme}.png`),
        });
        await page.keyboard.press('Escape');
      }
    }
  }
  await page.reload();
  await page.getByRole('tab', { name: 'Tasks', exact: false }).click();
  assert.equal(await page.locator('.sidebar .language-control select').inputValue(), 'en');
  await page.locator('.sidebar .language-control select').selectOption('zh-CN');
}
