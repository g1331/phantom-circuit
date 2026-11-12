import assert from 'node:assert/strict';
import { openPage } from './browser-pages.ts';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { Codex } from '../src/server/codex.ts';
import { Engine } from '../src/server/engine.ts';
import { GitHub } from '../src/server/github.ts';
import { Previews } from '../src/server/preview.ts';
import { Fault, Store } from '../src/server/store.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { createApp } from '../src/server/app.ts';
import { profileProtocol } from '../tests/profile-protocol.ts';
import { choosePreference } from './browser-preferences.ts';

const defaultArtifacts = 'C:/Users/admin/AppData/Local/Temp/opencode/pm-steer-browser';
type Scenario = 'before-thread' | 'after-thread' | 'ended' | 'unknown' | 'ended-after-click';

function gate() {
  let release = () => {};
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}

async function reach(pending: ReturnType<typeof gate>, label: string) {
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`Timed out waiting for ${label}`)), 10_000);
    void pending.promise.then(() => {
      clearTimeout(timer);
      done();
    });
  });
}

async function waitForStore(store: Store, ready: () => boolean, label: string) {
  if (ready()) return;
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => {
      store.changes.off('change', changed);
      fail(new Error(`Timed out waiting for ${label}`));
    }, 10_000);
    function changed() {
      if (!ready()) return;
      clearTimeout(timer);
      store.changes.off('change', changed);
      done();
    }
    store.changes.on('change', changed);
    changed();
  });
}

async function screenshot(page: Page, artifacts: string, name: string) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    `${name} has no horizontal overflow`,
  );
  await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true });
}

