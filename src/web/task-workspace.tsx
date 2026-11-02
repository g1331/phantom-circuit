import { ArrowUpRight, Check, Circle, GitPullRequest, Layers3, Pause } from 'lucide-react';
import type { Repo, SchedulingExplanation, Snapshot, Stage, Task } from '../shared/types.ts';
import { stageLabels } from '../shared/types.ts';
import { PriorityBadge, ClaimOrder } from './task-priority.tsx';
import { TaskRuntimeBadges } from './project-actions.tsx';
import { useLocale } from './locale/provider.tsx';
import { Empty } from './ui.tsx';
import { taskAttention } from '../shared/task-history.ts';

export const profileKeys = {
  backend: 'profile.backend',
  frontend: 'profile.frontend',
  fullstack: 'profile.fullstack',
  complex: 'profile.complex',
  pm: 'profile.pm',
  review: 'profile.review',
} as const;

export interface TaskFilters {
  stage: string;
  control: string;
  query: string;
  view: 'board' | 'list';
}

const stages = Object.keys(stageLabels) as Stage[];

/** Card tone: what needs the user's eye first. */
function tone(task: Task) {
  const attention = taskAttention(task);
  if (attention.blocked) return 'blocked';
  if (attention.paused) return 'paused';
  if (task.stage === 'done') return 'done';
  if (['developing', 'reviewing', 'merging'].includes(task.stage)) return 'moving';
  return 'idle';
}

