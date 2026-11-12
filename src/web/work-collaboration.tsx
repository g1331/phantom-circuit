import { useEffect, useState } from 'react';
import type { Collaboration, FollowUp } from '../shared/collaboration.ts';
import type { Snapshot, Task } from '../shared/types.ts';
import { api } from './api.ts';
import { useLocale } from './locale/provider.tsx';
import { MarkdownContent } from './markdown-content.tsx';

interface Page {
  assignments: Collaboration[];
  followUps: FollowUp[];
  hasMore: boolean;
}

export function WorkCollaboration({ task, state }: { task: Task; state: Snapshot }) {
  const { t, host, time } = useLocale();
  const [page, setPage] = useState<Page>();
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const revision = state.events[0]?.id;
  useEffect(() => {
    const abort = new AbortController();
    api<Page>(`/tasks/${task.id}/collaboration?offset=${offset}`, undefined, 'GET', abort.signal)
      .then((value) => {
        setPage(value);
        setError('');
      })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted) setError(String(failure));
      });
    return () => abort.abort();
  }, [task.id, revision, offset]);
  if (!error && !page?.assignments.length && !page?.followUps.length) return null;
  return (
    <section className="work-collaboration" aria-label={t('flow.collaboration')}>
      <h3>{t('flow.collaboration')}</h3>
      {error && (
        <p className="error-inline" role="alert">
          {host(error)}
        </p>
      )}
      {page?.assignments.map((item) => {
        const run = state.runs.find((candidate) => candidate.id === item.runId);
        return (
          <article key={item.id} className={`contribution-row state-${item.status}`}>
            <header>
              <strong>{item.objective}</strong>
              <span className="record-result">
                {t(
                  item.integratedAt
                    ? 'flow.integrated'
                    : item.status === 'failed'
                      ? 'flow.assignmentFailed'
                      : `flow.${item.status}`,
                )}
              </span>
            </header>
            <div className="muted">
              {t('flow.contributor')} · {t(`profile.${item.profile}`)}
              {run && (
                <>
                  {' '}
                  · {run.agentKind} / {run.profileConfig?.model}
                </>
              )}
              {' · '}
              <time dateTime={item.updatedAt}>{time(item.updatedAt)}</time>
            </div>
            {item.error && <p className="error-text">{host(item.error)}</p>}
            <ContributionDetails taskId={task.id} kind="collaboration" id={item.id} />
          </article>
        );
      })}
      {page?.followUps.map((item) => (
        <article key={item.id} className={`contribution-row state-${item.status}`}>
          <header>
            <strong>{item.body}</strong>
            <span className="record-result">
              {t(item.status === 'accepted' ? 'flow.followupAccepted' : `flow.${item.status}`)}
            </span>
          </header>
          <div className="muted">
            {item.url ? (
              <a href={item.url} target="_blank" rel="noreferrer">
                {item.author} · {item.kind === 'check' ? 'CI' : 'GitHub'}
              </a>
            ) : (
              item.author
            )}
            {' · '}
            <time dateTime={item.receivedAt}>{time(item.receivedAt)}</time>
          </div>
          {item.disposition && <p>{item.disposition.reason}</p>}
          <ContributionDetails taskId={task.id} kind="followUp" id={item.id} />
          {item.reply && <FollowUpReply key={`${item.id}:${item.reply.status}`} item={item} />}
        </article>
      ))}
      <div className="contribution-pagination">
        {offset > 0 && (
          <button onClick={() => setOffset(Math.max(0, offset - 30))}>{t('flow.records')}</button>
        )}
        {page?.hasMore && <button onClick={() => setOffset(offset + 30)}>{t('flow.more')}</button>}
      </div>
    </section>
  );
}

function ContributionDetails({
  taskId,
  kind,
  id,
}: {
  taskId: string;
  kind: 'collaboration' | 'followUp';
  id: string;
}) {
  const { t, host } = useLocale();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  async function load() {
    try {
      const record = await api<Collaboration | FollowUp>(
        `/tasks/${taskId}/collaboration/${kind}/${id}`,
      );
      setText(
        'body' in record
          ? `${record.body}\n\n${record.disposition?.reason ?? ''}`
          : `${record.objective}\n\n${record.result ?? ''}`,
      );
      setError('');
    } catch (failure) {
      setError(String(failure));
    }
  }
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary>{t('flow.contributionDetails')}</summary>
      {error ? <p className="error-text">{host(error)}</p> : <MarkdownContent content={text} />}
    </details>
  );
}

function FollowUpReply({ item }: { item: FollowUp }) {
  const { t, host } = useLocale();
  const [reply, setReply] = useState(item.reply!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function retry() {
    setBusy(true);
    try {
      const updated = await api<FollowUp>(`/follow-ups/${item.id}/reply`, {});
      setReply(updated.reply!);
      setError('');
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }
  const label = t(
    reply.status === 'sent'
      ? 'flow.replySent'
      : reply.status === 'uncertain'
        ? 'flow.replyUncertain'
        : 'flow.replyPending',
  );
  return (
    <div className="contribution-reply">
      {reply.url ? (
        <a href={reply.url} target="_blank" rel="noreferrer">
          {label}
        </a>
      ) : (
        label
      )}
      {reply.status === 'uncertain' && (
        <button disabled={busy} onClick={() => void retry()}>
          {t('flow.retryReply')}
        </button>
      )}
      {(error || reply.error) && <p className="error-text">{host(error || reply.error!)}</p>}
    </div>
  );
}
