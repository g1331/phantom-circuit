import { useState } from 'react';
import { Github, MessageSquare, RefreshCw } from 'lucide-react';
import type { IntakeSource } from '../shared/intake.ts';
import type { Repo } from '../shared/types.ts';
import { useLocale } from './locale/provider.tsx';
import { useWhen } from './work-list.tsx';
import { ReceivingForm } from './workbench-receiving.tsx';
import { routeHref } from './route.ts';
import { api } from './api.ts';

export function SourcePage({
  projectId,
  repos,
  sources,
  syncing,
  onSync,
  onSaved,
}: {
  projectId: string;
  repos: Repo[];
  sources: IntakeSource[];
  syncing?: string;
  onSync: (id: string) => Promise<void>;
  onSaved: () => Promise<void>;
}) {
  const { t, host } = useLocale();
  const when = useWhen();
  const [selected, setSelected] = useState(repos[0]?.id ?? 'web');
  const repo = repos.find((item) => item.id === selected);
  const source = sources.find((item) => item.repoId === selected);
  const health = source?.health;
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function toggleFollowUps() {
    if (!repo) return;
    setSaving(true);
    try {
      await api(`/repos/${repo.id}`, { followUpsEnabled: !repo.followUpsEnabled }, 'PATCH');
      await onSaved();
      setError('');
    } catch (failure) {
      setError(String(failure));
    } finally {
      setSaving(false);
    }
  }
  const status = !source?.enabled
    ? 'flow.notConnected'
    : health?.status === 'unavailable'
      ? 'flow.sourceUnavailable'
      : health?.status === 'healthy'
        ? 'flow.connected'
        : 'flow.sourcePending';
  return (
    <div className="source-workspace">
      <aside className="workspace-section-nav">
        <h1>{t('flow.sources')}</h1>
        {repos.map((item) => (
          <button
            key={item.id}
            aria-pressed={item.id === selected}
            onClick={() => setSelected(item.id)}
          >
            <Github size={20} />
            <span>
              <strong>GitHub</strong>
              <small>{item.github}</small>
            </span>
          </button>
        ))}
        <button aria-pressed={selected === 'web'} onClick={() => setSelected('web')}>
          <MessageSquare size={20} />
          <span>{t('flow.sourceWeb')}</span>
        </button>
        <a
          className="secondary-button"
          href={routeHref({ page: 'project', projectId, view: 'repos' })}
        >
          {t('flow.configureRepo')}
        </a>
      </aside>
      <section className="source-page-content">
        <header className="source-page-heading">
          {repo ? <Github size={29} /> : <MessageSquare size={29} />}
          <h2>{repo ? 'GitHub' : t('flow.sourceWeb')}</h2>
          {repo && (
            <span
              className={`record-result tone-${
                health?.status === 'unavailable'
                  ? 'warning'
                  : source?.enabled
                    ? 'success'
                    : 'neutral'
              }`}
            >
              {t(status)}
            </span>
          )}
          {repo && source?.enabled && (
            <button
              className="secondary-button"
              disabled={!!syncing}
              onClick={() => void onSync(repo.id)}
            >
              <RefreshCw size={15} />
              {t('flow.sync')}
            </button>
          )}
        </header>
        {repo ? (
          <>
            <dl className="source-facts">
              <div>
                <dt>{t('flow.repo')}</dt>
                <dd>
                  <a href={`https://github.com/${repo.github}`} target="_blank" rel="noreferrer">
                    {repo.github}
                  </a>
                </dd>
              </div>
              {health && 'checkedAt' in health && (
                <div>
                  <dt>{t('flow.latest')}</dt>
                  <dd>{when(health.checkedAt)}</dd>
                </div>
              )}
              {source && (
                <div>
                  <dt>{t('flow.rules', { version: source.version })}</dt>
                  <dd>{source.command}</dd>
                </div>
              )}
            </dl>
            {health?.status === 'unavailable' && (
              <div className="error-inline" role="alert">
                {host(health.reason)}
              </div>
            )}
            <section className="source-permissions">
              <label className="followup-toggle">
                <input
                  type="checkbox"
                  role="switch"
                  checked={!!repo.followUpsEnabled}
                  disabled={saving || (!repo.authorized && !repo.followUpsEnabled)}
                  onChange={() => void toggleFollowUps()}
                />
                {t('flow.followUpsEnabled')}
              </label>
              {error && (
                <p className="error-inline" role="alert">
                  {host(error)}
                </p>
              )}
              <h3>{t('flow.settings')}</h3>
              <ReceivingForm
                key={`${repo.id}:${source?.version ?? 0}`}
                repo={repo}
                autoFocus={false}
                source={source}
                onSaved={onSaved}
              />
            </section>
          </>
        ) : (
          <div className="source-web-actions">
            <a className="primary-button" href={routeHref({ page: 'conversation', projectId })}>
              {t('flow.openConversation')}
            </a>
            <a href={routeHref({ page: 'records', projectId })}>{t('flow.records')}</a>
          </div>
        )}
      </section>
    </div>
  );
}
