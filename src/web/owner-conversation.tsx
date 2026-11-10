import { useState } from 'react';
import { Send } from 'lucide-react';
import type { Snapshot, Task } from '../shared/types.ts';
import { hasOwner } from '../shared/team.ts';
import { api } from './api.ts';
import { useLocale } from './locale/provider.tsx';

/** The user's direct conversation with the member who owns this work (ADR 0013). */
export function OwnerConversation({
  task,
  state,
  busy,
  act,
}: {
  task: Task;
  state: Snapshot;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const { t, time } = useLocale();
  const [draft, setDraft] = useState({ content: '' });
  const lines = (state.ownerMessages ?? []).filter((m) => m.taskId === task.id);
  const open = hasOwner(task);
  if (!open && !lines.length) return null;
  return (
    <section className="owner-conversation" aria-label={t('owner.title')}>
      <h3>{t('owner.title')}</h3>
      <p className="muted">{t(open ? 'owner.hint' : 'owner.closed')}</p>
      {lines.length > 0 && (
        <ol className="owner-lines">
          {lines.map((m) => (
            <li key={m.id} className={`owner-line ${m.role}`}>
              <span className="owner-who">
                {t(m.role === 'user' ? 'owner.you' : 'owner.owner')} ·{' '}
                <time dateTime={m.createdAt}>{time(m.createdAt)}</time>
              </span>
              <p>{m.content}</p>
              {m.context === 'work_history' && <em>{t('owner.workHistory')}</em>}
              {m.status === 'queued' && <em>{t('owner.queued')}</em>}
              {m.status === 'answering' && <em>{t('owner.answering')}</em>}
              {m.status === 'failed' && (
                <em className="error-text">
                  {t(
                    m.failureReason === 'history_unavailable'
                      ? 'owner.historyUnavailable'
                      : m.failureReason === 'owner_changed'
                        ? 'owner.changed'
                        : 'owner.failed',
                  )}
                </em>
              )}
            </li>
          ))}
        </ol>
      )}
      {open && (
        <form
          className="owner-compose"
          onSubmit={(e) => {
            e.preventDefault();
            const content = draft.content.trim();
            if (!content) return;
            void act(async () => {
              await api(`/tasks/${task.id}/owner-messages`, { content });
              setDraft((current) => (current === draft ? { content: '' } : current));
            });
          }}
        >
          <textarea
            value={draft.content}
            rows={2}
            maxLength={8000}
            aria-label={t('owner.placeholder')}
            placeholder={t('owner.placeholder')}
            onChange={(e) => setDraft({ content: e.target.value })}
          />
          <button className="primary-button" disabled={busy || !draft.content.trim()}>
            <Send size={14} /> {t('owner.send')}
          </button>
        </form>
      )}
    </section>
  );
}
