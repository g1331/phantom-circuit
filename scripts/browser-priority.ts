import { choosePreference } from './browser-preferences.ts';
import type { Page } from 'playwright';
import type { Store } from '../src/server/store.ts';
import type { Task } from '../src/shared/types.ts';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { backToWork, openPage, openTask } from './browser-pages.ts';

export async function checkPriority(page: Page, store: Store, task: Task, artifacts: string) {
  store.updateTask(task.id, { priority: 1, control: 'paused', blocked: 'Delivery repair pending' });
  await openTask(page, task.title);
  // The work page is where the task's controls live now; the work list shows no priority.
  const taskPage = page.locator('.task-page');
  const priority = taskPage.getByRole('region', { name: '优先级', exact: true });
  await priority.getByText('旧版优先级 1', { exact: false }).waitFor();
  await taskPage.getByText('任务已暂停', { exact: true }).waitFor();
  await taskPage.getByText('已有活动 Run', { exact: false }).waitFor();
  await taskPage.getByLabel('选择优先级', { exact: true }).selectOption('high');
  await taskPage.getByLabel('优先级原因', { exact: true }).fill('解除交付阻塞 / Unblock delivery');
  await taskPage.getByRole('button', { name: '保存优先级', exact: true }).focus();
  await page.keyboard.press('Enter');
  await taskPage.getByRole('status').getByText('优先级已保存', { exact: true }).waitFor();
  assert.equal(store.task(task.id).priority, 5);
  assert.equal(store.task(task.id).control, 'paused');
  const runs = store.activeRuns();
  await taskPage.getByText('优先级历史', { exact: true }).click();
  await taskPage.getByText(/旧版优先级 1.*高.*本地用户/).waitFor();
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
  await taskPage.getByLabel('选择优先级', { exact: true }).selectOption('urgent');
  await taskPage.getByLabel('优先级原因', { exact: true }).fill('Confirmed delivery deadline');
  await taskPage.getByRole('button', { name: '保存优先级', exact: true }).click();
  await taskPage
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
  await taskPage.getByRole('button', { name: '保存优先级', exact: true }).click();
  await taskPage.getByRole('status').getByText('保存失败，请重试', { exact: true }).waitFor();
  await page.unroute('**/task-priority');
  await taskPage.getByRole('button', { name: '保存优先级', exact: true }).click();
  await taskPage.getByRole('status').getByText('优先级已保存', { exact: true }).waitFor();
  assert.deepEqual(store.activeRuns(), runs);
  await page.reload();
  await priority.getByText('优先级: 紧急', { exact: true }).waitFor();
  await backToWork(page);
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
  // The claim order lives on the project page.
  await openPage(page, 'project');
  const order = page.getByRole('region', { name: '当前项目认领顺序', exact: true });
  await order
    .locator('ol > li')
    .first()
    .getByText('高候选 / High candidate', { exact: false })
    .waitFor();
  await openTask(page, low.title);
  await taskPage.getByLabel('选择优先级', { exact: true }).selectOption('urgent');
  await taskPage.getByLabel('优先级原因', { exact: true }).fill('Immediate delivery impact');
  await taskPage.getByRole('button', { name: '保存优先级', exact: true }).click();
  await taskPage.getByRole('status').getByText('优先级已保存', { exact: true }).waitFor();
  await openPage(page, 'project');
  await order
    .locator('ol > li')
    .first()
    .getByText('低候选 / Low candidate', { exact: false })
    .waitFor();
  const claimed = store.claimNext()!;
  assert.equal(claimed.taskId, low.id);
  await page.getByRole('button', { name: '刷新认领顺序', exact: true }).click();
  await order.getByText('此刻没有可认领任务，请查看各任务的等待条件。', { exact: true }).waitFor();
  await openTask(page, high.title);
  await taskPage.getByText('等待仓库执行名额', { exact: true }).waitFor();
  store.finishRun(claimed.id, 'completed');
  store.updateTask(low.id, { stage: 'done' });
  await openPage(page, 'project');
  await order
    .locator('ol > li')
    .first()
    .getByText('高候选 / High candidate', { exact: false })
    .waitFor();
  for (const locale of ['zh-CN', 'en']) {
    await choosePreference(page, 'language', locale);
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
        const rules = region.locator('.schedule-rules');
        await rules.locator('summary').click();
        await region
          .getByText(locale === 'en' ? /not a promised start time/ : /不承诺开工时间/)
          .waitFor();
        await rules.locator('summary').click();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.locator('.claim-order').scrollIntoViewIfNeeded();
        await page.screenshot({
          path: resolve(artifacts, `priority-order-${locale}-${width}-${theme}.png`),
        });
        await openTask(page, task.title);
        await taskPage
          .getByText(locale === 'en' ? 'Priority history' : '优先级历史', { exact: true })
          .click();
        await taskPage.getByText('Confirmed delivery deadline', { exact: true }).last().waitFor();
        await taskPage
          .getByText(locale === 'en' ? 'Task paused' : '任务已暂停', { exact: true })
          .waitFor();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: resolve(artifacts, `priority-detail-${locale}-${width}-${theme}.png`),
        });
        await taskPage.locator('.claim-conditions').scrollIntoViewIfNeeded();
        await page.screenshot({
          path: resolve(artifacts, `priority-waiting-${locale}-${width}-${theme}.png`),
        });
        await backToWork(page);
        await openPage(page, 'project');
      }
    }
  }
  await page.reload();
  // The page and the language both survive a reload.
  await page.getByRole('region', { name: 'Current project claim order', exact: true }).waitFor();
  assert.equal(await page.locator('.sidebar .language-control').getAttribute('data-value'), 'en');
  await choosePreference(page, 'language', 'zh-CN');
}
