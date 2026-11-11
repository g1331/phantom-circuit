import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { devFixture } from './dev-fixture.ts';
import { Codex } from '../src/server/codex.ts';
import { command } from '../src/server/process.ts';
import { Engine } from '../src/server/engine.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { configuration, human, issueObservation } from './intake-fixture.ts';
import type { ObservedIssue } from '../src/server/github.ts';

async function fixture() {
  const base = await devFixture('phantom-intake-engine-');
  base.store.control(base.task.id, 'cancel');
  let mode: 'no_action' | 'missing' | 'failure' | 'multi' | 'revise' = 'no_action';
  let observation: ObservedIssue = {
    ...issueObservation,
    url: 'https://github.com/fixture/source/issues/12',
  };
  let taskId = '';
  let sourceId = '';
  let attempt:
    | ((handler: NonNullable<Parameters<Codex['thread']>[0]['toolHandler']>) => Promise<void>)
    | undefined;
  const prompts: string[] = [];
  const replies: string[] = [];
  base.github.resolveIntakeActor = async () => human;
  base.github.readIntakeIssues = async () => [observation];
  base.github.deliverSourceReply = async (reply, assertAllowed) => {
    assertAllowed();
    replies.push(reply.body);
    return {
      id: 1,
      body: reply.body,
      html_url: `${observation.url}#issuecomment-1`,
      user: { id: 7, login: 'human', type: 'User' },
    };
  };
  base.github.api = async <T = unknown>() =>
    ({
      id: 91,
      node_id: observation.nativeId,
      number: observation.number,
      html_url: observation.url,
      body: observation.body,
      state: 'open',
    }) as T;
  class Model extends Codex {
    options?: Parameters<Codex['thread']>[0];
    override async start() {}
    override async stop() {}
    override async thread(options: Parameters<Codex['thread']>[0]) {
      this.options = options;
      return 'intake-pm';
    }
    override async turn(_thread: string, prompt: string) {
      prompts.push(prompt);
      const handler = this.options!.toolHandler!;
      if (attempt) await attempt(handler);
      this.emit('notification', 'item/started', {
        item: { type: 'commandExecution', command: 'echo ghp_SECRET123' },
      });
      this.emit('notification', 'item/completed', {
        item: { type: 'fileChange', changes: [{ path: 'src/value.ts' }] },
      });
      if (mode === 'failure') throw new Error('PM assessment unavailable');
      if (mode === 'no_action')
        await handler('record_no_action', { reason: 'No repository change is necessary.' });
      if (mode === 'multi') {
        const input = {
          repoId: base.repo.id,
          title: 'Deliver one thing',
          spec: 'One change',
          acceptance: ['Works'],
          dependencies: [],
          kind: 'backend',
          complexity: 'normal',
          priority: 0,
        };
        const first = (await handler('create_task', input)) as { id: string };
        taskId = first.id;
        assert.equal(((await handler('create_task', input)) as { id: string }).id, first.id);
        await assert.rejects(
          handler('create_task', { ...input, title: 'Separate deliverable' }),
          /独立交付/,
        );
      }
      if (mode === 'revise')
        await handler('revise_task', {
          taskId,
          spec: 'Single agreed deliverable',
          acceptance: ['One result works'],
          guidance: 'Keep one deliverable.',
        });
      return 'Assessment complete';
    }
  }
  const engine = new Engine(
    base.store,
    base.github,
    new Workspaces(join(base.root, 'ws'), base.store),
    base.root,
    () => new Model(),
  );
  return {
    ...base,
    engine,
    prompts,
    replies,
    setMode(value: typeof mode) {
      mode = value;
    },
    setAttempt(value: typeof attempt) {
      attempt = value;
    },
    async input(number: number) {
      observation = {
        ...observation,
        nativeId: `I_${number}`,
        number,
        url: `https://github.com/fixture/source/issues/${number}`,
        revision: `revision-${number}`,
      };
      await engine.intake.refresh(base.repo.id);
      sourceId = engine.intake.workflow(base.project.id).inputs[0].input.id;
      return sourceId;
    },
    taskId: () => taskId,
    sourceId: () => sourceId,
    async close() {
      await engine.stop();
      base.store.close();
      await rm(base.root, { recursive: true, force: true });
    },
  };
}

