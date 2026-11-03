import { Activity } from 'lucide-react';
import type { Snapshot, Task } from '../shared/types.ts';
import { TaskRuntimeBadges } from './project-actions.tsx';
import { RunRecord } from './usage-panel.tsx';
import { useLocale } from './locale/provider.tsx';
import { isRunning } from './sidebar.tsx';
import { Empty, unset } from './ui.tsx';

type Run = Snapshot['runs'][number];

export function RunList({ state, runs, tasks }: { state: Snapshot; runs: Run[]; tasks: Task[] }) {
  const { t, time, host, duration } = useLocale();
  if (!runs.length)
    return (
      <div className="run-workspace">
        <Empty
          icon={<Activity size={26} />}
          title={t('runs.emptyTitle')}
          text={t('runs.emptyDescription')}
        />
      </div>
    );
  const statusLabel = {
    running: t('ui.running'),
    waiting: t('ui.waiting'),
    paused: t('ui.paused'),
    interrupted: t('ui.interrupted'),
    failed: t('ui.failed'),
    completed: t('ui.completed'),
    queued: t('ui.queued'),
  };
  const title = (run: Run) =>
    tasks.find((task) => task.id === run.taskId)?.title ??
    t('ui.projectRequirementsAndCoordination');
  // Consecutive Runs for the same work share one heading.
  const groups: Run[][] = [];
  for (const run of runs.slice().reverse()) {
    const last = groups.at(-1);
    if (last && last[0].taskId === run.taskId) last.push(run);
    else groups.push([run]);
  }
  return (
    <div className="run-workspace">
      {groups.map((group) => (
        <section className="run-group" key={group[0].id} aria-label={title(group[0])}>
          <h3>{title(group[0])}</h3>
          {group.map((r) => (
            <div className={`run-row status-${r.status}`} key={r.id}>
              <span className={`status-dot ${isRunning(r.status) ? 'live' : ''}`} />
              <div>
                <strong>
                  {t(`team.role.${r.role}`)} <RunModel run={r} />
                </strong>
                {r.error && <em>{host(r.error, r.errorDescriptor)}</em>}
                <TaskRuntimeBadges state={state} taskId={r.taskId} runId={r.id} />
                <RunRecord run={r} />
              </div>
              <div className="run-meta">
                <span className={`run-status ${r.status}`}>{statusLabel[r.status]}</span>
                <span>
                  {r.endedAt && (
                    <span className="run-duration">
                      {duration((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000)} ·{' '}
                    </span>
                  )}
                  <time dateTime={r.startedAt}>{time(r.startedAt)}</time>
                </span>
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/** Which model ran: a Run that started before anyone configured one says so plainly. */
function RunModel({ run: r }: { run: Run }) {
  const { t } = useLocale();
  const model = r.modelIdentity?.model ?? r.model?.model ?? r.profileConfig?.model;
  if (model && unset(model)) return <span>{t('runtime.unconfigured')}</span>;
  const provider =
    r.agentKind === 'omp'
      ? (r.modelIdentity?.providerId ?? r.profileConfig?.providerId ?? t('usage.unknown'))
      : r.provider?.kind === 'custom'
        ? r.provider.name
        : t('ui.officialCodexLogin');
  return (
    <span>
      {provider} · {model ?? t('ui.modelNotRecorded')} /{' '}
      {r.profileConfig?.effort ?? t('ui.unknownEffort')}
    </span>
  );
}
