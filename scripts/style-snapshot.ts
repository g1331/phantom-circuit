// Computed-style snapshot of the built UI, to prove a stylesheet reorganisation changes nothing.
//   npm run build && npx tsx scripts/style-snapshot.ts before.json
//   (reorganise, rebuild) && npx tsx scripts/style-snapshot.ts after.json
//   npx tsx scripts/style-snapshot.ts --diff before.json after.json
// Every element of every captured state is fingerprinted (own style plus ::before/::after),
// so any cascade change in the covered views shows up as a differing element.
import { chromium, type Page, type Request } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/server/store.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Engine } from '../src/server/engine.ts';
import { Previews } from '../src/server/preview.ts';
import { createApp } from '../src/server/app.ts';
import { Codex } from '../src/server/codex.ts';
import { OmpBackend } from '../src/server/omp.ts';
import { profileProtocol } from '../tests/profile-protocol.ts';
import { stageLabels, type Stage } from '../src/shared/types.ts';

type Snapshot = Record<string, Record<string, string>>;

if (process.argv[2] === '--diff') {
  const [before, after] = await Promise.all(
    process.argv
      .slice(3, 5)
      .map(async (file) => JSON.parse(await readFile(file, 'utf8')) as Snapshot),
  );
  // Restyling never adds or removes elements, so only elements present on both sides can fail;
  // one-sided elements are asynchronous content (for example a model list) and are only reported.
  let changed = 0;
  let oneSided = 0;
  for (const state of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[state] ?? {};
    const b = after[state] ?? {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const restyled = [...keys].filter((key) => key in a && key in b && a[key] !== b[key]);
    const missing = [...keys].filter((key) => !(key in a && key in b));
    changed += restyled.length;
    oneSided += missing.length;
    if (restyled.length)
      console.log(`${state}: ${restyled.length} restyled — ${restyled.slice(0, 3).join(' | ')}`);
    if (missing.length)
      console.log(`${state}: ${missing.length} on one side only (content, not style)`);
  }
  console.log(`restyled elements: ${changed}; one-sided elements: ${oneSided}`);
  process.exit(changed ? 1 : 0);
}

const out = process.argv[2];
if (!out)
  throw new Error('Usage: style-snapshot.ts <out.json> | --diff <before.json> <after.json>');
if (!existsSync(resolve('dist/index.html'))) throw new Error('Run npm run build first.');

const port = await new Promise<number>((done, fail) => {
  const probe = createServer().once('error', fail);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as AddressInfo;
    probe.close(() => done(port));
  });
});
const store = new Store(':memory:');
store.saveSettings({ ...store.settings(), defaultAgent: 'codex' });
const ws = new Workspaces(await mkdtemp(join(tmpdir(), 'phantom-style-ws-')), store);
class OfflinePM extends Codex {
  override async start() {
    throw new Error('Style snapshot: PM offline');
  }
}
class OfflineOmp extends OmpBackend {
  override async start() {}
  override async stop() {}
  override async modelCapabilities() {
    return [
      {
        id: 'snapshot-omp',
        model: 'snapshot-omp',
        provider: 'fixture',
        reasoningEfforts: ['low'],
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
      },
    ];
  }
  override async accountAllowance() {
    return { status: 'unavailable' as const, error: 'Style snapshot has no account allowance' };
  }
  override async probe() {
    return {
      backend: 'omp',
      models: await this.modelCapabilities(),
      capabilities: this.capabilities,
      version: 'snapshot-fixture',
    };
  }
}
const engine = new Engine(
  store,
  new GitHub(store),
  ws,
  await mkdtemp(join(tmpdir(), 'phantom-style-images-')),
  () => new OfflinePM(),
);
const app = createApp(
  store,
  engine,
  new Previews(store, ws),
  port,
  profileProtocol,
  () => new OfflineOmp(),
);

