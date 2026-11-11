import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page, Request, Response } from 'playwright';
import type { Store } from '../src/server/store.ts';
import type { ConversationPage, Snapshot } from '../src/shared/types.ts';
import sharp from 'sharp';
import { checkTyping } from './composer-browser-check.ts';
import { choosePreference } from './browser-preferences.ts';

/** Synthetic records exercise the real HTTP, Store, React and image rendering boundaries. */
export async function checkHistory(page: Page, store: Store, artifacts: string) {
  const project = store.createProject('History synthetic fixture', '');
  const short = store.createProject('Short synthetic fixture', '');
  const blank = store.createProject('Empty synthetic fixture', '');
  const overlap = store.createProject('Overlap synthetic fixture', '');
  const overlapFirst = store.addMessage(overlap.id, 'assistant', 'Original overlap body');
  store.addMessage(short.id, 'assistant', 'Short fixture reply');
  const image = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">' +
        '<rect width="320" height="180" fill="#e7eefc"/>' +
        '<path d="M30 140V95h45v45zm65 0V60h45v80zm65 0V80h45v60z" fill="#536cc8"/>' +
        '<text x="24" y="28" font-family="sans-serif" fill="#253b72">' +
        'Synthetic image fixture</text>' +
        '</svg>',
    ),
  )
    .png()
    .toBuffer();
  const expected: string[] = [];
  const types = { text: 0, markdown: 0, image: 0 };
  const activityRun = store.run('pm', project.id, 'pm');
  store.put('run', activityRun.id, { ...activityRun, status: 'completed' });
  for (let index = 0; index < 1003; index++) {
    const kind = index % 3;
    const content =
      kind === 1
        ? `## Fixture ${index}\n\n**Markdown** with [a link](https://example.com).\n\n` +
          '```ts\nconst result = 42;\n```\n\n| Stage | Value |\n| --- | --- |\n| Ready | 42 |'
        : `Complete synthetic message ${index}. ` +
          'A readable paragraph of actual content. '.repeat(4);
    const message = store.addMessage(
      project.id,
      index % 2 ? 'assistant' : 'user',
      content,
      undefined,
      kind === 2
        ? [
            {
              id: `image-${index}`,
              name: `Fixture ${index}.png`,
              mediaType: 'image/png',
              width: 320,
              height: 180,
              size: image.length,
            },
          ]
        : undefined,
    );
    store.put('message', message.id, {
      ...message,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, Math.floor(index / 4))).toISOString(),
      status: 'completed',
      draftStatus: 'completed',
    });
    expected.push(message.id);
    if (index % 100 === 0) {
      store.activity(activityRun, `history-${index}`, {
        kind: 'summary',
        title: `Fixture activity ${index}`,
        status: 'completed',
        startedAt: new Date(Date.UTC(2026, 0, 1, 0, Math.floor(index / 4))).toISOString(),
        details: { summary: `Complete synthetic tool evidence ${index}` },
      });
    }
    types[kind === 0 ? 'text' : kind === 1 ? 'markdown' : 'image']++;
  }
  const network: { url: string; count: number; bytes: number }[] = [];
  const bodies = new Set<string>();
  const responseChecks: Promise<void>[] = [];
  const readBody = async (response: Response) => {
    try {
      return await response.text();
    } catch (error) {
      const discarded = /No data found for resource|No resource with given identifier/;
      if (error instanceof Error && discarded.test(error.message)) return undefined;
      throw error;
    }
  };
  const record = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/')) return;
    if (path.endsWith('/messages')) {
      responseChecks.push(
        (async () => {
          const response = await request.response();
          if (!response?.ok()) return;
          const body = await readBody(response);
          if (body === undefined) return;
          const data: ConversationPage = JSON.parse(body);
          assert.ok(data.entries.length <= 50, 'every history response is bounded');
          for (const entry of data.entries)
            if (entry.kind === 'message') bodies.add(entry.value.id);
          network.push({ url: response.url(), count: data.entries.length, bytes: body.length });
        })(),
      );
    } else if (path === '/api/state') {
      responseChecks.push(
        (async () => {
          const response = await request.response();
          if (!response?.ok()) return;
          const body = await readBody(response);
          if (body === undefined) return;
          const state: Snapshot = JSON.parse(body);
          assert.deepEqual(state.messages, [], 'background state omits historical message bodies');
          assert.deepEqual(
            state.activities,
            [],
            'background state omits historical activity bodies',
          );
          network.push({ url: response.url(), count: 0, bytes: body.length });
        })(),
      );
    }
  };
  page.on('requestfinished', record);
  await page.route(`**/projects/${project.id}/messages/*/images/*`, (route) =>
    route.fulfill({ contentType: 'image/png', body: image }),
  );
  let navigation = 0;
  const visit = async (id: string) => {
    await Promise.all(responseChecks);
    // Hash-only navigation can normalize against a snapshot from before fixture creation.
    await page.goto(
      `${new URL(page.url()).origin}/?history-fixture=${++navigation}#/p/${id}/conversation`,
    );
    await page
      .getByRole('heading', { name: store.project(id).name, exact: true, includeHidden: true })
      .waitFor({ state: 'attached' });
  };
  const mounted = () => page.locator('.conversation .message').count();
  const retained = () =>
    page.evaluate(() => {
      const root = document.querySelector('.shell');
      if (!root) throw new Error('Missing React shell');
      const key = Object.keys(root).find((key) => key.startsWith('__reactFiber$'));
      if (!key) throw new Error('Missing React fiber');
      type Hook = { memoizedState: unknown; next: Hook | null };
      type Fiber = { return: Fiber | null; memoizedState: Hook | null };
      let fiber = (root as unknown as Record<string, Fiber>)[key];
      while (fiber) {
        let hook = fiber.memoizedState;
        while (hook) {
          const value = hook.memoizedState;
          if (
            value &&
            typeof value === 'object' &&
            'entries' in value &&
            'projectId' in value &&
            Array.isArray(value.entries)
          )
            return value.entries.length;
          hook = hook.next;
        }
        fiber = fiber.return!;
      }
      throw new Error('Missing retained conversation window');
    });
  const checkBounds = async () => {
    assert.ok((await mounted()) <= 150, 'mounted messages never exceed 150');
    assert.ok((await retained()) <= 150, 'actual retained React timeline never exceeds 150');
  };
  const conversation = page.locator('.conversation');
  const top = async () => {
    await conversation.evaluate((element) => {
      const boundary = element.querySelector('.history-before, .message');
      if (!boundary) throw new Error('Missing message boundary');
      element.scrollTop +=
        boundary.getBoundingClientRect().top - element.getBoundingClientRect().top - 28;
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await conversation.dispatchEvent('wheel', { deltaY: -20 });
  };
  const idleChecks: (() => void)[] = [];
  const checkIdleRefresh = async (id: string, name: string, width: number) => {
    await page.locator('.history-control [role="status"]').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => [...document.images].every((image) => image.complete));
    await page.evaluate(() => document.fonts.ready);
    const layout = () =>
      page.locator('.conversation').evaluate(async (element) => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const message = element.querySelector('.message:last-of-type');
        return {
          height: element.scrollHeight,
          top: element.scrollTop,
          message: message?.getBoundingClientRect().top,
          control: element.querySelector('.history-control')?.textContent ?? null,
        };
      });
    const samples = [];
    for (let iteration = 0; iteration < 3; iteration++) {
      let release!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => (entered = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      const pattern = `**/api/projects/${id}/messages`;
      await page.route(pattern, async (route) => {
        entered();
        await gate;
        await route.continue().catch(() => {});
      });
      const before = await layout();
      store.changes.emit('change');
      await waiting;
      const during = await layout();
      const finished = page.waitForResponse(
        (response) => new URL(response.url()).pathname === `/api/projects/${id}/messages`,
      );
      release();
      await finished;
      const after = await layout();
      await page.unroute(pattern);
      samples.push({ before, during, after });
      await writeFile(
        join(artifacts, `history-idle-${name}-${width}.json`),
        JSON.stringify(samples, null, 2),
      );
      idleChecks.push(() => {
        assert.deepEqual(during, before, `${name}: background refresh preserves pending layout`);
        assert.deepEqual(after, before, `${name}: background refresh preserves settled layout`);
      });
    }
  };
  try {
    await visit(project.id);
    await page.locator(`#message-${expected.at(-1)}`).waitFor();
    assert.ok((await mounted()) <= 50);
    assert.equal(await retained(), 50);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [name, id] of [
        ['empty', blank.id],
        ['short', short.id],
        ['long', project.id],
      ]) {
        await visit(id!);
        if (name === 'empty') await page.locator('.chat-empty').waitFor();
        else await page.locator('.conversation .message').first().waitFor();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        if (name === 'short' || name === 'long') await checkIdleRefresh(id!, name, width);
        await page.screenshot({
          path: join(artifacts, `history-${name}-${width}.png`),
          animations: 'disabled',
        });
      }
    }
    for (const check of idleChecks) check();
    await page.setViewportSize({ width: 1280, height: 900 });
    const initial = store.createProject('Initial failure recovery fixture', '');
    store.addMessage(initial.id, 'assistant', 'Recovered initial response');
    let releaseInitial!: () => void;
    let enteredInitial!: () => void;
    const initialWaiting = new Promise<void>((resolve) => (enteredInitial = resolve));
    const initialGate = new Promise<void>((resolve) => (releaseInitial = resolve));
    const initialPattern = `**/api/projects/${initial.id}/messages`;
    let failInitial = true;
    await page.route(initialPattern, async (route) => {
      if (failInitial) {
        enteredInitial();
        await initialGate;
        return route.fulfill({ status: 503, json: { error: 'Synthetic initial failure' } });
      }
      return route.continue();
    });
    await visit(initial.id);
    await initialWaiting;
    await page.locator('.composer textarea').fill('Draft survives initial failure');
    await conversation.dispatchEvent('wheel', { deltaY: -20 });
    releaseInitial();
    await page.getByRole('button', { name: '历史加载失败，重试', exact: true }).waitFor();
    failInitial = false;
    const initialRecovered = page.waitForResponse(
      (response) => response.url().endsWith(`/projects/${initial.id}/messages`) && response.ok(),
    );
    store.changes.emit('change');
    await initialRecovered;
    await page.getByText('Recovered initial response', { exact: true }).waitFor();
    await page
      .getByRole('button', { name: '历史加载失败，重试', exact: true })
      .waitFor({ state: 'hidden' });
    assert.equal(
      await retained(),
      1,
      'successful initial refresh populates the empty window after upward input',
    );
    assert.equal(
      await page.locator('.composer textarea').inputValue(),
      'Draft survives initial failure',
    );
    await page.unroute(initialPattern);
    await visit(project.id);
    await page.locator('.conversation .message').last().waitFor();
    assert.equal(
      await page.getByRole('button', { name: '加载更早消息' }).count(),
      0,
      'ordinary history reading has no load button',
    );
    const firstPage = await retained();
    await conversation.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.waitForTimeout(100);
    assert.equal(await retained(), firstPage, 'programmatic positioning grants no page');
    const lightWheel = page.waitForResponse((response) => response.url().includes('?before='));
    await conversation.dispatchEvent('wheel', { deltaY: -20 });
    await lightWheel;
    await page.waitForFunction(
      () => document.querySelectorAll('.conversation .message').length > 50,
    );
    assert.equal(await retained(), 100, 'top-clamped light wheel loads exactly one page');
    await page.getByRole('button', { name: '回到最新消息' }).click();
    assert.equal(await retained(), 100, 'returning to latest retains overlapping history');
    const refreshed = page.waitForResponse((response) =>
      response.url().endsWith(`/projects/${project.id}/messages`),
    );
    store.changes.emit('change');
    await refreshed;
    assert.equal(await retained(), 100, 'live refresh retains overlapping history');
    const clarificationId = 'history-tall-answered';
    store.put('clarification', clarificationId, {
      id: clarificationId,
      projectId: project.id,
      sourceMessageId: expected[0]!,
      sourceIntent: 'discuss',
      status: 'answered',
      questions: Array.from({ length: 6 }, (_, index) => ({
        id: `history-question-${index}`,
        question: `Answered historical design question ${index}`,
        recommendation: 'Keep the full historical answer visible above the conversation.',
      })),
      answers: Array.from({ length: 6 }, (_, index) => ({
        questionId: `history-question-${index}`,
        value: 'A complete historical answer retained in the original form.',
      })),
      createdAt: project.createdAt,
      updatedAt: project.createdAt,
    });
    await visit(project.id);
    await page.locator('.project-actions').waitFor();
    assert.ok(
      await page.locator('.project-actions').evaluate((element) => element.clientHeight > 900),
      'real answered forms remain taller than the viewport',
    );
    await page.evaluate(
      ({ projectId, requestId }) => {
        location.hash = `#/p/${projectId}/requests/${requestId}`;
      },
      { projectId: project.id, requestId: clarificationId },
    );
    await page.waitForFunction(
      (id) => document.activeElement?.id === `project-request-${id}`,
      clarificationId,
    );
    assert.equal(await retained(), 50, 'direct form focus grants no history pagination');
    await visit(project.id);
    await page.waitForFunction(() => [...document.images].every((image) => image.complete));
    await conversation.dispatchEvent('wheel', { deltaY: -20 });
    await conversation.evaluate((element) => {
      const boundary = element.querySelector('.history-before')!;
      element.scrollTop +=
        boundary.getBoundingClientRect().top - element.getBoundingClientRect().top + 260;
    });
    const smallSteps = page.waitForResponse((response) => response.url().includes('?before='));
    const bounds = await conversation.boundingBox();
    assert.ok(bounds);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    for (let step = 0; step < 5; step++) {
      await page.mouse.wheel(0, -20);
      await page.waitForTimeout(40);
    }
    await smallSteps;
    await page.waitForFunction(
      () => document.querySelectorAll('.conversation .message').length > 50,
    );
    assert.equal(
      await retained(),
      100,
      'ordinary small wheels load at the actual message boundary',
    );
    assert.ok(await conversation.evaluate((element) => element.scrollTop > 200));
    await conversation.evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2;
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await conversation.dispatchEvent('wheel', { deltaY: -20 });
    await page.waitForTimeout(150);
    assert.equal(
      await retained(),
      100,
      'a boundary far above the viewport does not load more pages',
    );
    await conversation.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await conversation.dispatchEvent('wheel', { deltaY: -20 });
    await page.waitForTimeout(150);
    assert.equal(await retained(), 100, 'forms far below the viewport do not grant history loads');
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(150);
    assert.equal(
      await retained(),
      100,
      'large upward wheel moving away from messages grants no page',
    );
    const crossedMessage = await page.locator('.conversation .message').first().getAttribute('id');
    await conversation.evaluate((element) => {
      const boundary = element.querySelector('.history-before')!;
      element.scrollTop +=
        boundary.getBoundingClientRect().top - element.getBoundingClientRect().top + 300;
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const crossedPage = page.waitForResponse((response) => response.url().includes('?before='));
    await page.mouse.wheel(0, -900);
    await crossedPage;
    await page.waitForFunction(() => {
      const root = document.querySelector('.conversation')!;
      return root.querySelectorAll('.message').length > 100;
    });
    assert.equal(await retained(), 150);
    assert.ok(
      await page
        .locator(`#${crossedMessage}`)
        .evaluate(
          (element) =>
            element.getBoundingClientRect().top -
              document.querySelector('.conversation')!.getBoundingClientRect().top >
            200,
        ),
      'large native wheel crosses the entire prefetch band and still loads one page',
    );
    await page.getByRole('button', { name: '回到最新消息' }).click();
    assert.equal(await retained(), 150, 'latest retains the entire overlapping 150-entry window');
    const refresh150 = page.waitForResponse((response) =>
      response.url().endsWith(`/projects/${project.id}/messages`),
    );
    store.changes.emit('change');
    await refresh150;
    assert.equal(await retained(), 150, 'background latest retains the full 150-entry window');
    let overlapLast = overlapFirst;
    for (let index = 0; index < 49; index++)
      overlapLast = store.addMessage(overlap.id, 'assistant', `New overlap message ${index}`);
    const overlapPattern = `**/api/projects/${overlap.id}/messages`;
    await page.route(overlapPattern, (route) => {
      const result = store.conversationPage(overlap.id);
      return route.fulfill({
        json: { ...result, entries: result.entries.slice(-1), hasBefore: true },
      });
    });
    await visit(overlap.id);
    await page.getByText(overlapLast.content, { exact: true }).waitFor();
    assert.equal(await retained(), 1);
    await page.unroute(overlapPattern);
    store.put('message', overlapFirst.id, { ...overlapFirst, content: 'Fresh overlap body' });
    store.put('message', overlapLast.id, {
      ...overlapLast,
      content: 'Fresh overlapping last body',
    });
    store.changes.emit('change');
    await page.getByText('Fresh overlap body', { exact: true }).waitFor();
    await page.getByText('Fresh overlapping last body', { exact: true }).waitFor();
    assert.equal(
      await retained(),
      50,
      'latest page containing the old short window preserves order',
    );
    assert.equal(
      await page.locator('.conversation .message').first().getAttribute('id'),
      `message-${overlapFirst.id}`,
    );
    await visit(project.id);
    const composer = page.locator('.composer textarea');
    await composer.fill('Draft survives history and retry');
    const latestPattern = `**/api/projects/${project.id}/messages`;
    await page.locator('.history-control [role="status"]').waitFor({ state: 'hidden' });
    for (const recovery of ['manual', 'automatic']) {
      await page.route(latestPattern, (route) =>
        route.fulfill({ status: 503, json: { error: 'Synthetic refresh failure' } }),
      );
      store.changes.emit('change');
      await page.getByRole('button', { name: '历史加载失败，重试' }).waitFor();
      assert.equal(await composer.inputValue(), 'Draft survives history and retry');
      assert.equal(await retained(), 50, 'refresh failure retains the message window');
      await page.unroute(latestPattern);
      const recoveredRefresh = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/projects/${project.id}/messages` &&
          response.ok(),
      );
      if (recovery === 'manual')
        await page.getByRole('button', { name: '历史加载失败，重试' }).click();
      else store.changes.emit('change');
      await recoveredRefresh;
      await page.getByRole('button', { name: '历史加载失败，重试' }).waitFor({ state: 'hidden' });
      assert.equal(await composer.inputValue(), 'Draft survives history and retry');
    }
    let releaseRefresh!: () => void;
    let refreshEntered!: () => void;
    let refreshReleased!: () => void;
    const refreshWaiting = new Promise<void>((resolve) => (refreshEntered = resolve));
    const refreshGate = new Promise<void>((resolve) => (releaseRefresh = resolve));
    const refreshDone = new Promise<void>((resolve) => (refreshReleased = resolve));
    await page.locator('.history-control [role="status"]').waitFor({ state: 'hidden' });
    await page.route(latestPattern, async (route) => {
      refreshEntered();
      await refreshGate;
      await route.continue().catch(() => {});
      refreshReleased();
    });
    store.changes.emit('change');
    await refreshWaiting;
    await page.locator('.conversation').dispatchEvent('wheel', { deltaY: -1000 });
    await page.locator('.conversation').evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2;
    });
    await page.getByRole('button', { name: '回到最新消息' }).click();
    await page.waitForFunction(() => {
      const element = document.querySelector('.conversation')!;
      return element.scrollHeight - element.scrollTop - element.clientHeight < 65;
    });
    const earlierResponse = page.waitForResponse((response) =>
      response.url().includes(`/projects/${project.id}/messages?before=`),
    );
    await top();
    await earlierResponse;
    await page.waitForFunction(
      () => document.querySelectorAll('.conversation .message').length > 50,
    );
    releaseRefresh();
    await refreshDone;
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    assert.ok((await retained()) > 50, 'cancelled refresh never replaces explicit pagination');
    assert.equal(await page.getByRole('button', { name: '历史加载失败，重试' }).count(), 0);
    await page.unroute(latestPattern);
    assert.equal(await composer.inputValue(), 'Draft survives history and retry');
    await visit(project.id);
    await composer.fill('Draft survives history and retry');
    let fail = true;
    let releaseFailure!: () => void;
    let failureEntered!: () => void;
    const failureWaiting = new Promise<void>((resolve) => (failureEntered = resolve));
    const failureGate = new Promise<void>((resolve) => (releaseFailure = resolve));
    await page.route(`**/projects/${project.id}/messages?before=*`, async (route) => {
      if (fail) {
        fail = false;
        failureEntered();
        await failureGate;
        await route.fulfill({ status: 503, json: { error: 'Synthetic history failure' } });
      } else await route.continue();
    });
    await top();
    await failureWaiting;
    await page.locator('.history-control [role="status"]').waitFor();
    const captureStatus = async (name: string) => {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const locale of ['zh-CN', 'en']) {
          await choosePreference(page, 'language', locale);
          for (const theme of ['light', 'dark']) {
            await choosePreference(page, 'theme', theme);
            await page.screenshot({
              path: join(artifacts, `history-${name}-${width}-${locale}-${theme}.png`),
              animations: 'disabled',
            });
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              true,
              'history status fits desktop and mobile',
            );
          }
        }
      }
      await choosePreference(page, 'language', 'zh-CN');
      await choosePreference(page, 'theme', 'light');
      await page.setViewportSize({ width: 1280, height: 900 });
    };
    await captureStatus('loading');
    releaseFailure();
    await page.getByRole('button', { name: '历史加载失败，重试' }).waitFor();
    await captureStatus('retry');
    assert.equal(await composer.inputValue(), 'Draft survives history and retry');
    assert.ok((await mounted()) <= 50);
    store.changes.emit('change');
    await page.waitForResponse((response) =>
      response.url().endsWith(`/projects/${project.id}/messages`),
    );
    await page.getByRole('button', { name: '历史加载失败，重试' }).waitFor();
    const prependAnchor = await page
      .locator('.conversation .message')
      .first()
      .evaluate((node) => ({
        id: node.id,
        top: node.getBoundingClientRect().top,
      }));
    await page.getByRole('button', { name: '历史加载失败，重试' }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('.conversation .message').length > 50,
    );
    await page.unroute(`**/projects/${project.id}/messages?before=*`);
    const prependTop = await page
      .locator(`#${prependAnchor.id}`)
      .evaluate((node) => node.getBoundingClientRect().top);
    assert.ok(
      Math.abs(prependTop - prependAnchor.top) < 3,
      `prepending preserves the reading anchor: ${JSON.stringify(prependAnchor)} -> ${prependTop}`,
    );
    for (let step = 0; step < 4; step++) {
      const first = await page.locator('.conversation .message').first().getAttribute('id');
      await top();
      await page.waitForFunction(
        (id) => document.querySelector('.conversation .message')?.id !== id,
        first,
      );
    }
    assert.equal(await retained(), 150);
    const distantFirst = await page.locator('.conversation .message').first().getAttribute('id');
    const distantRefresh = page.waitForResponse((response) =>
      response.url().includes(`/projects/${project.id}/messages?ids=`),
    );
    store.changes.emit('change');
    await distantRefresh;
    assert.equal(
      await page.locator('.conversation .message').first().getAttribute('id'),
      distantFirst,
      'background refresh preserves a disjoint reading window',
    );
    await page.getByRole('button', { name: '回到最新消息' }).click();
    await page.locator(`#message-${expected.at(-1)}`).waitFor();
    assert.equal(await retained(), 50, 'disjoint history window jumps to the latest bounded page');
    await page.waitForFunction(() => {
      const element = document.querySelector('.conversation')!;
      return element.scrollHeight - element.scrollTop - element.clientHeight < 65;
    });
    await conversation.evaluate((element) => {
      const boundary = element.querySelector('.history-before')!;
      element.scrollTop +=
        boundary.getBoundingClientRect().top - element.getBoundingClientRect().top - 28;
    });
    await composer.focus();
    await composer.press('PageUp');
    await page.waitForTimeout(100);
    assert.equal(await retained(), 50, 'composer navigation keys never authorize pagination');
    await conversation.dispatchEvent('touchstart', { touches: [{ identifier: 1, clientY: 100 }] });
    await conversation.dispatchEvent('touchmove', { touches: [{ identifier: 1, clientY: 100 }] });
    assert.equal(await retained(), 50, 'stationary touch grants no pagination');
    await conversation.dispatchEvent('touchmove', { touches: [{ identifier: 1, clientY: 120 }] });
    await page.waitForFunction(
      () => document.querySelectorAll('.conversation .message').length > 50,
    );
    assert.equal(await retained(), 100, 'actual upward touch displacement loads one page');
    await conversation.evaluate((element) => {
      const boundary = element.querySelector('.history-before')!;
      element.scrollTop +=
        boundary.getBoundingClientRect().top - element.getBoundingClientRect().top - 28;
    });
    await conversation.focus();
    await conversation.press('ArrowUp');
    await page.waitForFunction(
      () => document.querySelectorAll('.conversation .message').length > 100,
    );
    assert.equal(await retained(), 150, 'container scroll keys authorize one directional page');
    const dragFirst = await page.locator('.conversation .message').first().getAttribute('id');
    await conversation.evaluate((element) => {
      const boundary = element.querySelector('.history-before')!;
      element.scrollTop +=
        boundary.getBoundingClientRect().top - element.getBoundingClientRect().top + 260;
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await conversation.dispatchEvent('pointerdown', { buttons: 1 });
    await conversation.evaluate((element) => {
      element.scrollTop -= 100;
    });
    await page.waitForFunction(
      (id) => document.querySelector('.conversation .message')?.id !== id,
      dragFirst,
    );
    await conversation.dispatchEvent('pointerup', { buttons: 0 });
    assert.equal(
      await retained(),
      150,
      'scrollbar drag uses actual upward movement and stays bounded',
    );
    for (let step = 0; step < 22; step++) {
      const oldest = await page.locator('.conversation .message').first().getAttribute('id');
      if (oldest === `message-${expected[0]}`) break;
      await top();
      await page.waitForFunction(
        (id) => document.querySelector('.conversation .message')?.id !== id,
        oldest,
      );
      await checkBounds();
    }
    assert.equal(
      await page.locator('.conversation .message').first().getAttribute('id'),
      `message-${expected[0]}`,
    );
    await Promise.all(responseChecks);
    for (const id of expected) assert.ok(bodies.has(id), `continuous traversal fetched ${id}`);
    await checkTyping(page, '1003-record history, 150-entry window');
    await composer.fill('Draft survives history and retry');
    await conversation.dispatchEvent('wheel', { deltaY: 1000 });
    await conversation.evaluate((element) => {
      element.scrollTop = 5000;
    });
    await page.waitForTimeout(100);
    const resized = await conversation.evaluate((element) => {
      const top = element.getBoundingClientRect().top;
      const node = [...element.querySelectorAll<HTMLElement>('.message')].find(
        (node) => node.getBoundingClientRect().bottom > top,
      )!;
      return { id: node.id, top: node.getBoundingClientRect().top };
    });
    await page
      .locator('.conversation .message-images img')
      .first()
      .evaluate((image) => {
        image.style.height = '420px';
      });
    await page.waitForTimeout(100);
    assert.ok(
      Math.abs(
        (await page
          .locator(`#${resized.id}`)
          .evaluate((node) => node.getBoundingClientRect().top)) - resized.top,
      ) < 3,
      'image height changes preserve the reading anchor',
    );
    await page
      .locator('.conversation .message-content')
      .first()
      .evaluate((content) => {
        (content as HTMLElement).style.paddingBottom = '300px';
      });
    await page.waitForTimeout(100);
    assert.ok(
      Math.abs(
        (await page
          .locator(`#${resized.id}`)
          .evaluate((node) => node.getBoundingClientRect().top)) - resized.top,
      ) < 3,
      'Markdown height changes preserve the reading anchor',
    );
    const anchor = await conversation.evaluate((element) => {
      const top = element.getBoundingClientRect().top;
      const node = [...element.querySelectorAll<HTMLElement>('.message')].find(
        (node) => node.getBoundingClientRect().bottom > top,
      );
      return { id: node!.id, offset: node!.getBoundingClientRect().top - top };
    });
    store.addMessage(project.id, 'assistant', 'Realtime while reading history');
    await page.waitForResponse(
      (response) => response.url().includes('/api/state') && response.ok(),
    );
    await page.waitForTimeout(400);
    const offset = await page
      .locator(`#${anchor.id}`)
      .evaluate(
        (node) =>
          node.getBoundingClientRect().top -
          document.querySelector('.conversation')!.getBoundingClientRect().top,
      );
    assert.ok(Math.abs(offset - anchor.offset) < 3, 'realtime arrival preserves reading anchor');
    for (let step = 0; step < 22; step++) {
      const last = await page.locator('.conversation .message').last().getAttribute('id');
      if (
        last === `message-${expected.at(-1)}` ||
        (await page.getByText('Realtime while reading history', { exact: true }).count())
      )
        break;
      await conversation.evaluate((element) => {
        const boundary = element.querySelector('.history-after')!;
        element.scrollTop +=
          boundary.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom - 300;
      });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      let releaseAfter!: () => void;
      let enteredAfter!: () => void;
      const afterWaiting = new Promise<void>((resolve) => (enteredAfter = resolve));
      const afterGate = new Promise<void>((resolve) => (releaseAfter = resolve));
      const afterPattern = `**/projects/${project.id}/messages?after=*`;
      await page.route(afterPattern, async (route) => {
        enteredAfter();
        await afterGate;
        await route.continue().catch(() => {});
      });
      const bounds = await conversation.boundingBox();
      assert.ok(bounds);
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.wheel(0, 900);
      await afterWaiting;
      const trimmedAnchor = await conversation.evaluate(async (element) => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const top = element.getBoundingClientRect().top;
        const node = [...element.querySelectorAll<HTMLElement>('.message[id]')].find(
          (node) => node.getBoundingClientRect().bottom > top,
        )!;
        return { id: node.id, offset: node.getBoundingClientRect().top - top };
      });
      assert.ok(
        await conversation.evaluate(
          (element) =>
            Math.abs(
              element.getBoundingClientRect().bottom -
                element.querySelector('.history-after')!.getBoundingClientRect().bottom,
            ) <= 200,
        ),
        'large downward native wheel reaches the message boundary',
      );
      releaseAfter();
      await page.waitForFunction((id) => {
        const nodes = document.querySelectorAll('.conversation .message');
        return nodes[nodes.length - 1]?.id !== id;
      }, last);
      await page.unroute(afterPattern);
      const trimmedOffset = await page
        .locator(`#${trimmedAnchor.id}`)
        .evaluate(
          (node) =>
            node.getBoundingClientRect().top -
            document.querySelector('.conversation')!.getBoundingClientRect().top,
        );
      assert.ok(
        Math.abs(trimmedOffset - trimmedAnchor.offset) < 3,
        'releasing distant entries preserves the reading anchor',
      );
      await checkBounds();
      const ids = await page
        .locator('.conversation .message[id]')
        .evaluateAll((nodes) => nodes.map((node) => node.id.slice('message-'.length)));
      const positions = ids.map((id) => expected.indexOf(id)).filter((index) => index >= 0);
      assert.deepEqual(
        positions,
        [...new Set(positions)].sort((a, b) => a - b),
      );
    }
    await page.getByRole('button', { name: '回到最新消息' }).click();
    await page.getByText('Realtime while reading history', { exact: true }).waitFor();
    store.addMessage(project.id, 'assistant', 'Realtime at live edge');
    await page.getByText('Realtime at live edge', { exact: true }).waitFor();
    assert.ok(
      await conversation.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight < 65,
      ),
    );
    assert.equal(await composer.inputValue(), 'Draft survives history and retry');
    await checkBounds();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/projects/${project.id}/messages?before=*`, async (route) => {
      entered();
      await gate;
      await route.continue().catch(() => {});
    });
    await top();
    await waiting;
    await page.evaluate((id) => {
      location.hash = `#/p/${id}/conversation`;
    }, short.id);
    await page.getByText('Short fixture reply', { exact: true }).waitFor();
    release();
    await page.waitForTimeout(300);
    assert.equal(await mounted(), 1, 'late response never crosses projects');
    await page.unroute(`**/projects/${project.id}/messages?before=*`);
    await Promise.all(responseChecks);
    await writeFile(
      join(artifacts, 'history-network.json'),
      JSON.stringify(
        {
          fixture: 'synthetic',
          records: expected.length,
          types,
          network,
          fetchedDistinctBodies: expected.filter((id) => bodies.has(id)).length,
        },
        null,
        2,
      ),
    );
    console.log(
      'History browser PASS: 1003 complete mixed records, 50-entry HTTP pages, ' +
        '150-entry retained/mounted bounds, idle refresh layout, pending clicks, retry/draft, ' +
        'realtime anchor/follow, ' +
        'project isolation, 1280/390 empty/short/long.',
    );
  } catch (error) {
    await page.screenshot({ path: join(artifacts, 'history-failure.png'), animations: 'disabled' });
    throw error;
  } finally {
    page.off('requestfinished', record);
    await page.unroute(`**/projects/${project.id}/messages/*/images/*`);
  }
}
