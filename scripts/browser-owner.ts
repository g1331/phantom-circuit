import type { Page } from 'playwright';
import type { Store } from '../src/server/store.ts';
import type { Task } from '../src/shared/types.ts';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

/** The task detail lets the user talk with the work's owner and shows the exchange (ADR 0013). */
export async function checkOwnerConversation(
  page: Page,
  store: Store,
  task: Task,
  artifacts: string,
) {
  // Paused, so the fixture engine never schedules it; the owner still answers questions.
  store.updateTask(task.id, { worktree: resolve('.'), stage: 'reviewing' });
  const sent: unknown[] = [];
  await page.route('**/owner-messages', async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
  });
  await page.getByRole('tab', { name: '任务', exact: false }).click();
  await page.locator('.task-row').filter({ hasText: task.title }).click();
  const dialog = page.getByRole('dialog');
  const section = dialog.getByRole('region', { name: '和负责人对话', exact: true });
  await section.waitFor();
  const ask = section.getByRole('button', { name: '提问', exact: true });
  assert.equal(await ask.isDisabled(), true, 'nothing to send yet');
  await section.getByLabel('问问负责人这项工作的情况', { exact: true }).fill('现在卡在哪里？');
  await ask.click();
  await page.waitForFunction(
    () => !(document.querySelector('.owner-compose textarea') as HTMLTextAreaElement).value,
  );
  assert.deepEqual(sent, [{ content: '现在卡在哪里？' }]);
  await page.unroute('**/owner-messages');
  const question = store.addOwnerMessage(task.id, '现在卡在哪里？');
  await section.getByText('负责人稍后回答。', { exact: true }).waitFor();
  store.ownerReply(question, '在等交付修复，修好就继续评审。', store.activeRuns()[0]?.id ?? 'run');
  await section.getByText('在等交付修复，修好就继续评审。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(artifacts, 'owner-conversation.png') });
  await page.keyboard.press('Escape');
}
