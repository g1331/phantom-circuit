import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, routeHref, type Route } from '../src/web/route.ts';

test('every page round-trips through its hash, and unknown hashes fall back to home', () => {
  const routes: Route[] = [
    { page: 'home', projectId: 'p 1' },
    { page: 'home', projectId: 'p1', view: 'question/1' },
    { page: 'brief', projectId: 'p1' },
    { page: 'work', projectId: 'p1' },
    { page: 'task', projectId: 'p1', taskId: 't/1' },
    { page: 'task', projectId: 'p1', taskId: 't1', view: 'process' },
    { page: 'team', projectId: 'p1' },
    { page: 'project', projectId: 'p1' },
    { page: 'project', projectId: 'p1', view: 'runs' },
  ];
  for (const route of routes) assert.deepEqual(parseRoute(routeHref(route)), route);
  assert.deepEqual(parseRoute(''), { page: 'home' });
  assert.deepEqual(parseRoute('#/p/p1/nonsense'), { page: 'home', projectId: 'p1' });
  assert.equal(routeHref({ page: 'work' }), '#/');
  // Sections belong to the task and project pages only.
  assert.deepEqual(parseRoute('#/p/p1/team/extra'), { page: 'team', projectId: 'p1' });
});

test('malformed URL encoding falls back to home without throwing', () => {
  for (const hash of ['#/p/%', '#/p/p1/work/%E0%A4%A', '#/p/p1/requests/%FF']) {
    assert.deepEqual(parseRoute(hash), { page: 'home' });
  }
});
