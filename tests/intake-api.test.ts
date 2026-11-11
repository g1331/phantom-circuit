import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.ts';
import { Previews } from '../src/server/preview.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { configuration, intakeFixture, issueObservation } from './intake-fixture.ts';
import type { WorkflowPage, WorkflowInputDetail } from '../src/shared/intake.ts';

test('workflow API bounds bodies and keeps CSRF and policy-version gates', async () => {
  const f = intakeFixture();
  const app = createApp(
    f.store,
    f.engine,
    new Previews(f.store, new Workspaces('/unused', f.store)),
  );
  try {
    const session = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
    const headers = {
      host: '127.0.0.1:4317',
      cookie: String(session.headers['set-cookie']).split(';')[0],
    };
    const auth = { ...headers, 'x-phantom-csrf': session.json().csrf };
    const sourceUrl = `/api/repos/${f.repo.id}/intake`;
    assert.equal(
      (await app.inject({ method: 'PUT', url: sourceUrl, headers, payload: configuration }))
        .statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method: 'PUT', url: sourceUrl, headers: auth, payload: configuration }))
        .statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ method: 'PUT', url: sourceUrl, headers: auth, payload: configuration }))
        .statusCode,
      409,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: `${sourceUrl}/refresh`, headers: auth })).statusCode,
      200,
    );
    const page = (
      await app.inject({ url: `/api/projects/${f.project.id}/workflow?limit=1`, headers })
    ).json<WorkflowPage>();
    assert.equal(page.inputs.length, 1);
    assert.equal(page.sources.length, 1);
    assert(!('body' in page.inputs[0].input));
    const inputId = page.inputs[0].input.id;
    const detail = (
      await app.inject({ url: `/api/inputs/${inputId}`, headers })
    ).json<WorkflowInputDetail>();
    assert.equal(detail.input.body, issueObservation.body);
    assert.equal(detail.assessment.disposition.status, 'queued');
    assert.equal(
      (await app.inject({ method: 'POST', url: `/api/inputs/${inputId}/retry`, headers: auth }))
        .statusCode,
      409,
    );
    assert.equal(
      (await app.inject({ url: `/api/projects/${f.project.id}/workflow?limit=5000`, headers }))
        .statusCode,
      400,
    );
    const sourceMessage = f.intake.dispatchMessage(inputId)!;
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/projects/${f.project.id}/messages`,
          headers: auth,
          payload: { content: 'Forged', intent: 'implement', origin: sourceMessage.origin },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/messages/${sourceMessage.id}/retry`,
          headers: auth,
        })
      ).statusCode,
      404,
    );
    const snapshot = (await app.inject({ url: '/api/state', headers })).json();
    assert.equal(
      snapshot.messages.find((message: { id: string }) => message.id === sourceMessage.id).content,
      '',
    );
    assert(!JSON.stringify(snapshot).includes(issueObservation.body));
    const answer = 'Full answer. '.repeat(700);
    f.intake.noAction(sourceMessage.id, answer);
    const compact = (
      await app.inject({ url: `/api/projects/${f.project.id}/workflow`, headers })
    ).json<WorkflowPage>();
    assert.equal(compact.inputs[0].replies.length, 1);
    assert(!('body' in compact.inputs[0].replies[0]), 'reply bodies load only with input details');
    const expanded = (
      await app.inject({ url: `/api/inputs/${inputId}`, headers })
    ).json<WorkflowInputDetail>();
    assert(expanded.replies[0].body.startsWith(answer));
    const relatedUrl = `/api/projects/${f.project.id}/workflow/inputs?ids=${inputId}`;
    const relatedResponse = await app.inject({ url: relatedUrl, headers });
    assert.equal(relatedResponse.statusCode, 200);
    const related = relatedResponse.json<WorkflowPage['inputs']>();
    assert.equal(related[0].input.id, inputId);
    assert.equal(related[0].assessment.disposition.status, 'no_action');
    assert.equal(related[0].replies[0].state.status, 'queued');
    assert(!('body' in related[0].input));
    assert(!('body' in related[0].replies[0]));
    const other = f.store.createProject('Other input scope', '');
    assert.deepEqual(
      (
        await app.inject({
          url: `/api/projects/${other.id}/workflow/inputs?ids=${inputId}`,
          headers,
        })
      ).json(),
      [],
    );
    assert.equal(
      (await app.inject({ url: relatedUrl.replace(inputId, ''), headers })).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: relatedUrl.replace(inputId, Array(51).fill(inputId).join(',')),
          headers,
        })
      ).statusCode,
      400,
    );
  } finally {
    await app.close();
    await f.close();
  }
});

test('an existing receiving source can be disabled while GitHub is unreachable', async () => {
  const f = intakeFixture();
  try {
    await f.intake.configure(f.repo.id, configuration);
    f.github.resolveIntakeActor = async () => {
      throw new Error('GitHub is unreachable');
    };
    const disabled = await f.intake.configure(f.repo.id, {
      ...configuration,
      enabled: false,
      expectedVersion: 1,
    });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.allowedActors[0].id, 7);
  } finally {
    await f.close();
  }
});

test('unconfigured sources stay empty and paged inputs retain assessments', async () => {
  const f = intakeFixture();
  try {
    assert.deepEqual(f.intake.workflow(f.project.id).sources, []);
    await f.intake.configure(f.repo.id, configuration);
    await f.intake.refresh(f.repo.id);
    f.edit({ databaseId: 7, login: 'human', __typename: 'User' }, '/phantom\nSecond revision');
    await f.intake.refresh(f.repo.id);
    const first = f.intake.workflow(f.project.id, undefined, 1);
    assert(first.next);
    const second = f.intake.workflow(f.project.id, first.next, 1);
    assert.equal(second.inputs.length, 1);
    assert.equal(second.next, undefined);
    assert.notEqual(first.inputs[0].input.id, second.inputs[0].input.id);
    assert.equal(second.inputs[0].assessment.inputId, second.inputs[0].input.id);
  } finally {
    await f.close();
  }
});