test('PM records no-action, missing judgment and failure as distinct external states', async () => {
  const f = await fixture();
  try {
    await f.engine.intake.configure(f.repo.id, configuration);
    const noAction = await f.input(12);
    await f.engine.intake.pump(false);
    assert.equal(f.engine.intake.detail(noAction).assessment.disposition.status, 'no_action');
    assert.equal(f.replies.length, 1);
    assert.match(f.prompts[0], /NOT a local Web user/);
    assert.match(f.prompts[0], /ORIGINAL Issue/);
    const activity = f.store.events().filter((event) => event.type === 'activity');
    assert.equal(activity.length, 2);
    assert(activity.every((event) => event.projectId === f.project.id && event.runId));
    assert(!JSON.stringify(activity).includes('ghp_SECRET123'));
    const command = activity.find((event) => event.message.includes('echo '));
    assert(command);
    assert.match(command.message, /^echo /, 'live commands are readable without wire JSON');
    assert(activity.some((event) => event.message.includes('src/value.ts')));
    f.setMode('missing');
    const missing = await f.input(13);
    await f.engine.intake.pump(false);
    assert.equal(f.engine.intake.detail(missing).assessment.disposition.status, 'unavailable');
    f.setMode('failure');
    const failed = await f.input(14);
    await f.engine.intake.pump(false);
    assert.equal(f.engine.intake.detail(failed).assessment.disposition.status, 'unavailable');
    assert.equal(
      f.replies.length,
      1,
      'failed and unjudged inputs do not send invented no-action answers',
    );
    f.setMode('no_action');
    await f.engine.intake.retry(failed);
    assert.equal(f.engine.intake.detail(failed).assessment.disposition.status, 'no_action');
    assert.equal(
      f.store.list('message').filter((message) => message.origin?.inputId === failed).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('multi-deliverable requests pause before execution and preserve original text', async () => {
  const f = await fixture();
  try {
    f.setMode('multi');
    await f.engine.intake.configure(f.repo.id, configuration);
    const inputId = await f.input(12);
    await f.engine.intake.pump(false);
    const detail = f.engine.intake.detail(inputId);
    assert.equal(detail.assessment.disposition.status, 'awaiting_decision');
    const task = f.store.task(f.taskId());
    assert.equal(task.issue, 12);
    assert.equal(task.control, 'paused');
    assert.equal(f.store.list('task').filter((item) => item.issueOrigin).length, 1);
    assert.equal(f.store.claimNext(), undefined);
    const clarification = f.store
      .list('clarification')
      .find((item) => item.sourceMessageId === task.sourceMessageId)!;
    f.setMode('revise');
    await f.engine.answerClarification(f.project.id, clarification.id, [
      { questionId: clarification.questions[0].id, value: 'Only one deliverable.' },
    ]);
    for (
      let index = 0;
      index < 500 && f.store.task(task.id).spec !== 'Single agreed deliverable';
      index++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.store.task(task.id).spec, 'Single agreed deliverable');
    assert.equal(f.store.task(task.id).issueBody, issueObservation.body);
    assert.equal(f.store.get('message', task.sourceMessageId)?.content, issueObservation.body);
    assert.equal(f.engine.intake.detail(inputId).input.body, issueObservation.body);
  } finally {
    await f.close();
  }
});

test('admitted Issue PM tools reject other repositories and requests', async () => {
  const f = await fixture();
  try {
    const otherPath = join(f.root, 'other');
    await command('git', ['clone', f.repo.path, otherPath]);
    const otherRepo = f.store.createRepo({
      projectId: f.project.id,
      name: 'other',
      path: otherPath,
      github: 'fixture/other',
      defaultBranch: f.repo.defaultBranch,
      authorized: true,
    });
    const localSource = f.store.addMessage(
      f.project.id,
      'user',
      'A separate local request',
      'implement',
    );
    const otherTask = f.store.createTask({
      projectId: f.project.id,
      repoId: f.repo.id,
      sourceMessageId: localSource.id,
      title: 'Unrelated request',
      spec: 'Keep this request unchanged',
      acceptance: ['Unchanged'],
      priority: 0,
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
    });
    const attempts = [
      {
        name: 'configure_repository',
        args: { repoId: otherRepo.id, commands: f.repo.commands, requiredChecks: ['other'] },
      },
      {
        name: 'record_domain_document',
        args: { repoId: otherRepo.id, path: 'CONTEXT.md', content: 'Wrong scope', accepted: true },
      },
      {
        name: 'set_task_priority',
        args: {
          taskId: otherTask.id,
          level: 'urgent',
          reason: 'Wrong scope',
          expectedVersion: 0,
          requestId: 'external-priority',
        },
      },
    ];
    const outcomes: number[] = [];
    f.setAttempt(async (handler) => {
      for (const action of attempts) {
        try {
          await handler(action.name, action.args);
          outcomes.push(200);
        } catch (error) {
          outcomes.push(
            error instanceof Error && 'status' in error && typeof error.status === 'number'
              ? error.status
              : 500,
          );
        }
      }
    });
    await f.engine.intake.configure(f.repo.id, configuration);
    const inputId = await f.input(12);
    await f.engine.intake.pump(false);
    assert.deepEqual(outcomes, [403, 403, 403]);
    assert.equal(f.engine.intake.detail(inputId).assessment.disposition.status, 'no_action');
    assert.deepEqual(f.store.repo(otherRepo.id).requiredChecks, []);
    assert.equal(f.store.documentSnapshot(f.project.id, otherRepo.id).length, 0);
    assert.equal(f.store.task(otherTask.id).priority, 0);
  } finally {
    await f.close();
  }
});
