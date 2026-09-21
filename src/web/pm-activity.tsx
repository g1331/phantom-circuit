import { useEffect, useState } from 'react';
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

function compact(activity: PMActivity, roots: string[]) {
  let text = activity.details.command ?? activity.details.paths ?? activity.details.summary ?? '';
  for (const root of roots) text = text.replaceAll(root, '.');
  return text
    .replace(/[A-Za-z]:[\\/][^\n"]+/g, (path) => `…/${path.split(/[\\/]/).slice(-2).join('/')}`)
    .replaceAll('\n', ' ')
    .slice(0, 160);
}

export function ActivityRow({ activity, roots }: { activity: PMActivity; roots: string[] }) {
  const { t, date, duration: formatDuration, activityTitle } = useLocale();
  const timestamp = (value: string) => date(value, { dateStyle: 'short', timeStyle: 'medium' });
  const duration = (start: string, end: string | number) =>
    formatDuration((new Date(end).getTime() - new Date(start).getTime()) / 1000);
  return (
    <details className="pm-activity" data-status={activity.status}>
      <summary>
        <span className="activity-title">{activityTitle(activity.title)}</span>
        <span className="activity-preview">{compact(activity, roots)}</span>
        <span className="activity-status">{t(statuses[activity.status])}</span>
      </summary>
      <dl>
        <dt>Run</dt>
        <dd>{activity.runId}</dd>
        {activity.taskId && (
          <>
            <dt>Task</dt>
            <dd>{activity.taskId}</dd>
          </>
        )}
        {activity.messageId && (
          <>
            <dt>Message</dt>
            <dd>{activity.messageId}</dd>
          </>
        )}
        {activity.eventId !== undefined && (
          <>
            <dt> {t('ui.sourceEvent')} </dt>
            <dd>{activity.eventId}</dd>
          </>
        )}
        <dt> {t('ui.started')} </dt>
        <dd>{timestamp(activity.startedAt)}</dd>
        <dt> {t('ui.lastUpdated')} </dt>
        <dd>{timestamp(activity.updatedAt)}</dd>
        {activity.endedAt && (
          <>
            <dt> {t('ui.completed3')} </dt>
            <dd>
              {timestamp(activity.endedAt)} {t('ui.duration')}{' '}
              {duration(activity.startedAt, activity.endedAt)}
            </dd>
          </>
        )}
        {Object.entries(activity.details)
          .filter(([, value]) => value)
          .map(([key, value]) => (
            <div className="activity-detail" key={key}>
              <dt>{t(labels[key as keyof PMActivity['details']])}</dt>
              <dd>
                <pre>{key === 'source' ? activityTitle(value!) : value}</pre>
              </dd>
            </div>
          ))}
      </dl>
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
