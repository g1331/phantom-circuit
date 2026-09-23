import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Store } from '../src/server/store.ts';
import type { PriceCard, Snapshot } from '../src/shared/types.ts';

export async function checkRuntimeUI() {
  const store = new Store(':memory:');
  const project = store.createProject('Runtime fixture', 'User-authored 原文');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'runtime-repo',
    path: '/fixture',
    github: 'fixture/runtime',
    authorized: true,
    defaultBranch: 'main',
  });
  const message = store.addMessage(project.id, 'user', 'Implement fixture', 'implement');
  const task = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: message.id,
    title: 'Runtime task',
    spec: 'Original spec',
    acceptance: ['Observable outcome'],
    dependencies: [],
    kind: 'frontend',
    complexity: 'normal',
    priority: 0,
  });
  const historical = store.run('dev', project.id, 'frontend', task);
  store.finishRun(historical.id, 'completed', undefined, {
    usage: { inputTokens: 1200, outputTokens: 80 },
    durationMs: 50_000,
  });
  const snapshot: Snapshot = store.snapshot();
  snapshot.runs[0].usage = { ...snapshot.runs[0].usage, contextWindow: 128000 };
  snapshot.runs[0].priceSnapshot = {
    currency: 'USD',
    inputPerMillion: '0.0000001025',
    version: 'fixture-price-v1',
    source: 'custom-fixture',
    capturedAt: historical.startedAt,
  };
  const current = snapshot.projects[0];
  const originalRun = JSON.stringify(snapshot.runs[0]);
  snapshot.incidents = [
    {
      id: 'incident',
      projectId: project.id,
      taskId: task.id,
      phase: 'verification',
      status: 'open',
      message: 'Build needs assessment',
      descriptor: { code: 'service_unavailable' },
      evidence: 'Original tool evidence',
      createdAt: historical.startedAt,
      updatedAt: historical.startedAt,
    },
  ];
  snapshot.clarifications = [
    {
      id: 'clarification',
      projectId: project.id,
      sourceMessageId: message.id,
      sourceIntent: 'implement',
      status: 'open',
      questions: [
        {
          id: 'q1',
          question: 'Which audience?',
          recommendation: 'Teams',
          options: [
            { value: 'teams', label: 'Teams' },
            { value: 'solo', label: 'Individuals' },
          ],
        },
        { id: 'q2', question: 'What should remain unchanged?' },
      ],
      createdAt: historical.startedAt,
      updatedAt: historical.startedAt,
    },
  ];
  snapshot.recoveryItems = ['recovery-one', 'recovery-two'].map((id) => ({
    id,
    projectId: project.id,
    taskId: task.id,
    oldRunId: historical.id,
    runId: historical.id,
    status: 'recoverable',
    policy: 'manual',
    reason: 'Interrupted fixture',
    reasonDescriptor: id === 'recovery-one' ? { code: 'conflict' } : { code: 'unknown-legacy' },
    createdAt: historical.startedAt,
    updatedAt: historical.startedAt,
  }));
  const provider = {
    id: 'custom-fixture',
    kind: 'custom' as const,
    name: 'Custom fixture',
    baseUrl: 'https://example.test/v1',
    hasKey: true,
    prices: {
      'existing-token-rate': { currency: 'USD', inputPerToken: '0.000000000123' },
    } as Record<string, PriceCard>,
  };
  snapshot.providers.push(provider);
  const server = await createServer({
    server: { host: '127.0.0.1', port: 4330, strictPort: true },
  });
  await server.listen();
  const browser = await chromium.launch({
    headless: true,
    channel: process.platform === 'win32' ? 'msedge' : undefined,
  });
  const page = await browser.newPage({
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    reducedMotion: 'reduce',
  });
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(30000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let allowanceFails = false;
  const deliveries: string[] = [];
  const models = [{ id: 'omp-fixture', provider: 'fixture', reasoningEfforts: ['low', 'high'] }];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api', '');
    const body = request.method() === 'GET' ? undefined : request.postDataJSON();
    let result: unknown = {};
    if (path === '/session') result = { csrf: 'fixture' };
    else if (path === '/state') result = snapshot;
    else if (path === '/events') {
      await route.fulfill({ contentType: 'text/event-stream', body: 'event: ready\ndata: {}\n\n' });
      return;
    } else if (path.endsWith('/scheduling'))
      result = {
        projectId: project.id,
        at: historical.startedAt,
        projectOrder: [project.id],
        candidates: [],
        tasks: [],
      };
    else if (path === '/providers') result = snapshot.providers;
    else if (path.startsWith('/providers/') && path.endsWith('/models'))
      result = {
        ok: true,
        models: [
          { id: 'gpt-6-astra', reasoningEfforts: ['low', 'medium', 'high'] },
          { id: 'gpt-5.6-luna', reasoningEfforts: ['max'] },
        ],
      };
    else if (path.startsWith('/agents/') && path.endsWith('/models'))
      result = { models, available: true };
    else if (path.endsWith('/probe')) result = { available: true, version: 'fixture-1' };
    else if (path.endsWith('/allowance')) {
      if (allowanceFails) {
        await route.fulfill({
          status: 503,
          json: {
            code: 'service_unavailable',
            params: {},
            error: 'Allowance diagnostic 原文',
            detail: 'Allowance diagnostic 原文',
          },
        });
        return;
      }
      result = {
        agentKind: path.split('/')[2],
        providerId: new URL(request.url()).searchParams.get('providerId'),
        state: 'available',
        remaining: '12.345678901234',
        currency: 'USD',
        capturedAt: historical.startedAt,
      };
    } else if (path === '/settings') {
      Object.assign(snapshot.settings, body);
      result = { warnings: [] };
    } else if (path.endsWith('/runtime')) {
      Object.assign(current, body);
      result = { warnings: [] };
    } else if (path.endsWith('/answer')) {
      const clarification = snapshot.clarifications![0];
      clarification.answers = [
        ...new Map(
          [...(clarification.answers ?? []), ...body.answers].map((answer) => [
            answer.questionId,
            answer,
          ]),
        ).values(),
      ];
      clarification.status =
        clarification.answers.length === clarification.questions.length ? 'answered' : 'open';
      result = clarification;
    } else if (path.includes('/clarifications/') && path.endsWith('/cancel')) {
      snapshot.clarifications![0].status = 'cancelled';
      result = snapshot.clarifications![0];
    } else if (path.endsWith('/recovery/resume')) {
      for (const item of snapshot.recoveryItems!)
        if (!body.id || item.id === body.id) item.status = 'resumed';
    } else if (path.includes('/recovery/') && path.endsWith('/cancel'))
      snapshot.recoveryItems!.find((item) => path.includes(item.id))!.status = 'cancelled';
    else if (path.endsWith('/resolve'))
      snapshot.incidents![0].status = body.action === 'resolved' ? 'resolved' : 'waiting_user';
    else if (path.endsWith('/usage'))
      result = {
        usage: { inputTokens: 1200, outputTokens: 80 },
        cost: {
          amount: '0.000000000123',
          currency: 'USD',
          partial: true,
          coverage: ['inputTokens'],
        },
        coverage: { available: 1, total: 2 },
        costs: [
          { amount: '0.000000000123', currency: 'USD', partial: true, coverage: ['inputTokens'] },
          {
            amount: '0.1234567890123456789',
            currency: 'EUR',
            partial: false,
            coverage: ['outputTokens'],
          },
        ],
        runCosts: {
          [historical.id]: {
            amount: '0.000000000123',
            currency: 'USD',
            partial: true,
            coverage: ['inputTokens'],
          },
        },
        runs: snapshot.runs.filter((run) => run.taskId === task.id),
        durationMs: 50_000,
        elapsedMs: 300_000,
      };
    else if (path.endsWith('/prices')) {
      provider.prices = body.prices;
      result = provider;
    } else if (path.endsWith('/messages')) {
      deliveries.push(body.deliveryMode);
      snapshot.messages.push({
        ...message,
        id: `delivery-${deliveries.length}`,
        draftId: `delivery-${deliveries.length}`,
        content: body.content,
        deliveryMode: body.deliveryMode,
      });
    } else {
      await route.fulfill({ status: 404, json: { error: `Unexpected fixture request: ${path}` } });
      return;
    }
    await route.fulfill({ json: result });
  });
  try {
    await mkdir(resolve('test-results'), { recursive: true });
    await page.goto('http://127.0.0.1:4330');
    await page
      .getByText('The service is temporarily unavailable; try again later', { exact: true })
      .waitFor();
    await page.getByText('Interrupted fixture', { exact: true }).waitFor();
    await page.locator('.sidebar .language-control select').selectOption('zh-CN');
    await page.getByText('服务暂时不可用，请稍后重试', { exact: true }).waitFor();
    await page.getByText('当前资源状态不允许此操作', { exact: true }).waitFor();
    await page.getByText('Interrupted fixture', { exact: true }).waitFor();
    await page.locator('.sidebar .language-control select').selectOption('en');
    const clarification = page.locator('.clarification-card');
    await clarification.waitFor();
    await page.setViewportSize({ width: 390, height: 500 });
    await clarification.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve('test-results', 'runtime-actions-en-390.png') });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.setViewportSize({ width: 1366, height: 768 });
    await clarification.getByLabel('Which audience?', { exact: true }).selectOption('teams');
    await clarification.getByRole('button', { name: 'Submit available answers' }).click();
    assert.equal(snapshot.clarifications![0].status, 'open');
    await clarification.getByLabel('Other answer', { exact: true }).last().fill('Keep 用户内容');
    await page.reload();
    assert.equal(
      await clarification.getByLabel('Other answer', { exact: true }).last().inputValue(),
      'Keep 用户内容',
    );
    await clarification.getByRole('button', { name: 'Submit available answers' }).click();
    await clarification.getByText('Answered', { exact: true }).waitFor();
    assert.equal(snapshot.clarifications![0].answers?.[1].value, 'Keep 用户内容');
    const recovery = page.getByRole('region', { name: 'Interrupted work' });
    await recovery.getByRole('button', { name: 'Resume', exact: true }).first().click();
    await recovery.locator('.action-record').nth(1).waitFor({ state: 'hidden' });
    await recovery.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.deepEqual(
      snapshot.recoveryItems!.map((item) => item.status),
      ['resumed', 'cancelled'],
    );
    snapshot.recoveryItems!.forEach((item) => {
      item.status = 'recoverable';
    });
    snapshot.clarifications![0].status = 'open';
    await page.reload();
    await recovery.getByRole('button', { name: 'Resume all recoverable work' }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(
      snapshot.recoveryItems!.every((item) => item.status === 'resumed'),
      true,
    );
    await clarification.getByRole('button', { name: 'Cancel', exact: true }).click();
    await clarification.getByText('Cancelled', { exact: true }).waitFor();
    const incidents = page.getByRole('region', { name: 'Incidents' });
    await incidents.getByLabel('Resolution guidance').fill('Use the retained evidence');
    await incidents.getByRole('button', { name: 'Wait for user' }).click();
    await incidents.getByText('Waiting for user', { exact: true }).waitFor();
    await incidents.getByRole('button', { name: 'Mark resolved' }).click();
    await page.locator('.context-trigger').click();
    const allowance = page.getByRole('region', { name: 'Account allowance' });
    await allowance.getByText(/12.345678901234/).waitFor();
    allowanceFails = true;
    await allowance.getByRole('button', { name: 'Refresh allowance' }).click();
    await allowance
      .getByRole('alert')
      .getByText(/Last successful result/)
      .waitFor();
    assert.match(await allowance.innerText(), /12.345678901234/);
    await page.keyboard.press('Escape');
    await page.locator('#project-context').waitFor({ state: 'hidden' });
    await page.locator('.sidebar .language-control select').selectOption('zh-CN');
    await page.locator('.context-trigger').click();
    await page
      .getByRole('alert')
      .getByText('服务暂时不可用，请稍后重试', { exact: false })
      .waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#project-context').waitFor({ state: 'hidden' });
    await page.locator('.sidebar .language-control select').selectOption('en');
    allowanceFails = false;
    await page.getByRole('button', { name: 'Runtime settings', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Software default agent').selectOption('codex');
    await dialog.getByText('Effective agent: Codex', { exact: true }).waitFor();
    await dialog.locator('summary').filter({ hasText: 'OMP role models' }).click();
    await dialog
      .getByLabel('Project PM OMP model', { exact: true })
      .selectOption(JSON.stringify(['fixture', 'omp-fixture']));
    await dialog
      .getByLabel('Project PM OMP reasoning effort', { exact: true })
      .selectOption('high');
    await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(snapshot.settings.defaultAgent, 'codex');
    assert.equal(snapshot.settings.ompProfiles?.pm.model, 'omp-fixture');
    await page.locator('.context-trigger').click();
    await page
      .locator('#project-context')
      .getByRole('button', { name: 'Project model settings' })
      .click();
    await page.locator('#project-context').waitFor({ state: 'hidden' });
    await dialog.getByLabel('Project agent', { exact: true }).selectOption('omp');
    await dialog.locator('.role-modes-group > summary').click();
    await dialog.getByLabel('Project PM assignment mode').selectOption('pinned');
    await dialog.getByLabel('Interruption recovery policy').selectOption('manual');
    await dialog.locator('summary').filter({ hasText: 'Secondary review model' }).click();
    await dialog.getByLabel('Set OMP secondary review model').check();
    await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(current.agentSelection, { mode: 'override', agent: 'omp' });
    assert.equal(current.profileModes?.pm, 'pinned');
    assert.equal(current.recoveryPolicy, 'manual');
    assert.ok(current.secondaryReviewProfiles?.omp);
    assert.equal(
      JSON.stringify(snapshot.runs[0]),
      originalRun,
      'runtime edits cannot alter historical run evidence',
    );
    await page.getByRole('button', { name: 'Runtime settings', exact: true }).click();
    await dialog.locator('.provider-group > summary').click();
    await dialog.getByLabel('Select provider', { exact: true }).selectOption(provider.id);
    const prices = dialog.getByRole('region', { name: 'Custom model prices' });
    await prices.getByLabel('Priced model ID').fill('existing-token-rate');
    assert.equal(
      await prices.getByLabel('Input price per token', { exact: true }).inputValue(),
      '0.000000000123',
    );
    await prices.getByLabel('Input price per token', { exact: true }).fill('0.000000000456');
    await prices.getByRole('button', { name: 'Save model prices' }).click();
    await prices.getByText('Model prices saved', { exact: true }).waitFor();
    assert.equal(provider.prices['existing-token-rate'].inputPerToken, '0.000000000456');
    assert.equal(provider.prices['existing-token-rate'].inputPerMillion, undefined);
    await prices.getByLabel('Priced model ID').fill('exact-model');
    await prices
      .getByLabel('Input price per million tokens', { exact: true })
      .fill('0.1234567890123456789');
    await prices.getByLabel('Output price per million tokens', { exact: true }).fill('0');
    await prices.getByRole('button', { name: 'Save model prices' }).click();
    await prices.getByText('Model prices saved', { exact: true }).waitFor();
    assert.equal(provider.prices['exact-model'].inputPerMillion, '0.1234567890123456789');
    assert.equal(provider.prices['exact-model'].outputPerMillion, '0');
    assert.equal(provider.prices['exact-model'].cachedInputPerMillion, undefined);
    await page.keyboard.press('Escape');
    snapshot.runs.push({
      ...historical,
      id: 'active-pm',
      role: 'pm',
      status: 'running',
      endedAt: undefined,
    });
    snapshot.messages.push({
      ...message,
      id: 'assistant-draft',
      draftId: 'stable-draft',
      role: 'assistant',
      content: 'Streaming reply',
      runId: 'active-pm',
      draftStatus: 'running',
    });
    await page.reload();
    assert.equal(await page.getByLabel('Delivery while PM is active').inputValue(), 'queue');
    await page.getByLabel('Message to PM').fill('Queued input');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByLabel('Delivery while PM is active').selectOption('steer');
    await page.getByLabel('Message to PM').fill('Steered input');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    assert.deepEqual(deliveries, ['queue', 'steer']);
    assert.equal(
      await page.locator('.message.assistant').count(),
      1,
      'durable assistant drafts must not duplicate streaming placeholders',
    );
    for (const locale of ['en', 'zh-CN']) {
      await page.locator('.sidebar .language-control select').selectOption(locale);
      for (const theme of ['dark', 'light']) {
        if ((await page.locator('html').getAttribute('data-theme')) !== theme)
          await page
            .getByRole('button', {
              name:
                locale === 'en'
                  ? theme === 'light'
                    ? 'Light appearance'
                    : 'Dark appearance'
                  : theme === 'light'
                    ? '浅色外观'
                    : '深色外观',
              exact: true,
            })
            .click();
        for (const width of [1366, 390]) {
          await page.setViewportSize({ width, height: width === 390 ? 500 : 768 });
          await page.locator('.context-trigger').click();
          await page
            .locator('#project-context')
            .getByRole('button', {
              name: locale === 'en' ? 'Project model settings' : '项目模型设置',
              exact: true,
            })
            .click();
          await page.locator('#project-context').waitFor({ state: 'hidden' });
          await page.screenshot({
            path: resolve('test-results', `runtime-settings-${locale}-${width}-${theme}.png`),
          });
          assert.equal(
            await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
            true,
          );
          await page.keyboard.press('Escape');
          await page
            .getByRole('tab', { name: locale === 'en' ? 'Tasks' : '任务', exact: false })
            .click();
          await page.locator('.task-card').filter({ hasText: task.title }).click();
          await dialog.getByText('USD 0.000000000123', { exact: false }).first().waitFor();
          await dialog.getByText('EUR 0.1234567890123456789', { exact: false }).waitFor();
          const runRecord = dialog.locator('.run-record').first();
          await runRecord.locator('summary').first().click();
          await runRecord.getByText('USD 0.000000000123', { exact: false }).waitFor();
          await runRecord.getByText('128,000', { exact: true }).waitFor();
          await runRecord
            .getByText(locale === 'en' ? 'Pinned price snapshot' : '固定价格快照', { exact: true })
            .click();
          await runRecord.getByText('0.0000001025', { exact: true }).waitFor();
          await page
            .locator('.usage-panel > h3')
            .evaluate((element) => element.scrollIntoView({ block: 'start' }));
          await page.screenshot({
            path: resolve('test-results', `runtime-usage-${locale}-${width}-${theme}.png`),
          });
          if (width === 390) {
            await runRecord.locator('details').scrollIntoViewIfNeeded();
            await page.screenshot({
              path: resolve('test-results', `runtime-run-cost-${locale}-${theme}.png`),
            });
          }
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          await page.keyboard.press('Escape');
        }
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
    store.close();
  }
}
if (process.argv[1]?.endsWith('runtime-browser-check.ts')) await checkRuntimeUI();
