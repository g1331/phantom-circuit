import { Github, RefreshCw } from 'lucide-react';
import type { IntakeSource } from '../shared/intake.ts';
import type { Repo } from '../shared/types.ts';
import { useLocale } from './locale/provider.tsx';
import { useWhen } from './work-list.tsx';
import { routeHref } from './route.ts';

export function WorkbenchSources({
  repos,
  sources,
  projectId,
  syncing,
  onConfigure,
  onSync,
}: {
  repos: Repo[];
  sources: IntakeSource[];
  projectId: string;
  syncing?: string;
  onConfigure: (repoId: string) => void;
  onSync: (repoId: string) => Promise<void>;
}) {
  const { t, host } = useLocale();
  const when = useWhen();
  return (
    <div className="flow-sources" aria-label={t('flow.source')}>
      {repos.map((repo) => {
        const source = sources.find((item) => item.repoId === repo.id);
        const health = source?.health;
        return (
          <div
            key={repo.id}
            className={`flow-source-state ${
              health?.status === 'unavailable' ? 'source-unavailable' : ''
            }`}
          >
            <button onClick={() => onConfigure(repo.id)} title={repo.github}>
              <Github size={15} aria-hidden="true" />
              <strong>{repo.name}</strong>
              <span className="flow-source-label">
                {t(
                  !source?.enabled
                    ? 'flow.notConnected'
                    : health?.status === 'unavailable'
                      ? 'flow.sourceUnavailable'
                      : health?.status === 'not_connected'
                        ? 'flow.sourcePending'
                        : 'flow.connected',
                )}
              </span>
            </button>
            {health && 'checkedAt' in health && (
              <time dateTime={health.checkedAt}>
                {t('flow.checked', { time: when(health.checkedAt) })}
              </time>
            )}
            {health?.status === 'unavailable' && (
              <span className="flow-source-error" title={host(health.reason)}>
                {host(health.reason)}
              </span>
            )}
            {source?.enabled && (
              <button
                className="icon-button"
                disabled={!!syncing}
                aria-label={`${t('flow.sync')} · ${repo.name}`}
                onClick={() => void onSync(repo.id)}
              >
                <RefreshCw size={14} />
              </button>
            )}
          </div>
        );
      })}
      {!repos.length && <a href={routeHref({ page: 'project', projectId })}>{t('flow.noRepo')}</a>}
    </div>
  );
}
