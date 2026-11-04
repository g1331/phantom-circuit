import type { SchedulingExplanation, Snapshot, Task } from '../shared/types.ts';
import { Clamp, Fold } from './fold.tsx';
import { MarkdownContent } from './markdown-content.tsx';
import { PriorityEditor, ClaimConditions } from './task-priority.tsx';
import { ProjectActions, TaskRuntimeBadges } from './project-actions.tsx';
import { TaskProcess } from './process-record.tsx';
import { OwnerConversation } from './owner-conversation.tsx';
import { Receipt } from './receipt.tsx';
import { useLocale } from './locale/provider.tsx';
import { incidentAttention, taskAttention } from '../shared/task-history.ts';

export type TaskView = 'overview' | 'spec' | 'process';

/** One section of a task page: where it stands, what was asked, or how it went. */
export function TaskDetail({
  task: detail,
  state,
  schedule,
  busy,
  act,
  reload,
  view,
}: {
  task: Task;
  state: Snapshot;
  schedule?: SchedulingExplanation;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  reload: () => Promise<void>;
  view: TaskView;
}) {
  if (view === 'process')
    return <TaskProcess taskId={detail.id} revision={detail.updatedAt} state={state} />;
  if (view === 'spec') return <TaskSpec task={detail} state={state} />;
  return (
    <TaskOverview
      task={detail}
      state={state}
      schedule={schedule}
      busy={busy}
      act={act}
      reload={reload}
    />
  );
}

function TaskOverview({
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
            <Fold className="historical-incidents" title={t('tasks.historicalIncidents')}>
              {historicalIncidents.map((incident) => (
                <article key={incident.id}>
                  <p>
                    Incident {incident.id} · {t(`actions.${incident.status}`)}
                  </p>
                  <p>{incident.message}</p>
                  <Fold className="fold-quiet" title={t('ui.technicalRecords')}>
                    <pre className="log-block">{JSON.stringify(incident, null, 2)}</pre>
                  </Fold>
                </article>
              ))}
            </Fold>
          )}
        </section>
      )}
      {attention.blocked && (
        <div className="inline-warning">{host(attention.blocked, detail.blockedDescriptor)}</div>
      )}
      <Receipt task={detail} state={state} />
      <OwnerConversation task={detail} state={state} busy={busy} act={act} />
      {!finished && (
        <section className="detail-schedule">
          <PriorityEditor key={detail.id} task={detail} locale={locale} reload={reload} />
          <ClaimConditions
            entry={schedule?.tasks.find((entry) => entry.taskId === detail.id)}
            locale={locale}
          />
        </section>
      )}
    </div>
  );
}

/** What was asked, and every round of feedback since; long text opens a screen at a time. */
function TaskSpec({ task: detail, state }: { task: Task; state: Snapshot }) {
  const { t } = useLocale();
  const rounds = [
    ...detail.feedback.map((content, i) => ({ content, i, pending: false })),
    ...(detail.pendingFeedback ?? []).map((content, i) => ({ content, i, pending: true })),
  ];
  return (
    <div className="task-detail task-spec">
      <section className="doc-section">
        <h2>{t('ui.taskSpecification')}</h2>
        <Clamp height={360}>
          <MarkdownContent content={detail.spec} label={t('ui.taskSpecification')} />
        </Clamp>
      </section>
      {detail.dependencies.length > 0 && (
        <section className="doc-section">
          <h2>{t('ui.waitingForTasks')}</h2>
          <ul className="dependency-list">
            {detail.dependencies.map((id) => (
              <li key={id}>{state.tasks.find((task) => task.id === id)?.title ?? id}</li>
            ))}
          </ul>
        </section>
      )}
      {rounds.length > 0 && (
        <section className="doc-section">
          <h2>{t('ui.feedback')}</h2>
          <ol className="feedback-rounds">
            {rounds.map(({ content, i, pending }) => (
              <li key={`${pending}-${i}`} className={pending ? 'pending' : undefined}>
                <p className="feedback-round">
                  {pending ? t('feedback.pendingRound') : t('feedback.round', { count: i + 1 })}
                </p>
                <Clamp height={150}>
                  <MarkdownContent
                    content={content}
                    label={t(pending ? 'feedback.pending' : 'feedback.label', { count: i + 1 })}
                  />
                </Clamp>
              </li>
            ))}
          </ol>
        </section>
      )}
      {!!detail.documentChanges?.length && (
        <section className="doc-section">
          <h2>{t('ui.domainDocumentChanges')}</h2>
          <ol className="feedback-rounds">
            {detail.documentChanges.map((doc) => (
              <li key={doc.path}>
                <p className="feedback-round">
                  {doc.path} · {t('docs.version', { version: doc.version })}
                </p>
                <Clamp height={150}>
                  <MarkdownContent
                    content={doc.content}
                    label={t('docs.change', { path: doc.path })}
                  />
                </Clamp>
              </li>
            ))}
          </ol>
        </section>
      )}
      {detail.issueBody && (
        <section className="doc-section">
          <h2>{t('ui.issueBody')}</h2>
          <Clamp height={200}>
            <MarkdownContent content={detail.issueBody} label={t('ui.issueBody')} />
          </Clamp>
        </section>
      )}
    </div>
  );
}
