import { useState } from 'react';
import type { MaintenanceDetail, MaintenancePage } from '../shared/maintenance.ts';
import { api } from './api.ts';
import { useLocale } from './locale/provider.tsx';
import { useWhen } from './work-list.tsx';
import { routeHref } from './route.ts';

export function MaintenanceObservationRow({
  record,
  currentVersion,
}: {
  record: MaintenancePage['observations'][number];
  currentVersion?: number;
}) {
  const { t, host } = useLocale();
  const when = useWhen();
  const [detail, setDetail] = useState<MaintenanceDetail>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() {
    if (detail || busy) return;
    setBusy(true);
    try {
      setDetail(
        await api<MaintenanceDetail>(
          `/repos/${record.repoId}/maintenance/observations/${record.id}`,
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
      className="maintenance-observation"
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary>
        <strong>{record.candidate.title}</strong>
        <span className={`record-result tone-${record.wouldAccept ? 'success' : 'neutral'}`}>
          {t(record.wouldAccept ? 'maintenance.accept' : 'maintenance.decline')}
        </span>
        <time dateTime={record.createdAt}>{when(record.createdAt)}</time>
      </summary>
      <p>
        {t('maintenance.onlyObserve')} · v{record.policyVersion}
        {currentVersion !== record.policyVersion && ` · ${t('maintenance.stale')}`}
      </p>
      <a href={record.candidate.url} target="_blank" rel="noreferrer">
        {record.candidate.url}
      </a>
      {error && (
        <p className="error-inline" role="alert">
          {host(error)}
          <button onClick={() => void load()}>{t('flow.sync')}</button>
        </p>
      )}
      {detail && (
        <>
          <h4>
            {detail.rule.name} · {t(`maintenance.${detail.rule.mode}`)}
          </h4>
          <h4>{t('maintenance.reason')}</h4>
          <ul>
            {record.judgments.map((judgment) => (
              <li key={judgment.condition}>
                <span className={`record-result tone-${judgment.matched ? 'success' : 'warning'}`}>
                  {t(judgment.matched ? 'maintenance.pass' : 'maintenance.fail')}
                </span>{' '}
                {judgment.condition}
              </li>
            ))}
          </ul>
          <h4>{t('maintenance.proposed')}</h4>
          <p>{record.proposedScope}</p>
          <h4>{t('maintenance.recommendation')}</h4>
          <p>{record.recommendation}</p>
          {record.holdReasons.length > 0 && (
            <>
              <h4>{t('maintenance.holds')}</h4>
              <ul>
                {record.holdReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </>
          )}
          {record.taskIds.length > 0 && (
            <>
              <h4>{t('maintenance.work')}</h4>
              {record.taskIds.map((taskId) => (
                <a
                  key={taskId}
                  href={routeHref({
                    page: 'task',
                    projectId: record.projectId,
                    taskId,
                  })}
                >
                  {t('maintenance.work')} · {taskId.slice(0, 8)}
                </a>
              ))}
            </>
          )}
          <h4>{t('maintenance.evidence')}</h4>
          <p className="maintenance-body">{detail.candidate.body}</p>
          <pre>{JSON.stringify(detail.candidate.evidence, null, 2)}</pre>
        </>
      )}
    </details>
  );
}