async function appearanceMatrix(page: Page, artifacts: string, state: 'preparing' | 'unknown') {
  const article = page.locator('.message.user').filter({ hasText: 'pong steer' });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const language of ['zh-CN', 'en']) {
      await choosePreference(page, 'language', language);
      for (const theme of ['light', 'dark']) {
        await choosePreference(page, 'theme', theme);
        const label =
          state === 'preparing'
            ? language === 'en'
              ? 'Adjusting'
              : '调整中'
            : language === 'en'
              ? 'Receipt unconfirmed'
              : '待核对';
        await article.locator('.runtime-badge').getByText(label, { exact: true }).waitFor();
        assert.equal(await article.locator('.markdown-rendered').innerText(), 'pong steer');
        assert.equal(await article.locator('.retry-message').isDisabled(), true);
        if (state === 'unknown') {
          assert.equal(await article.locator('.runtime-badge.warning').count(), 1);
        }
        await screenshot(page, artifacts, `${state}-${width}-${language}-${theme}`);
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await choosePreference(page, 'language', 'zh-CN');
  await choosePreference(page, 'theme', 'light');
}

async function checkScenario(
  browser: Browser,
  artifacts: string,
  port: number,
  scenario: Scenario,
) {
  const root = await mkdtemp(join(artifacts, `${scenario}-`));
  const store = new Store(join(root, 'state.sqlite'));
  store.saveSettings({ ...store.settings(), defaultAgent: 'codex' });
  const preparing = gate();
  const preparation = gate();
  const threadReturned = gate();
  const turnReady = gate();
  const nativeStarted = gate();
  const nativeReceived = gate();
  const acknowledgement = gate();
  const completion = gate();
  const successor = gate();
  const gates = [
    preparing,
    preparation,
    threadReturned,
    turnReady,
    nativeStarted,
    nativeReceived,
    acknowledgement,
    completion,
    successor,
  ];
  const calls: Parameters<Codex['steer']>[] = [];
  let turns = 0;
  let accepted = '';
  let nativeActive = false;
  class SteeringAgent extends Codex {
    override async start() {
      preparing.release();
      if (scenario === 'before-thread') await preparation.promise;
    }
    override async stop() {}
    override async thread() {
      return `browser-thread-${scenario}`;
    }
    override async turn(...args: Parameters<Codex['turn']>) {
      const number = ++turns;
      threadReturned.release();
      if (number === 1) await turnReady.promise;
      else await successor.promise;
      nativeActive = true;
      args[5]?.(`browser-turn-${number}`);
      nativeStarted.release();
      this.emit('notification', 'item/agentMessage/delta', {
        threadId: args[0],
        turnId: `browser-turn-${number}`,
        delta: 'Fixture PM stream stays separate.\n',
      });
      await completion.promise;
      nativeActive = false;
      return accepted
        ? `Current reply incorporated: ${accepted}`
        : `Reply ${number} finished without native adjustment`;
    }
    override async steer(...args: Parameters<Codex['steer']>) {
      calls.push(args);
      assert.equal(nativeActive, true, 'adapter receives steer only after onTurn');
      assert.equal(args[2]?.expectedTurnId, 'browser-turn-1');
      nativeReceived.release();
      if (scenario === 'ended') {
        nativeActive = false;
        throw new Fault('turn ended', 409);
      }
      if (scenario === 'unknown') throw new Error('fixture lost acknowledgement');
      await acknowledgement.promise;
      accepted = args[1];
    }
  }
  const ws = new Workspaces(join(root, 'workspaces'), store);
  const engine = new Engine(store, new GitHub(store), ws, root, () => new SteeringAgent());
  const app = createApp(store, engine, new Previews(store, ws), port, profileProtocol);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await app.listen({ host: '127.0.0.1', port });
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByText('开始你的第一个项目', { exact: true }).waitFor();
    if (scenario === 'before-thread') {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await screenshot(page, artifacts, `empty-${width}`);
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await page.getByRole('button', { name: '创建项目', exact: true }).click();
    await page.getByLabel('项目名称', { exact: true }).fill(`PM steering ${scenario}`);
    await page.getByRole('dialog').getByRole('button', { name: '创建项目', exact: true }).click();
    await openPage(page, 'conversation');
    await page.getByLabel('给协调者的消息', { exact: true }).fill('ping');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await reach(preparing, 'native start preparation');
    if (scenario !== 'before-thread') await reach(threadReturned, 'saved thread preparation');
    const original = store.list('message').find((message) => message.content === 'ping');
    assert.ok(original);
    const run = store.list('run')[0];
    assert.ok(run);
    assert.equal(run.sourceMessageId, original.id);
    assert.equal(run.sourceIntent, 'discuss');
    assert.equal(Boolean(run.threadId), scenario !== 'before-thread');
    if (scenario === 'ended' || scenario === 'unknown' || scenario === 'ended-after-click') {
      turnReady.release();
      await reach(nativeStarted, 'native onTurn');
      assert.equal(store.get('run', run.id)?.turnId, 'browser-turn-1');
    }
    await page.getByLabel('给协调者的消息', { exact: true }).fill('pong steer');
    await page.getByRole('button', { name: '交给协调者做', exact: true }).click();
    if (scenario === 'ended-after-click') {
      await page.route('**/api/projects/*/messages', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        completion.release();
        await waitForStore(
          store,
          () => store.get('run', run.id)?.status === 'completed',
          'native completion after click and before request reaches the server',
        );
        await route.continue();
      });
    }
    await page.getByRole('button', { name: '立即调整', exact: true }).click();
    await waitForStore(
      store,
      () => store.list('message').some((message) => message.content === 'pong steer'),
      'browser adjustment submission',
    );
    const adjustment = store.list('message').find((message) => message.content === 'pong steer');
    assert.ok(adjustment);
    const article = page.locator(`#message-${adjustment.id}`);
    await article.locator('.message-content').getByText('pong steer', { exact: true }).waitFor();
    assert.equal(adjustment.intent, 'implement');
    if (scenario === 'before-thread' || scenario === 'after-thread') {
      await article.locator('.runtime-badge').getByText('调整中', { exact: true }).waitFor();
      assert.equal(await article.getByText('已排队', { exact: true }).count(), 0);
      assert.equal(await article.locator('.retry-message').isDisabled(), true);
      assert.equal(calls.length, 0, 'preparation never probes native steer');
      assert.equal(
        store.list('operation').filter((operation) => operation.kind === 'steer').length,
        0,
      );
      assert.equal(store.get('message', adjustment.id)?.descriptor?.code, 'steer_waiting');
      assert.equal(store.get('run', run.id)?.sourceMessageId, original.id);
      assert.equal(store.get('run', run.id)?.sourceIntent, 'discuss');
      if (scenario === 'before-thread') await appearanceMatrix(page, artifacts, 'preparing');
      preparation.release();
      await reach(threadReturned, 'saved thread preparation');
      turnReady.release();
      await reach(nativeReceived, 'native steer');
      assert.equal(calls.length, 1);
      assert.equal(store.get('run', run.id)?.sourceMessageId, original.id, 'ACK gates source');
      assert.equal(store.get('run', run.id)?.sourceIntent, 'discuss', 'ACK gates permission');
      await page.getByText('Fixture PM stream stays separate.', { exact: true }).waitFor();
      assert.equal(await article.locator('.markdown-rendered').innerText(), 'pong steer');
      await article.locator('.runtime-badge').getByText('调整中', { exact: true }).waitFor();
      acknowledgement.release();
      await waitForStore(
        store,
        () => store.get('run', run.id)?.sourceMessageId === adjustment.id,
        'acknowledged source',
      );
      assert.equal(store.get('run', run.id)?.sourceIntent, 'implement');
      completion.release();
      await page.getByText('Current reply incorporated: pong steer', { exact: true }).waitFor();
      assert.equal(store.list('run').length, 1, 'adjustment stays in the original PM Run');
      assert.equal(turns, 1);
      assert.equal(calls.length, 1);
    } else if (scenario === 'unknown') {
      await page.getByText('Fixture PM stream stays separate.', { exact: true }).waitFor();
      await article
        .locator('.runtime-badge.warning')
        .getByText('待核对', { exact: true })
        .waitFor();
      assert.equal(await article.locator('.retry-message').isDisabled(), true);
      assert.equal(store.get('message', adjustment.id)?.content, 'pong steer');
      assert.equal(store.get('run', run.id)?.sourceMessageId, original.id);
      assert.equal(store.get('run', run.id)?.sourceIntent, 'discuss');
      assert.equal(
        store.list('operation').filter((operation) => operation.kind === 'steer').length,
        1,
      );
      assert.equal(store.unresolvedSteers()[0]?.status, 'uncertain');
      await appearanceMatrix(page, artifacts, 'unknown');
      assert.equal(calls.length, 1);
      assert.equal(store.list('run').length, 1);
    } else if (scenario === 'ended-after-click') {
      await waitForStore(store, () => store.list('run').length === 2, 'no-active successor');
      await screenshot(page, artifacts, 'ended-after-click-status');
      assert.equal(
        store.get('message', adjustment.id)?.deliveryMode,
        'queue',
        'no active turn after click must normalize steer to queue before starting its successor',
      );
      assert.equal(await article.getByText('调整中', { exact: true }).count(), 0);
      assert.equal(calls.length, 0, 'a completed native turn receives no steer');
      successor.release();
      await waitForStore(
        store,
        () => store.list('run').every((candidate) => candidate.status === 'completed'),
        'no-active successor completion',
      );
      assert.equal(turns, 2);
    } else {
      await article.locator('.runtime-badge').getByText('已排队', { exact: true }).waitFor();
      assert.equal(store.get('message', adjustment.id)?.deliveryMode, 'queue');
      assert.equal(store.get('message', adjustment.id)?.descriptor?.code, 'steer_queued');
      assert.ok(await article.locator('.runtime-badge').getAttribute('title'));
      await screenshot(page, artifacts, 'ended-queued');
      assert.equal(calls.length, 1);
      assert.equal(store.get('run', run.id)?.sourceMessageId, original.id);
      completion.release();
      await waitForStore(store, () => store.list('run').length === 2, 'one queued successor');
      successor.release();
      await waitForStore(
        store,
        () => store.list('run').every((candidate) => candidate.status === 'completed'),
        'queued successor completion',
      );
      assert.equal(turns, 2);
      assert.equal(store.list('run').length, 2);
      assert.equal(calls.length, 1, 'ended rejection queues once without native resend');
    }
    assert.deepEqual(errors, []);
    console.log(`PM steering browser passed: ${scenario}`);
  } catch (error) {
    await page.screenshot({ path: join(artifacts, `${scenario}-failure.png`), fullPage: true });
    throw error;
  } finally {
    for (const pending of gates) pending.release();
    await context.close();
    await app.close();
    await engine.stop();
    store.close();
  }
}

export async function checkPMSteering(browser: Browser, artifacts: string, port: number) {
  await mkdir(artifacts, { recursive: true });
  for (const scenario of [
    'before-thread',
    'after-thread',
    'ended',
    'unknown',
    'ended-after-click',
  ] satisfies Scenario[]) {
    await checkScenario(browser, artifacts, port, scenario);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, fail) => probe.close((error) => (error ? fail(error) : done())));
  const browser = await chromium.launch({
    headless: true,
    channel: process.platform === 'win32' ? 'msedge' : undefined,
  });
  try {
    await checkPMSteering(browser, resolve(defaultArtifacts), address.port);
  } finally {
    await browser.close();
  }
}
