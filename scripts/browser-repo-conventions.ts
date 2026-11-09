import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { Store } from '../src/server/store.ts';
import { Engine } from '../src/server/engine.ts';
import { GitHub } from '../src/server/github.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { Previews } from '../src/server/preview.ts';
import { createApp } from '../src/server/app.ts';
import { command } from '../src/server/process.ts';
import { profileProtocol } from '../tests/profile-protocol.ts';
import { choosePreference } from './browser-preferences.ts';

/** A real repository with gitmoji history, a PR template, CI and an agent instruction file. */
async function greeterRepository(root: string) {
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  await command('git', ['init', '--bare', remote]);
  await command('git', ['init', '-b', 'main', source]);
  const git = (args: string[]) => command('git', args, source);
  await git(['config', 'user.name', 'Greeter Team']);
  await git(['config', 'user.email', 'team@example.invalid']);
  await git(['remote', 'add', 'origin', remote]);
  await mkdir(join(source, '.github', 'workflows'), { recursive: true });
  await mkdir(join(source, '.github', 'ISSUE_TEMPLATE'), { recursive: true });
  const files: Record<string, string> = {
    'AGENTS.md': '# Greeter\nKeep greetings short.\n',
    'CONTRIBUTING.md': '# Contributing\nOpen a pull request against main.\n',
    '.github/pull_request_template.md': '## What changed\n\n## How it was tested\n',
    '.github/ISSUE_TEMPLATE/bug_report.md': '---\nname: Bug report\n---\n',
    '.github/workflows/ci.yml':
      [
        'on: [push, pull_request]',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - run: npm ci',
        '      - run: |',
        '          npm run lint',
        '          npm test',
      ].join('\n') + '\n',
    'package.json': JSON.stringify(
      { name: 'greeter', scripts: { test: 'node --test', lint: 'eslint .', build: 'tsc' } },
      null,
      2,
    ),
  };
  for (const [file, text] of Object.entries(files)) await writeFile(join(source, file), text);
  await git(['add', '.']);
  await git(['commit', '-m', '🎉 Start the greeter']);
  for (const [file, subject] of [
    ['greet.js', '✨ Greet by name'],
    ['greet.test.js', '✅ Cover empty names'],
    ['README.md', '📝 Explain the greeting options'],
    ['greet.js', '🐛 Trim whitespace in names'],
    ['ci.txt', '👷 Cache npm in CI'],
  ]) {
    await writeFile(join(source, file), `${subject}\n`);
    await git(['add', '.']);
    await git(['commit', '-m', subject]);
  }
  await git(['push', '-u', 'origin', 'main']);
  return source;
}

export async function checkRepoConventions() {
  const root = await mkdtemp(join(tmpdir(), 'phantom-browser-conventions-'));
  const store = new Store(':memory:');
  const project = store.createProject('问候组件', '给访客打招呼的小组件。');
  store.saveTeamInstructions(
    project.id,
    {
      repository: '合并前先 squash。',
      engineering: '先写失败的测试，再修复。',
      delivery: '附上验证结果。',
    },
    { source: 'user', baseVersion: 0 },
  );
  store.createRepo({
    projectId: project.id,
    name: 'greeter',
    path: await greeterRepository(root),
    github: 'acme/greeter',
    defaultBranch: 'main',
    authorized: true,
  });
  const ws = new Workspaces(join(root, 'ws'), store);
  const engine = new Engine(store, new GitHub(store), ws, root);
  const port = await new Promise<number>((done, fail) => {
    const probe = createServer().once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture port');
      probe.close(() => done(address.port));
    });
  });
  const app = createApp(store, engine, new Previews(store, ws), port, profileProtocol);
  const origin = await app.listen({ host: '127.0.0.1', port });
  const browser = await chromium.launch({
    headless: true,
    channel: process.platform === 'win32' ? 'msedge' : undefined,
  });
  const artifacts = resolve('test-results');
  await mkdir(artifacts, { recursive: true });
  try {
    const context = await browser.newContext({ locale: 'zh-CN', reducedMotion: 'reduce' });
    await context.addInitScript((id) => {
      localStorage.setItem('phantom.project', id);
      localStorage.setItem('phantom.locale', 'zh-CN');
    }, project.id);
    await context.route('**/api/agents/*/models', (route) =>
      route.fulfill({ json: { available: true, models: [] } }),
    );
    await context.route('**/api/agents/*/allowance?*', (route) =>
      route.fulfill({ json: { state: 'unknown' } }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${origin}/#/p/${project.id}/project`);
    const panel = page.getByRole('region', { name: '团队说明', exact: true });
    await panel.getByRole('button', { name: '重新读取仓库约定' }).click();
    await panel
      .getByRole('status')
      .getByText(/读了 acme\/greeter 的约定/)
      .waitFor();
    await panel.getByText('acme/greeter', { exact: true }).waitFor();
    const current = store.currentTeamInstructions(project.id);
    assert.equal(current.source, 'team');
    assert.match(current.sections.repository, /^合并前先 squash。/);
    assert.match(current.sections.repository, /gitmoji/);
    assert.match(current.sections.repository, /`npm run lint`/);
    for (const width of [1440, 1366, 390]) {
      for (const theme of ['dark', 'light']) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        await choosePreference(page, 'theme', theme);
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${width}/${theme}: no horizontal overflow`,
        );
        await panel
          .locator('summary')
          .filter({ hasText: '当前说明' })
          .evaluate((element) => element.scrollIntoView({ block: 'start' }));
        await page.screenshot({
          path: resolve(artifacts, `repo-conventions-${width}-${theme}.png`),
          fullPage: false,
        });
        await panel
          .locator('.team-instruction-actions')
          .evaluate((element) => element.scrollIntoView({ block: 'center' }));
        await page.screenshot({
          path: resolve(artifacts, `repo-conventions-${width}-${theme}-actions.png`),
          fullPage: false,
        });
      }
    }
    assert.deepEqual(errors, []);
    console.log(
      'Repository convention browser checks passed: re-read from the Project page, learned block next to user text; 1440/1366/390 dark and light screenshots.',
    );
  } finally {
    await browser.close();
    await app.close();
    await engine.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await checkRepoConventions();
