import { useLayoutEffect, useMemo, useRef } from 'react';
import { ArrowLeft, Pause, Play, Undo2, UserRoundPlus } from 'lucide-react';
import type { Message, SchedulingExplanation, Snapshot } from '../shared/types.ts';
import { maxReworks, teamView, workGroup } from '../shared/team.ts';
import {
  externalDeliveryHold,
  isExternalDelivery,
  taskDeliveryPR,
} from '../shared/task-history.ts';
import { api } from './api.ts';
import { DeferredTaskDetail } from './deferred-panels.tsx';
import { Fold, PageTabs } from './fold.tsx';
import { TaskExperience } from './task-experience.tsx';
import type { TaskView } from './task-detail.tsx';
import { useLocale } from './locale/provider.tsx';
import { routeHref } from './route.ts';
import { deliveryPRUrl, EngineeringReference } from './engineering-reference.tsx';
import { WorkSummary } from './workbench-task-summary.tsx';

export const profileKeys = {
  backend: 'profile.backend',
  frontend: 'profile.frontend',
  fullstack: 'profile.fullstack',
  complex: 'profile.complex',
  pm: 'profile.pm',
  review: 'profile.review',
} as const;

export type TaskDraft = { content: string; intent: NonNullable<Message['intent']> };

/** One piece of work as an addressable page: where it stands, its receipt, then the detail. */
export function TaskPage({
  state,
  projectId,
  taskId,
  view: requested,
  schedule,
  busy,
  act,
  reload,
  onDraft,
}: {
  state: Snapshot;
  projectId: string;
  taskId: string;
  view?: string;
  schedule?: SchedulingExplanation;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  reload: () => Promise<void>;
  onDraft: (draft: TaskDraft) => void;
}) {
  const { t } = useLocale();
  const surface = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    surface.current?.focus({ preventScroll: true });
    surface.current?.scrollTo({ top: 0 });
  }, [projectId, taskId]);
  const task = state.tasks.find((x) => x.id === taskId && x.projectId === projectId);
  const view = useMemo(() => teamView(state, projectId), [state, projectId]);
  const work = view.work.find((w) => w.taskId === taskId);
  const back = (
    <a className="page-back" href={routeHref({ page: 'home', projectId })}>
      <ArrowLeft size={14} /> {t('flow.close')}
    </a>
  );
  if (!task || !work)
    return (
      <div className="page task-page" ref={surface} tabIndex={-1}>
        {back}
        <p className="work-none">{t('task.notFound')}</p>
      </div>
    );
  const group = workGroup(work);
  const finished = task.stage === 'done' || task.stage === 'cancelled';
  const held = externalDeliveryHold(task);
  const section: TaskView =
    requested === 'spec' || requested === 'process' ? requested : 'overview';
  const rounds = task.feedback.length + (task.pendingFeedback?.length ?? 0);
  const devWorking = view.members.some((m) => m.taskId === taskId && m.role === 'dev');
  // A fresh developer only helps unfinished work that already has code and nobody on it now.
  const canReassign = !!task.worktree && !finished && !held && !devWorking;
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
    <div className="page task-page" ref={surface} tabIndex={-1} aria-label={task.title}>
      {back}
      <header className="page-header task-header">
        <h1>{task.title}</h1>
        <p
          className={`task-status group-${group}`}
          data-hold={work.teamHold}
          data-external-pending={held || undefined}
        >
          <span className="task-status-group">
            {work.attention === 'needs_user'
              ? t('team.attention.needs_user')
              : isExternalDelivery(task)
                ? t('receipt.external')
                : work.externalDeliveryPending
                  ? t(work.externalMergePending ? 'task.remoteMerged' : 'task.externalPending')
                  : work.teamHold
                    ? t(`work.hold.${work.teamHold}`)
                    : t(`work.group.${group}`)}
          </span>
          {group === 'moving' && !work.teamHold && <span>{t(`team.step.${work.step}`)}</span>}
        </p>
      </header>
      <PageTabs
        label={t('tabs.task')}
        route={{ page: 'task', projectId, taskId }}
        current={section}
        tabs={[
          { view: 'overview', label: t('task.tab.overview') },
          { view: 'spec', label: t('task.tab.spec'), count: rounds },
          { view: 'process', label: t('task.tab.process') },
        ]}
      />
      {stuck && (
        <div className="task-trouble" role="status">
          <p>
            <strong>{t('task.trouble')}</strong> {t('task.reassignHint')}
          </p>
          {reassign}
        </div>
      )}
      {section === 'overview' && <WorkSummary task={task} state={state} />}
      <DeferredTaskDetail
        key={task.id}
        view={section}
        task={task}
        state={state}
        schedule={schedule}
        busy={busy}
        act={act}
        reload={reload}
        experience={
          task.stage === 'done' || held ? (
            <TaskExperience task={task} state={state} onDraft={onDraft} />
          ) : (
            <div className="task-collaborate">
              <button
                className="secondary-button"
                onClick={() =>
                  onDraft({
                    content: t('task.discussDraft', { title: task.title }),
                    intent: 'discuss',
                  })
                }
              >
                {t('task.discuss')}
              </button>
            </div>
          )
        }
      />
      <Fold className="task-controls" title={t('task.controls')}>
        {!finished && !held && <p className="muted task-control-hint">{t('task.controlHint')}</p>}
        <div className="task-interventions" role="group" aria-label={t('task.controls')}>
          {canReassign && !stuck && reassign}
          {task.stage === 'done' && (
            <button
              className="secondary-button"
              onClick={() =>
                onDraft({
                  content: t('task.rollbackDraft', {
                    title: task.title,
                    pr: taskDeliveryPR(task) ? ` (PR #${taskDeliveryPR(task)})` : '',
                  }),
                  intent: 'implement',
                })
              }
            >
              <Undo2 size={14} /> {t('task.rollback')}
            </button>
          )}
          {!finished && !held && (
            <>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    api(`/tasks/${task.id}/${task.control === 'paused' ? 'resume' : 'pause'}`, {}),
                  )
                }
              >
                {task.control === 'paused' ? <Play size={14} /> : <Pause size={14} />}{' '}
                {task.control === 'paused' ? t('ui.resumeTask') : t('ui.pauseTask')}
              </button>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() => void act(() => api(`/tasks/${task.id}/cancel`, {}))}
              >
                {t('ui.cancelTask')}
              </button>
            </>
          )}
          {(task.issueUrl || deliveryPRUrl(task)) && (
            <span className="task-links-gap" aria-hidden="true" />
          )}
          {task.issueUrl && <EngineeringReference task={task} kind="issue" external />}
          {deliveryPRUrl(task) && <EngineeringReference task={task} kind="pr" external />}
        </div>
        <p className="muted task-technical-profile">{t(profileKeys[task.profile])}</p>
      </Fold>
    </div>
  );
}
