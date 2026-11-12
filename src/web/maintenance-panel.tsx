import { useEffect, useState } from 'react';
import type { MaintenancePage } from '../shared/maintenance.ts';
import { api } from './api.ts';
import { useLocale } from './locale/provider.tsx';
import { useWhen } from './work-list.tsx';
import { MaintenanceRuleForm } from './maintenance-rule-form.tsx';
import { MaintenanceObservationRow } from './maintenance-observation.tsx';
import { MaintenanceHistory } from './maintenance-history.tsx';

export function MaintenancePanel({ repoId }: { repoId: string }) {
  const { t, host } = useLocale();
  const when = useWhen();
  const [page, setPage] = useState<MaintenancePage>();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api<MaintenancePage>(`/repos/${repoId}/maintenance`, undefined, 'GET', controller.signal)
      .then(setPage)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(String(cause));
      });
    return () => controller.abort();
  }, [repoId]);
  async function load(refresh = false, before?: string) {
    setBusy(true);
    try {
      setPage(
        await api<MaintenancePage>(
          `/repos/${repoId}/maintenance${
            refresh ? '/refresh' : before ? `?before=${encodeURIComponent(before)}` : ''
          }`,
          refresh ? {} : undefined,
          refresh ? 'POST' : 'GET',
        ),
      );
      setError('');
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function saved() {
    // A failed reload must leave the form visible so the saved version can be retrieved.
    const result = await api<MaintenancePage>(`/repos/${repoId}/maintenance`);
    setPage(result);
    setAdding(false);
  }
  return (
    <section className="maintenance-panel" aria-label={t('maintenance.title')}>
      <header className="maintenance-heading">
        <h3>{t('maintenance.title')}</h3>
        <button className="secondary-button" onClick={() => setAdding(!adding)}>
          {t('maintenance.new')}
        </button>
      </header>
      {error && (
        <p className="error-inline" role="alert">
          {host(error)}
          <button disabled={busy} onClick={() => void load()}>
            {t('flow.sync')}
          </button>
        </p>
      )}
      {adding && <MaintenanceRuleForm repoId={repoId} onSaved={saved} />}
      {page?.rules.length === 0 && !adding && <p>{t('maintenance.empty')}</p>}
      {page?.rules.map((rule) => (
        <details className="maintenance-rule" key={rule.id}>
          <summary>
            <strong>{rule.name}</strong> · v{rule.version} · {t(`maintenance.${rule.mode}`)}
          </summary>
          <MaintenanceRuleForm repoId={repoId} rule={rule} onSaved={saved} />
          <MaintenanceHistory rule={rule} />
        </details>
      ))}
      <header className="maintenance-heading">
        <h3>{t('maintenance.records')}</h3>
        <button
          className="secondary-button"
          disabled={busy || !page?.rules.some((r) => r.mode !== 'off')}
          onClick={() => void load(true)}
        >
          {t('maintenance.refresh')}
        </button>
      </header>
      {page?.health && (
        <p className={page.health.status === 'unavailable' ? 'error-inline' : ''}>
          {when(page.health.checkedAt)} ·{' '}
          {page.health.reason ? host(page.health.reason) : t('flow.connected')}
        </p>
      )}
      {page?.observations.length === 0 && <p>{t('maintenance.noRecords')}</p>}
      {page?.observations.map((record) => (
        <MaintenanceObservationRow
          key={record.id}
          record={record}
          currentVersion={page.rules.find((rule) => rule.ruleId === record.ruleId)?.version}
        />
      ))}
      {page && (
        <div className="maintenance-heading">
          <button disabled={busy} onClick={() => void load()}>
            {t('maintenance.back')}
          </button>
          {page.next && (
            <button disabled={busy} onClick={() => void load(false, page.next)}>
              {t('maintenance.more')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
