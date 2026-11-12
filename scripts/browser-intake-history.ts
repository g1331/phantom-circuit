import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import type { Engine } from '../src/server/engine.ts';
import type { Store } from '../src/server/store.ts';
import type { ObservedIssue } from '../src/server/github.ts';
import type { Repo } from '../src/shared/types.ts';

interface Context {
  page: Page;
  engine: Engine;
  store: Store;
  repo: Repo;
  projectId: string;
  observed: (number: number, title: string) => ObservedIssue;
  artifacts: string;
}

export async function checkPagedInputReplies(context: Context) {
  const { page, engine, store, repo, projectId, observed } = context;
  engine.github.readIntakeIssues = async () => [
    observed(17, 'Synthetic older externally delivered request'),
    ...Array.from({ length: 31 }, (_, index) => ({
      ...observed(100 + index, `Synthetic unapproved pagination input ${index}`),
      actor: { id: 17, login: 'other', kind: 'user' as const },
    })),
  ];
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/api/repos/${repo.id}/intake/refresh`) &&
        response.ok(),
    ),
    page.getByRole('button', { name: `同步来源 · ${repo.name}`, exact: true }).click(),
  ]);
  await page.locator('.source-unavailable').waitFor({ state: 'detached' });
  const entry = engine.intake
    .workflow(projectId, undefined, 50)
    .inputs.find((item) => item.input.number === 17)!;
  const message = engine.intake.dispatchMessage(entry.input.id)!;
  const task = store.createTask({
    projectId,
    repoId: repo.id,
    sourceMessageId: message.id,
    title: 'Synthetic older external delivery',
    spec: 'Synthetic independent delivery',
    acceptance: ['Synthetic delivered result'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  const at = new Date().toISOString();
  const remote = {
    repoId: repo.id,
    repository: repo.github,
    pr: 22,
    head: 'synthetic-remote-head',
    base: 'synthetic-remote-base',
    baseRef: 'main',
    mergeCommit: 'synthetic-merge',
    mergedAt: at,
    checkedAt: at,
  };
  store.updateTask(task.id, {
    pr: 22,
    prUrl: `https://github.com/${repo.github}/pull/22`,
    issueState: 'completed',
    prState: 'merged',
    remoteMerge: remote,
  });
  store.completeExternalTask(task.id, {
    issue: 17,
    primary: remote,
    closing: remote,
    closedAt: at,
    checkedAt: at,
    relationship: {
      primaryReferencesIssue: true,
      closingReferencesIssue: true,
      closureEventAt: at,
    },
  });
  engine.intake.outcome(store.task(task.id), 'Synthetic independently delivered outcome.');
  const reply = engine.intake.detail(entry.input.id).replies[0];
  const deliver = engine.github.deliverSourceReply;
  engine.github.deliverSourceReply = async (value, assertAllowed) => {
    assertAllowed();
    const id = `source-reply:${value.id}`;
    store.put('operation', id, {
      id,
      kind: 'source-reply',
      status: 'uncertain',
      attempt: 1,
      error: 'Synthetic response lost after write',
    });
    throw new Error('Synthetic response lost after write');
  };
  try {
    await engine.intake.sendReply(reply.id);
  } finally {
    engine.github.deliverSourceReply = deliver;
  }
  assert(
    !engine.intake.workflow(projectId).inputs.some((item) => item.input.id === entry.input.id),
  );
  const row = page.locator(`[data-task-id="${task.id}"]`);
  await row.locator('[data-step="source"] a').getByText('GitHub #17', { exact: true }).waitFor();
  await row.locator('[data-step="reply"]').getByText('回复待核对', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(context.artifacts, 'intake-older-reply-390.png') });
}

export async function checkLiveInputSettlement(context: Context) {
  const { page, engine, store, projectId, repo, observed, artifacts } = context;
  const paragraph = (index: number) =>
    `Synthetic source paragraph ${index} preserves reading position.`;
  engine.github.readIntakeIssues = async () => [
    {
      ...observed(18, 'Synthetic live source assessment'),
      body: '/phantom\n' + Array.from({ length: 30 }, (_, index) => paragraph(index)).join('\n\n'),
    },
  ];
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/api/repos/${repo.id}/intake/refresh`) &&
        response.ok(),
    ),
    page.getByRole('button', { name: `同步来源 · ${repo.name}`, exact: true }).click(),
  ]);
  const entry = engine.intake.workflow(projectId).inputs.find((item) => item.input.number === 18)!;
  const message = engine.intake.dispatchMessage(entry.input.id)!;
  const run = store.run('pm', projectId, 'pm', {
    sourceMessageId: message.id,
  });
  store.updateMessage(message.id, { status: 'running', draftStatus: 'running', runId: run.id });
  store.event('activity', 'Synthetic source assessment action', { projectId, runId: run.id });
  try {
    await page.getByRole('button', { name: '全部', exact: true }).click();
    await page
      .locator('.flow-project-activity')
      .getByText('Synthetic source assessment action', { exact: true })
      .waitFor();
    await page
      .locator(`[data-input-id="${entry.input.id}"]`)
      .getByRole('link', { name: entry.input.title, exact: true })
      .click();
    const drawer = page.getByRole('dialog', { name: '输入详情', exact: true });
    await drawer.getByText('正在判断', { exact: true }).waitFor();
    const target = drawer.getByText(paragraph(12), { exact: true });
    await target.scrollIntoViewIfNeeded();
    const before = (await target.boundingBox())!.y;
    engine.intake.noAction(message.id, 'Synthetic assessment finished without a code change.');
    store.updateMessage(message.id, { status: 'completed', draftStatus: 'completed' });
    await engine.intake.sendReply(engine.intake.detail(entry.input.id).replies[0].id);
    store.finishRun(run.id, 'completed');
    await drawer.getByText('无需处理', { exact: true }).waitFor({ timeout: 12000 });
    await drawer.getByText('回复已送达', { exact: true }).waitFor();
    assert(Math.abs((await target.boundingBox())!.y - before) < 2);
    await drawer.getByText('接收与授权记录', { exact: true }).click();
    await drawer.getByText('正文作者或编辑者', { exact: true }).waitFor();
    await page.screenshot({ path: resolve(artifacts, 'intake-live-settled-record.png') });
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
  } finally {
    if (store.get('run', run.id)?.status === 'running') store.finishRun(run.id, 'interrupted');
  }
}
