import type {
  CostEstimate,
  PriceCard,
  PriceSnapshot,
  RunUsage,
  UsageAggregate,
} from '../shared/types.ts';

export type UsageMode = 'cumulative' | 'per-run' | 'delta';
export type UsageValues = Omit<RunUsage, 'mode' | 'final'>;

const counters = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cacheWriteTokens',
  'reasoningOutputTokens',
  'totalTokens',
] as const satisfies readonly (keyof UsageValues)[];

const decimalDigitsLimit = 1024;
const decimalExponentLimit = 1024;

function asNonNegative(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function copyValues(value: UsageValues | undefined): UsageValues {
  if (!value) return {};
  const result: UsageValues = {};
  for (const key of [...counters, 'estimatedUsd'] as const) {
    const number = asNonNegative(value[key]);
    if (number !== undefined) result[key] = number;
  }
  const contextWindow = asNonNegative(value.contextWindow);
  if (contextWindow !== undefined) result.contextWindow = contextWindow;
  return result;
}

/**
 * Merge a provider usage update without inventing absent counters. Cumulative provider
 * snapshots are monotonic; per-run/delta values are added to the current Run total.
 */
export function normalizeUsage(
  previous: UsageValues | undefined,
  incoming: UsageValues | undefined,
  mode: UsageMode = 'cumulative',
): UsageValues {
  const before = copyValues(previous);
  const next = copyValues(incoming);
  const result: UsageValues = { ...before };
  for (const key of [...counters, 'estimatedUsd'] as const) {
    const value = next[key];
    if (value === undefined) continue;
    if (mode === 'cumulative') result[key] = Math.max(result[key] ?? 0, value);
    else result[key] = (result[key] ?? 0) + value;
  }
  if (next.contextWindow !== undefined)
    result.contextWindow =
      mode === 'cumulative'
        ? Math.max(result.contextWindow ?? 0, next.contextWindow)
        : (result.contextWindow ?? next.contextWindow);
  return result;
}

export function usageDelta(
  previous: UsageValues | undefined,
  incoming: UsageValues | undefined,
): UsageValues {
  const before = copyValues(previous);
  const next = copyValues(incoming);
  const result: UsageValues = {};
  for (const key of [...counters, 'estimatedUsd'] as const) {
    if (next[key] === undefined) continue;
    result[key] = Math.max(0, next[key]! - (before[key] ?? 0));
  }
  if (next.contextWindow !== undefined) result.contextWindow = next.contextWindow;
  return result;
}

export function aggregateUsage(usages: readonly (UsageValues | undefined)[]): UsageAggregate {
  let result: UsageValues = {};
  let runs = 0;
  for (const usage of usages) {
    if (!usage) continue;
    runs += 1;
    result = normalizeUsage(result, usage, 'per-run');
  }
  return { ...result, ...(runs ? { runs } : {}) };
}

type Decimal = { coefficient: bigint; scale: number };

function decimal(value: string | number | bigint): Decimal {
  if (typeof value === 'bigint') {
    if (value < 0n || value.toString().length > decimalDigitsLimit)
      throw new TypeError(`Invalid decimal: ${String(value)}`);
    return { coefficient: value, scale: 0 };
  }
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0))
    throw new TypeError(`Invalid decimal: ${String(value)}`);
  let text = typeof value === 'number' ? String(value) : value.trim();
  if (!text || !/^\+?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text))
    throw new TypeError(`Invalid decimal: ${String(value)}`);
  const exponentIndex = text.search(/e/i);
  let exponent = 0;
  if (exponentIndex >= 0) {
    exponent = Number(text.slice(exponentIndex + 1));
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > decimalExponentLimit)
      throw new TypeError(`Invalid decimal: ${String(value)}`);
    text = text.slice(0, exponentIndex);
  }
  const [whole, fraction = ''] = text.split('.');
  if (whole.length + fraction.length > decimalDigitsLimit)
    throw new TypeError(`Invalid decimal: ${String(value)}`);
  const digits = `${whole || '0'}${fraction}`.replace(/^0+(?=\d)/, '') || '0';
  if (digits.length > decimalDigitsLimit) throw new TypeError(`Invalid decimal: ${String(value)}`);
  let scale = fraction.length - exponent;
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > decimalExponentLimit)
    throw new TypeError(`Invalid decimal: ${String(value)}`);
  let coefficient = BigInt(digits);
  if (scale < 0) {
    if (digits.length + -scale > decimalDigitsLimit)
      throw new TypeError(`Invalid decimal: ${String(value)}`);
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

function align(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [
    a.coefficient * 10n ** BigInt(scale - a.scale),
    b.coefficient * 10n ** BigInt(scale - b.scale),
    scale,
  ];
}

function format(decimalValue: Decimal): string {
  let coefficient = decimalValue.coefficient;
  const negative = coefficient < 0n;
  if (negative) coefficient = -coefficient;
  let digits = coefficient.toString();
  if (digits.length > decimalDigitsLimit)
    throw new TypeError('Decimal result exceeds supported bounds');
  if (decimalValue.scale) {
    if (decimalValue.scale > decimalExponentLimit)
      throw new TypeError('Decimal result exceeds supported bounds');
    digits = digits.padStart(decimalValue.scale + 1, '0');
    const split = digits.length - decimalValue.scale;
    digits = `${digits.slice(0, split)}.${digits.slice(split)}`.replace(/\.?(\d*?)0+$/, '.$1');
    digits = digits.replace(/\.$/, '');
  }
  if (!digits) digits = '0';
  if (digits === '0') return '0';
  return negative ? `-${digits}` : digits;
}

/** Exact decimal multiplication, used for token-price calculations. */
export function multiplyDecimal(a: string | number | bigint, b: string | number | bigint): string {
  const left = decimal(a);
  const right = decimal(b);
  return format({
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  });
}

function addDecimal(a: string, b: string): string {
  const left = decimal(a);
  const right = decimal(b);
  const [aCoefficient, bCoefficient, scale] = align(left, right);
  return format({ coefficient: aCoefficient + bCoefficient, scale });
}

function rate(price: PriceCard | undefined, name: keyof PriceCard): string | number | undefined {
  if (!price) return undefined;
  const perToken = name.replace(/PerMillion$/, 'PerToken') as keyof PriceCard;
  return price[perToken] ?? price[name];
}

/**
 * Estimate a cost with exact decimal arithmetic. Missing usage/rates remain unknown and are
 * represented by `partial`; this function never turns an absent counter into zero.
 */
export function costForUsage(
  usage: UsageValues | undefined,
  price: PriceCard | PriceSnapshot | undefined,
): CostEstimate | undefined {
  if (!price || !usage || !counters.some((key) => usage[key] !== undefined)) return undefined;
  let amount = '0';
  const coverage: string[] = [];
  let partial = usage.inputTokens === undefined || usage.outputTokens === undefined;
  if (
    usage.inputTokens !== undefined &&
    usage.inputTokens > 0 &&
    (usage.cachedInputTokens === undefined || usage.cacheWriteTokens === undefined)
  )
    partial = true;
  const values = new Map<keyof UsageValues, number | undefined>();
  for (const key of counters)
    if (usage[key] !== undefined) values.set(key, asNonNegative(usage[key]));

  const add = (tokens: number | undefined, priceKey: keyof PriceCard, label: string) => {
    if (tokens === undefined) {
      partial = true;
      return;
    }
    const unit = rate(price, priceKey);
    if (unit === undefined) {
      partial = true;
      return;
    }
    const perToken = price[priceKey.replace(/PerMillion$/, 'PerToken') as keyof PriceCard];
    const tokenPrice = perToken === undefined ? multiplyDecimal(unit, '0.000001') : String(unit);
    amount = addDecimal(amount, multiplyDecimal(tokens, tokenPrice));
    coverage.push(label);
  };

  const input = values.get('inputTokens');
  const cached = values.get('cachedInputTokens');
  const cacheWrite = values.get('cacheWriteTokens');
  if (usage.inputTokens !== undefined) {
    if (input === undefined) partial = true;
    else
      add(Math.max(0, input - (cached ?? 0) - (cacheWrite ?? 0)), 'inputPerMillion', 'inputTokens');
  }
  if (usage.cachedInputTokens !== undefined)
    add(cached, 'cachedInputPerMillion', 'cachedInputTokens');
  if (usage.cacheWriteTokens !== undefined)
    add(cacheWrite, 'cacheWritePerMillion', 'cacheWriteTokens');
  if (usage.outputTokens !== undefined)
    add(values.get('outputTokens'), 'outputPerMillion', 'outputTokens');
  // Reasoning tokens are included in outputTokens by the provider contract. They are
  // retained for display but must never be charged as a second output category.
  if (usage.reasoningOutputTokens !== undefined && usage.outputTokens === undefined) partial = true;
  if (!coverage.length) partial = true;
  return {
    amount,
    currency: price.currency,
    partial: partial || ('partial' in price && price.partial === true),
    coverage,
    ...(price.source ? { source: price.source } : {}),
  };
}

export function aggregateCost(
  costs: readonly (CostEstimate | undefined)[],
): CostEstimate | undefined {
  const aggregates = aggregateCosts(costs);
  return aggregates.length === 1 ? aggregates[0] : undefined;
}

/** Aggregate estimates without discarding amounts when providers use currencies. */
export function aggregateCosts(costs: readonly (CostEstimate | undefined)[]): CostEstimate[] {
  const groups = new Map<string, CostEstimate>();
  const missing = costs.some((cost) => !cost);
  for (const cost of costs) {
    if (!cost) continue;
    const previous = groups.get(cost.currency);
    if (!previous) {
      groups.set(cost.currency, {
        amount: cost.amount,
        currency: cost.currency,
        partial: cost.partial || missing,
        ...(cost.coverage?.length ? { coverage: [...new Set(cost.coverage)] } : {}),
      });
      continue;
    }
    previous.amount = addDecimal(previous.amount, cost.amount);
    previous.partial ||= cost.partial;
    if (cost.coverage?.length)
      previous.coverage = [...new Set([...(previous.coverage ?? []), ...cost.coverage])];
  }
  return [...groups.values()];
}

export class UsageAccumulator {
  private value_: UsageValues = {};
  private frozen_ = false;

  update(usage: UsageValues | undefined, mode: UsageMode = 'cumulative'): UsageValues {
    if (this.frozen_) return this.snapshot();
    this.value_ = normalizeUsage(this.value_, usage, mode);
    return this.snapshot();
  }

  freeze(): UsageValues {
    this.frozen_ = true;
    return this.snapshot();
  }

  get frozen() {
    return this.frozen_;
  }

  snapshot(): UsageValues {
    return { ...this.value_ };
  }
}
