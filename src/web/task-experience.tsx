import { ExternalLink, MessageSquare } from 'lucide-react';
import type { Snapshot, Task } from '../shared/types.ts';
import { deliveryPreview } from '../shared/delivery-preview.ts';
import { isExternalDelivery } from '../shared/task-history.ts';
import { useLocale } from './locale/provider.tsx';
import type { TaskDraft } from './task-page.tsx';
import { deliveryPRUrl } from './engineering-reference.tsx';

export function TaskExperience({
  task,
  state,
  onDraft,
}: {
  task: Task;
  state: Snapshot;
  onDraft: (draft: TaskDraft) => void;
}) {
  const { t } = useLocale();
  const url = deliveryPreview(task, state.repos, window.location.origin);
  const changes = deliveryPRUrl(task);
  return (
    <section className="task-experience" aria-label={t('task.experience')}>
      <h2>{t('task.experience')}</h2>
      <div className="task-experience-actions">
        {url && (
          <a className="primary-button" href={url} target="_blank" rel="noreferrer">
            {t('brief.preview')} <ExternalLink size={14} />
          </a>
        )}
        {!url && changes && (isExternalDelivery(task) || task.prState === 'merged') && (
          <a className="secondary-button" href={changes} target="_blank" rel="noreferrer">
            {t('task.mergedChanges')} <ExternalLink size={14} />
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
    </section>
  );
}
