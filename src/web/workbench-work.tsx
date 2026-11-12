import {
  ClipboardCheck,
  Code2,
  FlaskConical,
  GitPullRequest,
  Inbox,
  PackageCheck,
  Send,
} from 'lucide-react';
import type { Snapshot, Task } from '../shared/types.ts';
import type { TeamWork } from '../shared/team.ts';
import { workGroup } from '../shared/team.ts';
import { useLocale } from './locale/provider.tsx';
import { useWhen } from './work-list.tsx';
import { WorkHold } from './work-hold.tsx';
import { routeHref } from './route.ts';
import { workNodes, type FlowEntry, type FlowNode } from './workbench-model.ts';

const icons = {
  source: Inbox,
  judgment: ClipboardCheck,
  dev: Code2,
  tests: FlaskConical,
  review: GitPullRequest,
  outcome: PackageCheck,
  reply: Send,
} satisfies Record<FlowNode['key'], typeof Inbox>;

export function WorkTrajectory({
  task,
  work,
  state,
  entry,
}: {
  task: Task;
  work: TeamWork;
  state: Snapshot;
  entry?: FlowEntry;
}) {
  const copy = useLocale();
  const { t, host } = copy;
  const when = useWhen();
  const group = workGroup(work);
  const nodes = workNodes(task, state, copy, entry).filter(
    (node) => node.key !== 'judgment' && node.key !== 'dev' && (node.key !== 'source' || node.href),
  );
  const live = state.runs.filter((run) => run.taskId === task.id && run.status === 'running');
  const last = state.events.find(
    (event) =>
      event.taskId === task.id && (!live.length || live.some((run) => run.id === event.runId)),
  );
  const detailHref = routeHref({ page: 'task', projectId: task.projectId, taskId: task.id });
  return (
    <article className={`flow-work group-${group}`} data-task-id={task.id}>
      <header className="flow-work-heading">
        <a className="flow-work-title" href={detailHref}>
          {task.title}
        </a>
        <span className={`flow-work-state group-${group}`}>
          {work.teamHold ? (
            <WorkHold work={work} />
          ) : (
            t(group === 'moving' ? `team.step.${work.step}` : `work.group.${group}`)
          )}
        </span>
      </header>
      <div className="flow-work-meta">
        {entry && <span>{entry.input.actor.login}</span>}
        <time dateTime={work.settledAt ?? work.updatedAt}>
          {when(work.settledAt ?? work.updatedAt)}
        </time>
        {live.map((run) => (
          <span key={run.id} className="flow-role">
            {t(`team.role.${run.role}`)} · {t('ui.running')}
          </span>
        ))}
      </div>
      {nodes.length > 0 && (
        <ol className="flow-trajectory" aria-label={t('flow.work')}>
          {nodes.map((node) => {
            const Icon = icons[node.key];
            return (
              <li
                key={node.key}
                className={`flow-node tone-${node.tone}`}
                data-step={node.key}
                data-summary={['source', 'outcome', 'reply'].includes(node.key) ? true : undefined}
              >
                <Icon size={16} aria-hidden="true" />
                <div>
                  <span className="flow-node-label">{t(node.label)}</span>
                  {node.href ? (
                    <a href={node.href}>{node.detail}</a>
                  ) : (
                    <strong>{node.detail}</strong>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {last && live.length > 0 && (
        <details className="flow-activity">
          <summary>
            <span>{host(last.message.split('\n')[0], last.descriptor)}</span>
            <time dateTime={last.at}>{when(last.at)}</time>
          </summary>
          <pre>{host(last.message, last.descriptor)}</pre>
        </details>
      )}
      {work.reason && group !== 'delivered' && (
        <div className="flow-work-reason">{host(work.reason)}</div>
      )}
    </article>
  );
}
