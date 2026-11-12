import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import type { Store } from '../src/server/store.ts';
import type { Engine } from '../src/server/engine.ts';
import type { ObservedIssue } from '../src/server/github.ts';
import { issueObservation, human } from '../tests/intake-fixture.ts';
import { choosePreference } from './browser-preferences.ts';
import { openPage } from './browser-pages.ts';
import { checkLiveInputSettlement, checkPagedInputReplies } from './browser-intake-history.ts';
import { checkVisualWorkspace } from './browser-visual-workspace.ts';
import { checkMaintenanceRules } from './browser-maintenance-rules.ts';

/** Synthetic GitHub-boundary fixtures; live-platform acceptance remains a separate gate. */
export async function checkIntakeWorkbench(
  page: Page,
  store: Store,
  engine: Engine,
  artifacts: string,
) {
  const project = store.createProject('Synthetic Issue intake', 'Browser regression fixture');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'Synthetic intake repository',
    path: '/synthetic/intake-browser',
    github: 'synthetic/intake',
    defaultBranch: 'main',
    authorized: true,
  });
  const observed = (number: number, title: string): ObservedIssue => ({
    ...issueObservation,
    number,
    title,
    nativeId: `I_browser_${number}`,
    databaseId: number,
    url: `https://github.com/synthetic/intake/issues/${number}`,
  });
  const observations = [
    observed(12, 'Synthetic answer without repository changes'),
    observed(13, 'Synthetic assessment failure'),
    { ...observed(14, 'Synthetic unapproved sender'), actor: { ...human, id: 17, login: 'other' } },
    observed(15, 'Synthetic product question'),
    observed(16, 'Synthetic admitted implementation'),
  ];
  const github = engine.github;
  const originals = {
    actor: github.resolveIntakeActor,
    read: github.readIntakeIssues,
    reply: github.deliverSourceReply,
  };
  github.resolveIntakeActor = async () => human;
  github.readIntakeIssues = async () => observations;
  github.deliverSourceReply = async (reply, assertAllowed) => {
    assertAllowed();
    return {
      id: 1,
      body: reply.body,
      html_url: `https://github.com/synthetic/intake/issues/${reply.issue}#issuecomment-1`,
      user: { id: 7, type: 'User', login: 'human' },
    };
  };
  const origin = new URL(page.url()).origin;
  try {
    await mkdir(artifacts, { recursive: true });
    await page.goto(`${origin}/?intake-fixture=1#/p/${project.id}`);
    await choosePreference(page, 'language', 'zh-CN');
    await page.getByText('提交需求，开始下一项工作。', { exact: true }).waitFor();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: resolve(artifacts, `intake-empty-${width}.png`) });
    }
    await page.locator('.flow-source-state > button').first().click();
    const settings = page.getByRole('dialog', { name: '接收设置', exact: true });
    await settings.getByLabel('接收明确指令的 Issue 请求').check();
    await settings.getByLabel('允许发起工作的 GitHub 用户').fill('human');
    await settings.getByLabel('接收起点').fill('2026-01-01T00:00');
    await settings.getByRole('button', { name: '保存接收设置', exact: true }).click();
    await settings.waitFor({ state: 'hidden' });
    assert.equal(engine.intake.source(repo.id)?.enabled, true);
    await page.getByRole('button', { name: `同步来源 · ${repo.name}`, exact: true }).click();
    await page.getByRole('button', { name: '全部', exact: true }).click();
    await page.getByRole('link', { name: observations[0].title, exact: true }).waitFor();
    const input = (number: number) => {
      const entry = engine.intake
        .workflow(project.id, undefined, 50)
        .inputs.find((item) => item.input.number === number);
      assert(entry);
      return entry.input.id;
    };
    const answer = engine.intake.dispatchMessage(input(12))!;
    engine.intake.noAction(
      answer.id,
      'Synthetic answer: existing behavior already meets the request.',
    );
    store.updateMessage(answer.id, { status: 'completed', draftStatus: 'completed' });
    await engine.intake.sendReply(engine.intake.detail(input(12)).replies[0].id);
    const failed = engine.intake.dispatchMessage(input(13))!;
    store.updateMessage(failed.id, { status: 'failed', draftStatus: 'failed' });
    engine.intake.settle(failed, new Error('Synthetic backend unavailable'));
    const question = engine.intake.dispatchMessage(input(15))!;
    store.createClarification({
      projectId: project.id,
      sourceMessageId: question.id,
      sourceIntent: 'implement',
      questions: [{ question: 'Synthetic question: which single deliverable should proceed?' }],
    });
    engine.intake.settle(question);
    const accepted = engine.intake.dispatchMessage(input(16))!;
    const task = store.createTask({
      projectId: project.id,
      repoId: repo.id,
      sourceMessageId: accepted.id,
      title: 'Synthetic admitted implementation',
      spec: 'One synthetic deliverable',
      acceptance: ['Synthetic outcome'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    store.updateMessage(accepted.id, { status: 'completed', draftStatus: 'completed' });
    await page.reload();
    await page.getByRole('button', { name: '全部', exact: true }).click();
    await page.locator(`[data-task-id="${task.id}"]`).waitFor();
    assert.equal(await page.locator('.flow-work').count(), 1);
    assert.equal(await page.locator('.flow-input').count(), 4);
    await page.locator('.flow-attention').waitFor();
    for (const theme of ['light', 'dark'] as const) {
      await choosePreference(page, 'theme', theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        assert(await page.locator('.flow-page').evaluate((el) => el.scrollWidth <= el.clientWidth));
        await page.locator('.flow-page').evaluate((el) => {
          el.scrollTop = 0;
        });
        if (width === 1280)
          await page.getByRole('button', { name: '适配视图', exact: true }).click();
        await page.screenshot({ path: resolve(artifacts, `intake-${width}-${theme}.png`) });
        await page.getByRole('link', { name: observations[0].title, exact: true }).click();
        const detail = page.getByRole('dialog', { name: '输入详情', exact: true });
        await detail.getByRole('heading', { name: '原始请求', exact: true }).waitFor();
        assert((await detail.textContent())?.includes(issueObservation.body));
        await detail.getByText('回复已送达', { exact: true }).waitFor();
        assert(await detail.getByRole('link', { name: '查看原文', exact: true }).count());
        assert(await detail.evaluate((el) => el.scrollWidth <= el.clientWidth));
        await page.screenshot({ path: resolve(artifacts, `intake-detail-${width}-${theme}.png`) });
        await page.keyboard.press('Escape');
        await detail.waitFor({ state: 'hidden' });
        await page.goBack();
        await page.getByRole('dialog', { name: '输入详情', exact: true }).waitFor();
        await page.goForward();
        await page.getByRole('heading', { name: '工作台', exact: true }).waitFor();
      }
    }
    await page.getByRole('button', { name: '暂停团队', exact: true }).click();
    await page.getByRole('button', { name: '恢复团队', exact: true }).waitFor();
    assert.equal(store.project(project.id).admissionPaused, true);
    await page.reload();
    await page.getByRole('button', { name: '恢复团队', exact: true }).click();
    await page.getByRole('button', { name: '暂停团队', exact: true }).waitFor();
    await page.getByRole('button', { name: '全部', exact: true }).click();
    assert.equal(store.project(project.id).admissionPaused, false);
    github.readIntakeIssues = async () => {
      throw new Error('Synthetic source read failed');
    };
    await page.getByRole('button', { name: `同步来源 · ${repo.name}`, exact: true }).click();
    await page.locator('.source-unavailable').waitFor();
    assert.equal(await page.locator('.flow-input').count(), 4);
    const history = { page, store, engine, repo, projectId: project.id, observed, artifacts };
    await checkPagedInputReplies(history);
    const original = page.locator(`[data-task-id="${task.id}"] [data-step="source"] a`);
    await original.waitFor();
    assert.equal(await original.innerText(), 'GitHub #16');
    await page.getByRole('button', { name: '平台输入', exact: true }).click();
    for (let index = 0; index < 4; index++) await page.locator('.flow-more').click();
    const questionRow = page.locator(`[data-input-id="${input(15)}"]`);
    await questionRow.getByText('回复待发送', { exact: true }).waitFor();
    const questionReply = engine.intake.detail(input(15)).replies[0];
    await engine.intake.sendReply(questionReply.id);
    await questionRow.getByText('回复已送达', { exact: true }).waitFor({ timeout: 12000 });
    await page.getByRole('button', { name: '全部', exact: true }).click();
    await original.waitFor();
    assert.equal(
      await original.getAttribute('href'),
      `#/p/${project.id}/inputs/${accepted.origin!.inputId}`,
    );
    await openPage(page, 'conversation');
    await page.getByLabel('给协调者的消息', { exact: true }).waitFor();
    await openPage(page, 'home');
    store.updateTaskControl(
      task.id,
      { stage: 'developing', control: 'active', pausedByUser: false },
      'resume',
      { source: 'user', reason: 'Synthetic live-activity scenario' },
    );
    const run = store.run('dev', project.id, 'backend', store.task(task.id));
    const context = { projectId: project.id, taskId: task.id, runId: run.id };
    store.event('activity', 'Synthetic older action', context);
    store.event('activity', 'Synthetic latest action', context);
    const activity = page.locator(`[data-task-id="${task.id}"] .flow-activity > summary`);
    await activity.getByText('Synthetic latest action', { exact: true }).waitFor();
    assert(!(await activity.innerText()).includes('Synthetic older action'));
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: resolve(artifacts, `intake-live-${width}.png`) });
    }
    store.finishRun(run.id, 'completed');
    await checkLiveInputSettlement(history);
    await checkVisualWorkspace(page, store, project.id, task.id, artifacts);
    await checkMaintenanceRules(page, store, engine, artifacts);
    console.log(
      'Workbench browser fixture passed: source configuration, admission states, ' +
        'original text/reply, history navigation, durable pause, failed-source retention, ' +
        'secondary conversation, 1280/390 light/dark. This is not real-platform acceptance.',
    );
  } finally {
    github.resolveIntakeActor = originals.actor;
    github.readIntakeIssues = originals.read;
    github.deliverSourceReply = originals.reply;
  }
}
