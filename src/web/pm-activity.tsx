import { useEffect, useState } from 'react';
import type { PMActivity, Run, RunStatus } from '../shared/types.ts';

const statuses: Record<RunStatus, string> = {
  queued: '排队',
  running: '进行中',
  waiting: '等待结果',
  paused: '已暂停',
  interrupted: '已中断',
  failed: '失败',
  completed: '已完成',
};
const labels: Record<keyof PMActivity['details'], string> = {
  source: '触发来源',
  command: '命令',
  cwd: '工作目录',
  paths: '文件路径',
  input: '参数',
  output: '结果摘要',
  error: '错误',
  summary: '摘要',
};
const timestamp = (value: string) => new Date(value).toLocaleString('zh-CN');
const duration = (start: string, end: string | number) =>
  `${Math.max(0, Math.floor((new Date(end).getTime() - new Date(start).getTime()) / 1000))} 秒`;

function compact(activity: PMActivity, roots: string[]) {
  let text = activity.details.command ?? activity.details.paths ?? activity.details.summary ?? '';
  for (const root of roots) text = text.replaceAll(root, '.');
  return text
    .replace(/[A-Za-z]:[\\/][^\n"]+/g, (path) => `…/${path.split(/[\\/]/).slice(-2).join('/')}`)
    .replaceAll('\n', ' ')
    .slice(0, 160);
}

export function ActivityRow({ activity, roots }: { activity: PMActivity; roots: string[] }) {
  return (
    <details className="pm-activity" data-status={activity.status}>
      <summary>
        <span className="activity-title">{activity.title}</span>
        <span className="activity-preview">{compact(activity, roots)}</span>
        <span className="activity-status">{statuses[activity.status]}</span>
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
            <dt>源 Event</dt>
            <dd>{activity.eventId}</dd>
          </>
        )}
        <dt>开始</dt>
        <dd>{timestamp(activity.startedAt)}</dd>
        <dt>最后更新</dt>
        <dd>{timestamp(activity.updatedAt)}</dd>
        {activity.endedAt && (
          <>
            <dt>完成</dt>
            <dd>
              {timestamp(activity.endedAt)} · 耗时 {duration(activity.startedAt, activity.endedAt)}
            </dd>
          </>
        )}
        {Object.entries(activity.details)
          .filter(([, value]) => value)
          .map(([key, value]) => (
            <div className="activity-detail" key={key}>
              <dt>{labels[key as keyof PMActivity['details']]}</dt>
              <dd>
                <pre>{value}</pre>
              </dd>
            </div>
          ))}
      </dl>
    </details>
  );
}

export function PMProgress({ run, activities }: { run: Run; activities: PMActivity[] }) {
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
        {stale ? '等待新活动（超过 60 秒未更新，无法确认是否仍在推进）' : statuses[run.status]} ·{' '}
        {latest?.title ?? '准备上下文'}
      </span>
      <small>
        最后活动 {timestamp(updatedAt)} · 已运行 {duration(run.startedAt, clock)}
      </small>
    </div>
  );
}
