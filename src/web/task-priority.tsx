import React, { useState } from 'react';
import {
  priorityLabel,
  priorityLevels,
  priorityValues,
  priorityNames,
  type PriorityLocale,
  type PriorityLevel,
} from '../shared/priority.ts';
import {
  stageLabels,
  type Task,
  type SchedulingExplanation,
  type Project,
} from '../shared/types.ts';
import { priorityText, schedulingReasonText } from './priority-resources.ts';
import { api } from './api.ts';

export function PriorityBadge({ value, locale }: { value: number; locale: PriorityLocale }) {
  return (
    <span className="priority-badge">
      {priorityText[locale].title}: {priorityLabel(value, locale)}
    </span>
  );
}
export function ClaimConditions({
  entry,
  locale,
}: {
  entry?: SchedulingExplanation['tasks'][number];
  locale: PriorityLocale;
}) {
  if (!entry) return null;
  const text = priorityText[locale];
  return (
    <div className="claim-conditions">
      <strong>{text.waiting}</strong>
      <p>
        {text.stage}: {locale === 'zh-CN' ? stageLabels[entry.stage] : entry.stage}
      </p>
      {entry.reasons.length ? (
        <ul>
          {entry.reasons.map((reason, i) => (
            <li key={i}>
              {schedulingReasonText[locale][reason.code]}
              {reason.detail && `: ${reason.detail}`}
            </li>
          ))}
        </ul>
      ) : (
        <p>{text.eligible}</p>
      )}
    </div>
  );
}
export function ClaimOrder({
  schedule,
  projects,
  locale,
  refresh,
  error,
}: {
  schedule?: SchedulingExplanation;
  projects: Project[];
  locale: PriorityLocale;
  refresh: () => void;
  error: string;
}) {
  const text = priorityText[locale];
  return (
    <section className="claim-order" aria-label={text.schedule}>
      <h3>{text.schedule}</h3>
      <p>{text.scope}</p>
      <button className="secondary-button" onClick={refresh}>
        {text.refresh}
      </button>
      {error && <p role="alert">{text.scheduleFailed}</p>}
      {schedule && (
        <>
          <p>
            {text.updated}:{' '}
            <time dateTime={schedule.at}>{new Date(schedule.at).toLocaleString(locale)}</time> ·{' '}
            {projects.find((p) => p.id === schedule.projectId)?.name}
          </p>
          <p>
            {text.rotation}:{' '}
            {schedule.projectOrder
              .map((id) => projects.find((p) => p.id === id)?.name ?? id)
              .join(' → ')}
          </p>
          {schedule.candidates.length ? (
            <ol>
              {schedule.candidates.map((id) => {
                const task = schedule.tasks.find((t) => t.taskId === id);
                return (
                  <li key={id}>
                    {task?.title ?? id}{' '}
                    {task && <PriorityBadge value={task.priority} locale={locale} />}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p>{text.empty}</p>
          )}
        </>
      )}
    </section>
  );
}
export function PriorityEditor({
  task,
  locale,
  reload,
}: {
  task: Task;
  locale: PriorityLocale;
  reload: () => Promise<void>;
}) {
  const text = priorityText[locale];
  const [level, setLevel] = useState<PriorityLevel | ''>(
    priorityLevels.find((l) => priorityValues[l] === task.priority) ?? '',
  );
  const [reason, setReason] = useState('');
  const [version, setVersion] = useState(task.priorityVersion ?? 0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'saved' | 'conflict' | 'failed' | 'refreshFailed' | ''>('');
  const [request, setRequest] = useState<{ key: string; id: string }>();
  async function save() {
    const key = JSON.stringify([level, reason.trim(), version]);
    const requestId = request?.key === key ? request.id : crypto.randomUUID();
    setRequest({ key, id: requestId });
    setBusy(true);
    setResult('');
    try {
      const updated = await api<Task>(`/projects/${task.projectId}/task-priority`, {
        taskId: task.id,
        level,
        reason: reason.trim(),
        expectedVersion: version,
        requestId,
      });
      setVersion(updated.priorityVersion ?? 0);
      setReason('');
      setRequest(undefined);
      setResult('saved');
      try {
        await reload();
      } catch {
        setResult('refreshFailed');
      }
    } catch (error) {
      const conflict = error instanceof Error && /version conflict/i.test(error.message);
      setResult(conflict ? 'conflict' : 'failed');
      if (conflict) {
        try {
          const state = await api<{ tasks: Task[] }>('/state');
          setVersion(state.tasks.find((t) => t.id === task.id)?.priorityVersion ?? 0);
          await reload();
        } catch {
          setResult('failed');
        }
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="priority-editor" aria-label={text.title}>
      <PriorityBadge value={task.priority} locale={locale} />
      <p>
        {text.reason}: {task.priorityReason ?? text.missing}
      </p>
      {!['done', 'cancelled'].includes(task.stage) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            {text.level}
            <select
              aria-label={text.level}
              value={level}
              required
              onChange={(e) => setLevel(e.target.value as PriorityLevel)}
            >
              <option value="" disabled>
                {text.level}
              </option>
              {priorityLevels.map((l) => (
                <option key={l} value={l}>
                  {priorityNames[locale][l]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {text.reason}
            <textarea
              aria-label={text.reason}
              value={reason}
              maxLength={1000}
              required
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button
            className="primary-button"
            type="submit"
            disabled={busy || !level || !reason.trim()}
          >
            {busy ? text.saving : text.save}
          </button>
          <p role="status">{result && text[result]}</p>
        </form>
      )}
      <details>
        <summary>{text.history}</summary>
        {task.priorityHistory?.length ? (
          <ol>
            {task.priorityHistory.map((change) => (
              <li key={change.requestId}>
                <p>
                  {change.oldValue === null ? text.created : priorityLabel(change.oldValue, locale)}{' '}
                  → {priorityLabel(change.newValue, locale)} · {text[change.actor]} ·{' '}
                  <time dateTime={change.at}>{new Date(change.at).toLocaleString(locale)}</time>
                </p>
                <p>{change.reason}</p>
                {change.sourceMessageId && (
                  <p>
                    {text.source}: {change.sourceMessageId}
                  </p>
                )}
                {change.runId && (
                  <p>
                    {text.run}: {change.runId}
                  </p>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p>{text.missing}</p>
        )}
      </details>
    </section>
  );
}