// Long, varied content so overflow, wrapping and every stage/status tone are on screen.
const project = store.createProject('Orbit Studio', '让每一次产品迭代，都从明确的需求开始。');
const repos = ['orbit-web', 'orbit-api', 'orbit-admin', 'orbit-docs'].map((name, i) =>
  store.createRepo({
    projectId: project.id,
    name,
    path: `D:/${name}`,
    github: `orbit/${name}`,
    authorized: i < 3,
    defaultBranch: 'main',
  }),
);
const reply = (n: number) =>
  `第 ${n} 轮回复。\n\n${'这是一段较长的说明文字，用来观察段落的阅读节奏与间距。'.repeat(4)}\n\n- 要点一\n- 要点二\n\n\`\`\`ts\n${'const result = await someService.performOperation(argumentOne, argumentTwo, argumentThree);\n'.repeat(3)}\`\`\``;
let source: { id: string } | undefined;
for (let i = 1; i <= 12; i++) {
  const message = store.addMessage(
    project.id,
    'user',
    `第 ${i} 个问题：${'需求描述'.repeat(i % 3 ? 3 : 30)}`,
    i % 2 ? 'discuss' : 'implement',
  );
  if (i % 2 === 0) source ??= message;
  const run = store.run('pm', project.id, 'pm', { sourceMessageId: message.id });
  for (let k = 0; k < (i === 12 ? 14 : 3); k++)
    store.activity(run, `a${k}`, {
      kind: 'command',
      title: '执行命令',
      status: 'completed',
      details: {
        command: `npm run step-${k} -- --flag=${'x'.repeat(60)}`,
        output: 'ok\n'.repeat(30),
      },
    });
  store.addMessage(project.id, 'assistant', reply(i), undefined, undefined, {
    runId: run.id,
    sourceMessageId: message.id,
  });
  store.finishRun(run.id, i === 7 ? 'failed' : 'completed', i === 7 ? '命令失败' : undefined);
}
const stages = Object.keys(stageLabels) as Stage[];
const tasks = Array.from({ length: 40 }, (_, i) => {
  const task = store.createTask({
    projectId: project.id,
    repoId: repos[i % 3].id,
    sourceMessageId: source!.id,
    title: `任务 ${i + 1}：${i % 5 === 0 ? '一个标题特别长、需要换行才能放下的任务名称，用来观察卡片高度' : '登录与会话改进'}`,
    spec: `## 目标\n\n${'详细规格说明。'.repeat(40)}\n\n${Array.from({ length: 15 }, (_, k) => `- 约束 ${k + 1}`).join('\n')}`,
    acceptance: Array.from({ length: 8 }, (_, k) => `验收条件 ${k + 1}：用户可见结果正确`),
    dependencies: [],
    kind: i % 2 ? 'backend' : 'frontend',
    complexity: 'normal',
    priority: [-5, 0, 5, 10][i % 4],
  });
  store.updateTask(task.id, {
    stage: stages[i % 4 === 0 ? 1 : i % stages.length],
    blocked: i % 9 === 0 ? '依赖未完成' : undefined,
  });
  return task;
});
for (let i = 0; i < 30; i++) {
  const run = store.run(
    i % 2 ? 'dev' : 'review',
    project.id,
    i % 2 ? 'frontend' : 'review',
    tasks[i],
  );
  if (i > 2)
    store.finishRun(run.id, i % 5 ? 'completed' : 'failed', i % 5 ? undefined : '评审发现问题');
}
for (let i = 0; i < 3; i++)
  store.createIncident({
    projectId: project.id,
    phase: 'review',
    message: `事件 ${i + 1}：评审代理连续超时。`,
    taskId: tasks[i].id,
  });

