import { useState } from 'react';
import { Send } from 'lucide-react';
import type { Snapshot, Task } from '../shared/types.ts';
import { hasOwner } from '../shared/team.ts';
import { isExternalDelivery } from '../shared/task-history.ts';
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
  const [draft, setDraft] = useState({ content: '', requestId: crypto.randomUUID() });
  const [mode, setMode] = useState<'question' | 'followup'>('question');
  const lines = (state.ownerMessages ?? []).filter((m) => m.taskId === task.id);
  const open = hasOwner(task);
  const external = isExternalDelivery(task);
  if (!open && !lines.length) return null;
  return (
    <section
      className="owner-conversation"
      aria-label={t(external ? 'task.ownerHistory' : 'owner.title')}
    >
      <h3>{t(external ? 'task.ownerHistory' : 'owner.title')}</h3>
      {open && (
        <div className="segmented-control" aria-label={t('owner.title')}>
          <button
            type="button"
            aria-pressed={mode === 'question'}
            onClick={() => setMode('question')}
          >
            {t('flow.readQuestion')}
          </button>
          <button
            type="button"
            aria-pressed={mode === 'followup'}
            onClick={() => setMode('followup')}
          >
            {t('flow.requestChange')}
          </button>
        </div>
      )}
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
              await api(
                `/tasks/${task.id}/${mode === 'question' ? 'owner-messages' : 'follow-ups'}`,
                mode === 'question' ? { content } : { content, requestId: draft.requestId },
              );
              setDraft((current) =>
                current === draft ? { content: '', requestId: crypto.randomUUID() } : current,
              );
            });
          }}
        >
          <textarea
            value={draft.content}
            rows={2}
            maxLength={8000}
            aria-label={t('owner.placeholder')}
            placeholder={t('owner.placeholder')}
            onChange={(e) => setDraft({ content: e.target.value, requestId: crypto.randomUUID() })}
          />
          <button className="primary-button" disabled={busy || !draft.content.trim()}>
            <Send size={14} /> {t(mode === 'question' ? 'owner.send' : 'flow.requestChange')}
          </button>
        </form>
      )}
    </section>
  );
}
