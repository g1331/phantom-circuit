import type { Page } from 'playwright';
import type { Store } from '../src/server/store.ts';
import type { Task } from '../src/shared/types.ts';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { backToWork, openTask } from './browser-pages.ts';

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
  let release!: () => void;
  let entered!: () => void;
  const requested = new Promise<void>((done) => {
    entered = done;
  });
  const pending = new Promise<void>((done) => {
    release = done;
  });
  await page.route('**/owner-messages', async (route) => {
    sent.push(route.request().postDataJSON());
    entered();
    await pending;
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
  });
  await openTask(page, task.title);
  const section = page
    .locator('.task-page')
    .getByRole('region', { name: '和负责人对话', exact: true });
  await section.waitFor();
  await page.locator('.task-controls > summary').click();
  const ask = section.getByRole('button', { name: '提问', exact: true });
  assert.equal(await ask.isDisabled(), true, 'nothing to send yet');
  await section.getByLabel('问问负责人这项工作的情况', { exact: true }).fill('现在卡在哪里？');
  await ask.click();
  await requested;
  const draft = section.locator('textarea');
  await draft.fill('');
  await draft.fill('现在卡在哪里？');
  const accepted = page.waitForResponse((response) => response.url().endsWith('/owner-messages'));
  release();
  await accepted;
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLButtonElement>('.task-controls .danger-button')?.disabled ===
      false,
  );
  assert.equal(await draft.inputValue(), '现在卡在哪里？', 'retyped text is a new draft');
  await draft.fill('  这条问题发送后清空  ');
  await ask.click();
  await page.waitForFunction(
    () => !(document.querySelector('.owner-compose textarea') as HTMLTextAreaElement).value,
  );
  assert.deepEqual(sent, [{ content: '现在卡在哪里？' }, { content: '这条问题发送后清空' }]);
  await page.locator('.task-controls > summary').click();
  await page.unroute('**/owner-messages');
  const question = store.addOwnerMessage(task.id, '现在卡在哪里？');
  await section.getByText('负责人稍后回答。', { exact: true }).waitFor();
  // Browser fixtures prove presentation only, not native history inheritance or model correctness.
  store.ownerReply(
    question,
    '在等交付修复，修好就继续评审。',
    'browser-owner-fixture',
    'work_history',
  );
  await section.getByText('在等交付修复，修好就继续评审。', { exact: true }).waitFor();
  await section.getByText('结合提问时已保存的开发记录回答', { exact: true }).waitFor();
  const legacy = store.addOwnerMessage(task.id, '旧问题');
  store.ownerReply(legacy, '旧回答没有上下文标记。', 'browser-legacy-fixture');
  await section.getByText('旧回答没有上下文标记。', { exact: true }).waitFor();
  assert.equal(
    await section.getByText('结合提问时已保存的开发记录回答', { exact: true }).count(),
    1,
  );
  for (const [failureReason, wording] of [
    ['history_unavailable', '暂时取不到负责人的工作记录，请稍后再问。'],
    ['owner_changed', '负责人已更换，请向当前负责人重新提问。'],
    ['answer_interrupted', '回答中断了，可以再问一次。'],
  ] as const) {
    const failed = store.addOwnerMessage(task.id, `展示 ${failureReason}`);
    store.setOwnerMessage(failed.id, { status: 'failed', failureReason });
    await section.getByText(wording, { exact: true }).waitFor();
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(artifacts, 'owner-conversation.png') });
  await backToWork(page);
}
