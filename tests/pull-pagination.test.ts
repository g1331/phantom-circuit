import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.ts';
import { GitHub, parsePullPage, type GhResult } from '../src/server/github.ts';
import { command, OUTPUT_LIMIT } from '../src/server/process.ts';
import { FakeGitHub, pullFixture, seedAdapterTask } from './fake-github.ts';

/**
 * A PR listing is read one page per request. These tests exist because the previous read asked
 * `gh api --paginate --slurp` for the whole listing in one response: the process layer caps stdout
 * by dropping its front, so a large listing arrived truncated and a front-truncated JSON document
 * cannot be told apart from a short one. Every case here is about a listing that is only partly
 * readable, and about never letting that read as "there is no PR".
 */

/** Prints a file through a real child process, so the real stdout limit and flag apply. */
const PRINT = 'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))';

class FilePagedGitHub extends GitHub {
  constructor(
    store: Store,
    private dir: string,
  ) {
    super(store);
  }
  override async gh(args: string[], input?: string, timeout?: number): Promise<GhResult> {
    const endpoint = args[1];
    const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1] ?? '1');
    const listing = /[?&]head=/.test(endpoint) ? 'branch' : 'repo';
    const file = join(this.dir, `${listing}-${page}.json`);
    if (!existsSync(file)) return { stdout: '[]', stderr: '', code: 0, truncated: false };
    return command(process.execPath, ['-e', PRINT, file], undefined, undefined, timeout);
  }
}

test('a candidate on the last page is found even though the listing exceeds the output limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phantom-pagination-'));
  const store = new Store(':memory:');
  try {
    const seed = seedAdapterTask(store);
    const marker = `<!-- phantom-task:${seed.task().id} -->`;
    const filler = (n: number) =>
      pullFixture({ number: n, slug: 'example/repo', branch: 'phantom/other', body: 'x'.repeat(60_000) });
    const page = (numbers: number[]) => JSON.stringify(numbers.map(filler));
    const pages = [page([...Array(20).keys()].map((i) => 100 + i)), page([...Array(20).keys()].map((i) => 200 + i))];
    // The related PR is alone on the last page, past two full pages of unrelated ones.
    const last = JSON.stringify([
      pullFixture({ number: 9, slug: 'example/repo', branch: 'phantom/task', body: `${marker}\nSpec\n` }),
    ]);
    pages.forEach((body, i) => writeFileSync(join(dir, `repo-${i + 1}.json`), body));
    writeFileSync(join(dir, 'repo-3.json'), last);
    writeFileSync(join(dir, 'branch-1.json'), '[]');

    // The property that matters: no single response is near the limit, the total is past it.
    const sizes = [...pages, last].map((body) => body.length);
    assert.ok(
      sizes.every((size) => size < OUTPUT_LIMIT),
      `every page fits within the output limit: ${sizes.join(', ')}`,
    );
    assert.ok(
      sizes.reduce((a, b) => a + b, 0) > OUTPUT_LIMIT,
      `the whole listing together exceeds it: ${sizes.reduce((a, b) => a + b, 0)}`,
    );

    // The shape the old read asked for really is truncated by the real process boundary.
    const aggregated = `[${[...pages, last].join(',')}]`;
    writeFileSync(join(dir, 'whole.json'), aggregated);
    const whole = await command(process.execPath, ['-e', PRINT, join(dir, 'whole.json')]);
    assert.equal(whole.truncated, true, 'an aggregated listing exceeds the process output limit');
    assert.throws(() => parsePullPage(whole.stdout), /核对后恢复/);

    // Read page by page, the last page is still reached and its candidate is adopted.
    const github = new FilePagedGitHub(store, dir);
    const found = await github.findTaskPR(seed.task());
    assert.equal(found?.number, 9, 'a last-page candidate survives the process output limit');
    assert.equal(readFileSync(join(dir, 'repo-3.json'), 'utf8'), last, 'the page files are untouched');
  } finally {
    store.close();
  }
});

