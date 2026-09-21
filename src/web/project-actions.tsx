import { ErrorText } from './error-text.tsx';
import { useEffect, useState } from 'react';
import type { Clarification, Incident, Project, Snapshot } from '../shared/types.ts';
import { api } from './api.ts';
import { useLocale } from './locale/provider.tsx';

export function ProjectActions({
  state,
  project,
  reload,
}: {
  state: Snapshot;
  project: Project;
  reload: () => Promise<void>;
}) {
  const { t, host } = useLocale();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<string | Error>('');
  const incidents =
    state.incidents?.filter(
      (item) => item.projectId === project.id && item.status !== 'resolved',
    ) ?? [];
  const clarifications =
    state.clarifications?.filter((item) => item.projectId === project.id) ?? [];
  const recovery =
    state.recoveryItems?.filter(
      (item) => item.projectId === project.id && ['pending', 'recoverable'].includes(item.status),
    ) ?? [];
  async function act(key: string, path: string, body: unknown) {
    setBusy(key);
    setError('');
    try {
      await api(`/projects/${project.id}/${path}`, body);
      await reload();
    } catch (error) {
      setError(error instanceof Error ? error : String(error));
    } finally {
      setBusy('');
    }
  }
  if (!incidents.length && !clarifications.length && !recovery.length) return null;
  return (
    <section className="project-actions">
      {error && (
        <p role="alert">
          {t('actions.errors')} <ErrorText error={error} />
        </p>
      )}
      {!!recovery.length && (
        <section aria-label={t('actions.recovery')}>
          <h3>{t('actions.recovery')}</h3>
          <button
            className="secondary-button"
            disabled={!!busy}
            onClick={() => void act('all', 'recovery/resume', {})}
          >
            {t('actions.resumeAll')}
          </button>
          {recovery.map((item) => (
            <article className="action-record" key={item.id}>
              <strong>
                {state.tasks.find((task) => task.id === item.taskId)?.title ?? item.oldRunId}
              </strong>
              <span className="runtime-badge">
                {t(item.status === 'recoverable' ? 'actions.recoverable' : 'actions.pending')}
              </span>
              <p>{host(item.reason ?? '', item.reasonDescriptor)}</p>
              <p className="muted">
                {item.role?.toUpperCase()} · {item.oldRunId}
                {item.stage && <> · {t(`stage.${item.stage}`)}</>} ·{' '}
                {t(item.policy === 'automatic' ? 'runtime.automatic' : 'runtime.manual')}
              </p>
              <div className="detail-actions">
                <button
                  className="secondary-button"
                  disabled={!!busy}
                  onClick={() => void act(item.id, 'recovery/resume', { id: item.id })}
                >
                  {t('actions.resume')}
                </button>
                <button
                  className="secondary-button"
                  disabled={!!busy}
                  onClick={() => void act(item.id, `recovery/${item.id}/cancel`, {})}
                >
                  {t('actions.cancel')}
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
      {!!incidents.length && (
        <section aria-label={t('actions.incidents')}>
          <h3>{t('actions.incidents')}</h3>
          {incidents.map((incident) => (
            <IncidentCard
              key={incident.id}
              incident={incident}
              disabled={!!busy}
              submit={(action, guidance) =>
                act(incident.id, `incidents/${incident.id}/resolve`, { action, guidance })
              }
            />
          ))}
        </section>
      )}
      {!!clarifications.length && (
        <section aria-label={t('actions.clarifications')}>
          <h3>{t('actions.clarifications')}</h3>
          {clarifications.map((clarification) => (
            <ClarificationCard
              key={clarification.id}
              clarification={clarification}
              disabled={!!busy}
              submit={(answers) =>
                act(clarification.id, `clarifications/${clarification.id}/answer`, { answers })
              }
              cancel={() => act(clarification.id, `clarifications/${clarification.id}/cancel`, {})}
            />
          ))}
        </section>
      )}
    </section>
  );
}

function IncidentCard({
  incident,
  disabled,
  submit,
}: {
  incident: Incident;
  disabled: boolean;
  submit: (action: 'resolved' | 'paused' | 'waiting_user', guidance: string) => Promise<void>;
}) {
  const { t, host } = useLocale();
  const [guidance, setGuidance] = useState('');
  return (
    <article className="action-record">
      <span className="runtime-badge">{t(`actions.${incident.status}`)}</span>
      <p>{host(incident.message, incident.descriptor)}</p>
      {incident.evidence && (
        <details>
          <summary>{t('ui.technicalRecords')}</summary>
          <pre>{incident.evidence}</pre>
        </details>
      )}
      <label>
        {t('actions.guidance')}
        <textarea value={guidance} onChange={(event) => setGuidance(event.target.value)} />
      </label>
      <div className="detail-actions">
        {(['resolved', 'paused', 'waiting_user'] as const).map((action) => (
          <button
            key={action}
            className="secondary-button"
            disabled={disabled}
            onClick={() => void submit(action, guidance)}
          >
            {t(
              action === 'resolved'
                ? 'actions.resolve'
                : action === 'paused'
                  ? 'actions.pause'
                  : 'actions.waitUser',
            )}
          </button>
        ))}
      </div>
    </article>
  );
}

function ClarificationCard({
  clarification,
  disabled,
  submit,
  cancel,
}: {
  clarification: Clarification;
  disabled: boolean;
  submit: (answers: { questionId: string; value: string }[]) => Promise<void>;
  cancel: () => Promise<void>;
}) {
  const { t } = useLocale();
  const storageKey = `phantom.clarification.${clarification.id}`;
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
      if (
        saved &&
        typeof saved === 'object' &&
        Object.values(saved).every((value) => typeof value === 'string')
      )
        return saved as Record<string, string>;
    } catch {
      /* A malformed browser draft must not hide the server question. */
    }
    return {};
  });
  useEffect(() => {
    if (clarification.status !== 'open') {
      localStorage.removeItem(storageKey);
      setDrafts({});
    }
  }, [clarification.status, storageKey]);
  const value = (id: string) =>
    drafts[id] ??
    clarification.answers?.find((answer) => answer.questionId === id)?.value.toString() ??
    '';
  const update = (id: string, value: string) => {
    const next = { ...drafts, [id]: value };
    setDrafts(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
  };
  const answers = clarification.questions
    .map((question) => ({ questionId: question.id, value: value(question.id).trim() }))
    .filter((answer) => answer.value);
  return (
    <article className="action-record clarification-card">
      {clarification.status !== 'open' && (
        <p className="runtime-badge">
          {t(clarification.status === 'answered' ? 'actions.answered' : 'actions.cancelled')}
        </p>
      )}
      {clarification.questions.map((question) => (
        <fieldset key={question.id} disabled={disabled || clarification.status !== 'open'}>
          <legend>{question.question}</legend>
          {question.recommendation && (
            <p>{t('actions.recommended', { value: question.recommendation })}</p>
          )}
          {!!question.options?.length && (
            <label>
              {t('actions.choose')}
              <select
                aria-label={question.question}
                value={
                  question.options.some((option) => option.value === value(question.id))
                    ? value(question.id)
                    : value(question.id)
                      ? '__other'
                      : ''
                }
                onChange={(event) =>
                  update(question.id, event.target.value === '__other' ? '' : event.target.value)
                }
              >
                <option value="">—</option>
                {question.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label ?? option.value}
                    {option.description ? ` — ${option.description}` : ''}
                  </option>
                ))}
                <option value="__other">{t('actions.custom')}</option>
              </select>
            </label>
          )}
          <label>
            {t('actions.custom')}
            <textarea
              aria-label={t('actions.custom')}
              value={
                question.options?.some((option) => option.value === value(question.id))
                  ? ''
                  : value(question.id)
              }
              onChange={(event) => update(question.id, event.target.value)}
            />
          </label>
        </fieldset>
      ))}
      {clarification.status === 'open' && (
        <>
          <p className="muted">{t('actions.partial')}</p>
          <div className="detail-actions">
            <button
              className="primary-button"
              disabled={disabled || !answers.length}
              onClick={() => void submit(answers)}
            >
              {t('actions.submit')}
            </button>
            <button className="secondary-button" disabled={disabled} onClick={() => void cancel()}>
              {t('actions.cancel')}
            </button>
          </div>
        </>
      )}
    </article>
  );
}

export function TaskRuntimeBadges({
  state,
  taskId,
  runId,
}: {
  state: Snapshot;
  taskId?: string;
  runId?: string;
}) {
  const { t } = useLocale();
  const incident = state.incidents?.some(
    (item) =>
      item.status !== 'resolved' &&
      ((taskId && item.taskId === taskId) || (runId && item.runId === runId)),
  );
  const recovery = state.recoveryItems?.some(
    (item) =>
      ['pending', 'recoverable'].includes(item.status) &&
      ((taskId && item.taskId === taskId) || (runId && item.oldRunId === runId)),
  );
  const sourceId =
    state.tasks.find((task) => task.id === taskId)?.sourceMessageId ??
    state.runs.find((run) => run.id === runId)?.sourceMessageId;
  const clarification =
    sourceId &&
    state.clarifications?.some(
      (item) => item.status === 'open' && item.sourceMessageId === sourceId,
    );
  return (
    <>
      {incident && <span className="runtime-badge warning">{t('actions.incidentBadge')}</span>}
      {recovery && <span className="runtime-badge">{t('actions.recoveryBadge')}</span>}
      {clarification && <span className="runtime-badge">{t('actions.clarificationBadge')}</span>}
    </>
  );
}
