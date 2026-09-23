import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Code2,
  FileText,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PMActivity, Run, RunStatus } from '../shared/types.ts';
import { useLocale } from './locale/provider.tsx';

const statuses = {
  queued: 'ui.queued2',
  running: 'ui.running2',
  waiting: 'ui.waitingForResults',
  paused: 'ui.paused',
  interrupted: 'ui.interrupted',
  failed: 'ui.failed',
  completed: 'ui.completed2',
} as const;
const labels = {
  source: 'ui.trigger',
  command: 'ui.command',
  cwd: 'ui.workingDirectory',
  paths: 'ui.filePaths',
  input: 'ui.input',
  output: 'ui.resultSummary',
  error: 'ui.error',
  summary: 'ui.summary',
} as const;
type ActivityCategory = 'command' | 'tool' | 'search' | 'files' | 'analysis' | 'plan';
const categoryByKind: Record<PMActivity['kind'], ActivityCategory> = {
  trigger: 'analysis',
  plan: 'plan',
  summary: 'analysis',
  tool: 'tool',
  command: 'command',
  files: 'files',
  search: 'search',
  phase: 'analysis',
  error: 'analysis',
};
const categoryLabels: Record<ActivityCategory, `activity.category.${ActivityCategory}`> = {
  command: 'activity.category.command',
  tool: 'activity.category.tool',
  search: 'activity.category.search',
  files: 'activity.category.files',
  analysis: 'activity.category.analysis',
  plan: 'activity.category.plan',
};
const iconsByKind: Record<PMActivity['kind'], LucideIcon> = {
  trigger: Activity,
  plan: Code2,
  summary: Activity,
  tool: Wrench,
  command: Terminal,
  files: FileText,
  search: Search,
  phase: Activity,
  error: AlertTriangle,
};

function inputDescription(input: string | undefined, fields: readonly string[]) {
  if (!input) return '';
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return '';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return '';
  for (const field of fields) {
    const candidate = (value as Record<string, unknown>)[field];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (Array.isArray(candidate) && candidate.every((item) => typeof item === 'string'))
      return candidate.join(', ');
  }
  return '';
}

function operationSummary(activity: PMActivity) {
  const { command, error, input, paths, source, summary } = activity.details;
  const firstErrorLine = error?.split(/\r?\n/).find((line) => line.trim());
  if (firstErrorLine) return firstErrorLine.trim();
  switch (activity.kind) {
    case 'command':
      return command || summary || input || '';
    case 'search':
      return (
        inputDescription(input, ['query', 'searchQuery', 'search']) ||
        summary ||
        input ||
        command ||
        ''
      );
    case 'files':
      return paths || inputDescription(input, ['path', 'paths', 'file']) || summary || input || '';
    case 'tool':
      return (
        inputDescription(input, ['description', 'command', 'path', 'paths', 'query']) ||
        paths ||
        input ||
        summary ||
        ''
      );
    default:
      return summary || source || paths || input || command || '';
  }
}

