import { ExternalLink, Play, MessageSquare } from 'lucide-react';
import type { Snapshot, Task } from '../shared/types.ts';
import { api } from './api.ts';
import { useLocale } from './locale/provider.tsx';
import { routeHref } from './route.ts';
import type { TaskDraft } from './task-page.tsx';

export function TaskExperience({
  task,
  state,
  busy,
  act,
  onDraft,
}: {
  task: Task;
  state: Snapshot;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  onDraft: (draft: TaskDraft) => void;
}) {
  const { t, host } = useLocale();
  const repo = state.repos.find((repo) => repo.id === task.repoId);
  const preview = repo?.preview;
  const configured = !!repo?.commands.start.trim() && repo.commands.port > 0;
  return (
    <section className="task-experience" aria-label={t('task.experience')}>
      <div>
        <h2>{t('task.experience')}</h2>
        <p className="muted">{t('task.previewScope', { branch: repo?.defaultBranch ?? 'main' })}</p>
      </div>
      <div className="task-experience-actions">
        {preview?.status === 'running' && preview.url ? (
          <a className="primary-button" href={preview.url} target="_blank" rel="noreferrer">
            {t('task.tryProject')} <ExternalLink size={14} />
          </a>
        ) : preview?.status === 'starting' ? (
          <button className="primary-button" disabled aria-live="polite">
            {t('task.previewStarting')}
          </button>
        ) : configured && repo?.authorized ? (
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => void act(() => api(`/repos/${repo.id}/preview/start`, {}))}
          >
            <Play size={14} />{' '}
            {t(preview?.status === 'failed' ? 'task.previewRetry' : 'task.tryProject')}
          </button>
        ) : (
          <a
            className="secondary-button"
            href={routeHref({ page: 'project', projectId: task.projectId })}
          >
            {t('task.previewConfigure')}
          </a>
        )}
        <button
          className="secondary-button"
          onClick={() =>
            onDraft({
              content: t('brief.feedbackDraft', { title: task.title }),
              intent: 'feedback',
            })
          }
        >
          <MessageSquare size={14} /> {t('brief.feedback')}
        </button>
      </div>
      {!configured && preview?.status !== 'running' && preview?.status !== 'starting' && (
        <p className="task-experience-note muted">{t('task.previewUnconfigured')}</p>
      )}
      {repo && !repo.authorized && (
        <p className="task-experience-note muted">{t('task.previewUnauthorized')}</p>
      )}
      {preview?.status === 'failed' && (
        <p className="task-experience-note" role="status">
          {t('task.previewFailed')} {preview.error && host(preview.error)}
        </p>
      )}
      <p className="task-experience-note muted">{t('task.feedbackHint')}</p>
    </section>
  );
}
