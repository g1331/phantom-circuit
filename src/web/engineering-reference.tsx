import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from 'lucide-react';
import type { Task } from '../shared/types.ts';
import { useLocale } from './locale/provider.tsx';

/** Completed delivery sync confirms both the merge and completed Issue closure. */
export function EngineeringReference({
  task,
  kind,
  linked = true,
  external = false,
}: {
  task: Task;
  kind: 'pr' | 'issue';
  linked?: boolean;
  external?: boolean;
}) {
  const { t } = useLocale();
  const status =
    (kind === 'pr' ? task.prState : task.issueState) ??
    (task.completionSyncedAt ? (kind === 'pr' ? 'merged' : 'completed') : 'unknown');
  const Icon =
    kind === 'pr'
      ? status === 'merged'
        ? GitMerge
        : status === 'closed'
          ? GitPullRequestClosed
          : status === 'draft'
            ? GitPullRequestDraft
            : GitPullRequest
      : status === 'completed'
        ? CircleCheck
        : status === 'not_planned'
          ? CircleSlash
          : status === 'open'
            ? CircleDot
            : CircleDashed;
  const label = t(`reference.${status}`);
  const content = (
    <>
      <span className={`reference-state reference-${kind} reference-${status}`}>
        <Icon size={13} role="img" aria-label={label} />
        {kind === 'pr' ? 'PR' : 'Issue'} #{(kind === 'pr' ? task.pr : task.issue) ?? ''}
      </span>
      {external && <ExternalLink size={12} aria-hidden="true" />}
    </>
  );
  const href = kind === 'pr' ? task.prUrl : task.issueUrl;
  return linked && href ? (
    <a className="engineering-reference quiet-link" href={href} target="_blank" rel="noreferrer">
      {content}
    </a>
  ) : (
    <span className="engineering-reference">{content}</span>
  );
}