function compact(activity: PMActivity, roots: string[]) {
  let text = operationSummary(activity);
  for (const root of roots) text = text.replaceAll(root, '.');
  text = text
    .replace(/[A-Za-z]:[\\/][^\n"]+/g, (path) => `…/${path.split(/[\\/]/).slice(-2).join('/')}`)
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 160 ? `${text.slice(0, 159).trimEnd()}…` : text;
}

function ActivityRow({ activity, roots }: { activity: PMActivity; roots: string[] }) {
  const { t, date, duration: formatDuration, activityTitle } = useLocale();
  const timestamp = (value: string) => date(value, { dateStyle: 'short', timeStyle: 'medium' });
  const duration = (start: string, end: string | number) =>
    formatDuration((new Date(end).getTime() - new Date(start).getTime()) / 1000);
  const Icon = iconsByKind[activity.kind];
  const preview = compact(activity, roots);
  const statusLabel = activity.status === 'completed' ? '' : t(statuses[activity.status]);
  const { command, cwd, error, input, output, paths, source, summary } = activity.details;
  return (
    <details className="pm-activity" data-kind={activity.kind} data-status={activity.status}>
      <summary className="activity-summary">
        <Icon className="activity-icon" size={16} aria-hidden="true" />
        <span className="activity-title">{activityTitle(activity.title)}</span>
        {preview && (
          <>
            <span className="activity-separator" aria-hidden="true">
              ·
            </span>
            <span className="activity-preview">{preview}</span>
          </>
        )}
        {statusLabel && (
          <span className="activity-state" data-status={activity.status}>
            {statusLabel}
          </span>
        )}
        <ChevronRight className="activity-chevron" size={14} aria-hidden="true" />
      </summary>
      <div className="activity-details">
        {(command || input || summary || output || error) && (
          <div className="activity-panels">
            {command && (
              <section className="activity-panel">
                <h4>{t(labels.command)}</h4>
                <pre>{command}</pre>
              </section>
            )}
            {input && (
              <section className="activity-panel">
                <h4>{t(labels.input)}</h4>
                <pre>{input}</pre>
              </section>
            )}
            {summary && (
              <section className="activity-panel">
                <h4>{activity.kind === 'search' ? t('activity.query') : t(labels.summary)}</h4>
                <pre>{summary}</pre>
              </section>
            )}
            {output && (
              <section className="activity-panel">
                <h4>{t(labels.output)}</h4>
                <pre>{output}</pre>
              </section>
            )}
            {error && (
              <section className="activity-panel activity-panel-error">
                <h4>{t(labels.error)}</h4>
                <pre>{error}</pre>
              </section>
            )}
          </div>
        )}
        <dl className="activity-meta">
          <dt>{t('activity.runId')}</dt>
          <dd>{activity.runId}</dd>
          {activity.taskId && (
            <>
              <dt>{t('activity.taskId')}</dt>
              <dd>{activity.taskId}</dd>
            </>
          )}
          {activity.messageId && (
            <>
              <dt>{t('activity.messageId')}</dt>
              <dd>{activity.messageId}</dd>
            </>
          )}
          {activity.eventId !== undefined && (
            <>
              <dt>{t('activity.eventId')}</dt>
              <dd>{activity.eventId}</dd>
            </>
          )}
          {source && (
            <>
              <dt>{t(labels.source)}</dt>
              <dd>{activityTitle(source)}</dd>
            </>
          )}
          {cwd && (
            <>
              <dt>{t(labels.cwd)}</dt>
              <dd>{cwd}</dd>
            </>
          )}
          {paths && (
            <>
              <dt>{t(labels.paths)}</dt>
              <dd>{paths}</dd>
            </>
          )}
          <dt>{t('ui.started')}</dt>
          <dd>{timestamp(activity.startedAt)}</dd>
          <dt>{t('ui.lastUpdated')}</dt>
          <dd>{timestamp(activity.updatedAt)}</dd>
          {activity.endedAt && (
            <>
              <dt>{t('ui.completed3')}</dt>
              <dd>
                {timestamp(activity.endedAt)} {t('ui.duration')}{' '}
                {duration(activity.startedAt, activity.endedAt)}
              </dd>
            </>
          )}
        </dl>
      </div>
    </details>
  );
}

export function ActivityGroup({
  activities,
  runStatus,
  roots,
}: {
  activities: PMActivity[];
  runStatus?: RunStatus;
  roots: string[];
}) {
  const { t } = useLocale();
  const first = activities[0]!;
  const categoryCounts = new Map<ActivityCategory, { count: number; firstIndex: number }>();
  activities.forEach((activity, index) => {
    if (!operationSummary(activity)) return;
    const category = categoryByKind[activity.kind];
    const existing = categoryCounts.get(category);
    if (existing) existing.count++;
    else categoryCounts.set(category, { count: 1, firstIndex: index });
  });
  const majorCategories = [...categoryCounts]
    .sort(([, a], [, b]) => b.count - a.count || a.firstIndex - b.firstIndex)
    .slice(0, 2)
    .map(([category]) => category);
  let preview = '';
  for (let index = activities.length - 1; index >= 0; index--) {
    preview = compact(activities[index]!, roots);
    if (preview) break;
  }
  const failures = activities.filter(
    (activity) => activity.status === 'failed' && activity.kind !== 'phase',
  );
  const status = runStatus ?? activities.at(-1)!.status;
  return (
    <details
      className="pm-process"
      data-status={status}
      data-has-failure={failures.length > 0}
      data-run-id={first.runId}
    >
      <summary className="process-summary">
        <span className="process-title">{t('activity.process')}</span>
        <span className="process-count">
          {t(activities.length === 1 ? 'activity.operation' : 'activity.operations', {
            count: activities.length,
          })}
        </span>
        <span className="process-categories">
          {majorCategories.map((category) => (
            <span className="process-category" key={category}>
              {t(categoryLabels[category])}
            </span>
          ))}
        </span>
        {preview && <span className="process-preview">{preview}</span>}
        {!!failures.length && (
          <span className="process-failure">
            {t('activity.failedOperations', { count: failures.length })}
          </span>
        )}
        <span className="process-status">{t(statuses[status])}</span>
        <span
          className="process-run"
          title={first.runId}
          aria-label={t('activity.runShortId', { id: first.runId })}
        >
          #{first.runId.slice(-7)}
        </span>
      </summary>
      <div className="process-rows">
        {activities.map((activity) => (
          <ActivityRow key={activity.id} activity={activity} roots={roots} />
        ))}
      </div>
    </details>
  );
}

export function PMProgress({ run, activities }: { run: Run; activities: PMActivity[] }) {
  const { t, date, duration: formatDuration, activityTitle } = useLocale();
  const timestamp = (value: string) => date(value, { dateStyle: 'short', timeStyle: 'medium' });
  const duration = (start: string, end: string | number) =>
    formatDuration((new Date(end).getTime() - new Date(start).getTime()) / 1000);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const latest = activities
    .filter((a) => a.runId === run.id)
    .reverse()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const updatedAt = latest?.updatedAt ?? run.startedAt;
  const stale = clock - new Date(updatedAt).getTime() >= 60000;
  return (
    <div className="pm-progress" role="status">
      <span>
        {stale ? t('ui.waitingForActivityNoUpdateForOver') : t(statuses[run.status])} ·{' '}
        {latest ? activityTitle(latest.title) : t('ui.preparingContext')}
      </span>
      <small>
        {t('ui.lastActivity')} {timestamp(updatedAt)} {t('ui.elapsed')}{' '}
        {duration(run.startedAt, clock)}
      </small>
    </div>
  );
}
