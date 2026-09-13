import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { Previews } from '../src/server/preview.ts';
import { createApp } from '../src/server/app.ts';
import { checkInitialLocales } from './locale-browser-check.ts';

const artifacts = resolve('test-results');
await mkdir(artifacts, { recursive: true });
const store = new Store(':memory:');
const ws = new Workspaces(resolve('.cache/browser-workspaces'), store);
const engine = new Engine(store, new GitHub(store), ws, resolve('.cache'));
const app = createApp(store, engine, new Previews(store, ws), 4318);
await app.listen({ host: '127.0.0.1', port: 4318 });
const browser = await chromium.launch({
  headless: true,
  channel: process.platform === 'win32' ? 'msedge' : undefined,
});
const page = await browser.newPage({
  locale: 'zh-CN',
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
  reducedMotion: 'reduce',
});
const errors: string[] = [];
// Windows normalizes line endings in its native clipboard; the source text is unchanged.
const readClipboard = async () =>
  (await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n');
page.on('pageerror', (e) => errors.push(e.message));
try {
  await checkInitialLocales(browser, artifacts);
  await page.goto('http://127.0.0.1:4318');
  await page.getByText('从一个项目开始。').waitFor();
  await page.screenshot({ path: resolve(artifacts, '01-empty-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await page.getByLabel('项目名称', { exact: true }).fill('Orbit Studio');
  await page.getByLabel('项目目标').fill('让每一次产品迭代，都从明确的需求开始。');
  await page.getByRole('dialog').getByLabel('语言', { exact: true }).selectOption('en');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await page.getByRole('heading', { name: 'Orbit Studio', exact: true }).waitFor();
  await page.getByLabel('Language', { exact: true }).selectOption('zh-CN');
  const project = store.list('project')[0];
  const repo = store.createRepo({
    projectId: project.id,
    name: 'orbit-web',
    path: '/fixture/web',
    github: 'example/orbit-web',
    authorized: true,
    defaultBranch: 'main',
  });
  store.createRepo({
    projectId: project.id,
    name: 'orbit-service-long-repository-name',
    path: '/fixture/service',
    github: 'example/very-long-repository-name-for-responsive-validation',
    authorized: true,
    defaultBranch: 'main',
  });
  store.addMessage(
    project.id,
    'user',
    '我想让新用户更容易完成第一次项目创建。我们先讨论体验。',
    'discuss',
  );
  store.addMessage(
    project.id,
    'assistant',
    '可以。我们先明确用户第一次进入时，最需要完成什么。\n\n我建议先聚焦“创建项目 → 接入仓库 → 提出第一个需求”。仓库保持关闭，我们把体验聊清楚后再开工。',
  );
  const source = store.addMessage(
    project.id,
    'user',
    '请实现项目创建流程，并简化接入仓库的提示。',
    'implement',
  );
  const makeTask = (title: string) =>
    store.createTask({
      projectId: project.id,
      repoId: repo.id,
      sourceMessageId: source.id,
      title,
      spec: '让用户可以完成项目创建并理解下一步。',
      acceptance: ['可以创建项目', '空状态引导清晰'],
      dependencies: [],
      kind: 'frontend',
      complexity: 'normal',
      priority: 0,
    });
  const done = makeTask('完成首次项目创建体验');
  store.updateTask(done.id, {
    stage: 'done',
    issueBody: `<!-- phantom-task:${done.id} -->\n## What to build\n持久化的 Issue 正文。\n\n## Acceptance criteria\n- [x] 可以创建项目\n- [x] 空状态引导清晰\n\n## Blocked by\nNone (can start immediately)\n`,
  });
  const task = makeTask('简化仓库接入与授权提示');
  store.updateTask(task.id, {
    stage: 'developing',
    spec: '## 任务方案\n\n保留 **原始需求**。',
    acceptance: ['**创建项目**\n\n- 显示结果'],
    feedback: ['## 体验反馈\n\n- 增加说明'],
    pendingFeedback: ['> 待处理建议'],
    issueBody: '## Issue 原文\n\n`保留格式`',
    documentChanges: [{ path: 'CONTEXT.md', content: '# 文档变更\n\n**项目词汇**', version: 1 }],
    reviews: [
      {
        axis: 'spec',
        approved: false,
        head: 'fixture',
        base: 'fixture',
        summary: '## Review 总结\n\n请检查 `边界`。',
        findings: ['> Review 发现'],
      },
    ],
    tests: [
      {
        command: 'npm test',
        output: '# 原始日志\n**不渲染**',
        exitCode: 0,
        head: 'fixture',
        at: new Date().toISOString(),
      },
    ],
  });
  store.run('dev', project.id, 'frontend', task);
  const domainContent =
    '# 项目词汇\n\n> 保留 **词汇定义**。\n\n[不安全](javascript:alert%281%29)\n\n<script>alert(1)</script>';
  const domainDoc = store.recordDocument(project.id, {
    repoId: repo.id,
    path: 'CONTEXT.md',
    content: domainContent,
    accepted: true,
  });
  makeTask('支持体验反馈与持续迭代');
  store.event('fixture', '浏览器验证场景已准备', { projectId: project.id });
  await page.getByRole('switch', { name: 'orbit-web 开工开关', exact: true }).waitFor();
  const documents = page.getByRole('region', { name: '领域文档', exact: true });
  await documents.getByText(/orbit-web.*CONTEXT.md/).click({ timeout: 5000 });
  await documents.getByRole('heading', { name: '项目词汇' }).waitFor();
  assert.equal(await documents.locator('script, a[href]').count(), 0);
  await documents.getByRole('button', { name: '原始', exact: true }).click();
  assert.equal(await documents.locator('pre').textContent(), domainContent);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await documents.getByRole('button', { name: '复制', exact: true }).click();
  await documents.getByRole('status').getByText('已复制').waitFor();
  assert.equal(await readClipboard(), domainContent);
  assert.equal(
    store.snapshot().documents.find((d) => d.id === domainDoc.id)?.content,
    domainContent,
  );
  await documents.getByRole('button', { name: '美化', exact: true }).click();
  await page.screenshot({
    path: resolve(artifacts, 'markdown-domain-desktop.png'),
    fullPage: true,
  });
  await documents.getByText(/orbit-web.*CONTEXT.md/).click();
  await page.screenshot({ path: resolve(artifacts, '02-workspace-dark.png'), fullPage: true });
  await page.getByRole('switch', { name: 'orbit-web 开工开关', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="orbit-web 开工开关"]')?.getAttribute('aria-checked') ===
      'true',
  );
  await page.getByRole('switch', { name: 'orbit-web 开工开关', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="orbit-web 开工开关"]')?.getAttribute('aria-checked') ===
      'false',
  );
  assert.equal(store.repo(repo.id).enabled, false);
  assert.equal(store.activeRuns().filter((r) => r.role === 'dev').length, 1);
  await page.getByRole('tab', { name: '任务', exact: false }).click();
  await page.getByRole('button', { name: /简化仓库接入与授权提示/ }).click();
  await page.getByRole('heading', { name: '验收条件' }).waitFor();
  const taskDialog = page.getByRole('dialog');
  await taskDialog.getByRole('heading', { name: '任务方案' }).waitFor({ timeout: 5000 });
  assert.equal(
    await taskDialog
      .getByRole('region', { name: '验收条件 1', exact: true })
      .locator('li')
      .textContent(),
    '显示结果',
  );
  await taskDialog.getByRole('heading', { name: 'Review 总结' }).waitFor();
  assert.equal(
    await taskDialog
      .getByRole('region', { name: 'spec Review 发现 1', exact: true })
      .locator('blockquote')
      .innerText(),
    'Review 发现',
  );
  for (const heading of ['体验反馈', 'Issue 原文', '文档变更']) {
    await taskDialog
      .getByRole('heading', { name: heading, exact: true })
      .waitFor({ timeout: 5000 });
  }
  assert.equal(
    await taskDialog
      .getByRole('region', { name: '待处理反馈 1', exact: true })
      .locator('blockquote')
      .innerText(),
    '待处理建议',
  );
  const feedbackBlock = taskDialog.getByRole('region', { name: '反馈 1', exact: true });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await feedbackBlock.getByRole('button', { name: '复制', exact: true }).click();
  await feedbackBlock.getByRole('status').getByText('已复制').waitFor();
  assert.equal(await readClipboard(), '## 体验反馈\n\n- 增加说明');
  await taskDialog
    .getByRole('region', { name: '任务说明', exact: true })
    .getByRole('button', { name: '原始', exact: true })
    .click();
  assert.equal(
    await taskDialog
      .getByRole('region', { name: '任务说明', exact: true })
      .locator('pre')
      .textContent(),
    '## 任务方案\n\n保留 **原始需求**。',
  );
  await taskDialog.getByText('✓ npm test', { exact: true }).click();
  assert.equal(
    await taskDialog.locator('details[open] pre').textContent(),
    '# 原始日志\n**不渲染**',
  );
  assert.equal(await taskDialog.locator('details[open] h1, details[open] strong').count(), 0);
  await page.screenshot({ path: resolve(artifacts, '03-task-detail.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭窗口' }).click();
  for (const refresh of [false, true]) {
    if (refresh) {
      await page.reload();
      await page.getByRole('tab', { name: '任务', exact: false }).click();
    }
    await page.getByRole('button', { name: /完成首次项目创建体验/ }).click();
    const issue = page.getByRole('region', { name: 'Issue 正文', exact: true });
    await issue.waitFor({ timeout: 5000 });
    assert.equal(await issue.getByText('持久化的 Issue 正文。').count(), 1);
    assert.equal(await issue.getByRole('checkbox').count(), 2);
    for (const criterion of ['可以创建项目', '空状态引导清晰']) {
      assert.equal(
        await issue.locator('li').filter({ hasText: criterion }).getByRole('checkbox').isChecked(),
        true,
      );
      assert.equal(
        await issue.locator('li').filter({ hasText: criterion }).getByRole('checkbox').isDisabled(),
        true,
      );
    }
    assert.equal((await issue.innerText()).includes('phantom-task:'), false);
    if (refresh)
      await page.screenshot({
        path: resolve(artifacts, '07-completed-issue-reloaded.png'),
        fullPage: true,
      });
    await page.getByRole('button', { name: '关闭窗口' }).click();
  }
  await page.getByLabel('搜索任务').fill('不会匹配');
  await page.getByText('还没有匹配的任务').waitFor();
  await page.getByLabel('搜索任务').fill('');
  await page.getByRole('tab', { name: '与 PM 讨论' }).click();
  const markdown = [
    '# 交付说明',
    '',
    '这是 **重点**、*说明* 和 `npm test`。',
    '',
    '## 下一步',
    '',
    '- 检查结果',
    '- 复制命令',
    '',
    '1. 打开项目',
    '2. 阅读回复',
    '',
    '> 保持范围清晰。',
    '',
    '[项目文档](https://example.com/docs)',
    '',
    '| 检查 | 结果 |',
    '| --- | --- |',
    '| 浏览器 | 通过 |',
    '',
    '```sh',
    'npm test',
    'npm run check',
    '```',
  ].join('\n');
  store.addMessage(project.id, 'assistant', markdown);
  const reply = page.locator('.message.assistant').last();
  await reply.getByRole('heading', { name: '交付说明', level: 1 }).waitFor({ timeout: 5000 });
  assert.equal(await reply.getByRole('heading', { name: '下一步', level: 2 }).count(), 1);
  assert.equal(await reply.locator('li').count(), 4);
  assert.equal(await reply.locator('strong').last().textContent(), '重点');
  assert.equal(await reply.locator('em').textContent(), '说明');
  assert.equal(await reply.locator('blockquote').innerText(), '保持范围清晰。');
  assert.equal(await reply.getByRole('cell', { name: '通过', exact: true }).count(), 1);
  assert.equal(await reply.locator('p code').textContent(), 'npm test');
  assert.equal(await reply.locator('pre code').textContent(), 'npm test\nnpm run check\n');
  assert.equal(
    await reply.getByRole('link', { name: '项目文档' }).getAttribute('href'),
    'https://example.com/docs',
  );
  const safeLink = reply.getByRole('link', { name: '项目文档' });
  assert.equal(await safeLink.getAttribute('target'), '_blank');
  assert.match((await safeLink.getAttribute('rel')) ?? '', /\bnoopener\b/);
  assert.match((await safeLink.getAttribute('rel')) ?? '', /\bnoreferrer\b/);
  await page
    .context()
    .route('https://example.com/docs', (route) => route.fulfill({ body: 'Documentation' }));
  const originalUrl = page.url();
  const popupOpened = page.waitForEvent('popup');
  await safeLink.click();
  const popup = await popupOpened;
  await popup.waitForLoadState();
  assert.equal(popup.url(), 'https://example.com/docs');
  assert.equal(page.url(), originalUrl);
  assert.equal(await popup.evaluate(() => window.opener === null), true);
  await popup.close();
  const unsafe = [
    '# 安全边界',
    '',
    '<script>document.documentElement.dataset.compromised = "yes"</script>',
    '',
    '<img src=x onerror="document.documentElement.dataset.compromised = \'yes\'">',
    '',
    '<a href="javascript:alert(1)" onclick="alert(1)">HTML 链接</a>',
    '',
    '[脚本](javascript:alert%281%29) [混合大小写](JaVaScRiPt:alert%281%29)',
    '[实体](javascript&#58;alert%281%29) [数据](data:text/html,hello)',
    '[文件](file:///C:/Windows) [VB](vbscript:msgbox%281%29)',
  ].join('\n');
  store.addMessage(project.id, 'assistant', unsafe);
  const unsafeReply = page.locator('.message.assistant').last();
  await unsafeReply.getByRole('heading', { name: '安全边界' }).waitFor();
  assert.equal(await unsafeReply.locator('script, img, [onclick], [onerror], a[href]').count(), 0);
  assert.equal(await page.locator('html').getAttribute('data-compromised'), null);
  const literal = '# 原样文本\n\n**不要加粗** [链接](https://example.com) <b>保留</b>';
  for (const role of ['system'] as const) {
    store.addMessage(project.id, role, literal);
    const message = page.locator(`.message.${role} .message-content`).last();
    await message.getByText('保留', { exact: false }).waitFor();
    assert.equal(await message.textContent(), literal);
    assert.equal(await message.locator('h1, strong, a, b').count(), 0);
  }
  const userMarkdown = store.addMessage(project.id, 'user', literal);
  const userBlock = page.locator('.message.user').last();
  await userBlock.getByRole('heading', { name: '原样文本' }).waitFor({ timeout: 5000 });
  await userBlock.getByRole('button', { name: '原始', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(
    await userBlock.getByRole('button', { name: '原始', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(await userBlock.locator('pre').textContent(), literal);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await userBlock.getByRole('button', { name: '复制', exact: true }).click();
  await userBlock.getByRole('status').getByText('已复制').waitFor();
  assert.equal(await readClipboard(), literal);
  await userBlock.getByRole('button', { name: '美化', exact: true }).click();
  await userBlock.getByRole('heading', { name: '原样文本' }).waitFor();
  await userBlock.getByRole('button', { name: '复制', exact: true }).click();
  assert.equal(await readClipboard(), literal);
  assert.equal(store.snapshot().messages.find((m) => m.id === userMarkdown.id)?.content, literal);
  await page.evaluate(
    "Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw new Error('Clipboard denied'); } })",
  );
  await userBlock.getByRole('button', { name: '复制', exact: true }).click();
  await userBlock.getByRole('status').getByText('复制失败，请重试').waitFor();
  await page.evaluate(() => {
    delete (navigator.clipboard as Partial<Clipboard>).writeText;
  });
  const pmRun = store.run('pm', project.id, 'pm');
  store.event('fixture', 'PM streaming started', { projectId: project.id });
  await page.getByText('正在阅读上下文并整理回应…').waitFor();
  const firstChunk = '# 流式说明\n\n```sh\nnpm test';
  store.changes.emit('delta', { role: 'pm', runId: pmRun.id, text: firstChunk });
  const streaming = page.locator('.message.assistant').last();
  await streaming.getByRole('heading', { name: '流式说明' }).waitFor();
  assert.equal(await streaming.locator('pre code').textContent(), 'npm test\n');
  await streaming.getByRole('button', { name: '原始', exact: true }).click();
  assert.equal(await streaming.locator('pre').textContent(), firstChunk);
  await streaming.getByRole('button', { name: '复制', exact: true }).click();
  await streaming.getByRole('status').getByText('已复制').waitFor();
  assert.equal(await readClipboard(), firstChunk);
  const secondChunk = '\nnpm run check\n```\n\n' + markdown + '\n\n' + unsafe;
  store.changes.emit('delta', { role: 'pm', runId: pmRun.id, text: secondChunk });
  await streaming.locator('pre').filter({ hasText: '安全边界' }).waitFor();
  assert.equal(await streaming.locator('pre').textContent(), firstChunk + secondChunk);
  await streaming.getByRole('button', { name: '美化', exact: true }).click();
  await streaming.getByRole('heading', { name: '安全边界' }).waitFor();
  assert.equal(
    await streaming.locator('pre code').first().textContent(),
    'npm test\nnpm run check\n',
  );
  assert.equal(await streaming.getByRole('cell', { name: '通过', exact: true }).count(), 1);
  assert.equal(await streaming.locator('li').count(), 4);
  assert.equal(await streaming.locator('script, img, [onclick], [onerror]').count(), 0);
  assert.equal(await streaming.locator('a[href]').count(), 1);
  const streamedHtml = await streaming.locator('.message-content').innerHTML();
  store.addMessage(project.id, 'assistant', firstChunk + secondChunk);
  store.finishRun(pmRun.id, 'completed');
  await page.getByText('处理中', { exact: false }).waitFor({ state: 'hidden' });
  assert.equal(
    await page.locator('.message.assistant').last().locator('.message-content').innerHTML(),
    streamedHtml,
  );
  const longUrl = 'https://example.com/' + 'long-path-'.repeat(60);
  const longCode = 'echo ' + 'very-long-command-'.repeat(80);
  const wideTable =
    '| ' +
    Array.from({ length: 12 }, (_, i) => `Column ${i + 1}`).join(' | ') +
    ' |\n' +
    '| ' +
    Array(12).fill('---').join(' | ') +
    ' |\n' +
    '| ' +
    Array(12).fill('可读的表格内容').join(' | ') +
    ' |';
  const longMarkdown =
    '# 长内容\n\n' + longUrl + '\n\n```sh\n' + longCode + '\nsecond line\n```\n\n' + wideTable;
  store.updateTask(task.id, { spec: longMarkdown });
  store.recordDocument(project.id, {
    repoId: repo.id,
    path: 'CONTEXT.md',
    content: longMarkdown,
    accepted: true,
  });
  store.addMessage(project.id, 'assistant', longMarkdown);
  await page.getByRole('heading', { name: '长内容' }).waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    for (const theme of ['dark', 'light']) {
      if ((await page.locator('html').getAttribute('data-theme')) !== theme) {
        await page
          .getByRole('button', { name: theme === 'light' ? '浅色外观' : '深色外观' })
          .click();
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `${width}px ${theme}: page overflow`,
      );
      assert.equal(
        await page.locator('.conversation').evaluate((el) => el.scrollWidth <= el.clientWidth),
        true,
        `${width}px ${theme}: conversation overflow`,
      );
      const longReply = page.locator('.message.assistant').last();
      assert.equal(
        await longReply.locator('pre').evaluate((el) => {
          el.scrollLeft = 100;
          return getComputedStyle(el).whiteSpace === 'pre' && el.scrollLeft > 0;
        }),
        true,
        'long code preserves whitespace and scrolls horizontally',
      );
      assert.equal(
        await longReply.locator('table').evaluate((el) => {
          const scroller = el.parentElement!;
          scroller.scrollLeft = 100;
          return scroller.scrollLeft > 0;
        }),
        true,
        'wide tables scroll inside the reply',
      );
      await longReply.locator('pre').evaluate((el) => {
        el.scrollLeft = 0;
      });
      await longReply.locator('table').evaluate((el) => {
        el.parentElement!.scrollLeft = 0;
      });
      await longReply.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: resolve(artifacts, `markdown-${width}-${theme}.png`),
        fullPage: true,
      });
      await longReply.locator('pre').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: resolve(artifacts, `markdown-code-${width}-${theme}.png`),
        fullPage: true,
      });
      await page
        .getByRole('heading', { name: '交付说明', exact: true })
        .first()
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: resolve(artifacts, `markdown-structure-${width}-${theme}.png`),
        fullPage: true,
      });
      await longReply.getByRole('button', { name: '原始', exact: true }).click();
      assert.equal(await longReply.locator('pre').textContent(), longMarkdown);
      await longReply.getByRole('button', { name: '复制', exact: true }).click();
      await longReply.getByRole('status').getByText('已复制').waitFor();
      assert.equal(await readClipboard(), longMarkdown);
      assert.equal(
        await page.locator('.conversation').evaluate((el) => el.scrollWidth <= el.clientWidth),
        true,
      );
      await longReply.getByRole('button', { name: '美化', exact: true }).click();
      await page.getByRole('tab', { name: '任务', exact: false }).click();
      await page.getByRole('button', { name: /简化仓库接入与授权提示/ }).click();
      const description = page.getByRole('region', { name: '任务说明', exact: true });
      await description.getByRole('heading', { name: '长内容' }).waitFor();
      assert.equal(
        await description.locator('pre').evaluate((el) => {
          el.scrollLeft = 100;
          return el.scrollLeft > 0 && getComputedStyle(el).whiteSpace === 'pre';
        }),
        true,
      );
      assert.equal(
        await page.getByRole('dialog').evaluate((el) => el.scrollWidth <= el.clientWidth),
        true,
      );
      await description.getByRole('button', { name: '原始', exact: true }).click();
      assert.equal(await description.locator('pre').textContent(), longMarkdown);
      assert.equal(
        await page.getByRole('dialog').evaluate((el) => el.scrollWidth <= el.clientWidth),
        true,
      );
      await page.screenshot({
        path: resolve(artifacts, `markdown-task-raw-${width}-${theme}.png`),
      });
      await page.getByRole('button', { name: '关闭窗口' }).click();
      await page.getByRole('tab', { name: '与 PM 讨论' }).click();
      await documents.getByText(/orbit-web.*CONTEXT.md/).click();
      const documentBlock = documents.getByRole('region', {
        name: '领域文档 CONTEXT.md',
        exact: true,
      });
      await documentBlock.getByRole('heading', { name: '长内容' }).waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.equal(
        await documentBlock.locator('pre').evaluate((el) => {
          el.scrollLeft = 100;
          return el.scrollLeft > 0 && getComputedStyle(el).whiteSpace === 'pre';
        }),
        true,
      );
      await documentBlock.getByRole('button', { name: '原始', exact: true }).click();
      assert.equal(await documentBlock.locator('pre').textContent(), longMarkdown);
      await documentBlock.getByRole('button', { name: '复制', exact: true }).click();
      await documentBlock.getByRole('status').getByText('已复制').waitFor();
      assert.equal(await readClipboard(), longMarkdown);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await documentBlock.locator('pre').scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(artifacts, `markdown-doc-${width}-${theme}.png`) });
      if (width === 390) {
        await page.evaluate(
          "Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw new Error('Clipboard denied'); } })",
        );
        await documentBlock.getByRole('button', { name: '复制', exact: true }).click();
        await documentBlock.getByRole('status').getByText('复制失败，请重试').waitFor();
        await page.evaluate(() => {
          delete (navigator.clipboard as Partial<Clipboard>).writeText;
        });
      }
      await documentBlock.getByRole('button', { name: '美化', exact: true }).click();
      await documents.getByText(/orbit-web.*CONTEXT.md/).click();
    }
  }
  assert.equal(store.task(task.id).spec, longMarkdown);
  assert.equal(
    store.snapshot().documents.find((d) => d.id === domainDoc.id)?.content,
    longMarkdown,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '深色外观' }).click();
  await page.getByRole('button', { name: '浅色外观' }).click();
  await page.screenshot({ path: resolve(artifacts, '04-workspace-light.png'), fullPage: true });
  await page.getByRole('button', { name: '运行设置' }).click();
  await page.getByLabel('全局 Dev 上限').fill('3');
  await page.getByRole('button', { name: '保存设置' }).click();
  assert.equal(store.settings().globalDevLimit, 3);
  await page.reload();
  await page.getByRole('heading', { name: 'Orbit Studio', exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(artifacts, '05-mobile-light.png'), fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    'mobile must not overflow horizontally',
  );
  await page.getByRole('button', { name: '深色外观' }).click();
  await page.getByRole('button', { name: '运行设置' }).click();
  await page.screenshot({
    path: resolve(artifacts, '06-mobile-settings.png'),
    fullPage: false,
    animations: 'disabled',
  });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await page.getByRole('button', { name: '关闭窗口' }).click();
  const beforeLocaleSwitch = store.snapshot();
  const originalMessages = await page
    .locator(
      '.message-content .markdown-rendered, .message-content .markdown-source, .message.system .message-content',
    )
    .allTextContents();
  await page.getByLabel('给 PM 的消息').fill('原样保留 draft **text**');
  const localeWrites: string[] = [];
  const recordLocaleWrite = (request: import('playwright').Request) => {
    if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method()))
      localeWrites.push(request.url());
  };
  page.on('request', recordLocaleWrite);
  await page.getByLabel('语言', { exact: true }).selectOption('en');
  await page.getByRole('tab', { name: 'Discuss with PM' }).waitFor();
  assert.equal(await page.getByLabel('Message to PM').inputValue(), '原样保留 draft **text**');
  assert.equal(await page.getByRole('heading', { name: 'Orbit Studio', exact: true }).count(), 1);
  assert.deepEqual(
    await page
      .locator(
        '.message-content .markdown-rendered, .message-content .markdown-source, .message.system .message-content',
      )
      .allTextContents(),
    originalMessages,
  );
  assert.equal((await page.getByRole('button', { name: 'Copy', exact: true }).count()) > 0, true);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['dark', 'light']) {
      if ((await page.locator('html').getAttribute('data-theme')) !== theme)
        await page
          .getByRole('button', { name: theme === 'dark' ? 'Dark appearance' : 'Light appearance' })
          .click();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `English workspace ${width} ${theme}`,
      );
      await page.screenshot({
        path: resolve(artifacts, `locale-workspace-${width}-${theme}.png`),
        fullPage: true,
      });
    }
  }
  await page.getByRole('tab', { name: 'Tasks', exact: false }).click();
  await page.getByRole('button', { name: /简化仓库接入与授权提示/ }).click();
  const untranslatedSpec = page.getByRole('region', { name: '任务说明', exact: true });
  await untranslatedSpec.getByRole('button', { name: 'Raw', exact: true }).click();
  assert.equal(await untranslatedSpec.locator('pre').textContent(), longMarkdown);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByLabel('Language', { exact: true }).selectOption('zh-CN');
  assert.deepEqual(store.snapshot(), beforeLocaleSwitch);
  assert.deepEqual(localeWrites, []);
  page.off('request', recordLocaleWrite);
  assert.deepEqual(errors, []);
  console.log(
    'Browser checks passed: locale inference, switching, persistence, validation, accessibility, unchanged content without writes, bilingual dark/light 390px layouts, project creation, claim switch/drain, task details, search, settings, reload, shared Markdown, streaming, clipboard, safe links/HTML and raw logs; screenshots in test-results/.',
  );
} finally {
  await page.close();
  await browser.close();
  await app.close();
  store.close();
}
