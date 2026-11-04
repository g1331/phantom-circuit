import { RefreshCw } from 'lucide-react';
import { ErrorText } from './error-text.tsx';
import { useEffect, useState } from 'react';
import type { AccountAllowance, AgentKind } from '../shared/types.ts';
import { api } from './api.ts';
import { useLocale } from './locale/provider.tsx';

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
      <header className="allowance-head">
        <h3>
          {t('usage.allowance')} · {agent === 'omp' ? 'OMP' : 'Codex'}
        </h3>
        <span className={`allowance-state state-${current?.state ?? 'unknown'}`}>
          {current ? t(`usage.${current.state}`) : t('usage.unknown')}
        </span>
        <button
          className="icon-button"
          disabled={loading}
          aria-label={t('usage.refresh')}
          title={t('usage.refresh')}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={14} className={loading ? 'spinning' : undefined} />
        </button>
      </header>
      {error && (
        <p role="alert" className="check-failed">
          {current && current.state !== 'unknown' && t('usage.stale')} <ErrorText error={error} />
        </p>
      )}
      {current?.stale && !error && <p className="muted">{t('usage.cachedSnapshot')}</p>}
      {current && (
        <dl className="allowance-facts">
          {current.remaining !== undefined && (
            <div>
              <dt>{t('usage.remaining')}</dt>
              <dd>
                {current.currency} {current.remaining}
              </dd>
            </div>
          )}
          {current.resetAt && (
            <div>
              <dt>{t('usage.reset')}</dt>
              <dd>{date(current.resetAt, { dateStyle: 'short', timeStyle: 'short' })}</dd>
            </div>
          )}
          <div>
            <dt>{t('usage.captured')}</dt>
            <dd>{date(current.capturedAt, { dateStyle: 'short', timeStyle: 'short' })}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
