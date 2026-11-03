import { ExternalLink, GitPullRequest, Pause, Play } from 'lucide-react';
import type { ReviewResult, SchedulingExplanation, Snapshot, Task } from '../shared/types.ts';
import { api } from './api.ts';
import { MarkdownContent } from './markdown-content.tsx';
import { PriorityEditor, ClaimConditions } from './task-priority.tsx';
import { ProjectActions, TaskRuntimeBadges } from './project-actions.tsx';
import { TaskUsagePanel } from './usage-panel.tsx';
import { OwnerConversation } from './owner-conversation.tsx';
import { useLocale } from './locale/provider.tsx';
import { incidentAttention, taskAttention } from '../shared/task-history.ts';

const reviewTitle: Record<ReviewResult['axis'], string> = {
  primary: 'Primary Review',
  secondary: 'Secondary Review',
  standards: 'Standards',
  spec: 'Spec',
};

export function TaskDetail({
  task: detail,
  state,
  schedule,
  busy,
  act,
  reload,
}: {
  task: Task;
  state: Snapshot;
  schedule?: SchedulingExplanation;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  reload: () => Promise<void>;
}) {
  const { t, host, locale } = useLocale();
  const attention = taskAttention(detail);
  // Finished work leads with its outcome; scheduling and priority no longer apply to it.
  const finished = detail.stage === 'done' || detail.stage === 'cancelled';
  const historicalIncidents =
    state.incidents?.filter((incident) => incidentAttention(incident, detail).historicalReason) ??
    [];
  return (
    <div className="task-detail">
      <TaskRuntimeBadges state={state} taskId={detail.id} />
      <ProjectActions
        state={{
          ...state,
          incidents: [],
          recoveryItems: [],
          clarifications: state.clarifications?.filter((c) => c.taskId === detail.id && c.review),
        }}
        project={state.projects.find((p) => p.id === detail.projectId)!}
        reload={reload}
      />
      {attention.historicalReason && (
        <section className="historical-completion" aria-label={t('tasks.historicalCompletion')}>
          <p>{t('tasks.historicalCompletion')}</p>
          <p className="muted">{attention.historicalReason}</p>
          {!!historicalIncidents.length && (
            <details className="historical-incidents">
              <summary>{t('tasks.historicalIncidents')}</summary>
              {historicalIncidents.map((incident) => (
                <article key={incident.id}>
                  <p>
                    Incident {incident.id} · {t(`actions.${incident.status}`)}
                  </p>
                  <p>{incident.message}</p>
                  <details>
                    <summary>{t('ui.technicalRecords')}</summary>
                    <pre>{JSON.stringify(incident, null, 2)}</pre>
                  </details>
                </article>
              ))}
            </details>
          )}
        </section>
      )}
      {attention.blocked && (
        <div className="inline-warning">{host(attention.blocked, detail.blockedDescriptor)}</div>
      )}
      <div className="detail-actions">
        {detail.issueUrl && (
          <a className="secondary-button" href={detail.issueUrl} target="_blank" rel="noreferrer">
            GitHub Issue <ExternalLink size={13} />
          </a>
        )}
        {detail.prUrl && (
          <a className="secondary-button" href={detail.prUrl} target="_blank" rel="noreferrer">
            <GitPullRequest size={14} /> PR <ExternalLink size={13} />
          </a>
        )}
        {!finished && (
          <>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api(
                    `/tasks/${detail.id}/${detail.control === 'paused' ? 'resume' : 'pause'}`,
                    {},
                  ),
                )
              }
            >
              {detail.control === 'paused' ? <Play size={14} /> : <Pause size={14} />}{' '}
              {detail.control === 'paused' ? t('ui.resumeTask') : t('ui.pauseTask')}
            </button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => void act(() => api(`/tasks/${detail.id}/cancel`, {}))}
            >
              {t('ui.cancelTask')}
            </button>
          </>
        )}
      </div>
      <OwnerConversation task={detail} state={state} busy={busy} act={act} />
      <h3>{t('ui.taskSpecification')}</h3>
      <MarkdownContent content={detail.spec} label={t('ui.taskSpecification')} />
      <h3>{t('ui.acceptanceCriteria')}</h3>
      <ul>
        {detail.acceptance.map((x, i) => (
          <li key={i}>
            <MarkdownContent content={x} label={t('acceptance.label', { count: i + 1 })} />
          </li>
        ))}
      </ul>
      {detail.dependencies.length > 0 && (
        <>
          <h3>{t('ui.waitingForTasks')}</h3>
          <ul>
            {detail.dependencies.map((id) => (
              <li key={id}>{state.tasks.find((task) => task.id === id)?.title ?? id}</li>
            ))}
          </ul>
        </>
      )}
      {detail.reviews.map((r) => (
        <section
          className={`review-result ${r.approved ? 'approved' : 'changes'}`}
          key={r.runId ?? r.axis}
        >
          <h3>
            {reviewTitle[r.axis] ?? r.axis}{' '}
            <span>
              {r.verdict === 'needs_user'
                ? t('review.needsUser')
                : r.approved
                  ? t('ui.approved')
                  : t('ui.changesRequested')}
            </span>
          </h3>
          <MarkdownContent content={r.summary} label={t('review.summary', { axis: r.axis })} />
          {r.findings.map((f, i) => (
            <MarkdownContent
              key={i}
              content={f}
              label={t('review.finding', { axis: r.axis, count: i + 1 })}
            />
          ))}
        </section>
      ))}
      {detail.feedback.length > 0 && <h3>{t('ui.feedback')}</h3>}
      {detail.feedback.map((content, i) => (
        <MarkdownContent key={i} content={content} label={t('feedback.label', { count: i + 1 })} />
      ))}
      {!!detail.pendingFeedback?.length && <h3>{t('ui.pendingFeedback')}</h3>}
      {detail.pendingFeedback?.map((content, i) => (
        <MarkdownContent
          key={i}
          content={content}
          label={t('feedback.pending', { count: i + 1 })}
        />
      ))}
      {!!detail.documentChanges?.length && <h3>{t('ui.domainDocumentChanges')}</h3>}
      {detail.documentChanges?.map((doc) => (
        <section key={doc.path}>
          <h4>
            {doc.path} · v{doc.version}
          </h4>
          <MarkdownContent content={doc.content} label={t('docs.change', { path: doc.path })} />
        </section>
      ))}
      {detail.issueBody && (
        <section>
          <h3>{t('ui.issueBody')}</h3>
          <MarkdownContent content={detail.issueBody} label={t('ui.issueBody')} />
        </section>
      )}
      {detail.tests.map((test, i) => (
        <details key={i} className={`test-evidence ${test.exitCode === 0 ? 'passed' : 'failed'}`}>
          <summary>
            {test.exitCode === 0 ? '✓' : '!'} {test.command}
          </summary>
          <pre>{test.output}</pre>
        </details>
      ))}
      {!finished && (
        <section className="detail-schedule">
          <PriorityEditor key={detail.id} task={detail} locale={locale} reload={reload} />
          <ClaimConditions
            entry={schedule?.tasks.find((entry) => entry.taskId === detail.id)}
            locale={locale}
          />
        </section>
      )}
      <TaskUsagePanel key={detail.id} taskId={detail.id} revision={detail.updatedAt} />
      <details>
        <summary>{t('ui.technicalRecords')}</summary>
        <pre>
          {state.events
            .filter((e) => e.taskId === detail.id)
            .slice(0, 30)
            .map((e) => `${e.at} ${e.type}\n${e.message}`)
            .join('\n\n')}
        </pre>
      </details>
    </div>
  );
}
