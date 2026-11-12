import { useState } from 'react';
import type { MaintenanceHistory as History, MaintenanceRule } from '../shared/maintenance.ts';
import { api } from './api.ts';
import { useLocale } from './locale/provider.tsx';
import { useWhen } from './work-list.tsx';

export function MaintenanceHistory({ rule }: { rule: MaintenanceRule }) {
  const { t, host } = useLocale();
  const when = useWhen();
  const [history, setHistory] = useState<History>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load(before?: number) {
    if (busy) return;
    setBusy(true);
    try {
      setHistory(
        await api<History>(
          `/repos/${rule.repoId}/maintenance/rules/${rule.ruleId}/history${
            before ? `?before=${before}` : ''
          }`,
        ),
      );
      setError('');
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open && !history) void load();
      }}
    >
      <summary>{t('maintenance.history')}</summary>
      {error && (
        <p className="error-inline" role="alert">
          {host(error)}
        </p>
      )}
      {history?.versions.map((version) => (
        <article key={version.id}>
          <h4>
            v{version.version} · {when(version.createdAt)} · {t(`maintenance.${version.mode}`)}
          </h4>
          <p>
            {version.name} · {t(`maintenance.${version.kind}`)} · {version.selector}
          </p>
          <p>
            {t('maintenance.age')}: {version.minimumAgeMinutes}
          </p>
          <p>
            {t('maintenance.scope')}: {version.scope}
          </p>
        </article>
      ))}
      <button disabled={busy} onClick={() => void load()}>
        {t('flow.sync')}
      </button>
      {history?.next && (
        <button disabled={busy} onClick={() => void load(history.next)}>
          {t('maintenance.olderVersions')}
        </button>
      )}
    </details>
  );
}
