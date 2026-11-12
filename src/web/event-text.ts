import type { Event, Role, RunStatus } from '../shared/types.ts';
import type { createLocale } from './locale/core.ts';

const roles: Role[] = ['pm', 'dev', 'review', 'oncall'];
const statuses: RunStatus[] = [
  'queued',
  'running',
  'waiting',
  'paused',
  'interrupted',
  'failed',
  'completed',
];
const controls = {
  pause: 'flow.taskPaused',
  resume: 'flow.taskResumed',
  cancel: 'flow.taskCancelled',
} as const;

export function eventText(event: Event, copy: ReturnType<typeof createLocale>) {
  const { t, host } = copy;
  if (event.type === 'task') {
    const action = event.control?.action ?? /^任务 (pause|resume|cancel)$/.exec(event.message)?.[1];
    if (action === 'pause' || action === 'resume' || action === 'cancel')
      return t(controls[action]);
  }
  const [role, status] = event.message.split(' ');
  if (
    event.type === 'run' &&
    roles.includes(role as Role) &&
    statuses.includes(status as RunStatus)
  )
    return `${t(`team.role.${role as Role}`)} · ${t(`ui.${status as RunStatus}`)}`;
  return host(event.message, event.descriptor);
}
