import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateCost,
  aggregateCosts,
  costForUsage,
  multiplyDecimal,
  normalizeUsage,
  UsageAccumulator,
} from '../src/server/usage.ts';

test('usage snapshots are monotonic and preserve absent counters', () => {
  assert.deepEqual(
    normalizeUsage({ inputTokens: 10 }, { inputTokens: 8, outputTokens: 3 }, 'cumulative'),
    { inputTokens: 10, outputTokens: 3 },
  );
  assert.deepEqual(normalizeUsage({ inputTokens: 10 }, { inputTokens: 2 }, 'per-run'), {
    inputTokens: 12,
  });
  const accumulator = new UsageAccumulator();
  accumulator.update({ inputTokens: 4 });
  accumulator.freeze();
  assert.deepEqual(accumulator.update({ inputTokens: 99, outputTokens: 1 }), { inputTokens: 4 });
});

test('exact decimal pricing handles sub-cent rates without floating point drift', () => {
  assert.equal(multiplyDecimal('0.000001', 5), '0.000005');
  assert.deepEqual(
    costForUsage(
      { inputTokens: 1500, outputTokens: 2 },
      {
        currency: 'USD',
        inputPerMillion: '1.25',
        outputPerMillion: '2',
      },
    ),
    {
      amount: '0.001879',
      currency: 'USD',
      partial: true,
      coverage: ['inputTokens', 'outputTokens'],
    },
  );
});

test('unknown pricing and currency mismatches remain partial instead of inventing zeros', () => {
  assert.equal(costForUsage(undefined, { currency: 'USD', inputPerMillion: '1' }), undefined);
  assert.equal(
    costForUsage({ inputTokens: 10 }, { currency: 'USD', outputPerMillion: '1' })?.partial,
    true,
  );
  assert.deepEqual(
    aggregateCost([
      { amount: '1.20', currency: 'USD', partial: false },
      { amount: '0.05', currency: 'USD', partial: false },
    ]),
    { amount: '1.25', currency: 'USD', partial: false },
  );
});

test('inclusive input and reasoning usage are priced once per canonical category', () => {
  assert.deepEqual(
    costForUsage(
      {
        inputTokens: 100,
        cachedInputTokens: 40,
        cacheWriteTokens: 10,
        outputTokens: 20,
        reasoningOutputTokens: 10,
      },
      {
        currency: 'USD',
        inputPerMillion: '1',
        cachedInputPerMillion: '0.1',
        cacheWritePerMillion: '2',
        outputPerMillion: '2',
        reasoningOutputPerMillion: '100',
      },
    ),
    {
      amount: '0.000114',
      currency: 'USD',
      partial: false,
      coverage: ['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens'],
    },
  );
});

test('unknown usage and pricing stay partial, while zero usage remains exact', () => {
  assert.equal(
    costForUsage({ inputTokens: 10 }, { currency: 'USD', inputPerMillion: '1' })?.partial,
    true,
  );
  assert.equal(
    costForUsage({ inputTokens: 0, outputTokens: 0 }, { currency: 'USD' })?.partial,
    true,
  );
  assert.deepEqual(
    costForUsage(
      { inputTokens: 0, outputTokens: 0 },
      {
        currency: 'USD',
        inputPerMillion: '1',
        outputPerMillion: '2',
      },
    ),
    {
      amount: '0',
      currency: 'USD',
      partial: false,
      coverage: ['inputTokens', 'outputTokens'],
    },
  );
  assert.equal(costForUsage(undefined, { currency: 'USD', inputPerMillion: '1' }), undefined);
  assert.deepEqual(
    aggregateCosts([
      { amount: '1.20', currency: 'USD', partial: false },
      { amount: '0.05', currency: 'USD', partial: true },
      { amount: '2', currency: 'EUR', partial: false },
      undefined,
    ]),
    [
      { amount: '1.25', currency: 'USD', partial: true },
      { amount: '2', currency: 'EUR', partial: true },
    ],
  );
  assert.equal(
    aggregateCost([
      { amount: '1', currency: 'USD', partial: false },
      { amount: '2', currency: 'EUR', partial: false },
    ]),
    undefined,
  );
});

test('decimal arithmetic rejects negative, non-finite, and oversized values before BigInt work', () => {
  assert.throws(() => multiplyDecimal('-1', '2'), /Invalid decimal/);
  assert.throws(() => multiplyDecimal(Infinity, '2'), /Invalid decimal/);
  assert.throws(() => multiplyDecimal('1e1000000', '2'), /Invalid decimal/);
  assert.throws(() => multiplyDecimal('9'.repeat(1025), '2'), /Invalid decimal/);
});
