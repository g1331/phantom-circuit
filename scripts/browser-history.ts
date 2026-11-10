import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page, Response } from 'playwright';
import type { Store } from '../src/server/store.ts';
import type { ConversationPage, Snapshot } from '../src/shared/types.ts';
import sharp from 'sharp';
import { checkTyping } from './composer-browser-check.ts';

/** Synthetic records exercise the real HTTP, Store, React and image rendering boundaries. */
export async function checkHistory(page: Page, store: Store, artifacts: string) {
  const project = store.createProject('History synthetic fixture', '');
  const short = store.createProject('Short synthetic fixture', '');
  const blank = store.createProject('Empty synthetic fixture', '');
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
  const record = (response: Response) => {
    if (!response.url().includes('/api/')) return;
    if (
      response.url().includes('/messages') &&
      !response.url().includes('/images/') &&
      response.ok()
    ) {
      responseChecks.push(
        (async () => {
          const body = await readBody(response);
          if (body === undefined) return;
          const data: ConversationPage = JSON.parse(body);
          assert.ok(data.entries.length <= 50, 'every history response is bounded');
          for (const entry of data.entries)
            if (entry.kind === 'message') bodies.add(entry.value.id);
          network.push({ url: response.url(), count: data.entries.length, bytes: body.length });
        })(),
      );
    } else if (response.url().includes('/api/state') && response.ok()) {
      responseChecks.push(
        (async () => {
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
  page.on('response', record);
  await page.route(`**/projects/${project.id}/messages/*/images/*`, (route) =>
    route.fulfill({ contentType: 'image/png', body: image }),
  );
  let navigation = 0;
  const visit = async (id: string) => {
    await Promise.all(responseChecks);
    // Hash-only navigation can normalize against a snapshot from before fixture creation.
    await page.goto(`${new URL(page.url()).origin}/?history-fixture=${++navigation}#/p/${id}`);
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
        await page.screenshot({
          path: join(artifacts, `history-${name}-${width}.png`),
          animations: 'disabled',
        });
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await visit(project.id);
    const composer = page.locator('.composer textarea');
    await composer.fill('Draft survives history and retry');
    let fail = true;
    await page.route(`**/projects/${project.id}/messages?before=*`, async (route) => {
      if (fail) {
        fail = false;
        await route.fulfill({ status: 503, json: { error: 'Synthetic history failure' } });
      } else await route.continue();
    });
    const conversation = page.locator('.conversation');
    const top = async () => {
      await conversation.dispatchEvent('wheel', { deltaY: -1000 });
      await conversation.evaluate((element) => {
        element.scrollTop = 0;
      });
    };
    await top();
    await page.getByRole('button', { name: '历史加载失败，重试' }).waitFor();
    assert.equal(await composer.inputValue(), 'Draft survives history and retry');
    assert.ok((await mounted()) <= 50);
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
      await conversation.dispatchEvent('wheel', { deltaY: 1000 });
      const trimmedAnchor = await conversation.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        const top = element.getBoundingClientRect().top;
        const node = [...element.querySelectorAll<HTMLElement>('.message[id]')].find(
          (node) => node.getBoundingClientRect().bottom > top,
        )!;
        return { id: node.id, offset: node.getBoundingClientRect().top - top };
      });
      await page.waitForFunction((id) => {
        const nodes = document.querySelectorAll('.conversation .message');
        return nodes[nodes.length - 1]?.id !== id;
      }, last);
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
      location.hash = `#/p/${id}`;
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
        '150-entry retained/mounted bounds, retry/draft, realtime anchor/follow, ' +
        'project isolation, 1280/390 empty/short/long.',
    );
  } catch (error) {
    await page.screenshot({ path: join(artifacts, 'history-failure.png'), animations: 'disabled' });
    throw error;
  } finally {
    page.off('response', record);
    await page.unroute(`**/projects/${project.id}/messages/*/images/*`);
  }
}
