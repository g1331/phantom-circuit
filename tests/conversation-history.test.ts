import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';

test('conversation pages stay bounded and stable across timestamp ties and new arrivals', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject('History', '');
    const other = store.createProject('Other', '');
    const expected: string[] = [];
    for (let index = 0; index < 1003; index++) {
      const message = store.addMessage(project.id, 'user', `message ${index}`);
      store.put('message', message.id, { ...message, createdAt: '2026-01-01T00:00:00.000Z' });
      expected.push(message.id);
    }
    store.addMessage(other.id, 'user', 'private to other project');
    let page = store.conversationPage(project.id);
    assert.equal(page.entries.length, 50);
    assert.equal(page.hasAfter, false);
    const seen = page.entries.map((entry) => entry.value.id);
    const arrival = store.addMessage(project.id, 'assistant', 'arrived during pagination');
    store.put('message', arrival.id, { ...arrival, createdAt: '2026-01-01T00:00:00.000Z' });
    while (page.hasBefore) {
      page = store.conversationPage(project.id, { before: page.entries[0]!.cursor });
      assert.ok(page.entries.length <= 50);
      seen.unshift(...page.entries.map((entry) => entry.value.id));
    }
    assert.deepEqual(seen, expected);
    assert.equal(new Set(seen).size, 1003);
    assert.equal(store.conversationPage(project.id).entries.at(-1)?.cursor, arrival.id);
    const forward = store.conversationPage(project.id, { after: page.entries.at(-1)!.cursor });
    assert.deepEqual(
      forward.entries.map((entry) => entry.value.id),
      expected.slice(3, 53),
    );
    assert.throws(() => store.conversationPage(other.id, { before: page.entries[0]!.cursor }));
    const bounded = store.snapshot({ conversation: 'bounded' });
    assert.deepEqual(bounded.messages, []);
    assert.deepEqual(bounded.activities, []);
    assert.equal(store.snapshot().messages.length, 1005);
  } finally {
    store.close();
  }
});

test('message and activity paging share durable legacy tie order and scoped refreshes', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject('Mixed history', '');
    const other = store.createProject('Other', '');
    const run = store.run('pm', project.id, 'pm');
    const expected: string[] = [];
    const at = '2026-01-01T00:00:00.000Z';
    for (let index = 0; index < 63; index++) {
      const message = store.addMessage(project.id, 'assistant', `body ${index}`);
      store.put('message', message.id, { ...message, createdAt: at, timelineOrder: undefined });
      expected.push(message.id);
      if (index % 2 === 0) {
        const activity = store.activity(run, `activity-${index}`, {
          kind: 'summary',
          title: `activity ${index}`,
          status: 'completed',
          startedAt: at,
        });
        store.put('activity', activity.id, { ...activity, timelineOrder: undefined });
        expected.push(activity.id);
      }
    }
    const last = store.conversationPage(project.id);
    const first = store.conversationPage(project.id, { before: last.entries[0]!.cursor });
    assert.deepEqual(
      [...first.entries, ...last.entries].map((entry) => entry.cursor),
      expected,
    );
    const ids = last.entries.map((entry) => entry.cursor);
    store.updateMessage(expected[0]!, { content: 'updated queued reply', status: 'completed' });
    const refreshed = store.conversationPage(project.id, {
      ids: [expected[0]!, ...ids.slice(0, 49)],
    });
    assert.equal(refreshed.entries.length, 50);
    const changed = refreshed.entries[0]!;
    assert.equal(changed.kind, 'message');
    if (changed.kind === 'message') assert.equal(changed.value.content, 'updated queued reply');
    assert.throws(() => store.conversationPage(other.id, { ids }), /跨项目操作被拒绝/);
    assert.throws(() => store.conversationPage(project.id, { ids: Array(51).fill(expected[0]) }));
    assert.equal(store.snapshot().activities.length, 32);
  } finally {
    store.close();
  }
});
