import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';

export async function checkInitialLocales(browser: Browser, artifacts: string) {
  const unavailable = await browser.newContext({ locale: 'en-US' });
  await unavailable.route('**/api/session', (route) => route.fulfill({ status: 503, body: '' }));
  const unavailablePage = await unavailable.newPage();
  await unavailablePage.goto('http://127.0.0.1:4318');
  await unavailablePage
    .getByRole('alert')
    .getByText('Cannot connect to local service')
    .waitFor({ timeout: 5000 });
  await unavailablePage.getByLabel('Language', { exact: true }).selectOption('zh-CN');
  await unavailablePage.getByRole('alert').getByText('无法连接本地服务').waitFor();
  await unavailable.close();
  for (const [languages, expected] of [
    [['en-US'], 'en'],
    [['zh-TW'], 'zh-CN'],
    [['en-US', 'zh-TW'], 'zh-CN'],
    [['zh-TW', 'en-US'], 'zh-CN'],
    [['fr-FR'], 'en'],
    [[], 'en'],
  ] as const) {
    const context = await browser.newContext({ locale: 'en-US' });
    await context.addInitScript((languages) => {
      Object.defineProperty(navigator, 'languages', { value: languages });
    }, languages);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:4318');
    await page
      .getByRole('heading', {
        name: expected === 'en' ? 'Start with a project.' : '从一个项目开始。',
      })
      .waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), expected);
    assert.equal(await page.evaluate(() => localStorage.getItem('phantom.locale')), null);
    await context.close();
  }

  const context = await browser.newContext({ locale: 'zh-CN', reducedMotion: 'reduce' });
  let page = await context.newPage();
  const writes: string[] = [];
  context.on('request', (request) => {
    if (
      request.url().includes('/api/') &&
      !['GET', 'HEAD'].includes(request.method()) &&
      !request.url().endsWith('/session')
    )
      writes.push(request.url());
  });
  const errors: string[] = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:4318');
  await page.getByRole('heading', { name: '从一个项目开始。' }).waitFor();
  await page.getByLabel('语言', { exact: true }).selectOption('en');
  await page.getByRole('heading', { name: 'Start with a project.' }).waitFor();
  assert.equal(await page.title(), 'Phantom Circuit · Local workspace');
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(await page.getByRole('link', { name: 'Phantom Circuit home' }).count(), 1);
  assert.equal(
    await page.getByLabel('Language', { exact: true }).getAttribute('title'),
    'Language',
  );
  await page.getByText('Connected to local service', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  const dialog = page.getByRole('dialog');
  assert.equal(await dialog.getAttribute('aria-label'), 'Create project');
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await dialog.getByRole('alert').getByText('Enter a project name.').waitFor();
  await dialog.getByLabel('Project name', { exact: true }).fill('   ');
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  assert.equal(
    await dialog.getByLabel('Project name', { exact: true }).getAttribute('aria-invalid'),
    'true',
  );
  await dialog.getByLabel('Project goal', { exact: true }).fill('原文 **unchanged** /path');
  await dialog.getByLabel('Language', { exact: true }).selectOption('zh-CN');
  await dialog.getByRole('alert').getByText('请输入项目名称。').waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  assert.equal(await page.title(), 'Phantom Circuit · 本地工作空间');
  assert.equal(await dialog.getAttribute('aria-label'), '创建项目');
  assert.equal(await dialog.getByPlaceholder('例如：我的产品').inputValue(), '   ');
  assert.equal(
    await dialog.getByPlaceholder('这个项目希望解决什么问题？').inputValue(),
    '原文 **unchanged** /path',
  );
  await dialog.getByLabel('项目名称', { exact: true }).fill('保持原名 Project');
  await dialog.getByLabel('语言', { exact: true }).selectOption('en');
  assert.equal(
    await dialog.getByLabel('Project name', { exact: true }).inputValue(),
    '保持原名 Project',
  );
  // Imported or programmatically supplied form values must obey the same server limits.
  await dialog.getByLabel('Project name', { exact: true }).evaluate((input: HTMLInputElement) => {
    input.value = 'a'.repeat(101);
  });
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await dialog
    .getByRole('alert')
    .getByText('Project name must be 100 characters or fewer.')
    .waitFor();
  await dialog.getByLabel('Project name', { exact: true }).fill('Valid name');
  await dialog
    .getByLabel('Project goal', { exact: true })
    .evaluate((input: HTMLTextAreaElement) => {
      input.value = 'a'.repeat(3001);
    });
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await dialog
    .getByRole('alert')
    .getByText('Project goal must be 3,000 characters or fewer.')
    .waitFor();
  await dialog.getByLabel('Language', { exact: true }).selectOption('zh-CN');
  await dialog.getByRole('alert').getByText('项目目标不能超过 3000 个字符。').waitFor();
  await dialog.getByLabel('语言', { exact: true }).selectOption('en');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await page.reload();
  await page.getByRole('heading', { name: 'Start with a project.' }).waitFor();
  await page.close();
  page = await context.newPage();
  await page.goto('http://127.0.0.1:4318');
  await page.getByRole('heading', { name: 'Start with a project.' }).waitFor();
  // Restoring browser storage into a new context models reopening the browser.
  const saved = await context.storageState();
  const reopened = await browser.newContext({ locale: 'zh-CN', storageState: saved });
  const reopenedPage = await reopened.newPage();
  await reopenedPage.goto('http://127.0.0.1:4318');
  await reopenedPage.getByRole('heading', { name: 'Start with a project.' }).waitFor();
  await reopened.close();

  for (const locale of ['en', 'zh-CN'] as const) {
    await page.locator('.sidebar select').selectOption(locale);
    const english = locale === 'en';
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      for (const theme of ['dark', 'light']) {
        if ((await page.locator('html').getAttribute('data-theme')) !== theme) {
          await page
            .getByRole('button', {
              name:
                theme === 'light'
                  ? english
                    ? 'Light appearance'
                    : '浅色外观'
                  : english
                    ? 'Dark appearance'
                    : '深色外观',
            })
            .click();
        }
        for (const modal of ['none', 'project', 'settings']) {
          if (modal !== 'none')
            await page
              .getByRole('button', {
                name:
                  modal === 'project'
                    ? english
                      ? 'Create project'
                      : '创建项目'
                    : english
                      ? 'Runtime settings'
                      : '运行设置',
                exact: true,
              })
              .click();
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
            `${locale} ${width} ${theme} ${modal}: page overflow`,
          );
          if (modal !== 'none')
            assert.equal(
              await page.getByRole('dialog').evaluate((el) => el.scrollWidth <= el.clientWidth),
              true,
              `${locale} ${width} ${theme} ${modal}: dialog overflow`,
            );
          await page.screenshot({
            path: resolve(artifacts, `locale-${locale}-${width}-${theme}-${modal}.png`),
            fullPage: modal === 'none',
            animations: 'disabled',
          });
          if (modal !== 'none')
            await page.getByRole('button', { name: english ? 'Close dialog' : '关闭窗口' }).click();
        }
      }
    }
  }
  await page.getByRole('button', { name: '运行设置', exact: true }).click();
  await page.getByRole('dialog').getByLabel('语言', { exact: true }).selectOption('en');
  assert.equal(await page.getByRole('dialog').getAttribute('aria-label'), 'Runtime settings');
  assert.equal(await page.getByLabel('Global Dev limit').count(), 1);
  assert.equal(await page.getByLabel('Backend model', { exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  // An invalid saved value is ignored in favor of the browser's Chinese preference.
  await page.evaluate(() => localStorage.setItem('phantom.locale', 'unsupported'));
  await page.reload();
  await page.getByRole('heading', { name: '从一个项目开始。' }).waitFor();
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  await context.close();
}
