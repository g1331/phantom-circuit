import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import type { Page, Route } from 'playwright';
import type { Store } from '../src/server/store.ts';
import { routeHref } from '../src/web/route.ts';
import { choosePreference } from './browser-preferences.ts';

/** Observable UI regression on the existing synthetic intake boundary fixture. */
export async function checkVisualWorkspace(
  page: Page,
  store: Store,
  projectId: string,
  taskId: string,
  artifacts: string,
) {
  const origin = new URL(page.url()).origin;
  const nav = () => page.locator('.pages-sidebar:visible, .pages-bar:visible');
  const visit = async (route: Parameters<typeof routeHref>[0]) => {
    await page.goto(`${origin}/${routeHref({ ...route, projectId })}`);
  };
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await choosePreference(page, 'theme', 'light');
    await visit({ page: 'home' });
    await page.getByRole('button', { name: '全部', exact: true }).click();
    await page.locator(`[data-task-id="${taskId}"]`).waitFor();
    if (width === 1280) {
      const paths = page.locator('.canvas-connections > path');
      await paths.first().waitFor({ state: 'attached' });
      assert((await paths.count()) > 0);
      const card = page.locator(`[data-task-id="${taskId}"]`);
      const before = (await card.boundingBox())!;
      const toolbar = await page.locator('.canvas-tools').boundingBox();
      await page.getByRole('button', { name: '缩小', exact: true }).click();
      const after = (await card.boundingBox())!;
      assert(Math.abs(after.width / before.width - 1 / 1.2) < 0.01);
      assert(Math.abs(after.height / before.height - 1 / 1.2) < 0.01);
      assert.deepEqual(await page.locator('.canvas-tools').boundingBox(), toolbar);
      const viewport = page.locator('.canvas-viewport');
      const bounds = (await viewport.boundingBox())!;
      const stage = page.locator('.canvas-stage');
      const start = (await stage.boundingBox())!;
      await page.mouse.move(bounds.x + 8, bounds.y + 8);
      await page.mouse.down();
      await page.mouse.move(bounds.x + 108, bounds.y + 68, { steps: 5 });
      await page.mouse.up();
      const moved = (await stage.boundingBox())!;
      assert(Math.abs(moved.x - start.x - 100) < 1);
      assert(Math.abs(moved.y - start.y - 60) < 1);
      const anchor = { x: bounds.x + 200, y: bounds.y + 180 };
      await page.mouse.move(anchor.x, anchor.y);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -80);
      await page.keyboard.up('Control');
      await page.waitForFunction(
        (width) => document.querySelector('.canvas-stage')!.getBoundingClientRect().width > width,
        moved.width,
      );
      const zoomed = (await stage.boundingBox())!;
      const factor = zoomed.width / moved.width;
      assert(Math.abs((anchor.x - zoomed.x) / factor - (anchor.x - moved.x)) < 1);
      assert(Math.abs((anchor.y - zoomed.y) / factor - (anchor.y - moved.y)) < 1);
      await page.getByRole('button', { name: '适配视图', exact: true }).click();
      const fitted = (await stage.boundingBox())!;
      assert(fitted.x >= bounds.x && fitted.x + fitted.width <= bounds.x + bounds.width + 1);
      assert(fitted.y >= bounds.y && fitted.y + fitted.height <= bounds.y + bounds.height + 1);
      await page.getByRole('button', { name: '复位画布', exact: true }).click();
      assert.equal(await page.locator('.canvas-tools output').innerText(), '100%');
      const reset = (await stage.boundingBox())!;
      assert.equal(Math.round(reset.x - bounds.x), 32);
      assert.equal(Math.round(reset.y - bounds.y), 32);
    }
    await page.locator(`[data-task-id="${taskId}"] .flow-work-title`).click();
    await page.locator('.workbench-inspector .task-detail').waitFor();
    await page.screenshot({ path: resolve(artifacts, `visual-inspector-${width}.png`) });
    await page.getByRole('link', { name: '返回工作台', exact: true }).click();
    await page.locator('.workbench-inspector').waitFor({ state: 'detached' });
    await nav().getByRole('link', { name: '记录', exact: true }).click();
    await page.getByRole('button', { name: '回复', exact: true }).click();
    await page
      .locator('.record-row')
      .filter({ hasText: 'Issue #18 · Synthetic live source assessment' })
      .filter({ hasText: '回复已送达' })
      .click();
    await page
      .locator('.record-detail')
      .getByText('Synthetic assessment finished without a code change.', { exact: true })
      .waitFor();
    await page.screenshot({ path: resolve(artifacts, `visual-record-detail-${width}.png`) });
    if (width === 1280) {
      const outage = (route: Route) =>
        route.fulfill({
          status: 503,
          json: { error: 'Synthetic source-read outage' },
        });
      await page.route('**/api/inputs/*', outage);
      await page.locator('.record-detail').getByRole('alert').waitFor({ timeout: 12000 });
      await page.locator('.record-detail').getByText('回复已送达', { exact: true }).waitFor();
      await page
        .locator('.record-detail')
        .getByText('Synthetic assessment finished without a code change.', { exact: true })
        .waitFor();
      await page.unroute('**/api/inputs/*', outage);
    }
    await page
      .locator('.record-detail')
      .getByRole('button', { name: '关闭窗口', exact: true })
      .click();
    await page.getByRole('button', { name: '输入', exact: true }).click();
    await page
      .locator('.record-row')
      .filter({ hasText: 'Issue #18 · Synthetic live source assessment' })
      .click();
    await page
      .locator('.record-detail')
      .getByText('Synthetic source paragraph 12 preserves reading position.', { exact: true })
      .waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.record-detail').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '全部', exact: true }).click();
    await page.getByLabel('搜索请求、工作与结果', { exact: true }).fill('no-match-for-ui-check');
    await page.getByText('换一个筛选查看其他记录。', { exact: true }).waitFor();
    assert.equal(await page.locator('.record-row').count(), 0);
    await page.getByLabel('搜索请求、工作与结果', { exact: true }).fill('');
    await page.locator('.record-row').first().waitFor();
    await page.screenshot({ path: resolve(artifacts, `visual-records-${width}.png`) });
    await nav().getByRole('link', { name: '来源', exact: true }).click();
    await page.getByLabel('允许发起工作的 GitHub 用户', { exact: true }).waitFor();
    const feedbackSwitch = page.getByRole('switch', { name: '接续 Issue／PR 反馈与 CI 结果' });
    for (const enabled of [true, false]) {
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().includes('/api/repos/') && response.request().method() === 'PATCH',
        ),
        feedbackSwitch.setChecked(enabled),
      ]);
      assert.equal(await feedbackSwitch.isChecked(), enabled);
    }
    await page.screenshot({ path: resolve(artifacts, `visual-sources-${width}.png`) });
    await nav().getByRole('link', { name: '设置', exact: true }).click();
    await page.locator('.workspace-settings').waitFor();
    await page.locator('#settings-tab-models').click();
    const settingsOverflow = await page.locator('.workspace-settings-content').evaluate((root) =>
      [...root.querySelectorAll<HTMLElement>('*')]
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.right > innerWidth + 1;
        })
        .slice(0, 8)
        .map((element) => ({
          className: element.className,
          width: element.getBoundingClientRect().width,
          columns: getComputedStyle(element).gridTemplateColumns,
          parentClass: element.parentElement?.className,
          parentDisplay: element.parentElement
            ? getComputedStyle(element.parentElement).display
            : '',
          parentWidth: element.parentElement?.getBoundingClientRect().width,
        })),
    );
    assert.deepEqual(settingsOverflow, [], 'settings controls fit the viewport');
    await page.screenshot({ path: resolve(artifacts, `visual-settings-${width}.png`) });
    await page.getByRole('button', { name: '全局默认', exact: true }).click();
    await page.locator('#settings-tab-providers').waitFor();
    await page.getByRole('button', { name: '当前项目', exact: true }).click();
    await page
      .locator('.workspace-section-nav')
      .getByRole('link', {
        name: '团队说明',
        exact: true,
      })
      .click();
    await page
      .locator('.workspace-settings-content')
      .getByRole('heading', {
        name: '团队说明',
        exact: true,
      })
      .waitFor();
    assert(
      await page.locator('.main').evaluate((element) => element.scrollWidth <= element.clientWidth),
    );
  }
  const empty = store.createProject('Synthetic empty visual workspace', 'Browser fixture');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const target of ['home', 'records', 'sources', 'project'] as const) {
      await page.goto(
        `${origin}/?visual-empty=1${routeHref({ page: target, projectId: empty.id })}`,
      );
      await page.waitForURL((url) => url.hash === routeHref({ page: target, projectId: empty.id }));
      await page.locator(target === 'project' ? '.workspace-settings' : '.flow-page').waitFor();
      if (target === 'home')
        await page.getByText('提交需求，开始下一项工作。', { exact: true }).waitFor();
      if (target === 'records') {
        await page.getByRole('button', { name: '输入', exact: true }).click();
        await page.getByText('换一个筛选查看其他记录。', { exact: true }).waitFor();
      }
      await page.screenshot({ path: resolve(artifacts, `visual-empty-${target}-${width}.png`) });
    }
  }
  console.log(
    'Visual workspace fixture passed: canvas zoom/reset, inspector/back, records/search, ' +
      'sources, project/global settings and empty/populated views at 1280/390.',
  );
}
