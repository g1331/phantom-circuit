import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import type { Page } from 'playwright';

export async function checkProviders(page: Page, artifacts: string) {
  let authenticated = true;
  const upstream = createServer((_req, res) => {
    if (!authenticated) {
      res.writeHead(401);
      res.end();
    } else res.end(JSON.stringify({ data: [{ id: 'browser-model' }, { id: 'browser-model' }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as any).port;
  try {
    for (const width of [1440, 390]) {
      const key = `browser-fixture-private-${width}`;
      const replacement = `browser-fixture-replacement-${width}`;
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('button', { name: '运行设置' }).click();
      await page.locator('.provider-group > summary').click();
      const region = page.getByRole('region', { name: 'Provider 管理' });
      await region.getByText('使用现有 Codex 官方登录，无需复制凭据。').waitFor();
      assert.equal(await region.getByRole('button', { name: '删除 Provider' }).count(), 0);
      await region.getByRole('button', { name: '新增 Provider' }).click();
      await region.getByLabel('Provider 名称', { exact: true }).fill(`Browser ${width}`);
      await region.getByLabel('Responses API base URL').fill(`http://127.0.0.1:${port}/v1`);
      await region.getByLabel('API key', { exact: true }).fill(key);
      await region.getByRole('button', { name: '保存 Provider' }).click();
      await region.getByText('API key：已保存').waitFor();
      const selector = region.getByLabel('选择 Provider');
      const id = await selector.inputValue();
      assert.equal(await region.getByLabel('已显示的 API key').count(), 0);
      assert.equal(await region.getByLabel('替换 API key（留空保留）').inputValue(), '');
      await region.getByRole('button', { name: '获取模型', exact: true }).click();
      await region.getByText('已连接 · 1 个模型').waitFor();
      await region.getByLabel('可用模型', { exact: true }).selectOption('browser-model');
      assert.equal(await region.getByLabel('手工模型 ID').inputValue(), 'browser-model');
      authenticated = false;
      await region.getByRole('button', { name: '获取模型', exact: true }).click();
      await region.getByText('认证失败，请检查 API key 与上游权限').waitFor();
      await region.getByLabel('手工模型 ID').fill('manual-model');
      authenticated = true;
      await region.getByRole('button', { name: '显示密钥', exact: true }).click();
      await region.getByLabel('已显示的 API key').waitFor();
      assert.equal(await region.getByLabel('已显示的 API key').textContent(), key);
      await region.getByRole('button', { name: '隐藏密钥' }).click();
      assert.equal(await region.getByLabel('已显示的 API key').count(), 0);
      await region.getByLabel('Provider 名称', { exact: true }).fill(`Renamed ${width}`);
      await region.getByRole('button', { name: '保存 Provider' }).click();
      await region.getByRole('button', { name: '显示密钥', exact: true }).click();
      await region.getByLabel('已显示的 API key').waitFor();
      assert.equal(await region.getByLabel('已显示的 API key').textContent(), key);
      await selector.selectOption('codex');
      await selector.selectOption(id);
      assert.equal(await region.getByLabel('已显示的 API key').count(), 0);
      await region.getByLabel('替换 API key（留空保留）').fill(replacement);
      await region.getByRole('button', { name: '保存 Provider' }).click();
      await page.clock.install();
      await region.getByRole('button', { name: '显示密钥', exact: true }).click();
      await region.getByLabel('已显示的 API key').waitFor();
      assert.equal(await region.getByLabel('已显示的 API key').textContent(), replacement);
      await page.clock.fastForward(30_001);
      await region.getByLabel('已显示的 API key').waitFor({ state: 'detached' });
      await page.clock.resume();
      let release!: () => void;
      let received!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const requested = new Promise<void>((r) => {
        received = r;
      });
      await page.route('**/reveal-key', async (route) => {
        const response = await route.fetch();
        received();
        await held;
        await route.fulfill({ response });
      });
      await region.getByRole('button', { name: '显示密钥', exact: true }).click();
      await requested;
      await selector.selectOption('codex');
      const arrived = page.waitForResponse((r) => r.url().endsWith('/reveal-key'));
      release();
      await arrived;
      await page.unroute('**/reveal-key');
      await selector.selectOption(id);
      assert.equal(await region.getByLabel('已显示的 API key').count(), 0);
      await region.getByRole('button', { name: '显示密钥', exact: true }).click();
      await region.getByLabel('已显示的 API key').waitFor();
      const persisted = await page.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
          url: location.href,
        }),
      );
      assert.ok(!persisted.includes(key) && !persisted.includes(replacement));
      await page.getByRole('button', { name: '关闭窗口' }).click();
      await page.getByRole('button', { name: '运行设置' }).click();
      await page.locator('.provider-group > summary').click();
      await region.getByLabel('选择 Provider').selectOption(id);
      assert.equal(await region.getByLabel('已显示的 API key').count(), 0);
      await region.getByRole('button', { name: '显示密钥', exact: true }).click();
      await region.getByLabel('已显示的 API key').waitFor();
      await page.reload();
      await page.getByRole('button', { name: '运行设置' }).click();
      await page.locator('.provider-group > summary').click();
      await region.getByLabel('选择 Provider').selectOption(id);
      assert.equal(await region.getByLabel('已显示的 API key').count(), 0);
      await region.scrollIntoViewIfNeeded();
      assert.equal(
        await page.getByRole('dialog').evaluate((el) => el.scrollWidth <= el.clientWidth),
        true,
      );
      await page.screenshot({ path: resolve(artifacts, `providers-${width}.png`) });
      await region.getByRole('button', { name: '删除 Provider' }).click();
      await region.getByText('使用现有 Codex 官方登录，无需复制凭据。').waitFor();
      assert.equal(await selector.locator(`option[value="${id}"]`).count(), 0);
      await page.getByRole('button', { name: '关闭窗口' }).click();
    }
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}
