import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { devFixture } from './dev-fixture.ts';
import { Codex } from '../src/server/codex.ts';
import { Engine } from '../src/server/engine.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { configuration, human, issueObservation } from './intake-fixture.ts';
import type { Task } from '../src/shared/types.ts';

test(
  'an external request reaches Git validation, review, completion and one reply',
  { timeout: 60_000 },
  async () => {
    const base = await devFixture('phantom-intake-lifecycle-');
    base.store.control(base.task.id, 'cancel');
    base.store.patchRepo(base.repo.id, {
      commands: {
        install: '',
        build: '',
        test: "node -e \"require('node:assert/strict').equal(require('./index.cjs'),2)\"",
        start: '',
        port: 3000,
      },
    });
    const observation = { ...issueObservation, url: 'https://github.com/fixture/source/issues/12' };
    let merged = false;
    let sourceWrites = 0;
    let issueCreates = 0;
    let issueBody = observation.body;
    let issueState = 'open';
    const replies: {
      id: number;
      body: string;
      html_url: string;
      user: typeof human & { type: string };
    }[] = [];
    const github = base.github;
    github.resolveIntakeActor = async () => human;
    github.readIntakeIssues = async () => [observation];
    github.publishIssue = async () => {
      issueCreates++;
      throw new Error('Imported Issue must not be published');
    };
    github.api = async <T = unknown>(
      _endpoint: string,
      method = 'GET',
      body?: unknown,
    ): Promise<T> => {
      if (method === 'PATCH') {
        assert.deepEqual(body, { state: 'closed', state_reason: 'completed' });
        issueState = 'closed';
      }
      return {
        id: 91,
        node_id: observation.nativeId,
        number: 12,
        html_url: observation.url,
        body: issueBody,
        state: issueState,
        state_reason: issueState === 'closed' ? 'completed' : null,
      } as T;
    };
    github.pull = async (task: Task) => ({
      number: 22,
      html_url: 'https://github.com/fixture/source/pull/22',
      state: merged ? 'closed' : 'open',
      merged,
      mergeable: true,
      mergeable_state: 'clean',
      head: { sha: task.head!, ref: task.branch, repo: { full_name: 'fixture/source' } },
      base: { sha: task.base!, ref: 'main', repo: { full_name: 'fixture/source' } },
      body: 'Closes #12',
    });
    github.publishPR = async (task: Task) => {
      base.store.updateTask(task.id, {
        pr: 22,
        prUrl: 'https://github.com/fixture/source/pull/22',
      });
      return github.pull(task);
    };
    github.feedback = async () => [];
    github.reviewComment = async () => {};
    github.checks = async () => ({ ready: true });
    github.merge = async (task: Task) =>
      github.operation(
        `merge:${task.id}:${task.head}`,
        'merge-pr',
        async () => (merged ? github.pull(task) : undefined),
        async () => {
          merged = true;
          return github.pull(task);
        },
      );
    github.deliverSourceReply = async (reply, check) =>
      github.operation(
        `source-reply:${reply.id}`,
        'source-reply',
        async () => replies.find((comment) => comment.body === reply.body),
        async () => {
          check();
          sourceWrites++;
          const comment = {
            id: sourceWrites,
            body: reply.body,
            html_url: `${observation.url}#issuecomment-${sourceWrites}`,
            user: { ...human, type: 'User' },
          };
          replies.push(comment);
          return comment;
        },
      );
    class Model extends Codex {
      options?: Parameters<Codex['thread']>[0];
      override async start() {}
      override async stop() {}
      override async thread(options: Parameters<Codex['thread']>[0]) {
        this.options = options;
        return `test-${options.writable ? 'dev' : 'pm-review'}`;
      }
      override async turn(_thread: string, prompt: string) {
        const options = this.options!;
        if (options.writable) {
          await writeFile(join(options.cwd, 'index.cjs'), 'module.exports = 2;\n');
          return 'Implemented one change.';
        }
        if (options.tools?.some((tool) => tool.name === 'submit_review')) {
          await options.toolHandler!('submit_review', {
            approved: true,
            verdict: 'pass',
            summary: 'Verified the single change against the pinned diff.',
            findings: [],
          });
          return 'Review submitted.';
        }
        if (prompt.includes('External human GitHub Issue request')) {
          await options.toolHandler!('create_task', {
            repoId: base.repo.id,
            title: 'Deliver value two',
            spec: 'Set index export to two.',
            acceptance: ['index export is 2'],
            dependencies: [],
            kind: 'backend',
            complexity: 'normal',
            priority: 0,
          });
          return 'One deliverable accepted.';
        }
        return 'No further action.';
      }
    }
    const engine = new Engine(
      base.store,
      github,
      new Workspaces(join(base.root, 'ws'), base.store),
      base.root,
      () => new Model(),
    );
    const f = {
      async close() {
        await engine.stop();
        base.store.close();
        await rm(base.root, { recursive: true, force: true });
      },
    };
    try {
      await engine.intake.configure(base.repo.id, configuration);
      await engine.intake.refresh(base.repo.id);
      await engine.intake.pump(false);
      const inputId = engine.intake.workflow(base.project.id).inputs[0].input.id;
      const taskId = base.store.list('task').find((task) => task.issueOrigin)?.id;
      assert(taskId);
      await engine.start();
      for (let index = 0; index < 1500; index++) {
        await engine.tick();
        await engine.intake.pump(false);
        if (
          base.store.task(taskId).stage === 'done' &&
          engine.intake.detail(inputId).replies.some((reply) => reply.state.status === 'sent')
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const task = base.store.task(taskId);
      assert.equal(
        task.stage,
        'done',
        JSON.stringify({
          stage: task.stage,
          blocked: task.blocked,
          incidents: base.store.list('incident'),
        }),
      );
      assert.equal(task.completion?.source, 'host');
      assert(
        task.tests.length > 0 &&
          task.tests.every((evidence) => evidence.head === task.head && evidence.exitCode === 0),
      );
      assert(
        task.reviews.some(
          (review) =>
            review.verdict === 'pass' && review.head === task.head && review.base === task.base,
        ),
      );
      assert.equal(task.issue, 12);
      assert.equal(issueCreates, 0);
      assert.equal(issueBody, observation.body);
      assert.equal(issueState, 'closed');
      assert.equal(sourceWrites, 1);
      assert.match(replies[0].html_url, /issues\/12#/);
      assert.equal(engine.intake.detail(inputId).replies[0].state.status, 'sent');
      await engine.sync();
      await engine.intake.pump(false);
      assert.equal(sourceWrites, 1);
      assert.equal(base.store.list('task').filter((item) => item.issueOrigin).length, 1);
    } finally {
      await f.close();
    }
  },
);
