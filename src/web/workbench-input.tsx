import { ClipboardCheck, Inbox, MessageSquare } from 'lucide-react';
import { useLocale } from './locale/provider.tsx';
import { useWhen } from './work-list.tsx';
import { routeHref } from './route.ts';
import { inputTone, type FlowEntry } from './workbench-model.ts';

export function InputTrajectory({ entry }: { entry: FlowEntry }) {
  const { t, host } = useLocale();
  const when = useWhen();
  const { input, assessment } = entry;
  const disposition = assessment.disposition;
  const href = routeHref({ page: 'input', projectId: input.projectId, inputId: input.id });
  const reply = entry.replies.at(-1);
  return (
    <article className={`flow-input tone-${inputTone(entry)}`} data-input-id={input.id}>
      <header className="flow-work-heading">
        <a className="flow-work-title" href={href}>
          {input.title}
        </a>
        <span className="flow-input-state">{t(`flow.${disposition.status}`)}</span>
      </header>
      <div className="flow-work-meta">
        <a href={input.url} target="_blank" rel="noreferrer">
          GitHub Issue #{input.number}
        </a>
        <span>{input.actor.login}</span>
        <time dateTime={input.observedAt}>{when(input.observedAt)}</time>
      </div>
      <ol className="flow-trajectory" aria-label={t('flow.admission')}>
        <li className="flow-node tone-neutral">
          <Inbox size={16} aria-hidden="true" />
          <div>
            <span className="flow-node-label">{t('flow.received')}</span>
            <strong>
              {t(input.state === 'closed' ? 'flow.originalClosed' : 'flow.originalOpen')}
            </strong>
          </div>
        </li>
        <li className={`flow-node tone-${inputTone(entry)}`}>
          <ClipboardCheck size={16} aria-hidden="true" />
          <div>
            <span className="flow-node-label">{t('flow.admission')}</span>
            <strong>{t(`flow.${disposition.status}`)}</strong>
          </div>
        </li>
        {reply && (
          <li
            className={`flow-node tone-${
              reply.state.status === 'sent'
                ? 'success'
                : reply.state.status === 'queued'
                  ? 'neutral'
                  : 'warning'
            }`}
          >
            <MessageSquare size={16} aria-hidden="true" />
            <div>
              <span className="flow-node-label">{t('flow.reply')}</span>
              <strong>{t(`flow.reply.${reply.state.status}`)}</strong>
            </div>
          </li>
        )}
      </ol>
      {'reason' in disposition && (
        <div className="flow-input-reason">{host(disposition.reason)}</div>
      )}
    </article>
  );
}
