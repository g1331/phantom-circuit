import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import type { Store } from '../src/server/store.ts';

export async function checkTyping(page: Page) {
  const input = page.locator('.composer textarea');
  await input.fill('');
  await input.focus();
  // Measure the browser input path, excluding automation transport latency.
  const timings = await page.evaluate(async () => {
    const input = document.querySelector<HTMLTextAreaElement>('.composer textarea')!;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    const times: number[] = [];
    for (const char of 'Typing performance test') {
      const start = performance.now();
      set.call(input, input.value + char);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      times.push(performance.now() - start);
    }
    return times.sort((a, b) => a - b);
  });
  assert.equal(await input.inputValue(), 'Typing performance test');
  const p95 = timings[Math.floor(timings.length * 0.95)];
  console.log(
    `PM typing (50 turns): median=${timings[Math.floor(timings.length / 2)].toFixed(1)}ms p95=${p95.toFixed(1)}ms`,
  );
  assert.ok(p95 < 100, `PM input-to-frame p95 exceeded 100ms: ${p95.toFixed(1)}ms`);
  await input.fill('');
}

export async function checkComposer(page: Page, store: Store, projectId: string, png: Buffer) {
  const input = page.getByLabel('给 PM 的消息', { exact: true });
  const send = page.getByRole('button', { name: '发送消息', exact: true });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await input.fill('');
  await page.evaluate(() => navigator.clipboard.writeText('普通粘贴文本'));
  await input.focus();
  await page.keyboard.press('Control+V');
  assert.equal(await input.inputValue(), '普通粘贴文本');
  await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) }),
    ]);
  }, png.toString('base64'));
  await input.focus();
  await page.keyboard.press('Control+V');
  await page.locator('.image-drafts img').waitFor();
  const imageStrip = await page.locator('.image-drafts').boundingBox();
  assert.ok(imageStrip && imageStrip.height <= 56, 'pending images use one compact thumbnail row');
  assert.equal(
    await input.inputValue(),
    '普通粘贴文本',
    'image paste preserves the existing draft',
  );
  await input.evaluate((element) => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        isComposing: true,
        bubbles: true,
      }),
    );
  });
  assert.equal(
    await page.locator('.image-drafts img').count(),
    1,
    'IME composition must not submit',
  );

  await page.route('**/api/projects/*/messages', (route) =>
    route.fulfill({ status: 503, json: { error: 'Fixture upload failed' } }),
  );
  await send.click();
  await page.getByText('Fixture upload failed', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '普通粘贴文本');
  assert.equal(await page.locator('.image-drafts img').count(), 1, 'failed upload keeps its image');
  await page.unroute('**/api/projects/*/messages');
  await send.click();
  await page.waitForFunction(() => !document.querySelector('.image-drafts img'));
  const saved = store
    .list('message')
    .find((message) => message.projectId === projectId && message.content === '普通粘贴文本');
  assert.equal(
    saved?.attachments?.length,
    1,
    'clipboard image follows the real multipart persistence path',
  );
  assert.equal(await input.inputValue(), '');

  // Unsupported pasted images show the same validation as file selection.
  await input.evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(new File(['gif'], 'unsupported.gif', { type: 'image/gif' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await page.getByText('仅支持 PNG、JPEG、WebP 图片', { exact: true }).waitFor();
  assert.equal(await page.locator('.image-drafts img').count(), 0);
}

export async function checkPMModels(page: Page, store: Store, projectId: string) {
  const before = structuredClone(store.project(projectId));
  const globalBefore = structuredClone(store.settings());
  const run = store.run('pm', projectId, 'pm');
  const runBefore = structuredClone(store.get('run', run.id));
  const trigger = page.getByRole('button', { name: '切换 PM 模型和思考等级', exact: true });
  const menu = page.getByRole('menu', { name: '切换 PM 模型和思考等级', exact: true });
  const composerBefore = await page.locator('.composer').boundingBox();
  await trigger.click();
  await menu.waitFor();
  const composerAfter = await page.locator('.composer').boundingBox();
  assert.equal(
    composerAfter?.height,
    composerBefore?.height,
    'model menu never expands the composer',
  );
  await menu.getByRole('menuitem').filter({ hasText: '模型' }).click();
  await menu.getByRole('menuitemradio', { name: 'gpt-5.6-luna', exact: true }).waitFor();
  await menu.getByRole('menuitemradio', { name: 'gpt-5.6-luna', exact: true }).click();
  await menu.waitFor({ state: 'hidden' });
  assert.equal(store.project(projectId).profiles.pm.model, 'gpt-5.6-luna');
  await page.getByLabel('给 PM 的消息', { exact: true }).fill('Draft survives model switching');
  await trigger.click();
  await menu.getByRole('menuitem').filter({ hasText: '推理档位' }).click();
  await menu.getByRole('menuitemradio', { name: 'low', exact: true }).click();
  await menu.waitFor({ state: 'hidden' });
  assert.equal(store.project(projectId).profiles.pm.effort, 'low');
  assert.equal(store.project(projectId).profileModes?.pm, 'pinned');
  for (const role of ['backend', 'frontend', 'fullstack', 'complex', 'review'] as const)
    assert.deepEqual(store.project(projectId).profiles[role], before.profiles[role]);
  assert.deepEqual(store.settings(), globalBefore);
  assert.deepEqual(
    store.get('run', run.id),
    runBefore,
    'active Run keeps its original configuration',
  );
  assert.equal(
    await page.getByLabel('给 PM 的消息', { exact: true }).inputValue(),
    'Draft survives model switching',
  );
  await page.getByRole('tab', { name: /^任务/ }).click();
  await page.getByRole('tab', { name: '与 PM 讨论', exact: true }).click();
  assert.equal(
    await page.getByLabel('给 PM 的消息', { exact: true }).inputValue(),
    'Draft survives model switching',
    'view switching preserves the draft',
  );
  await page.route('**/api/projects/*/runtime', (route) =>
    route.fulfill({ status: 503, json: { error: 'Fixture model save failed' } }),
  );
  await trigger.click();
  await menu.getByRole('menuitem').filter({ hasText: '推理档位' }).click();
  await menu.getByRole('menuitemradio', { name: 'max', exact: true }).click();
  await menu.getByText('Fixture model save failed', { exact: true }).waitFor();
  assert.equal(store.project(projectId).profiles.pm.effort, 'low');
  assert.equal(
    await menu
      .getByRole('menuitemradio', { name: 'low', exact: true })
      .getAttribute('aria-checked'),
    'true',
  );
  await page.unroute('**/api/projects/*/runtime');
  await page.keyboard.press('Escape');
  await menu.getByRole('menuitem').filter({ hasText: '模型' }).waitFor();
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await menu.waitFor();
  await page.keyboard.press('ArrowDown');
  assert.equal(await menu.evaluate((element) => element.contains(document.activeElement)), true);
  await page.locator('.sidebar').click({ position: { x: 5, y: 5 } });
  await menu.waitFor({ state: 'hidden' });
  store.finishRun(run.id, 'completed');
  await page.reload();
  await trigger.waitFor();
  assert.ok((await trigger.getAttribute('title'))?.includes('gpt-5.6-luna · low'));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 500 : 1000 });
    await trigger.click();
    await menu.getByRole('menuitem').filter({ hasText: '推理档位' }).waitFor();
    const box = await menu.boundingBox();
    assert.ok(
      box &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= width &&
        box.y + box.height <= (width === 390 ? 500 : 1000),
      'popover stays within the viewport',
    );
    await page.screenshot({ path: `test-results/pm-model-menu-${width}.png` });
    await page.keyboard.press('Escape');
  }
}
