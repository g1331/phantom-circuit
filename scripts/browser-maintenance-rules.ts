import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import type { Store } from '../src/server/store.ts';
import type { Engine } from '../src/server/engine.ts';
import type { MaintenanceCandidate } from '../src/shared/maintenance.ts';
import { choosePreference } from './browser-preferences.ts';

/** Runs inside the existing isolated browser fixture; no platform or model calls. */
export async function checkMaintenanceRules(
  page: Page,
  store: Store,
  engine: Engine,
  artifacts: string,
) {
  const original = engine.github.readMaintenanceCandidates;
  const origin = new URL(page.url()).origin;
  try {
    for (const width of [1280, 390]) {
      const project = store.createProject(`Maintenance ${width}`, '');
      const repo = store.createRepo({
        projectId: project.id,
        name: 'Maintenance fixture',
        path: `/synthetic/maintenance-${width}`,
        github: `synthetic/maintenance-${width}`,
        defaultBranch: 'main',
        authorized: true,
      });
      const observedAt = new Date().toISOString();
      const candidate: MaintenanceCandidate = {
        id: `candidate-${width}`,
        repoId: repo.id,
        projectId: project.id,
        kind: 'issue',
        nativeId: '100',
        revision: 'fixed',
        title: 'Documentation correction',
        body: 'Correct the installation command.',
        url: `https://github.com/${repo.github}/issues/100`,
        sourceAt: observedAt,
        observedAt,
        selectorValues: ['docs'],
        ageMinutes: 120,
        issue: 100,
        pullRequests: [],
        selfGenerated: false,
        evidence: { number: 100, body: 'Correct the installation command.', labels: ['docs'] },
      };
      engine.github.readMaintenanceCandidates = async () => [candidate];
      await page.setViewportSize({ width, height: 900 });
      // Reload the snapshot after creating each isolated project; a hash-only navigation
      // can resolve against the preceding fixture's still-loaded project list.
      await page.goto(`${origin}/?maintenance-fixture=${width}#/p/${project.id}/sources`);
      await choosePreference(page, 'language', 'zh-CN');
      const panel = page.getByRole('region', { name: '维护规则', exact: true });
      await panel.getByText('新增观察规则以读取候选。', { exact: true }).waitFor();
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(artifacts, `maintenance-empty-${width}.png`) });
      await panel.getByRole('button', { name: '新增规则', exact: true }).click();
      const form = panel.locator('form');
      // The wrapping label's text includes options; use the select's accessible name.
      const mode = panel.getByRole('combobox', { name: '模式', exact: true });
      assert.equal(await mode.inputValue(), 'observe');
      await form.getByLabel('规则名称', { exact: true }).fill('Documentation rule');
      await form.getByLabel('Issue 标签（完整名称）', { exact: true }).fill('docs');
      await form
        .getByLabel('允许处理范围', { exact: true })
        .fill('Only installation documentation');
      await form.getByRole('button', { name: '保存新版本', exact: true }).click();
      await panel.locator('.maintenance-rule').waitFor();
      await panel.getByRole('button', { name: '读取候选', exact: true }).click();
      const record = panel.locator('.maintenance-observation');
      await record.locator('summary').click();
      await record.getByRole('heading', { name: '来源证据', exact: true }).waitFor();
      assert.match(await record.innerText(), /符合接纳条件/);
      assert.match(await record.innerText(), /Only installation documentation/);
      await record.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: resolve(artifacts, `maintenance-detail-${width}.png`),
        fullPage: true,
      });
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      );
      await panel.locator('.maintenance-rule > summary').click();
      await mode.selectOption('auto');
      await panel.locator('form').getByRole('button', { name: '保存新版本', exact: true }).click();
      await panel.getByText('历史规则版本', { exact: false }).waitFor();
      assert.equal(engine.maintenance.rules(repo.id)[0].mode, 'auto');
      await panel.locator('.maintenance-rule > summary').click();
      await panel.getByText('历史版本', { exact: true }).click();
      await panel
        .locator('.maintenance-rule details')
        .getByRole('heading')
        .filter({ hasText: 'v1' })
        .waitFor();
      assert.match(await panel.innerText(), /自动（当前仅观察，执行待实现）/);
      await mode.selectOption('off');
      await panel.locator('form').getByRole('button', { name: '保存新版本', exact: true }).click();
      await panel.locator('.maintenance-rule > summary').filter({ hasText: 'v3' }).waitFor();
      assert.equal(
        await panel.getByRole('button', { name: '读取候选', exact: true }).isDisabled(),
        true,
      );
      assert.equal(store.list('task').filter((task) => task.projectId === project.id).length, 0);
      assert.equal(store.list('run').filter((run) => run.projectId === project.id).length, 0);
    }
  } finally {
    engine.github.readMaintenanceCandidates = original;
  }
}
