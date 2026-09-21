import { ErrorText } from './error-text.tsx';
import { useEffect, useState } from 'react';
import type {
  AccountAllowance,
  AgentKind,
  CostEstimate,
  PriceSnapshot,
  Run,
  RunUsage,
  UsageAggregate,
} from '../shared/types.ts';
import { api } from './api.ts';
import { useLocale } from './locale/provider.tsx';

const tokenFields = {
  inputTokens: 'usage.input',
  outputTokens: 'usage.output',
  cachedInputTokens: 'usage.cached',
  cacheWriteTokens: 'usage.cacheWrite',
  reasoningOutputTokens: 'usage.reasoning',
  totalTokens: 'usage.total',
} as const;
const priceFields = {
  inputPerMillion: 'prices.input',
  outputPerMillion: 'prices.output',
  cachedInputPerMillion: 'prices.cached',
  cacheWritePerMillion: 'prices.cacheWrite',
  reasoningOutputPerMillion: 'prices.reasoning',
  inputPerToken: 'prices.inputToken',
  outputPerToken: 'prices.outputToken',
  cachedInputPerToken: 'prices.cachedToken',
  cacheWritePerToken: 'prices.cacheWriteToken',
  reasoningOutputPerToken: 'prices.reasoningToken',
} as const;
function PriceDetails({ price }: { price: PriceSnapshot }) {
  const { t, date } = useLocale();
  return (
    <>
      <p>
        {t('prices.currency')}: {price.currency}
      </p>
      <dl className="usage-grid">
        {Object.entries(priceFields)
          .filter(([key]) => price[key as keyof typeof priceFields] !== undefined)
          .map(([key, label]) => (
            <div key={key}>
              <dt>{t(label)}</dt>
              <dd>{String(price[key as keyof typeof priceFields])}</dd>
            </div>
          ))}
        <div>
          <dt>{t('usage.priceVersion')}</dt>
          <dd>{price.version ?? t('usage.unknown')}</dd>
        </div>
        <div>
          <dt>{t('usage.priceSource')}</dt>
          <dd>{price.source ?? t('usage.unknown')}</dd>
        </div>
      </dl>
      <p>
        {t('usage.captured')}:{' '}
        {price.capturedAt
          ? date(price.capturedAt, { dateStyle: 'short', timeStyle: 'medium' })
          : t('usage.unknown')}
      </p>
    </>
  );
}
function UsageValues({
  usage,
  cost,
  costs,
}: {
  usage?: RunUsage | UsageAggregate;
  cost?: CostEstimate;
  costs?: CostEstimate[];
}) {
  const { t, number } = useLocale();
  const estimates = costs ?? (cost ? [cost] : []);
  return (
    <>
      <dl className="usage-grid">
        {Object.entries(tokenFields).map(([field, label]) => (
          <div key={field}>
            <dt>{t(label)}</dt>
            <dd>
              {usage?.[field as keyof typeof tokenFields] === undefined
                ? t('usage.unknown')
                : number(usage[field as keyof typeof tokenFields]!)}
            </dd>
          </div>
        ))}
      </dl>
      {usage?.estimatedUsd !== undefined && (
        <p>
          {t('usage.actual')}: USD {number(usage.estimatedUsd, { maximumSignificantDigits: 15 })}
        </p>
      )}
      {!estimates.length && (
        <p>
          {t('usage.estimated')}: {t('usage.unknown')}
        </p>
      )}
      {estimates.map((cost) => (
        <div key={cost.currency}>
          <p>
            {t('usage.estimated')}: {cost.currency} {cost.amount}
          </p>
          <p className="muted">{t(cost.partial ? 'usage.partial' : 'usage.complete')}</p>
          {!!cost.coverage?.length && (
            <p>
              {t('usage.coverage')}:{' '}
              {cost.coverage
                .map((field) =>
                  field in tokenFields ? t(tokenFields[field as keyof typeof tokenFields]) : field,
                )
                .join(', ')}
            </p>
          )}
        </div>
      ))}
    </>
  );
}

