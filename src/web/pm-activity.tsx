import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
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

export function ActivityRow({ activity, roots }: { activity: PMActivity; roots: string[] }) {
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
  run,
  runId,
  children,
  disclosures,
  groupId,
  wasLive,
  following,
}: {
  activities: PMActivity[];
  runStatus?: RunStatus;
  roots: string[];
  run?: Run;
  runId?: string;
  children?: ReactNode;
  disclosures?: Map<string, boolean>;
  groupId?: string;
  wasLive?: boolean;
  following?: RefObject<boolean>;
}) {
  const { t, duration } = useLocale();
  const status = runStatus ?? activities.at(-1)?.status ?? 'completed';
  const ref = useRef<HTMLDetailsElement>(null);
  const key = groupId ?? activities[0]?.id ?? runId ?? '';
  const touched = useRef(disclosures?.has(key) ?? false);
  const failures = activities.filter(
    (activity) => activity.status === 'failed' && activity.kind !== 'phase',
  );
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (touched.current && disclosures?.has(key)) element.open = disclosures.get(key)!;
    else if (status !== 'completed') element.open = true;
    else if (!touched.current && !element.contains(document.activeElement)) {
      const scroller = element.closest('.conversation');
      const box = element.getBoundingClientRect();
      const viewport = scroller?.getBoundingClientRect();
      const reading = following
        ? !following.current
        : scroller && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 64;
      const inView = viewport && box.bottom > viewport.top && box.top < viewport.bottom;
      if (wasLive && reading && inView) element.open = true;
      else element.open = false;
    }
  }, [status]);
  const elapsed = run?.endedAt
    ? duration((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000)
    : '';
  return (
    <details
      ref={ref}
      id={`process-${key}`}
      className="pm-process"
      data-status={status}
      data-has-failure={failures.length > 0}
      data-run-id={runId ?? run?.id ?? activities[0]?.runId}
    >
      <summary
        className="process-summary"
        onClick={() => {
          touched.current = true;
          if (ref.current) disclosures?.set(key, !ref.current.open);
        }}
      >
        <span className="process-title">{t('activity.process')}</span>
        <span className="process-status">{t(statuses[status])}</span>
        {elapsed && <span className="process-duration">{elapsed}</span>}
        {!!failures.length && (
          <span className="process-failure">
            {t('activity.failedOperations', { count: failures.length })}
          </span>
        )}
      </summary>
      <div className="process-rows">
        {children ??
          activities.map((activity) => (
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