function TaskRefs({ task }: { task: Task }) {
  if (!task.issue && !task.pr) return null;
  return (
    <span className="task-refs">
      {task.issue ? <span>#{task.issue}</span> : null}
      {task.pr ? (
        <span>
          <GitPullRequest size={12} aria-hidden /> {task.pr}
        </span>
      ) : null}
    </span>
  );
}

export function TaskWorkspace({
  state,
  tasks,
  repos,
  filters,
  setFilters,
  schedule,
  scheduleError,
  scheduleLoading,
  onRefreshSchedule,
  onOpen,
}: {
  state: Snapshot;
  tasks: Task[];
  repos: Repo[];
  filters: TaskFilters;
  setFilters: (next: TaskFilters) => void;
  schedule?: SchedulingExplanation;
  scheduleError: string;
  scheduleLoading: boolean;
  onRefreshSchedule: () => void;
  onOpen: (taskId: string) => void;
}) {
  const { t, host, number, locale } = useLocale();
  const shown = tasks.filter(
    (task) =>
      (filters.stage === 'all' ||
        (filters.stage === 'active'
          ? !['done', 'cancelled'].includes(task.stage)
          : task.stage === filters.stage)) &&
      (filters.control === 'all' ||
        (filters.control === 'paused'
          ? taskAttention(task).paused
          : !taskAttention(task).paused)) &&
      `${task.title} ${task.spec}`.toLowerCase().includes(filters.query.toLowerCase()),
  );
  const repoName = (task: Task) => repos.find((repo) => repo.id === task.repoId)?.name;
  const columns = stages.filter(
    (stage) => !stages.includes(filters.stage as Stage) || stage === filters.stage,
  );
  return (
    <div className="task-workspace">
      <ClaimOrder
        schedule={schedule}
        projects={state.projects}
        locale={locale}
        refresh={onRefreshSchedule}
        error={scheduleError}
        refreshing={scheduleLoading}
      />
      <div className="list-toolbar">
        <input
          type="search"
          aria-label={t('tasks.search')}
          placeholder={t('tasks.searchPlaceholder')}
          value={filters.query}
          onChange={(e) => setFilters({ ...filters, query: e.target.value })}
        />
        <select
          aria-label={t('tasks.filter')}
          value={filters.stage}
          onChange={(e) => setFilters({ ...filters, stage: e.target.value })}
        >
          <option value="all">{t('tasks.all')}</option>
          <option value="active">{t('tasks.active')}</option>
          {stages.map((stage) => (
            <option key={stage} value={stage}>
              {t(`stage.${stage}`)}
            </option>
          ))}
        </select>
        <select
          aria-label={t('tasks.control')}
          value={filters.control}
          onChange={(e) => setFilters({ ...filters, control: e.target.value })}
        >
          <option value="all">{t('tasks.allControls')}</option>
          <option value="active">{t('tasks.activeControl')}</option>
          <option value="paused">{t('tasks.pausedControl')}</option>
        </select>
        <div className="view-switch" role="group" aria-label={t('tasks.view')}>
          {(['board', 'list'] as const).map((mode) => (
            <button
              key={mode}
              aria-pressed={filters.view === mode}
              onClick={() => {
                setFilters({ ...filters, view: mode });
                localStorage.setItem('phantom.taskView', mode);
              }}
            >
              {t(`tasks.${mode}`)}
            </button>
          ))}
        </div>
      </div>
      {filters.view === 'board' ? (
        <div className="task-board" tabIndex={0} aria-label={t('tasks.board')}>
          {columns.map((stage) => {
            const column = shown.filter((task) => task.stage === stage);
            return (
              <section
                className={`board-column ${column.length ? '' : 'empty'}`}
                key={stage}
                aria-label={t(`stage.${stage}`)}
              >
                <h3>
                  <span className={`stage-dot ${stage}`} aria-hidden />
                  {t(`stage.${stage}`)} <span>{number(column.length)}</span>
                </h3>
                {column.map((task) => (
                  <button
                    className={`task-card tone-${tone(task)}`}
                    key={task.id}
                    onClick={() => onOpen(task.id)}
                  >
                    <strong>{task.title}</strong>
                    <span className="task-meta">
                      {repoName(task)} · {t(profileKeys[task.profile])}
                      <TaskRefs task={task} />
                    </span>
                    <span className="task-badges">
                      <PriorityBadge value={task.priority} locale={locale} />
                      <TaskRuntimeBadges state={state} taskId={task.id} />
                      {!!task.dependencies.length && (
                        <span className="task-dependencies">
                          {t('tasks.dependencies', { count: task.dependencies.length })}
                        </span>
                      )}
                    </span>
                    {taskAttention(task).paused && !taskAttention(task).blocked && (
                      <em>{t('tasks.pausedControl')}</em>
                    )}
                    {taskAttention(task).blocked && (
                      <em>{host(task.blocked!, task.blockedDescriptor)}</em>
                    )}
                  </button>
                ))}
                {!column.length && <p className="muted">{t('tasks.columnEmpty')}</p>}
              </section>
            );
          })}
        </div>
      ) : shown.length ? (
        <div className="task-list">
          {shown.map((task) => (
            <button
              className={`task-row tone-${tone(task)}`}
              key={task.id}
              onClick={() => onOpen(task.id)}
            >
              <span className={`task-icon ${task.stage}`}>
                {task.stage === 'done' ? (
                  <Check size={17} />
                ) : taskAttention(task).blocked ? (
                  <Pause size={17} />
                ) : (
                  <Circle size={16} />
                )}
              </span>
              <div className="task-row-main">
                <strong>{task.title}</strong>
                <PriorityBadge value={task.priority} locale={locale} />
                <TaskRuntimeBadges state={state} taskId={task.id} />
                <span>
                  {repoName(task)} <i>·</i> {t(profileKeys[task.profile])}{' '}
                  {taskAttention(task).blocked && (
                    <em>· {host(task.blocked!, task.blockedDescriptor)}</em>
                  )}
                </span>
              </div>
              <TaskRefs task={task} />
              <span className={`stage ${task.stage}`}>
                {t(`stage.${task.stage}`)}
                {taskAttention(task).paused && <> · {t('tasks.pausedControl')}</>}
              </span>
              <ArrowUpRight size={14} />
            </button>
          ))}
        </div>
      ) : (
        <Empty
          icon={<Layers3 size={26} />}
          title={t('tasks.emptyTitle')}
          text={t('tasks.emptyDescription')}
        />
      )}
    </div>
  );
}
