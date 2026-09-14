import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { Previews } from '../src/server/preview.ts';
import { createApp } from '../src/server/app.ts';
import { Codex } from '../src/server/codex.ts';
import sharp from 'sharp';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function upload(content = '', bytes = png, filename = 'screenshot.png') {
  return uploadMany(content, [{ bytes, filename }]);
}
function uploadMany(content: string, files: { bytes: Buffer; filename: string }[]) {
  const boundary = 'phantom-test-image';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n${content}\r\n--${boundary}\r\nContent-Disposition: form-data; name="intent"\r\n\r\ndiscuss\r\n`,
      ),
      ...files.flatMap(({ bytes, filename }) => [
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        bytes,
        Buffer.from('\r\n'),
      ]),
      Buffer.from(`--${boundary}--\r\n`),
    ]),
  };
}

test('image-only PM messages survive restart with protected readable images', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-images-'));
  let store = new Store(join(root, 'state.sqlite'));
  class OfflineModel extends Codex {
    override async start() {
      throw new Error('offline fixture');
    }
  }
  const open = () => {
    const ws = new Workspaces(join(root, 'workspaces'), store);
    const engine = new Engine(store, new GitHub(store), ws, root, () => new OfflineModel());
    return { app: createApp(store, engine, new Previews(store, ws)), engine };
  };
  let { app, engine } = open();
  const auth = async () => {
    const init = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
    return {
      host: '127.0.0.1:4317',
      cookie: String(init.headers['set-cookie']).split(';')[0],
      'x-phantom-csrf': init.json().csrf,
    };
  };
  try {
    let headers = await auth();
    const project = (
      await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers,
        payload: { name: 'Images' },
      })
    ).json();
    const other = (
      await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers,
        payload: { name: 'Other' },
      })
    ).json();
    const body = upload();
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/messages`,
      headers: { ...headers, ...body.headers },
      payload: body.payload,
    });
    assert.equal(response.statusCode, 202, response.body);
    const message = response.json();
    assert.equal(message.content, '');
    assert.equal(message.attachments.length, 1);
    assert.equal(message.attachments[0].width, 1);
    const imagePath = `/api/projects/${project.id}/messages/${message.id}/images/${message.attachments[0].id}`;
    await engine.stop();
    await app.close();
    store.close();
    store = new Store(join(root, 'state.sqlite'));
    ({ app, engine } = open());
    headers = await auth();
    const state = (await app.inject({ url: '/api/state', headers })).json();
    assert.deepEqual(
      state.messages.find((m: any) => m.id === message.id).attachments,
      message.attachments,
    );
    const image = await app.inject({ url: imagePath, headers });
    assert.equal(image.statusCode, 200);
    assert.equal(image.headers['content-type'], 'image/png');
    assert.ok(image.rawPayload.length > 0);
    assert.equal(
      (await app.inject({ url: imagePath.replace(project.id, other.id), headers })).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ url: imagePath, headers: { host: headers.host } })).statusCode,
      401,
    );
  } finally {
    await engine.stop();
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'invalid uploads never create messages or runs and remove staged files',
  { timeout: 10000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'phantom-image-invalid-'));
    const store = new Store(join(root, 'state.sqlite'));
    const ws = new Workspaces(join(root, 'ws'), store);
    const engine = new Engine(store, new GitHub(store), ws, root);
    const app = createApp(store, engine, new Previews(store, ws));
    try {
      const init = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
      const headers = {
        host: '127.0.0.1:4317',
        cookie: String(init.headers['set-cookie']).split(';')[0],
        'x-phantom-csrf': init.json().csrf,
      };
      const p = (
        await app.inject({
          method: 'POST',
          url: '/api/projects',
          headers,
          payload: { name: 'Invalid' },
        })
      ).json();
      const tooManyPixels = await sharp({
        create: { width: 5001, height: 5000, channels: 3, background: 'red' },
      })
        .png()
        .toBuffer();
      const invalid = [
        upload('', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'fake.png'),
        upload('', Buffer.from('not an image'), 'image.png'),
        upload('', png.subarray(0, 45)),
        upload('', Buffer.alloc(10 * 1024 * 1024 + 1)),
        upload('', tooManyPixels),
        uploadMany(
          '',
          Array.from({ length: 5 }, () => ({ bytes: png, filename: 'image.png' })),
        ),
        uploadMany('', []),
        uploadMany('Reject the whole batch', [
          { bytes: png, filename: 'valid.png' },
          { bytes: Buffer.from('bad'), filename: 'bad.png' },
        ]),
        { ...upload(), payload: upload().payload.subarray(0, -30) },
      ];
      for (const body of invalid) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/projects/${p.id}/messages`,
          headers: { ...headers, ...body.headers },
          payload: body.payload,
        });
        assert.ok([400, 413].includes(response.statusCode), response.body);
        assert.ok(response.json().error.length > 0);
        const state = (await app.inject({ url: '/api/state', headers })).json();
        assert.deepEqual(state.messages, []);
        assert.deepEqual(state.runs, []);
        assert.deepEqual(await readdir(join(root, 'messages', p.id)), []);
      }
      await rm(join(root, 'messages'), { recursive: true });
      await writeFile(join(root, 'messages'), 'storage unavailable');
      const body = upload();
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/projects/${p.id}/messages`,
            headers: { ...headers, ...body.headers },
            payload: body.payload,
          })
        ).statusCode,
        500,
      );
      const state = (await app.inject({ url: '/api/state', headers })).json();
      assert.deepEqual(state.messages, []);
      assert.deepEqual(state.runs, []);
    } finally {
      await engine.stop();
      await app.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('PM sends the same managed images on first turn and retry in the same thread; text stays text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phantom-image-protocol-'));
  const store = new Store(join(root, 'state.sqlite'));
  const turns: any[] = [];
  const resumes: string[] = [];
  class Protocol extends Codex {
    override async start() {}
    override async stop() {}
    override async request(method: string, params: any) {
      if (method === 'model/list')
        return {
          data: [{ model: 'fixture', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }],
        };
      if (method === 'thread/start' || method === 'thread/resume') {
        if (params.threadId) resumes.push(params.threadId);
        return {
          thread: { id: 'persistent-pm' },
          model: 'fixture',
          modelProvider: 'openai',
          reasoningEffort: 'low',
        };
      }
      assert.equal(method, 'turn/start');
      turns.push(params);
      setImmediate(() =>
        this.emit('notification', 'turn/completed', {
          threadId: params.threadId,
          turn: { id: 'turn', status: turns.length === 1 ? 'failed' : 'completed' },
        }),
      );
      return { turn: { id: 'turn' } };
    }
  }
  store.saveSettings({
    ...store.settings(),
    profiles: {
      ...store.settings().profiles,
      pm: { providerId: 'codex', model: 'fixture', effort: 'low' },
    },
  });
  const ws = new Workspaces(join(root, 'ws'), store);
  const engine = new Engine(store, new GitHub(store), ws, root, () => new Protocol());
  const app = createApp(store, engine, new Previews(store, ws));
  try {
    const init = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
    const headers = {
      host: '127.0.0.1:4317',
      cookie: String(init.headers['set-cookie']).split(';')[0],
      'x-phantom-csrf': init.json().csrf,
    };
    const p = (
      await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers,
        payload: { name: 'Protocol' },
      })
    ).json();
    const waitFor = async (id: string, status: string) => {
      for (let i = 0; i < 200; i++) {
        const state = (await app.inject({ url: '/api/state', headers })).json();
        if (state.messages.find((m: any) => m.id === id)?.status === status) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.fail(`message did not become ${status}`);
    };
    const jpeg = await sharp(png).jpeg().toBuffer();
    const webp = await sharp(png).webp().toBuffer();
    const body = uploadMany('Please inspect this screenshot', [
      { bytes: png, filename: 'first.png' },
      { bytes: jpeg, filename: 'second.jpg' },
      { bytes: webp, filename: 'third.webp' },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${p.id}/messages`,
      headers: { ...headers, ...body.headers },
      payload: body.payload,
    });
    assert.equal(response.statusCode, 202, response.body);
    const message = response.json();
    assert.deepEqual(
      message.attachments.map((a: any) => a.mediaType),
      ['image/png', 'image/jpeg', 'image/webp'],
    );
    await waitFor(message.id, 'failed');
    assert.equal(turns[0].input[1]?.type, 'localImage');
    assert.equal(turns[0].input.length, 4);
    for (let i = 0; i < 3; i++) {
      assert.ok(
        turns[0].input[i + 1].path.endsWith(
          `${message.attachments[i].id}.${['png', 'jpeg', 'webp'][i]}`,
        ),
      );
    }
    assert.match(turns[0].input[0].text, /Please inspect this screenshot/);
    assert.ok(!turns[0].input[0].text.includes(turns[0].input[1].path));
    assert.equal((await sharp(await readFile(turns[0].input[1].path)).metadata()).width, 1);
    const retry = await app.inject({
      method: 'POST',
      url: `/api/messages/${message.id}/retry`,
      headers,
      payload: {},
    });
    assert.equal(retry.statusCode, 200);
    await waitFor(message.id, 'completed');
    assert.deepEqual(turns[1].input.slice(1), turns[0].input.slice(1));
    assert.equal(turns[1].threadId, turns[0].threadId);
    assert.deepEqual(resumes, ['persistent-pm']);
    const text = await app.inject({
      method: 'POST',
      url: `/api/projects/${p.id}/messages`,
      headers,
      payload: { content: 'plain text', intent: 'discuss' },
    });
    await waitFor(text.json().id, 'completed');
    assert.equal(turns[2].input.length, 1);
    assert.equal(turns[2].input[0].type, 'text');
  } finally {
    await engine.stop();
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
