import { Layers3 } from 'lucide-react';
import type { Message, Snapshot } from '../shared/types.ts';
import { MarkdownContent } from './markdown-content.tsx';
import { PMProgress } from './pm-activity.tsx';
import { useLocale } from './locale/provider.tsx';
import { isRunning } from './sidebar.tsx';

type Run = Snapshot['runs'][number];
type Activity = NonNullable<Snapshot['activities']>[number];

export function ChatMessage({
  message: m,
  activeRun,
  activities,
  streamText,
  retryDisabled,
  onRetry,
}: {
  message: Message;
  /** The live PM Run that is writing this assistant draft, if any. */
  activeRun?: Run;
  activities: Activity[];
  streamText?: string;
  retryDisabled: boolean;
  onRetry: () => void;
}) {
  const { t, time, host } = useLocale();
  const delivery = m.draftStatus ?? m.status;
  return (
    <article id={`message-${m.id}`} tabIndex={-1} className={`message ${m.role}`}>
      <div className="message-heading">
        {m.role !== 'user' && (
          <span className="mini-avatar">
            {m.role === 'assistant' ? <Layers3 size={13} /> : '!'}
          </span>
        )}
        <strong>
          {m.role === 'assistant'
            ? t('profile.pm')
            : m.role === 'user'
              ? t('ui.you')
              : t('ui.runNotice')}
        </strong>
        {m.intent && (
          <span className={`message-intent intent-${m.intent}`}>
            {
              {
                discuss: t('ui.discussion'),
                implement: t('ui.implementationRequest'),
                feedback: t('ui.experienceFeedback'),
              }[m.intent]
            }
          </span>
        )}
        <time dateTime={m.createdAt}>{time(m.createdAt)}</time>
        {/* A settled message needs no badge; only in-flight or failed delivery is news. */}
        {delivery && delivery !== 'completed' && (
          <span className={`runtime-badge delivery-${delivery}`}>{t(`delivery.${delivery}`)}</span>
        )}
      </div>
      {activeRun && <PMProgress run={activeRun} activities={activities} />}
      <div className="message-content">
        {m.role === 'system' ? (
          host(m.content, m.descriptor)
        ) : (
          <MarkdownContent
            content={
              m.runId && isRunning(delivery ?? '') && streamText
                ? streamText
                : m.descriptor
                  ? host(m.content, m.descriptor)
                  : m.content
            }
          />
        )}
      </div>
      {!!m.attachments?.length && (
        <div className="message-images">
          {m.attachments.map((attachment) => {
            const url = `/api/projects/${m.projectId}/messages/${m.id}/images/${attachment.id}`;
            return (
              <a key={attachment.id} href={url} target="_blank" rel="noreferrer">
                <img src={url} alt={attachment.name} />
                <span>{attachment.name}</span>
              </a>
            );
          })}
        </div>
      )}
      {m.role === 'user' && (
        <button className="retry-message" disabled={retryDisabled} onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </article>
  );
}

/** A PM Run that has started but has not created its assistant draft yet. */
export function PendingReply({
  run,
  activities,
  streamText,
}: {
  run: Run;
  activities: Activity[];
  streamText?: string;
}) {
  const { t } = useLocale();
  return (
    <article className="message assistant">
      <div className="message-heading">
        <span className="mini-avatar">
          <Layers3 size={13} />
        </span>
        <strong>{t('profile.pm')}</strong>
        <span className="thinking">
          {t('chat.thinking')}
          <span>…</span>
        </span>
      </div>
      <PMProgress run={run} activities={activities} />
      {streamText ? (
        <div className="message-content">
          <MarkdownContent content={streamText} />
        </div>
      ) : null}
    </article>
  );
}
