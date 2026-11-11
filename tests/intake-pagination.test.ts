import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, type GhResult } from '../src/server/github.ts';
import { configuration, intakeFixture, issueObservation } from './intake-fixture.ts';

function paginatedRemote(f: ReturnType<typeof intakeFixture>) {
  const pages: number[] = [];
  let endless = false;
  let truncated = false;
  let missingEditor = false;
  class Remote extends GitHub {
    override async gh(args: string[], input?: string): Promise<GhResult> {
      const endpoint = args[1];
      let result: unknown;
      if (endpoint.includes('/issues?')) {
        const page = Number(new URLSearchParams(endpoint.split('?')[1]).get('page'));
        pages.push(page);
        result = Array.from(
          { length: endless || page === 1 ? 20 : page === 2 ? 1 : 0 },
          (_, index) => ({ number: (page - 1) * 20 + index + 1 }),
        );
      } else if (endpoint === 'graphql') {
        const number = JSON.parse(input!).variables.number;
        result = {
          data: {
            repository: {
              issue: {
                id: `I_${number}`,
                databaseId: number,
                number,
                title: `Issue ${number}`,
                body: '/phantom\nOne request',
                url: `https://github.com/test/repo/issues/${number}`,
                state: 'OPEN',
                createdAt: issueObservation.createdAt,
                updatedAt: issueObservation.updatedAt,
                lastEditedAt: missingEditor ? issueObservation.updatedAt : null,
                author: { databaseId: 7, login: 'human', __typename: 'User' },
                editor: null,
              },
            },
          },
        };
      } else throw new Error(`Unexpected remote call ${endpoint}`);
      return { stdout: JSON.stringify(result), stderr: '', code: 0, truncated };
    }
  }
  return {
    remote: new Remote(f.store),
    pages,
    cap: () => {
      endless = true;
    },
    truncate: () => {
      truncated = true;
    },
    unknownEditor: () => {
      missingEditor = true;
    },
  };
}

test('bounded Issue pagination rejects caps, truncation and unverified editors', async () => {
  const f = intakeFixture();
  try {
    const p = paginatedRemote(f);
    const issues = await p.remote.readIntakeIssues(f.repo, configuration.since);
    assert.equal(issues.length, 21);
    assert.deepEqual(p.pages, [1, 2]);
    p.cap();
    await assert.rejects(p.remote.readIntakeIssues(f.repo, configuration.since), /分页上限/);
    const truncated = paginatedRemote(f);
    truncated.truncate();
    await assert.rejects(truncated.remote.readIntakeIssues(f.repo, configuration.since), /截断/);
    const unknown = paginatedRemote(f);
    unknown.unknownEditor();
    await assert.rejects(
      unknown.remote.readIntakeIssues(f.repo, configuration.since),
      /编辑者证据不可用/,
    );
  } finally {
    await f.close();
  }
});

test('a racing policy change preserves inputs without issuing stale authority', async () => {
  const f = intakeFixture();
  try {
    await f.intake.configure(f.repo.id, configuration);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.github.readIntakeIssues = async () => {
      await blocked;
      return [issueObservation];
    };
    const scan = f.intake.refresh(f.repo.id);
    assert.equal(f.intake.refresh(f.repo.id), scan, 'one source scan at a time');
    await f.intake.configure(f.repo.id, {
      ...configuration,
      expectedVersion: 1,
      enabled: false,
      allowedActors: [],
    });
    release();
    await scan;
    const page = f.intake.workflow(f.project.id);
    assert.equal(page.inputs[0].assessment.policyVersion, 1);
    assert.equal(page.sources[0].health.status, 'not_connected');
    assert.equal(f.intake.dispatchMessage(page.inputs[0].input.id), undefined);
    assert.equal(
      f.intake.detail(page.inputs[0].input.id).assessment.disposition.status,
      'unavailable',
    );
    assert.equal(f.store.list('message').length, 0);
  } finally {
    await f.close();
  }
});

test('native host Issue identity is filtered independently of marker or actor', async () => {
  const f = intakeFixture();
  try {
    await f.intake.configure(f.repo.id, configuration);
    const local = f.store.addMessage(f.project.id, 'user', 'Local implementation', 'implement');
    const task = f.store.createTask({
      projectId: f.project.id,
      repoId: f.repo.id,
      sourceMessageId: local.id,
      title: 'Host created',
      spec: 'Work',
      acceptance: ['Works'],
      dependencies: [],
      kind: 'backend',
      complexity: 'normal',
      priority: 0,
    });
    f.store.updateTask(task.id, {
      issue: 12,
      issueNodeId: issueObservation.nativeId,
      issueDatabaseId: 91,
    });
    f.github.readIntakeIssues = async () => [
      issueObservation,
      {
        ...issueObservation,
        number: 13,
        databaseId: 92,
        nativeId: 'I_human',
        url: 'https://github.com/test/repo/issues/13',
        body: `/phantom\n<!-- phantom-task:${task.id} -->\nReal human request`,
      },
    ];
    await f.intake.refresh(f.repo.id);
    const page = f.intake.workflow(f.project.id);
    assert.equal(
      page.inputs.find((item) => item.input.number === 12)?.assessment.disposition.status,
      'refused',
    );
    const human = page.inputs.find((item) => item.input.number === 13)!;
    assert.equal(human.assessment.disposition.status, 'queued');
    assert.equal(f.intake.dispatchMessage(human.input.id)?.origin?.actor.id, 7);
  } finally {
    await f.close();
  }
});