test('the process output flag reports truncation without changing the cap', async () => {
  const short = await command(process.execPath, ['-e', 'process.stdout.write("a".repeat(1000))']);
  assert.equal(short.truncated, false);
  assert.equal(short.stdout.length, 1000);

  const long = await command(process.execPath, ['-e', `process.stdout.write("a".repeat(${OUTPUT_LIMIT + 5000}))`]);
  assert.equal(long.truncated, true, 'output past the cap is reported, not silently dropped');
  assert.equal(long.stdout.length, OUTPUT_LIMIT, 'the existing cap is unchanged');
  assert.equal(long.stdout.at(-1), 'a', 'the tail is what survives, so a JSON front is lost');
});

test('exhausting the page bound leaves the operation untouched and authorizes nothing', async () => {
  const store = new Store(':memory:');
  try {
    const seed = seedAdapterTask(store);
    const github = new FakeGitHub(store);
    const key = `pr:${seed.task().id}`;
    github.failWrite = new Error('gh (1): gh: Server Error (HTTP 502)');
    await assert.rejects(github.publishPR(seed.task()), /HTTP 502/);
    github.failWrite = undefined;
    const before = store.get('operation', key)!;

    github.endlessPages = true;
    await assert.rejects(github.authorizeTaskPRRetry(seed.task(), 'pm'), /最多 500 页的上限/);
    const after = store.get('operation', key)!;
    assert.equal(after.reconciliation, undefined, 'no absence conclusion was recorded');
    assert.equal(after.status, 'uncertain', 'the unresolved operation is preserved');
    assert.equal(after.error, before.error);
    assert.equal(after.attempt, before.attempt, 'no attempt was spent');
    // The reason and the pages read are kept as durable evidence.
    assert.match(
      store.events().map((e) => e.message).join('\n'),
      /未能完成读取（任务分支 \d+ 页、任务标记 \d+ 页）：已读取 \d+ 页仍未确认末页/,
    );

    await assert.rejects(github.publishPR(seed.task()), /查询未完成|核对后恢复/);
    assert.equal(github.posted.length, 1, 'an unread listing never reaches a creation');
    assert.equal(github.writes, 0);
  } finally {
    store.close();
  }
});

test('exhausting the total time budget leaves the operation untouched and authorizes nothing', async () => {
  const store = new Store(':memory:');
  const realNow = Date.now;
  try {
    const seed = seedAdapterTask(store);
    const github = new FakeGitHub(store);
    const key = `pr:${seed.task().id}`;
    github.failWrite = new Error('gh (1): gh: Server Error (HTTP 502)');
    await assert.rejects(github.publishPR(seed.task()), /HTTP 502/);
    github.failWrite = undefined;
    const before = store.get('operation', key)!;

    // A full page every time, and a clock that jumps past the budget once the scan is under way.
    const full = JSON.stringify(
      [...Array(20).keys()].map((i) =>
        pullFixture({ number: 100 + i, slug: 'example/repo', branch: 'phantom/other' }),
      ),
    );
    let reads = 0;
    let clock = realNow();
    Date.now = () => clock;
    github.readBody = () => {
      if (++reads >= 2) clock += 200_000;
      return full;
    };
    await assert.rejects(github.authorizeTaskPRRetry(seed.task(), 'pm'), /总时限/);
    const after = store.get('operation', key)!;
    assert.equal(after.reconciliation, undefined, 'no absence conclusion was recorded');
    assert.equal(after.attempt, before.attempt, 'no attempt was spent');
    assert.match(
      store.events().map((e) => e.message).join('\n'),
      /达到 120 秒总时限/,
    );
    await assert.rejects(github.publishPR(seed.task()), /查询未完成|核对后恢复/);
    assert.equal(github.posted.length, 1);
  } finally {
    Date.now = realNow;
    store.close();
  }
});
