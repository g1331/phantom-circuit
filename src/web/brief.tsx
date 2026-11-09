import { useState } from 'react';
import { ArrowRight, Check, ExternalLink, MessageSquarePlus, Pause, Play } from 'lucide-react';
import type { Project, Snapshot } from '../shared/types.ts';
import { maxReworks, workGroup, type TeamView } from '../shared/team.ts';
import { api } from './api.ts';
import { useLocale } from './locale/provider.tsx';
import { routeHref } from './route.ts';
import { useWhen } from './work-list.tsx';

const seenKey = (projectId: string) => `phantom.seen.${projectId}`;

/** When the user last acknowledged deliveries; the first visit counts everything as seen. */
function useSeen(projectId: string) {
  const [seen, setSeenState] = useState(() => {
    const saved = localStorage.getItem(seenKey(projectId));
    if (saved) return saved;
    const now = new Date().toISOString();
    localStorage.setItem(seenKey(projectId), now);
    return now;
  });
  const markSeen = () => {
    const now = new Date().toISOString();
    localStorage.setItem(seenKey(projectId), now);
    setSeenState(now);
  };
  return [seen, markSeen] as const;
}

/**
 * The client's brief (ADR 0014): what needs them, what is moving, and what was delivered since
 * they last looked, with the next action beside each.
 */
export function Brief({
  state,
  project,
  view,
  busy,
  act,
  onFeedback,
  onTeam,
}: {
  state: Snapshot;
  project: Project;
  view: TeamView;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  onFeedback: (draft: string) => void;
  onTeam: (action: 'pause' | 'resume') => void;
}) {
  const { t } = useLocale();
  const when = useWhen();
  const [seen, markSeen] = useSeen(project.id);
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const repos = state.repos.filter((repo) => repo.projectId === project.id);
  const moving = view.work.filter((w) => workGroup(w) === 'moving');
  const queued = view.work.filter((w) => workGroup(w) === 'queued').length;
  // The team view lists finished work newest first.
  const delivered = view.work.filter((w) => workGroup(w) === 'delivered');
  const settled = (w: (typeof delivered)[number]) => w.settledAt ?? w.updatedAt;
  const fresh = delivered.filter((w) => settled(w) > seen);
  const open = view.work.filter((w) => w.step !== 'done' && w.step !== 'cancelled');
  const paused =
    open.length > 0 && open.every((w) => w.attention === 'paused') && !view.members.length;
  const doing = (taskId: string) => view.members.find((m) => m.taskId === taskId);
  const href = (taskId: string) => routeHref({ page: 'task', projectId: project.id, taskId });
  const hasSuggestions =
    state.suggestions?.some((s) => s.projectId === project.id && s.status === 'pending') ?? false;
  const empty =
    !hasSuggestions && !view.waiting.length && !moving.length && !queued && !delivered.length;
  return (
    <section className="brief" aria-label={t('brief.title')}>
      <header className="brief-header">
        <h2>{t('brief.title')}</h2>
        {open.length > 0 && (
          <button
            className="brief-team-control"
            disabled={busy}
            onClick={() => onTeam(paused ? 'resume' : 'pause')}
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
            {paused ? t('team.resume') : t('team.pause')}
          </button>
        )}
      </header>

      {empty && <p className="brief-empty">{t('brief.empty')}</p>}

      {(view.waiting.length > 0 || hasSuggestions) && (
        <section className="brief-group brief-needs">
          <h3>
            {t('brief.needsYou')} <span>{view.waiting.length + (hasSuggestions ? 1 : 0)}</span>
          </h3>
          <ul>
            {hasSuggestions && (
              <li className="brief-request">
                <a href={routeHref({ page: 'project', projectId: project.id })}>
                  {t('suggestions.waiting')}
                </a>
              </li>
            )}
            {view.waiting.map((request) => (
              <li key={request.id} className={`brief-request kind-${request.kind}`}>
                <span className="brief-kind">{t(`team.request.${request.kind}`)}</span>
                {request.taskTitle && <strong>{request.taskTitle}</strong>}
                {request.text && <p>{request.text}</p>}
                {request.taskId ? (
                  <a className="brief-link" href={href(request.taskId)}>
                    {t('team.open')} <ArrowRight size={12} />
                  </a>
                ) : (
                  <span className="brief-hint">{t('brief.inConversation')}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(moving.length > 0 || queued > 0) && (
        <section className="brief-group">
          <h3>
            {t('brief.moving')} <span>{moving.length}</span>
          </h3>
          <ul>
            {moving.map((work) => {
              const member = doing(work.taskId);
              return (
                <li key={work.taskId}>
                  <a className="brief-work" href={href(work.taskId)}>
                    <strong>{work.title}</strong>
                    <span className="brief-work-line">
                      <span className={`brief-step step-${work.step}`}>
                        {t(`team.step.${work.step}`)}
                      </span>
                      {member && (
                        <span>
                          {t(`team.role.${member.role}`)} · {t(`team.doing.${member.activity}`)}
                        </span>
                      )}
                      {work.rounds > 0 && (
                        <span
                          className={`brief-rework ${work.rounds >= maxReworks ? 'at-limit' : ''}`}
                        >
                          {t('work.rework', { count: work.rounds, max: maxReworks })}
                        </span>
                      )}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
          {queued > 0 && (
            <a className="brief-more" href={routeHref({ page: 'work', projectId: project.id })}>
              {t('brief.queued', { count: queued })} <ArrowRight size={12} />
            </a>
          )}
        </section>
      )}

      {fresh.length > 0 ? (
        <section className="brief-group brief-delivered">
          <h3>
            {t('brief.delivered')} <span>{fresh.length}</span>
            <button className="brief-seen" onClick={markSeen}>
              <Check size={12} /> {t('brief.seen')}
            </button>
          </h3>
          <ul>
            {fresh.map((work) => {
              const repo = repos.find((r) => r.id === tasks.get(work.taskId)?.repoId);
              return (
                <li key={work.taskId} className="brief-delivery">
                  <a href={href(work.taskId)}>
                    <strong>{work.title}</strong>
                    <span>{t('work.deliveredAt', { time: when(settled(work)) })}</span>
                  </a>
                  <span className="brief-actions">
                    {repo?.preview?.status === 'running' && repo.preview.url ? (
                      <a href={repo.preview.url} target="_blank" rel="noreferrer">
                        {t('brief.preview')} <ExternalLink size={12} />
                      </a>
                    ) : (
                      repo && (
                        <button
                          disabled={busy || repo.preview?.status === 'starting'}
                          onClick={() => void act(() => api(`/repos/${repo.id}/preview/start`, {}))}
                        >
                          <Play size={12} /> {t('brief.startPreview')}
                        </button>
                      )
                    )}
                    <button
                      onClick={() => onFeedback(t('brief.feedbackDraft', { title: work.title }))}
                    >
                      <MessageSquarePlus size={12} /> {t('brief.feedback')}
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        delivered[0] && (
          <section className="brief-group brief-last">
            <h3>{t('brief.recent')}</h3>
            <a className="brief-work" href={href(delivered[0].taskId)}>
              <strong>{delivered[0].title}</strong>
              <span className="brief-work-line">
                {t('work.deliveredAt', { time: when(settled(delivered[0])) })}
              </span>
            </a>
          </section>
        )
      )}

      <a className="brief-more brief-all" href={routeHref({ page: 'work', projectId: project.id })}>
        {t('brief.allWork')} <ArrowRight size={12} />
      </a>
    </section>
  );
}
