import { useMemo } from 'react';
import { ArrowLeft, Undo2, UserRoundPlus } from 'lucide-react';
import type { SchedulingExplanation, Snapshot } from '../shared/types.ts';
import { maxReworks, teamView, workGroup } from '../shared/team.ts';
import { api } from './api.ts';
import { DeferredTaskDetail } from './deferred-panels.tsx';
import { useLocale } from './locale/provider.tsx';
import { routeHref } from './route.ts';

export const profileKeys = {
  backend: 'profile.backend',
  frontend: 'profile.frontend',
  fullstack: 'profile.fullstack',
  complex: 'profile.complex',
  pm: 'profile.pm',
  review: 'profile.review',
} as const;

/** One piece of work as an addressable page: where it stands, its receipt, then the detail. */
export function TaskPage({
  state,
  projectId,
  taskId,
  schedule,
  busy,
  act,
  reload,
  onDraft,
}: {
  state: Snapshot;
  projectId: string;
  taskId: string;
  schedule?: SchedulingExplanation;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  reload: () => Promise<void>;
  /** Prefills the liaison conversation, for requests that become new work (a rollback). */
  onDraft: (content: string) => void;
}) {
  const { t } = useLocale();
  const task = state.tasks.find((x) => x.id === taskId && x.projectId === projectId);
  const view = useMemo(() => teamView(state, projectId), [state, projectId]);
  const work = view.work.find((w) => w.taskId === taskId);
  const member = view.members.find((m) => m.taskId === taskId);
  const back = (
    <a className="page-back" href={routeHref({ page: 'work', projectId })}>
      <ArrowLeft size={14} /> {t('work.back')}
    </a>
  );
  if (!task || !work)
    return (
      <div className="page task-page">
        {back}
        <p className="work-none">{t('task.notFound')}</p>
      </div>
    );
  const group = workGroup(work);
  const devWorking = view.members.some((m) => m.taskId === taskId && m.role === 'dev');
  // A fresh developer only helps unfinished work that already has code and nobody on it now.
  const canReassign = !!task.worktree && !['done', 'cancelled'].includes(task.stage) && !devWorking;
  const stuck = canReassign && (work.rounds >= maxReworks || work.attention === 'blocked');
  const reassign = (
    <button
      className={stuck ? 'primary-button' : 'secondary-button'}
      disabled={busy}
      onClick={() => void act(() => api(`/tasks/${task.id}/reassign`, {}))}
    >
      <UserRoundPlus size={14} /> {t('task.reassign')}
    </button>
  );
  return (
    <div className="page task-page">
      {back}
      <header className="page-header task-header">
        <h1>{task.title}</h1>
        <p className={`task-status group-${group}`}>
          <span className="task-status-group">{t(`work.group.${group}`)}</span>
          {group === 'moving' && <span>{t(`team.step.${work.step}`)}</span>}
          {member && (
            <span>
              {t(`team.role.${member.role}`)} · {t(`team.doing.${member.activity}`)}
            </span>
          )}
          <span>{t(profileKeys[task.profile])}</span>
        </p>
        <div className="task-interventions">
          {canReassign && !stuck && reassign}
          {task.stage === 'done' && (
            <button
              className="secondary-button"
              onClick={() =>
                onDraft(
                  t('task.rollbackDraft', {
                    title: task.title,
                    pr: task.pr ? ` (PR #${task.pr})` : '',
                  }),
                )
              }
            >
              <Undo2 size={14} /> {t('task.rollback')}
            </button>
          )}
        </div>
      </header>
      {stuck && (
        // The team surfaces the control that fits the trouble it sees (ADR 0013).
        <div className="task-trouble" role="status">
          <p>
            <strong>{t('task.trouble')}</strong> {t('task.reassignHint')}
          </p>
          {reassign}
        </div>
      )}
      <DeferredTaskDetail
        key={task.id}
        task={task}
        state={state}
        schedule={schedule}
        busy={busy}
        act={act}
        reload={reload}
      />
    </div>
  );
}
