import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { resolve } from 'node:path';

export async function checkLocale(page: Page, artifacts: string) {
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.locator('.sidebar .language-control select').selectOption('zh-CN');
  await page.getByRole('tab', { name: '与 PM 讨论', exact: true }).click();
  const draft = 'Keep this draft 中文内容 **unchanged**';
  await page.getByLabel('给 PM 的消息').fill(draft);
  await page.locator('.sidebar .language-control select').selectOption('en');
  assert.equal(await page.getByLabel('Message to PM').inputValue(), draft);
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(await page.title(), 'Phantom Circuit · Local workspace');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await dialog.getByRole('alert').getByText('Enter a project name.', { exact: true }).waitFor();
  await dialog.getByLabel('Language').selectOption('zh-CN');
  await dialog.getByRole('alert').getByText('请输入项目名称。', { exact: true }).waitFor();
  await dialog.getByLabel('项目名称', { exact: true }).fill('Unsubmitted 中文项目');
  await dialog.getByLabel('语言').selectOption('en');
  assert.equal(
    await dialog.getByLabel('Project name', { exact: true }).inputValue(),
    'Unsubmitted 中文项目',
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Runtime settings', exact: true }).click();
  await dialog.getByRole('heading', { name: 'Codex role models', exact: true }).waitFor();
  await dialog.getByLabel('Project PM model', { exact: true }).waitFor();
  await dialog.getByRole('region', { name: 'Provider management' }).waitFor();
  const text = (await dialog.innerText()).replaceAll('简体中文', '');
  assert.equal(
    /\p{Script=Han}/u.test(text),
    false,
    `English settings must include provider and profile translations: ${text
      .split('\n')
      .filter((line) => /\p{Script=Han}/u.test(line))
      .join(' | ')}`,
  );
  await page.screenshot({ path: resolve(artifacts, 'locale-settings-en-desktop.png') });
  await dialog.getByLabel('Language').selectOption('zh-CN');
  await dialog.getByLabel('项目 PM模型', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '接入仓库', exact: true }).click();
  await dialog.getByLabel('语言').selectOption('en');
  await dialog.getByLabel('Local repository path', { exact: true }).waitFor();
  assert.equal(
    /\p{Script=Han}/u.test((await dialog.innerText()).replaceAll('简体中文', '')),
    false,
  );
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('button', { name: 'Runtime settings', exact: true }).waitFor();
  assert.equal(await page.locator('.sidebar .language-control select').inputValue(), 'en');
  await page.setViewportSize({ width: 390, height: 500 });
  await page.getByRole('button', { name: 'Runtime settings', exact: true }).click();
  await dialog.getByLabel('Language').selectOption('zh-CN');
  await dialog.getByLabel('项目 PM模型', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(artifacts, 'locale-settings-zh-mobile-short.png') });
  await page.keyboard.press('Escape');
}
