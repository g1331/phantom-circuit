import type { ReactNode } from 'react';
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
import { hasOwner, teamView, type TeamMember, type TeamWork } from '../shared/team.ts';
import { WorkHold } from './work-hold.tsx';

export type TaskView = 'overview' | 'spec' | 'process';

function progressFor({
  task,
  work,
  member,
  needsDecision,
}: {
  task: Task;
  work?: TeamWork;
  member?: TeamMember;
  needsDecision: boolean;
}) {
  if (task.stage === 'done') return 'delivered';
  if (task.stage === 'cancelled') return 'cancelled';
  if (task.pausedByUser && task.control === 'paused') return 'paused';
  if (needsDecision) return 'needsYou';
  if (work?.teamHold) return 'teamHandling';
  if (member) return member.activity;
  if (work?.step === 'planned') return 'queued';
  if (task.stage === 'reviewing') return 'reviewQueued';
  if (task.stage === 'merging') return 'merging';
  return 'waiting';
}

/** One section of a task page: where it stands, what was asked, or how it went. */
export function TaskDetail({
  task: detail,
  state,
  schedule,
  busy,
  act,
  reload,
  view,
  experience,
}: {
  task: Task;
  state: Snapshot;
  schedule?: SchedulingExplanation;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  reload: () => Promise<void>;
  view: TaskView;
  experience?: ReactNode;
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
      experience={experience}
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
  experience,
}: {
  task: Task;
  state: Snapshot;
  schedule?: SchedulingExplanation;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  reload: () => Promise<void>;
  experience?: ReactNode;
}) {
  const { t, host, locale } = useLocale();
  const attention = taskAttention(detail);
  const finished = detail.stage === 'done' || detail.stage === 'cancelled';
  const historicalIncidents =
    state.incidents?.filter((incident) => incidentAttention(incident, detail).historicalReason) ??
    [];
  const team = teamView(state, detail.projectId);
  const work = team.work.find((work) => work.taskId === detail.id);
  const member = team.members.find((member) => member.taskId === detail.id);
  const requests = team.waiting.filter((request) => request.taskId === detail.id);
  const status = progressFor({ task: detail, work, member, needsDecision: requests.length > 0 });
  const next =
    status === 'delivered' || status === 'cancelled' || status === 'paused' || status === 'needsYou'
      ? status
      : 'team';
  const conversation =
    hasOwner(detail) || state.ownerMessages?.some((line) => line.taskId === detail.id);
  return (
    <div className="task-detail task-workspace">
      {(!finished || attention.blocked || requests.length > 0) && (
        <section
          className="task-progress"
          data-progress={status}
          data-hold={work?.teamHold}
          aria-label={t('task.progress')}
        >
          <h2>{work?.teamHold ? t(`work.hold.${work.teamHold}`) : t(`task.progress.${status}`)}</h2>
          <p className="muted task-next-step">
            {work?.teamHold ? <WorkHold work={work} showStatus={false} /> : t(`task.next.${next}`)}
          </p>
          {requests.length > 0 && (
            <div className="task-decisions">
              {requests.map((request) => (
                <p key={request.id}>{request.text}</p>
              ))}
            </div>
          )}
          {attention.blocked &&
            (finished ? (
              <p className="inline-warning">{host(attention.blocked, detail.blockedDescriptor)}</p>
            ) : (
              <Fold className="task-blocker" title={t('ui.technicalRecords')}>
                <Clamp height={100}>
                  <p>{host(attention.blocked, detail.blockedDescriptor)}</p>
                </Clamp>
              </Fold>
            ))}
          <ProjectActions
            state={{
              ...state,
              incidents: state.incidents?.filter((i) => requests.some((r) => r.id === i.id)),
              recoveryItems: [],
              clarifications: state.clarifications?.filter((c) => c.taskId === detail.id),
            }}
            project={state.projects.find((p) => p.id === detail.projectId)!}
            reload={reload}
          />
        </section>
      )}
      <div className="task-evidence">
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
        <Fold className="task-receipt-details" title={t('task.evidence')} open>
          <TaskRuntimeBadges state={state} taskId={detail.id} />
          <Receipt task={detail} state={state} />
        </Fold>
      </div>
      {experience}
      <div className="task-owner-context">
        {conversation ? (
          <OwnerConversation task={detail} state={state} busy={busy} act={act} />
        ) : (
          <section className="task-owner-empty">
            <h3>{t('task.ownerPending')}</h3>
            <p className="muted">{t(finished ? 'task.ownerFinished' : 'task.ownerPendingHint')}</p>
          </section>
        )}
      </div>
      {!finished && (
        <Fold className="task-scheduling" title={t('task.scheduling')}>
          <section className="detail-schedule">
            <PriorityEditor key={detail.id} task={detail} locale={locale} reload={reload} />
            <ClaimConditions
              entry={schedule?.tasks.find((entry) => entry.taskId === detail.id)}
              locale={locale}
            />
          </section>
        </Fold>
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
