import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer as createPortProbe, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createApp } from '../src/server/app.ts';
import { Store } from '../src/server/store.ts';
import { Engine } from '../src/server/engine.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Previews } from '../src/server/preview.ts';
import { profileProtocol } from '../tests/profile-protocol.ts';
import { openPage } from './browser-pages.ts';

export async function checkReconnect() {
  const probe = createPortProbe();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((done, fail) => probe.close((error) => (error ? fail(error) : done())));
  await mkdir(resolve('.phantom'), { recursive: true });
  const root = await mkdtemp(resolve('.phantom/browser-reconnect-'));
  const store = new Store(join(root, 'state.sqlite'));
  store.saveSettings({ ...store.settings(), defaultAgent: 'codex' });
  const project = store.createProject('Restart fixture', 'Retained state');
  const run = store.run('pm', project.id, 'pm');
  store.activity(run, 'restart-step', {
    kind: 'command',
    title: 'Restart progress',
    status: 'running',
    details: { command: 'fixture-only' },
  });
  const ws = new Workspaces(join(root, 'workspaces'), store);
  const engine = new Engine(store, new GitHub(store), ws, root);
  const sockets = new Set<Socket>();
  const makeApp = () => {
    const instance = createApp(store, engine, new Previews(store, ws), port, profileProtocol);
    instance.server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    return instance;
  };
  let app = makeApp();
  const stopApp = async () => {
    for (const socket of sockets) socket.destroy();
    await app.close();
  };
  const web = await createServer({
    configFile: false,
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 0,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${port}`,
          // The isolated frontend port is outside the production dev-origin allowlist.
          changeOrigin: true,
          headers: { origin: `http://127.0.0.1:${port}` },
          configure(proxy) {
            proxy.on('proxyRes', (response, _request, outgoing) => {
              response.on('aborted', () => outgoing.destroy());
            });
          },
        },
      },
    },
    logLevel: 'silent',
  });
  const browser = await chromium.launch({
    headless: true,
    channel: process.platform === 'win32' ? 'msedge' : undefined,
  });
  const page = await browser.newPage({ locale: 'zh-CN' });
  const writes: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(request.url());
  });
  try {
    await app.listen({ host: '127.0.0.1', port });
    await web.listen();
    const origin = web.resolvedUrls?.local[0];
    assert.ok(origin);
    await page.goto(origin);
    await page.locator('.connection .live').waitFor();
    await openPage(page, 'conversation');
    const oldSession = (await page.context().cookies()).find(
      (cookie) => cookie.name === 'phantom_session',
    );
    const process = page.locator(`.pm-process[data-run-id="${run.id}"]`);
    await process.waitFor();
    const draft = page.getByLabel('给 PM 的消息', { exact: true });
    await draft.fill('重启期间保留这份草稿');
    await draft.focus();
    await draft.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 5));
    await stopApp();
    await page.locator('.connection .live').waitFor({ state: 'detached' });
    const failedWrite = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/projects/${project.id}/messages`) &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '排队发送', exact: true }).click();
    assert.equal((await failedWrite).ok(), false);
    await page.getByRole('alert').waitFor();
    assert.equal(await draft.inputValue(), '重启期间保留这份草稿');
    await draft.focus();
    await draft.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 5));
    store.finishRun(run.id, 'completed');
    store.addMessage(project.id, 'assistant', '停机期间完成的进度');
    app = makeApp();
    await app.listen({ host: '127.0.0.1', port });
    await page.locator('.connection .live').waitFor({ timeout: 12_000 });
    const renewedSession = (await page.context().cookies()).find(
      (cookie) => cookie.name === 'phantom_session',
    );
    assert.ok(oldSession && renewedSession && oldSession.value !== renewedSession.value);
    await page.getByText('停机期间完成的进度', { exact: true }).waitFor({ timeout: 5000 });
    assert.equal(await process.getAttribute('data-status'), 'completed');
    assert.equal(await draft.inputValue(), '重启期间保留这份草稿');
    assert.deepEqual(
      await draft.evaluate((element: HTMLTextAreaElement) => ({
        focused: document.activeElement === element,
        start: element.selectionStart,
        end: element.selectionEnd,
      })),
      { focused: true, start: 2, end: 5 },
    );
    assert.equal(writes.length, 1, 'reconnection must never replay the failed user write');
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    await page.getByLabel('项目名称', { exact: true }).fill('Fresh CSRF');
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/projects') && response.request().method() === 'POST',
    );
    await page.getByRole('dialog').getByRole('button', { name: '创建项目', exact: true }).click();
    assert.equal((await created).status(), 200, 'a new user write uses the renewed CSRF');
    console.log(
      'Reconnect browser: rotated session, fresh progress, draft/focus, no write replay, fresh CSRF passed.',
    );

    await page.close();
    await stopApp();
    const initial = await browser.newPage({ locale: 'zh-CN' });
    initial.on('pageerror', (error) => errors.push(error.message));
    const unavailable = initial.waitForResponse((response) =>
      response.url().endsWith('/api/session'),
    );
    await initial.goto(origin);
    assert.equal((await unavailable).ok(), false);
    app = makeApp();
    await app.listen({ host: '127.0.0.1', port });
    await initial.locator('.connection .live').waitFor({ timeout: 12_000 });
    await openPage(initial, 'conversation');
    await initial.getByRole('heading', { name: 'Restart fixture', exact: true }).waitFor();
    assert.equal(
      await initial.getByRole('alert').count(),
      0,
      'recovered startup clears connection failure',
    );
    console.log('Reconnect browser: initially unavailable service recovered without page refresh.');
    const interruptedStream = await browser.newPage({ locale: 'zh-CN' });
    interruptedStream.on('pageerror', (error) => errors.push(error.message));
    await interruptedStream.route('**/api/events', (route) =>
      route.fulfill({ contentType: 'text/event-stream', body: 'event: ready\ndata: {}\n\n' }),
    );
    await interruptedStream.goto(origin);
    await openPage(interruptedStream, 'conversation');
    await interruptedStream
      .getByRole('heading', { name: 'Restart fixture', exact: true })
      .waitFor();
    await interruptedStream.getByText('停机期间完成的进度', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log('Reconnect browser: HTTP progress remains visible when the event stream closes.');
  } finally {
    await browser.close();
    await web.close();
    await stopApp();
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await checkReconnect();
