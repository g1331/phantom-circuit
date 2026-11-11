import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useInputDetail } from './use-input-detail.ts';
import { useLocale } from './locale/provider.tsx';
import { MarkdownContent } from './markdown-content.tsx';
import { routeHref } from './route.ts';
import { InputRecord } from './workbench-input-record.tsx';

export function InputDetail({
  inputId,
  projectId,
  onChange,
}: {
  inputId: string;
  projectId: string;
  onChange: () => Promise<void>;
}) {
  const { t, host, date } = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const anchor = useRef<{ key: string; offset: number } | undefined>(undefined);
  const remember = useCallback(() => {
    anchor.current = undefined;
    const element = dialog.current;
    if (!element || element.scrollTop === 0) return;
    const top = element.getBoundingClientRect().top;
    const section = [...element.querySelectorAll<HTMLElement>('[data-input-section]')].find(
      (item) => item.getBoundingClientRect().bottom > top,
    );
    if (section) {
      anchor.current = {
        key: section.dataset.inputSection!,
        offset: section.getBoundingClientRect().top - top,
      };
    }
  }, []);
  const { detail, error, busy, act } = useInputDetail(inputId, onChange, remember);
  useLayoutEffect(() => {
    const element = dialog.current;
    const saved = anchor.current;
    anchor.current = undefined;
    if (!element || !saved) return;
    const section = [...element.querySelectorAll<HTMLElement>('[data-input-section]')].find(
      (item) => item.dataset.inputSection === saved.key,
    );
    if (section) {
      element.scrollTop +=
        section.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.offset;
    }
  }, [detail]);
  const home = routeHref({ page: 'home', projectId });
  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.focus();
    const current = dialog.current;
    return () => current?.close();
  }, []);
  const current = detail?.input.id === inputId ? detail : undefined;
  const disposition = current?.assessment.disposition;
  return (
    <dialog
      className="flow-detail-drawer"
      ref={dialog}
      tabIndex={-1}
      aria-label={t('flow.inputDetails')}
      onCancel={() => {
        location.hash = home;
      }}
    >
      <header className="flow-detail-header">
        <h2>{current?.input.title ?? t('flow.inputDetails')}</h2>
        <a className="icon-button" href={home} aria-label={t('flow.close')}>
          <X size={18} />
        </a>
      </header>
      {error && (
        <div className="error-inline" role="alert">
          {host(error)}
        </div>
      )}
      {!current ? (
        !error && <div className="loading">{t('connection.loading')}</div>
      ) : (
        <>
          <div className="flow-detail-meta">
            <a href={current.input.url} target="_blank" rel="noreferrer">
              GitHub Issue #{current.input.number}
            </a>
            <span>{current.input.actor.login}</span>
            <time dateTime={current.input.observedAt}>
              {date(current.input.observedAt, {
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
          </div>
          <section className="flow-detail-section" data-input-section="assessment">
            <h3>{t('flow.admission')}</h3>
            <strong>{disposition && t(`flow.${disposition.status}`)}</strong>
            <span className="flow-policy">
              {t('flow.rules', { version: current.assessment.policyVersion })}
            </span>
            {disposition && 'reason' in disposition && <p>{host(disposition.reason)}</p>}
            {disposition?.status === 'awaiting_decision' && (
              <a
                className="primary-button"
                href={routeHref({
                  page: 'conversation',
                  projectId,
                  view: disposition.clarificationId,
                })}
              >
                {t('flow.awaiting_decision')}
              </a>
            )}
            {disposition?.status === 'accepted' && (
              <a
                className="secondary-button"
                href={routeHref({ page: 'task', projectId, taskId: disposition.taskId })}
              >
                {t('flow.details')}
              </a>
            )}
            {disposition?.status === 'unavailable' && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void act('retry')}
              >
                {t('flow.retry')}
              </button>
            )}
          </section>
          <section className="flow-detail-section" data-input-section="source">
            <h3>{t('flow.sourceText')}</h3>
            <MarkdownContent content={current.input.body} />
          </section>
          <InputRecord detail={current} />
          {current.replies.map((reply) => (
            <section key={reply.id} className="flow-detail-section" data-input-section={reply.id}>
              <h3>{t('flow.reply')}</h3>
              <strong>{t(`flow.reply.${reply.state.status}`)}</strong>
              {reply.state.status === 'sent' && (
                <a href={reply.state.url} target="_blank" rel="noreferrer">
                  {t('flow.sourceOpen')}
                </a>
              )}
              {'reason' in reply.state && <p>{host(reply.state.reason)}</p>}
              {reply.state.status === 'unavailable' && (
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void act('retry')}
                >
                  {t('flow.retry')}
                </button>
              )}
              {reply.state.status === 'uncertain' && (
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void act('reconcile-reply')}
                >
                  {t('flow.reconcile')}
                </button>
              )}
              <MarkdownContent content={reply.body} />
            </section>
          ))}
        </>
      )}
    </dialog>
  );
}