export function RunRecord({ run, cost }: { run: Run; cost?: CostEstimate }) {
  const { t, date, duration, number } = useLocale();
  const identity = run.modelIdentity ?? run.model;
  return (
    <details className="run-record">
      <summary>
        {t('usage.run')} · {run.agentKind ?? identity?.agentKind ?? t('usage.unknown')} ·{' '}
        {identity?.model ?? run.profileConfig?.model ?? t('usage.unknown')}
      </summary>
      <dl className="usage-grid">
        <div>
          <dt>{t('runtime.provider')}</dt>
          <dd>{identity?.providerId ?? run.provider?.id ?? t('usage.unknown')}</dd>
        </div>
        <div>
          <dt>{t('ui.reasoningEffort')}</dt>
          <dd>{identity?.effort ?? run.profileConfig?.effort ?? t('usage.unknown')}</dd>
        </div>
        <div>
          <dt>{t('usage.version')}</dt>
          <dd>{run.agentVersion ?? identity?.agentVersion ?? t('usage.unknown')}</dd>
        </div>
        <div>
          <dt>{t('usage.profileVersion')}</dt>
          <dd>{run.profileVersion ?? t('usage.unknown')}</dd>
        </div>
        <div>
          <dt>{t('usage.contextWindow')}</dt>
          <dd>
            {run.usage?.contextWindow === undefined
              ? t('usage.unknown')
              : number(run.usage.contextWindow)}
          </dd>
        </div>
      </dl>
      <p>
        {date(run.startedAt, { dateStyle: 'short', timeStyle: 'medium' })}
        {run.endedAt && <> → {date(run.endedAt, { dateStyle: 'short', timeStyle: 'medium' })}</>}
      </p>
      <p>
        {t('usage.duration')}:{' '}
        {run.durationMs === undefined ? t('usage.unknown') : duration(run.durationMs / 1000)}
      </p>
      <p>
        {t('usage.elapsed')}:{' '}
        {run.endedAt
          ? duration((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000)
          : t('delivery.running')}
      </p>
      <UsageValues usage={run.usage} cost={cost} />
      <details>
        <summary>{t('usage.priceSnapshot')}</summary>
        {(run.priceSnapshot ?? run.price) ? (
          <PriceDetails price={(run.priceSnapshot ?? run.price)!} />
        ) : (
          <p>{t('usage.unknown')}</p>
        )}
      </details>
    </details>
  );
}

type TaskUsageResult = {
  usage?: UsageAggregate;
  cost?: CostEstimate;
  costs?: CostEstimate[];
  runCosts?: Record<string, CostEstimate | undefined>;
  runs?: Run[];
  coverage?: { available: number; total: number };
  durationMs?: number;
  elapsedMs?: number | null;
};
export function TaskUsagePanel({ taskId, revision }: { taskId: string; revision: string }) {
  const { t, duration } = useLocale();
  const [result, setResult] = useState<TaskUsageResult>();
  const [error, setError] = useState<string | Error>('');
  useEffect(() => {
    let current = true;
    setError('');
    void api<TaskUsageResult>(`/tasks/${taskId}/usage`)
      .then((result) => {
        if (current) setResult(result);
      })
      .catch((error) => {
        if (current) setError(error instanceof Error ? error : String(error));
      });
    return () => {
      current = false;
    };
  }, [taskId, revision]);
  return (
    <section className="usage-panel" aria-label={t('usage.title')}>
      <h3>{t('usage.title')}</h3>
      {error && <p role="alert">{<ErrorText error={error} />}</p>}
      <UsageValues usage={result?.usage} cost={result?.cost} costs={result?.costs} />
      {result?.coverage && <p>{t('usage.coverageCount', result.coverage)}</p>}
      <p>
        {t('usage.duration')}:{' '}
        {result?.durationMs === undefined ? t('usage.unknown') : duration(result.durationMs / 1000)}
      </p>
      <p>
        {t('usage.elapsed')}:{' '}
        {result?.elapsedMs == null ? t('usage.unknown') : duration(result.elapsedMs / 1000)}
      </p>
      {result?.runs?.map((run) => (
        <RunRecord key={run.id} run={run} cost={result.runCosts?.[run.id]} />
      ))}
    </section>
  );
}

export function AllowancePanel({ agent, providerId }: { agent: AgentKind; providerId: string }) {
  const { t, date } = useLocale();
  const [allowance, setAllowance] = useState<
    AccountAllowance & { stale?: boolean; error?: string }
  >();
  const [error, setError] = useState<string | Error>('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    void api<AccountAllowance & { stale?: boolean; error?: string }>(
      `/agents/${agent}/allowance?providerId=${encodeURIComponent(providerId)}${refresh ? '&force=1' : ''}`,
    )
      .then((result) => {
        if (current) {
          setAllowance(result);
          if (result.error) setError(result.error);
        }
      })
      .catch((error) => {
        if (current) setError(error instanceof Error ? error : String(error));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [agent, providerId, refresh]);
  const current =
    allowance?.agentKind === agent && allowance.providerId === providerId ? allowance : undefined;
  return (
    <section className="allowance-panel" aria-label={t('usage.allowance')}>
      <h3>
        {t('usage.allowance')} · {agent.toUpperCase()}
      </h3>
      <button
        className="text-button"
        disabled={loading}
        onClick={() => setRefresh((value) => value + 1)}
      >
        {t('usage.refresh')}
      </button>
      {error && (
        <p role="alert">
          {current && current.state !== 'unknown' && t('usage.stale')} <ErrorText error={error} />
        </p>
      )}
      <p>{current ? t(`usage.${current.state}`) : t('usage.unknown')}</p>
      {current?.stale && !error && <p className="muted">{t('usage.cachedSnapshot')}</p>}
      {current?.remaining !== undefined && (
        <p>
          {t('usage.remaining')}: {current.currency} {current.remaining}
        </p>
      )}
      {current && (
        <p>
          {t('usage.captured')}:{' '}
          {date(current.capturedAt, { dateStyle: 'short', timeStyle: 'medium' })}
        </p>
      )}
      {current?.resetAt && (
        <p>
          {t('usage.reset')}: {date(current.resetAt, { dateStyle: 'short', timeStyle: 'medium' })}
        </p>
      )}
    </section>
  );
}