const snapshot: Snapshot = {};
const inflight = new Map<Page, Set<Request>>();
/** Counts a page's open requests; the event stream stays open by design and is ignored. */
function trackRequests(page: Page) {
  const open = new Set<Request>();
  inflight.set(page, open);
  page.on('request', (request) => {
    if (request.resourceType() !== 'eventsource') open.add(request);
  });
  page.on('requestfinished', (request) => open.delete(request));
  page.on('requestfailed', (request) => open.delete(request));
}
async function capture(page: Page, state: string) {
  for (let waited = 0; inflight.get(page)!.size && waited < 10_000; waited += 100)
    await page.waitForTimeout(100);
  // tsx keeps function names with a __name helper that the page does not define.
  await page.evaluate('window.__name = (f) => f');
  // Panels load asynchronously; sample once the DOM has been quiet for 500ms (at most 5s).
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const finish = () => {
          observer.disconnect();
          clearTimeout(quiet);
          clearTimeout(limit);
          done();
        };
        let quiet = setTimeout(finish, 500);
        const limit = setTimeout(finish, 5000);
        const observer = new MutationObserver(() => {
          clearTimeout(quiet);
          quiet = setTimeout(finish, 500);
        });
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      }),
  );
  snapshot[state] = await page.evaluate(() => {
    const result: Record<string, string> = {};
    const hash = (text: string) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
      return (h >>> 0).toString(36);
    };
    // Key = parent key > tag.classes[n among same-keyed siblings], so an inserted element
    // does not shift the keys of unrelated elements elsewhere in the page.
    const walk = (parent: Element, parentKey: string) => {
      const seen = new Map<string, number>();
      for (const element of parent.children) {
        const classes =
          typeof element.className === 'string'
            ? element.className.trim().split(/s+/).filter(Boolean).join('.')
            : '';
        const label = `${element.tagName.toLowerCase()}${classes ? '.' + classes : ''}`;
        const n = seen.get(label) ?? 0;
        seen.set(label, n + 1);
        const key = `${parentKey}>${label}[${n}]`;
        const parts: string[] = [];
        for (const pseudo of [null, '::before', '::after'] as const) {
          const style = getComputedStyle(element, pseudo);
          if (pseudo && style.content === 'none') continue;
          for (let i = 0; i < style.length; i++) {
            const name = style[i];
            if (!name.startsWith('--'))
              parts.push(`${pseudo ?? ''}${name}:${style.getPropertyValue(name)}`);
          }
        }
        result[key] = hash(parts.join(';'));
        walk(element, key);
      }
    };
    walk(document.body, 'body');
    return result;
  });
}

await app.listen({ host: '127.0.0.1', port });
const browser = await chromium.launch({
  headless: true,
  channel: process.platform === 'win32' ? 'msedge' : undefined,
});
try {
  for (const theme of ['dark', 'light']) {
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [760, 900],
      [390, 844],
    ] as const) {
      const page = await browser.newPage({
        viewport: { width, height },
        locale: 'zh-CN',
        reducedMotion: 'reduce',
      });
      trackRequests(page);
      await page.addInitScript((value) => {
        localStorage.setItem('phantom.theme', value);
        localStorage.setItem('phantom.locale', 'zh-CN');
      }, theme);
      await page.goto(`http://127.0.0.1:${port}`);
      await page.getByRole('heading', { name: 'Orbit Studio', exact: true }).waitFor();
      const prefix = `${theme}-${width}`;
      await capture(page, `${prefix}-chat`);
      await page.getByRole('tab', { name: /任务/ }).first().click();
      await capture(page, `${prefix}-board`);
      await page.getByRole('button', { name: '列表', exact: true }).click();
      await capture(page, `${prefix}-list`);
      await page.getByText('任务 2：登录与会话改进').first().click();
      await page.locator('dialog[open]').waitFor();
      await capture(page, `${prefix}-detail`);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '看板', exact: true }).click();
      await page.getByRole('tab', { name: /运行/ }).first().click();
      await capture(page, `${prefix}-runs`);
      await page.locator('.context-trigger').click();
      await capture(page, `${prefix}-context`);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '运行设置' }).first().click();
      await page.locator('dialog[open]').waitFor();
      await capture(page, `${prefix}-settings`);
      await page.close();
    }
  }
  await writeFile(out, JSON.stringify(snapshot));
  const elements = Object.values(snapshot).reduce((n, state) => n + Object.keys(state).length, 0);
  console.log(`states: ${Object.keys(snapshot).length}, elements: ${elements}`);
} finally {
  await browser.close();
  await app.close();
  store.close();
}
