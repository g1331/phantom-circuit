import { useMemo, useState } from 'react';
import {
  ArrowRight,
  CircleDashed,
  CircleDot,
  GitMerge,
  CirclePause,
  CircleX,
  Hand,
} from 'lucide-react';
import type { Project, Snapshot } from '../shared/types.ts';
import {
  maxReworks,
  teamView,
  workGroup,
  workGroups,
  type TeamWork,
  type TeamRequest,
  type WorkGroup,
} from '../shared/team.ts';
import { useLocale } from './locale/provider.tsx';
import { incidentAttention } from '../shared/task-history.ts';
import { routeHref } from './route.ts';
import { Empty } from './ui.tsx';
import { EngineeringReference } from './engineering-reference.tsx';
import { WorkHold } from './work-hold.tsx';

const icons: Record<WorkGroup, typeof CircleDot> = {
  needs_you: Hand,
  moving: CircleDot,
  paused: CirclePause,
  queued: CircleDashed,
  delivered: GitMerge,
  cancelled: CircleX,
};
/** Long finished groups show their newest entries until asked for the rest. */
const preview = 8;

/** Today's times read as a clock; older ones carry the date. */
export function useWhen() {
  const { date, time } = useLocale();
  return (value: string) =>
    new Date(value).toDateString() === new Date().toDateString()
      ? time(value)
      : date(value, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Row({
  work,
  group,
  state,
  projectId,
  repoName,
  activity,
  request,
  selected,
}: {
  work: TeamWork;
  group: WorkGroup;
  state: Snapshot;
  projectId: string;
  repoName?: string;
  activity?: string;
  request?: string;
  selected: boolean;
}) {
  const { t } = useLocale();
  const when = useWhen();
  const task = state.tasks.find((x) => x.id === work.taskId)!;
  const Icon = icons[group];
  const waitsOn = task.dependencies
    .map((id) => state.tasks.find((x) => x.id === id))
    .filter((x) => x && x.stage !== 'done' && x.stage !== 'cancelled')
    .map((x) => x!.title);
  // Delivered work can still carry a live problem (a failed sync after merge); say so in the list.
  const issue =
    group === 'delivered' &&
    (state.incidents ?? []).some(
      (i) => i.taskId === task.id && incidentAttention(i, task).actionable,
    );
  const line = issue
    ? t('work.deliveredIssue')
    : group === 'needs_you'
      ? request || t('team.attention.needs_user')
      : group === 'paused'
        ? task.pausedByUser
          ? t('work.pausedByYou')
          : t('team.attention.paused')
        : group === 'queued'
          ? waitsOn.length
            ? t('work.waitingOn', { titles: waitsOn.join('、') })
            : t('work.queuedNext')
          : group === 'delivered'
            ? t('work.deliveredAt', { time: when(work.settledAt ?? work.updatedAt) })
            : group === 'cancelled'
              ? t('work.cancelledAt', { time: when(work.settledAt ?? work.updatedAt) })
              : [t(`team.step.${work.step}`), activity].filter(Boolean).join(' · ');
  return (
    <li>
      <a
        className={`work-row group-${group} ${work.teamHold === 'blocked' ? 'hold-blocked' : ''}`}
        href={routeHref({ page: 'task', projectId, taskId: work.taskId })}
        aria-current={selected ? 'page' : undefined}
        data-selected={selected || undefined}
      >
        <Icon className="work-icon" size={16} aria-hidden="true" />
        <span className="work-main">
          <strong title={work.title}>{work.title}</strong>
          <span
            className={`work-line ${issue || work.teamHold === 'blocked' ? 'has-issue' : ''}`}
            title={work.teamHold ? undefined : line}
          >
            {work.teamHold ? <WorkHold work={work} /> : line}
          </span>
        </span>
        <span className="work-meta">
          {work.rounds > 0 && group !== 'delivered' && group !== 'cancelled' && (
            <span className={`work-rework ${work.rounds >= maxReworks ? 'at-limit' : ''}`}>
              {t('work.rework', { count: work.rounds, max: maxReworks })}
            </span>
          )}
          {repoName && <span className="work-repo">{repoName}</span>}
          {task.pr ? <EngineeringReference task={task} kind="pr" linked={false} /> : null}
        </span>
        <ArrowRight className="work-go" size={14} aria-hidden="true" />
      </a>
    </li>
  );
}

function ProjectRequestRow({ request, projectId }: { request: TeamRequest; projectId: string }) {
  const { t } = useLocale();
  return (
    <li>
      <a
        className="work-row group-needs_you"
        href={routeHref({ page: 'home', projectId, view: request.id })}
      >
        <Hand className="work-icon" size={16} aria-hidden="true" />
        <span className="work-main">
          <strong title={request.text}>{request.text}</strong>
          <span className="work-line">
            {t(`team.request.${request.kind}`)} · {t('brief.inConversation')}
          </span>
        </span>
        <ArrowRight className="work-go" size={14} aria-hidden="true" />
      </a>
    </li>
  );
}

/** Every piece of work, grouped by what it asks of the user rather than by host stage. */
export function WorkList({
  state,
  project,
  query,
  setQuery,
  selectedId,
}: {
  state: Snapshot;
  project: Project;
  /** Held by the app, so a search survives opening a piece of work and coming back. */
  query: string;
  setQuery: (query: string) => void;
  selectedId?: string;
}) {
  const { t, number } = useLocale();
  const [expanded, setExpanded] = useState<Partial<Record<WorkGroup, boolean>>>({});
  const view = useMemo(() => teamView(state, project.id), [state, project.id]);
  const repos = new Map(state.repos.map((r) => [r.id, r.name]));
  const multiRepo = state.repos.filter((r) => r.projectId === project.id).length > 1;
  const specs = new Map(state.tasks.map((x) => [x.id, x]));
  const needle = query.trim().toLowerCase();
  const projectRequests = view.waiting.filter((request) => !request.taskId);
  const shownRequests = projectRequests.filter(
    (request) => !needle || request.text.toLowerCase().includes(needle),
  );
  const shown = view.work.filter(
    (w) =>
      !needle || `${w.title} ${specs.get(w.taskId)?.spec ?? ''}`.toLowerCase().includes(needle),
  );
  const groups = workGroups
    .map((group) => ({
      group,
      items: shown.filter((w) => workGroup(w) === group),
      requests: group === 'needs_you' ? shownRequests : [],
    }))
    .filter((g) => g.items.length || g.requests.length);
  const activity = (taskId: string) => {
    const member = view.members.find((m) => m.taskId === taskId);
    return member ? `${t(`team.role.${member.role}`)} ${t(`team.doing.${member.activity}`)}` : '';
  };
  return (
    <div className="page work-page">
      <header className="page-header work-header">
        {selectedId === undefined ? <h1>{t('work.title')}</h1> : <h2>{t('work.title')}</h2>}
        {(view.work.length > 0 || projectRequests.length > 0) && (
          <input
            type="search"
            className="work-search"
            aria-label={t('work.search')}
            placeholder={t('work.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
      </header>
      {!view.work.length && !projectRequests.length ? (
        <Empty icon={<CircleDashed size={26} />} title={t('work.title')} text={t('work.empty')} />
      ) : !groups.length ? (
        <p className="work-none">{t('work.noMatch')}</p>
      ) : (
        groups.map(({ group, items, requests }) => {
          const folded = (group === 'delivered' || group === 'cancelled') && !needle;
          const selectedIndex = items.findIndex((item) => item.taskId === selectedId);
          const visible =
            folded && !expanded[group]
              ? items.slice(0, Math.max(preview, selectedIndex + 1))
              : items;
          const body = (
            <>
              <ul className="work-rows">
                {requests.map((request) => (
                  <ProjectRequestRow key={request.id} request={request} projectId={project.id} />
                ))}
                {visible.map((work) => (
                  <Row
                    key={work.taskId}
                    work={work}
                    selected={selectedId === work.taskId}
                    group={group}
                    state={state}
                    projectId={project.id}
                    repoName={multiRepo ? repos.get(specs.get(work.taskId)!.repoId) : undefined}
                    activity={activity(work.taskId)}
                    request={view.waiting.find((r) => r.taskId === work.taskId)?.text}
                  />
                ))}
              </ul>
              {visible.length < items.length && (
                <button
                  className="work-show-all"
                  onClick={() => setExpanded((e) => ({ ...e, [group]: true }))}
                >
                  {t('work.showAll', { count: items.length })}
                </button>
              )}
            </>
          );
          const heading = (
            <>
              {t(`work.group.${group}`)} <span>{number(items.length + requests.length)}</span>
            </>
          );
          return group === 'cancelled' && !needle ? (
            <details
              key={group}
              className={`work-group group-${group}`}
              open={items.some((item) => item.taskId === selectedId) || undefined}
            >
              <summary>{heading}</summary>
              {body}
            </details>
          ) : (
            <section
              key={group}
              className={`work-group group-${group}`}
              aria-label={t(`work.group.${group}`)}
            >
              <h2>{heading}</h2>
              {body}
            </section>
          );
        })
      )}
    </div>
  );
}
