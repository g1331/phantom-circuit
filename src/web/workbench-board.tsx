import { useMemo, useState } from 'react';
import type { WorkflowPage } from '../shared/intake.ts';
import type { Snapshot, Task } from '../shared/types.ts';
import type { TeamView, TeamWork } from '../shared/team.ts';
import { WorkTrajectory } from './workbench-work.tsx';
import { InputTrajectory } from './workbench-input.tsx';
import { useLocale } from './locale/provider.tsx';
import type { FlowEntry } from './workbench-model.ts';
import { useInputSummaries } from './use-input-summaries.ts';
import { WorkCanvas } from './workbench-canvas.tsx';
import { WorkbenchAttention } from './workbench-attention.tsx';
import { routeHref } from './route.ts';
import { useWhen } from './work-list.tsx';

export type FlowFilter = 'all' | 'active' | 'inputs' | 'delivered';
export type FlowRow =
  | { kind: 'input'; id: string; at: string; active: boolean; entry: FlowEntry }
  | {
      kind: 'work';
      id: string;
      at: string;
      active: boolean;
      task: Task;
      work: TeamWork;
      entry?: FlowEntry;
    };

function rowsFor(state: Snapshot, team: TeamView, page?: WorkflowPage): FlowRow[] {
  const work = new Map(team.work.map((item) => [item.taskId, item]));
  const inputs = page?.inputs ?? [];
  const byInput = new Map(inputs.map((entry) => [entry.input.id, entry]));
  const bound = new Map<string, FlowEntry>();
  for (const entry of inputs) {
    if (entry.assessment.disposition.status === 'accepted')
      bound.set(entry.assessment.disposition.taskId, entry);
  }
  const rows: FlowRow[] = state.tasks.flatMap((task) => {
    const item = work.get(task.id);
    return item
      ? [
          {
            kind: 'work',
            id: task.id,
            at: task.createdAt,
            active: !['done', 'cancelled'].includes(task.stage),
            task,
            work: item,
            entry: task.issueOrigin ? byInput.get(task.issueOrigin.inputId) : bound.get(task.id),
          },
        ]
      : [];
  });
  const taskIds = new Set(rows.map((row) => row.id));
  for (const entry of inputs) {
    const disposition = entry.assessment.disposition;
    if (disposition.status === 'accepted' && taskIds.has(disposition.taskId)) continue;
    rows.push({
      kind: 'input',
      id: entry.input.id,
      at: entry.input.observedAt,
      active: ['queued', 'assessing', 'awaiting_decision', 'unavailable'].includes(
        disposition.status,
      ),
      entry,
    });
  }
  return rows.sort(
    (a, b) =>
      Number(b.active) - Number(a.active) || b.at.localeCompare(a.at) || a.id.localeCompare(b.id),
  );
}

export function WorkflowBoard({
  projectId,
  state,
  team,
  page,
  filter,
  loading,
  more,
  query = '',
}: {
  projectId: string;
  state: Snapshot;
  team: TeamView;
  page?: WorkflowPage;
  filter: FlowFilter;
  query?: string;
  loading: boolean;
  more: () => Promise<void>;
}) {
  const { t, host } = useLocale();
  const when = useWhen();
  const [count, setCount] = useState(8);
  const rows = useMemo(() => rowsFor(state, team, page), [state, team, page]);
  const filtered =
    filter === 'inputs'
      ? (page?.inputs ?? []).map((entry): FlowRow => ({
          kind: 'input',
          id: entry.input.id,
          at: entry.input.observedAt,
          active: true,
          entry,
        }))
      : rows.filter((row) =>
          filter === 'active'
            ? row.active
            : filter === 'delivered'
              ? row.kind === 'work' && row.task.stage === 'done'
              : true,
        );
  const needle = query.trim().toLocaleLowerCase();
  const matches = filtered.filter((row) => {
    const text =
      row.kind === 'input'
        ? `${row.entry.input.title} ${row.entry.input.number} ${row.entry.input.actor.login}`
        : `${row.task.title} ${row.task.issue ?? ''} ${row.task.pr ?? ''}`;
    return text.toLocaleLowerCase().includes(needle);
  });
  const recent = rows
    .filter(
      (row): row is Extract<FlowRow, { kind: 'work' }> =>
        row.kind === 'work' && row.task.stage === 'done',
    )
    .sort((a, b) =>
      (b.work.settledAt ?? b.work.updatedAt).localeCompare(a.work.settledAt ?? a.work.updatedAt),
    )
    .slice(0, 3);
  const visible = matches.slice(0, count);
  const ids = visible.flatMap((row) =>
    row.kind === 'work' && row.task.issueOrigin && !row.entry ? [row.task.issueOrigin.inputId] : [],
  );
  const summaries = useInputSummaries(projectId, ids, state.events[0]?.id);
  const related = new Map(summaries.entries.map((entry) => [entry.input.id, entry]));
  async function loadMore() {
    if (matches.length > count) setCount((value) => value + 8);
    else {
      await more();
      setCount((value) => value + 8);
    }
  }
  return (
    <div className="flow-board" data-empty={!matches.length} aria-label={t('flow.work')}>
      <div className="workbench-attention">
        <WorkbenchAttention state={state} team={team} projectId={projectId} page={page} />
      </div>
      {!matches.length && (
        <section className="flow-empty">
          <h2>
            {loading
              ? t('connection.loading')
              : t(
                  query || filter !== 'active'
                    ? 'flow.work'
                    : team.members.length
                      ? 'flow.live'
                      : 'home.status.idle',
                )}
          </h2>
          <p>{t(query || filter !== 'active' ? 'flow.emptyFilter' : 'flow.empty')}</p>
          {filter === 'active' && !query && recent.length > 0 && (
            <div className="flow-recent">
              <h3>{t('flow.recent')}</h3>
              {recent.map((row) => (
                <a key={row.id} href={routeHref({ page: 'task', projectId, taskId: row.id })}>
                  <span>{row.task.title}</span>
                  <time dateTime={row.work.settledAt ?? row.work.updatedAt}>
                    {when(row.work.settledAt ?? row.work.updatedAt)}
                  </time>
                </a>
              ))}
            </div>
          )}
        </section>
      )}
      {summaries.error && (
        <div className="error-inline" role="alert">
          {host(summaries.error.message)}
        </div>
      )}
      {visible.length > 0 && (
        <WorkCanvas
          key={`${projectId}:${filter}:${query}`}
          items={visible}
          state={state}
          projectId={projectId}
          renderItem={(row) =>
            row.kind === 'input' ? (
              <InputTrajectory entry={row.entry} />
            ) : (
              <WorkTrajectory
                task={row.task}
                work={row.work}
                state={state}
                entry={
                  row.entry ??
                  (row.task.issueOrigin ? related.get(row.task.issueOrigin.inputId) : undefined)
                }
              />
            )
          }
        />
      )}
      {(matches.length > count || page?.next) && (
        <button
          className="flow-more secondary-button"
          disabled={loading}
          onClick={() => void loadMore()}
        >
          {t('flow.more')}
        </button>
      )}
    </div>
  );
}
