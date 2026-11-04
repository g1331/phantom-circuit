import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fault } from '../src/server/store.ts';
import { fixture } from './finalization-fixture.ts';

test('a configured model the provider no longer lists goes to the user, not to a liaison assessment', async (t) => {
  const f = await fixture(t, async () => {
    throw new Fault('模型不可用：retired-model', 409, {
      code: 'model_unavailable',
      params: { model: 'retired-model' },
    });
  });
  const task = await f.run();

  const incidents = (f.store.snapshot().incidents ?? []).filter((i) => i.taskId === task.id);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].status, 'waiting_user');
  assert.match(incidents[0].message, /retired-model/);
  assert.match(incidents[0].message, /设置/, 'the user is told where to change it');
  assert.equal(
    f.store.snapshot().runs.filter((r) => r.role === 'pm' && r.incidentId).length,
    0,
    'the liaison cannot change settings, so no assessment turn is spent',
  );
  assert.equal(task.control, 'paused');
  assert.equal(task.retries, 0, 'a settings problem is not a rework round');
});
