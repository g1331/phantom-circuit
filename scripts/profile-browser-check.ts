import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import type { Store } from '../src/server/store.ts';
import { resolve } from 'node:path';
import { createServer } from 'node:http';

export async function checkProfiles(page: Page, store: Store, artifacts: string) {
  const project = store.list('project')[0];
  const original = project.profiles.pm.effort;
  await page.getByRole('button', { name: '运行设置', exact: true }).click();
  await page.getByLabel('项目 PM推理等级', { exact: true }).selectOption('low');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(store.settings().profiles.pm.effort, 'low');
  assert.equal(store.project(project.id).profiles.pm.effort, original);
  await page.getByRole('button', { name: '项目模型设置', exact: true }).click();
  await page
    .getByLabel('项目 PM模型', { exact: true })
    .locator('option[value="gpt-5.6-luna"]')
    .waitFor({ state: 'attached' });
  assert.equal(await page.getByLabel('项目 PM推理等级', { exact: true }).inputValue(), original);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.equal(
      await page.getByRole('dialog').evaluate((el) => el.scrollWidth <= el.clientWidth),
      true,
    );
    await page.screenshot({ path: resolve(artifacts, `project-profiles-${width}.png`) });
  }
  await page.getByLabel('项目 PM推理等级', { exact: true }).selectOption('max');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(store.project(project.id).profiles.pm.effort, 'max');
  assert.equal(store.settings().profiles.pm.effort, 'low');
  const upstream = createServer((_req, res) =>
    res.end(JSON.stringify({ data: [{ id: 'listed-model' }] })),
  );
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  try {
    // Exercise creation through the same authenticated browser interface as Provider management.
    await page.getByRole('button', { name: '运行设置', exact: true }).click();
    const region = page.getByRole('region', { name: 'Provider 管理' });
    await region.getByRole('button', { name: '新增 Provider' }).click();
    await region.getByLabel('Provider 名称', { exact: true }).fill('Profile browser upstream');
    await region
      .getByLabel('Responses API base URL')
      .fill(`http://127.0.0.1:${(upstream.address() as any).port}/v1`);
    await region.getByLabel('API key', { exact: true }).fill('profile-browser-private');
    await region.getByRole('button', { name: '保存 Provider', exact: true }).click();
    await region.getByText('API key：已保存').waitFor();
    const providerId = await region.getByLabel('选择 Provider').inputValue();
    await page.getByRole('button', { name: '关闭窗口' }).click();
    await page.getByRole('button', { name: '项目模型设置', exact: true }).click();
    await page.getByLabel('项目 PM Provider', { exact: true }).selectOption(providerId);
    await page.getByLabel('项目 PM模型', { exact: true }).selectOption('listed-model');
    await page.getByLabel('项目 PM推理等级', { exact: true }).fill('low');
    const pm = page.getByRole('group', { name: '项目 PM', exact: true });
    await pm.getByRole('button', { name: '刷新模型列表' }).click();
    await pm.getByLabel('自定义模型 ID', { exact: true }).check();
    await page.getByLabel('项目 PM自定义模型 ID', { exact: true }).fill('manual-model');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已保存。' }).waitFor();
    assert.equal(store.project(project.id).profiles.pm.model, 'manual-model');
    await page.getByLabel('项目 PM推理等级', { exact: true }).fill('unknown');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '实际推理档位' }).waitFor();
    assert.equal(await page.getByLabel('项目 PM推理等级', { exact: true }).inputValue(), 'unknown');
    assert.equal(store.project(project.id).profiles.pm.effort, 'low');
    await page.screenshot({ path: resolve(artifacts, 'profile-custom-error-390.png') });
    await page.getByRole('button', { name: '关闭窗口' }).click();
    const run = store.run('pm', project.id, 'pm');
    store.finishRun(run.id, 'completed');
    await page.reload();
    await page.getByRole('tab', { name: '运行记录', exact: true }).click();
    await page.getByText(/Profile browser upstream.*manual-model/).waitFor();
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}
