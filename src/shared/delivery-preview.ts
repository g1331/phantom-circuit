import type { Repo, Task } from './types.ts';
import { taskDeliveryHead, taskDeliveryCommits, isExternalDelivery } from './task-history.ts';

/** Only a ready checkout proven to include this delivery can represent its result. */
export function deliveryPreview(task: Task, repos: Repo[], applicationOrigin?: string) {
  const repo = repos.find((repo) => repo.id === task.repoId && repo.projectId === task.projectId);
  const preview = repo?.preview;
  const head = taskDeliveryHead(task);
  if (
    task.stage !== 'done' ||
    !head ||
    preview?.status !== 'running' ||
    !preview.revision ||
    !preview.taskHeads?.includes(head) ||
    (isExternalDelivery(task) &&
      !taskDeliveryCommits(task).every((commit) => preview.deliveryCommits?.includes(commit))) ||
    !preview.url
  )
    return undefined;
  let url: URL;
  try {
    url = new URL(preview.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (applicationOrigin && url.origin === applicationOrigin) return undefined;
  return url.href;
}
