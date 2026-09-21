import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commitMessage,
  engineeringMetadata,
  engineeringTitle,
  expectedTaskBranch,
  pullRequestBody,
  taskBranch,
} from '../src/server/task-naming.ts';

const named = {
  id: '12345678-abcd-4abc-9abc-1234567890ab',
  title: '支持图片附件',
  issue: 38,
  spec: '完整需求不应被复制到新 PR。',
  tests: [{ command: 'npm test', exitCode: 0, output: '', head: 'head', at: 'now' }],
  changeType: 'feat',
  scope: 'pm-image',
  summaryEn: 'support image attachments',
};

test('engineering metadata produces one stable branch, commit title and concise PR body', () => {
  assert.deepEqual(engineeringMetadata(named), {
    changeType: 'feat',
    scope: 'pm-image',
    summaryEn: 'support image attachments',
  });
  assert.equal(taskBranch(named), 'phantom/feat/pm-image-12345678');
  assert.equal(engineeringTitle(named), 'feat(pm-image): support image attachments');
  assert.equal(
    commitMessage(named),
    'feat(pm-image): support image attachments\n\nTask: 12345678-abcd-4abc-9abc-1234567890ab\nIssue: #38',
  );
  const body = pullRequestBody(named);
  assert.match(body, /^<!-- phantom-task:12345678-abcd-4abc-9abc-1234567890ab -->/);
  assert.match(body, /## Problem\n支持图片附件/);
  assert.match(body, /## Result\nsupport image attachments/);
  assert.match(body, /## Validation\n- npm test: exit 0/);
  assert.match(body, /## Limitations\nNone recorded\./);
  assert.match(body, /Closes #38/);
  assert.doesNotMatch(body, /完整需求不应被复制/);
});

test('legacy task branch assignments are preserved exactly', () => {
  const legacy = { id: 'task-id', branch: 'phantom/old-custom-branch' };
  assert.equal(expectedTaskBranch(legacy), legacy.branch);
  assert.equal(taskBranch({ id: legacy.id }), 'phantom/task-id');
  assert.throws(
    () => expectedTaskBranch({ ...legacy, changeType: 'feat', scope: 'pm', summaryEn: 'new name' }),
    /命名契约/,
  );
});

test('partial or unsafe engineering metadata is rejected instead of falling back to legacy naming', () => {
  assert.throws(() => taskBranch({ id: 'task-id', changeType: 'fix', scope: 'api' }), /summaryEn/);
  assert.throws(
    () =>
      taskBranch({ id: 'task-id', changeType: 'feat', scope: 'API' as string, summaryEn: 'fix' }),
    /scope/,
  );
  assert.throws(
    () => taskBranch({ id: 'task-id', changeType: 'perf', scope: 'api', summaryEn: 'fix' }),
    /changeType/,
  );
});
