import { useState } from 'react';
import { Activity } from 'lucide-react';
import type { Snapshot, Task } from '../shared/types.ts';
import { RunRow } from './process-record.tsx';
import { useLocale } from './locale/provider.tsx';
import { routeHref } from './route.ts';
import { Empty } from './ui.tsx';

type Run = Snapshot['runs'][number];
const page = 60;

/** Every model run in the project, newest first, consecutive runs of one piece of work together. */
export function RunList({ state, runs, tasks }: { state: Snapshot; runs: Run[]; tasks: Task[] }) {
  const { t } = useLocale();
  const [count, setCount] = useState(page);
  if (!runs.length)
    return (
      <Empty
        icon={<Activity size={26} />}
        title={t('runs.emptyTitle')}
        text={t('runs.emptyDescription')}
      />
    );
  const newest = runs.slice().reverse();
  const groups: Run[][] = [];
  for (const run of newest.slice(0, count)) {
    const last = groups.at(-1);
    if (last && last[0].taskId === run.taskId) last.push(run);
    else groups.push([run]);
  }
  return (
    <section className="run-log" aria-label={t('project.runs')}>
      {groups.map((group) => {
        const task = tasks.find((x) => x.id === group[0].taskId);
        return (
          <section className="run-group" key={group[0].id}>
            <h3>
              {task ? (
                <a
                  href={routeHref({
                    page: 'task',
                    projectId: task.projectId,
                    taskId: task.id,
                    view: 'process',
                  })}
                >
                  {task.title}
                </a>
              ) : (
                t('ui.projectRequirementsAndCoordination')
              )}
            </h3>
            <ol className="record-list">
              {group.map((run) => (
                <RunRow key={run.id} state={state} run={run} />
              ))}
            </ol>
          </section>
        );
      })}
      {newest.length > count && (
        <button className="record-more" onClick={() => setCount((c) => c + page * 2)}>
          {t('process.earlier', { count: newest.length - count })}
        </button>
      )}
    </section>
  );
}
