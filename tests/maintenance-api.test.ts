import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/server/app.ts';
import { Previews } from '../src/server/preview.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import { intakeFixture } from './intake-fixture.ts';

test('maintenance HTTP keeps CSRF, schema, version and repository boundaries', async () => {
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
    const url = `/api/repos/${f.repo.id}/maintenance`;
    const payload = {
      expectedVersion: 0,
      name: 'Docs',
      kind: 'issue',
      selector: 'docs',
      minimumAgeMinutes: 60,
      scope: 'Documentation',
    };
    assert.equal(
      (await app.inject({ method: 'POST', url: `${url}/rules`, headers, payload })).statusCode,
      403,
    );
    const saved = await app.inject({ method: 'POST', url: `${url}/rules`, headers: auth, payload });
    assert.equal(saved.statusCode, 200);
    const rule = saved.json();
    assert.equal(rule.mode, 'observe');
    const ruleUrl = `${url}/rules/${rule.ruleId}`;
    assert.equal(
      (await app.inject({ method: 'PUT', url: ruleUrl, headers: auth, payload })).statusCode,
      409,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: ruleUrl,
          headers: auth,
          payload: { ...payload, expectedVersion: 1, author: 'team' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: ruleUrl,
          headers: auth,
          payload: { ...payload, expectedVersion: 1, mode: 'off' },
        })
      ).statusCode,
      200,
    );
    const page = (await app.inject({ url, headers })).json();
    assert.equal(page.rules[0].version, 2);
    const history = (await app.inject({ url: `${ruleUrl}/history`, headers })).json();
    assert.equal(history.versions.length, 2);
    assert.equal(page.automaticExecutionAvailable, false);
    assert.equal(
      (await app.inject({ method: 'POST', url: `${url}/refresh`, headers: auth })).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: `${url}/observations/missing`, headers })).statusCode,
      404,
    );
    const other = f.store.createRepo({
      projectId: f.project.id,
      name: 'Other',
      path: '/other',
      github: 'test/other',
      defaultBranch: 'main',
      authorized: true,
    });
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/repos/${other.id}/maintenance/rules/${rule.ruleId}`,
          headers: auth,
          payload: { ...payload, expectedVersion: 2 },
        })
      ).statusCode,
      404,
    );
    assert.deepEqual(f.writes, []);
  } finally {
    await app.close();
    await f.close();
  }
});
