import { Github, GitPullRequest, MessageSquare } from 'lucide-react';
import type { Snapshot, Task } from '../shared/types.ts';
import { taskDeliveryPR } from '../shared/task-history.ts';
import { useLocale } from './locale/provider.tsx';
import { useWhen } from './work-list.tsx';
import { useInputSummaries } from './use-input-summaries.ts';
import { routeHref } from './route.ts';
import { workNodes } from './workbench-model.ts';
import { deliveryPRUrl } from './engineering-reference.tsx';

export function WorkSummary({ task, state }: { task: Task; state: Snapshot }) {
  const copy = useLocale();
  const { t, host } = copy;
  const when = useWhen();
  const summaries = useInputSummaries(
    task.projectId,
    task.issueOrigin ? [task.issueOrigin.inputId] : [],
    state.events[0]?.id,
  );
  const entry = summaries.entries.find((item) => item.input.id === task.issueOrigin?.inputId);
  const owner = state.runs.find((run) => run.id === task.ownerRunId);
  const events = state.events
    .filter(
      (event) => event.taskId === task.id && !['command', 'activity', 'sync'].includes(event.type),
    )
    .slice(0, 6)
    .reverse();
  const evidence = workNodes(task, state, copy, entry).filter((node) =>
    ['tests', 'review', 'outcome', 'reply'].includes(node.key),
  );
  const prUrl = deliveryPRUrl(task);
  return (
    <div className="task-focus-summary">
      <section className="task-focus-timeline">
        <h2>{t('flow.work')}</h2>
        <ol>
          <li>
            <time dateTime={entry?.input.observedAt ?? task.createdAt}>
              {when(entry?.input.observedAt ?? task.createdAt)}
            </time>
            <div>
              <strong>{t(entry ? 'flow.received' : 'flow.created')}</strong>
              {entry ? (
                <a
                  href={routeHref({
                    page: 'input',
                    projectId: task.projectId,
                    inputId: entry.input.id,
                  })}
                >
                  GitHub Issue #{entry.input.number}
                </a>
              ) : (
                <span>{task.issueOrigin ? 'GitHub' : t('flow.sourceWeb')}</span>
              )}
            </div>
          </li>
          {events.map((event) => (
            <li key={event.id}>
              <time dateTime={event.at}>{when(event.at)}</time>
              <div>{host(event.message.split('\n')[0], event.descriptor)}</div>
            </li>
          ))}
        </ol>
      </section>
      <aside className="task-focus-facts">
        <dl>
          <div>
            <dt>{t('flow.source')}</dt>
            <dd>
              {task.issueOrigin ? (
                <a
                  href={routeHref({
                    page: 'input',
                    projectId: task.projectId,
                    inputId: task.issueOrigin.inputId,
                  })}
                >
                  <Github size={15} />
                  GitHub Issue #{entry?.input.number ?? task.issue}
                </a>
              ) : (
                <span>
                  <MessageSquare size={15} />
                  {t('flow.sourceWeb')}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>{t('flow.owner')}</dt>
            <dd>
              {owner || task.ownerRunId
                ? t(`team.role.${owner?.role ?? 'dev'}`)
                : t('flow.historyMissing')}
            </dd>
          </div>
          {task.worktree && (
            <div>
              <dt>{t('flow.directory')}</dt>
              <dd className="task-worktree-path" title={task.worktree}>
                {task.worktree}
              </dd>
            </div>
          )}
          {prUrl && (
            <div>
              <dt>{t('flow.outcome')}</dt>
              <dd>
                <a href={prUrl} target="_blank" rel="noreferrer">
                  <GitPullRequest size={15} />
                  PR #{taskDeliveryPR(task)}
                </a>
              </dd>
            </div>
          )}
        </dl>
        <div className="task-focus-evidence">
          {evidence.map((node) => (
            <div key={node.key} data-step={node.key} className={`tone-${node.tone}`}>
              <span>{t(node.label)}</span>
              {node.href ? <a href={node.href}>{node.detail}</a> : <strong>{node.detail}</strong>}
            </div>
          ))}
        </div>
        {summaries.error && (
          <div className="error-inline" role="alert">
            {host(summaries.error.message)}
          </div>
        )}
      </aside>
    </div>
  );
}
