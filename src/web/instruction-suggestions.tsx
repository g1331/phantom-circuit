import { useEffect, useState } from 'react';
import type { ConversationPage, Snapshot } from '../shared/types.ts';
import { Fold } from './fold.tsx';
import { teamInstructionKeys } from '../shared/team-instructions.ts';
import { api } from './api.ts';
import { ErrorText } from './error-text.tsx';
import { useLocale } from './locale/provider.tsx';
import { routeHref } from './route.ts';

function MessageEvidence({ projectId, messageId }: { projectId: string; messageId: string }) {
  const [content, setContent] = useState('');
  const [error, setError] = useState<Error>();
  useEffect(() => {
    const controller = new AbortController();
    void api<ConversationPage>(
      `/projects/${projectId}/messages?ids=${encodeURIComponent(messageId)}`,
      undefined,
      'GET',
      controller.signal,
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        const entry = page.entries[0];
        if (entry?.kind === 'message') setContent(entry.value.content);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error : new Error(String(error)));
      });
    return () => controller.abort();
  }, [projectId, messageId]);
  return error ? <ErrorText error={error} /> : content ? <p>{content}</p> : null;
}

export function InstructionSuggestions({
  state,
  projectId,
  refresh,
}: {
  state: Snapshot;
  projectId: string;
  refresh: () => Promise<unknown>;
}) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [autoDraft, setAutoDraft] = useState<boolean>();
  const [error, setError] = useState<Error | string>();
  const suggestions = (state.suggestions ?? []).filter((s) => s.projectId === projectId).reverse();
  const project = state.projects.find((p) => p.id === projectId)!;
  async function act(path: string, body: unknown) {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/projects/${projectId}/team-instructions/${path}`, body);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e : String(e));
    } finally {
      setAutoDraft(undefined);
      setBusy(false);
    }
  }
  return (
    <Fold
      title={t('suggestions.title')}
      meta={suggestions.filter((s) => s.status === 'pending').length}
      open={suggestions.some((s) => s.status === 'pending')}
    >
      <label>
        <input
          type="checkbox"
          checked={autoDraft ?? !!project.autoAdoptInstructions}
          disabled={busy}
          onChange={(e) => {
            setAutoDraft(e.target.checked);
            void act('auto-adopt', { enabled: e.target.checked });
          }}
        />
        {t('suggestions.auto')}
      </label>
      <p className="muted">{t('suggestions.mode')}</p>
      {error !== undefined && (
        <div role="alert">
          <ErrorText error={error} />
        </div>
      )}
      {!suggestions.length && <p>{t('suggestions.empty')}</p>}
      <ol className="record-list">
        {suggestions.map((s) => {
          const task = state.tasks.find((task) => task.id === s.taskId);
          const base = state.teamInstructions?.find(
            (v) => v.projectId === projectId && v.version === s.baseVersion,
          );
          return (
            <li key={s.id}>
              <Fold title={task?.title ?? s.taskId} meta={t(`suggestions.${s.status}`)}>
                <p>
                  <a href={routeHref({ page: 'task', projectId, taskId: s.taskId })}>
                    {task?.title ?? s.taskId}
                  </a>{' '}
                  · v{s.baseVersion} · {t(`suggestions.category.${s.category}`)}
                </p>
                <p>{s.reason}</p>
                <ul>
                  {s.interruptionIds.map((id) => {
                    const [kind, ...parts] = id.split(':');
                    const key = parts.join(':');
                    const detail =
                      kind === 'incident'
                        ? state.incidents?.find((i) => i.id === key)?.message
                        : undefined;
                    return (
                      <li key={id}>
                        <small>{id}</small>
                        {kind === 'message' && (
                          <MessageEvidence projectId={projectId} messageId={key} />
                        )}
                        {detail && <p>{detail}</p>}
                      </li>
                    );
                  })}
                </ul>
                {s.sections &&
                  teamInstructionKeys
                    .filter((key) => (base?.sections[key] ?? '') !== s.sections![key])
                    .map((key) => (
                      <section className="team-instruction-change" key={key}>
                        <h4>{t(`teamInstructions.${key}`)}</h4>
                        <div className="team-instruction-comparison">
                          <div>
                            <strong>
                              {t('teamInstructions.from')} · v{s.baseVersion}
                            </strong>
                            <pre className="removed">
                              {base?.sections[key] || t('teamInstructions.empty')}
                            </pre>
                          </div>
                          <div>
                            <strong>{t('teamInstructions.to')}</strong>
                            <pre className="added">
                              {s.sections![key] || t('teamInstructions.empty')}
                            </pre>
                          </div>
                        </div>
                      </section>
                    ))}
                {s.adoptedVersion && (
                  <p>
                    v{s.adoptedVersion} · {t('suggestions.adopted')}
                  </p>
                )}
                {s.status === 'pending' && (
                  <div className="team-instruction-actions">
                    <button
                      className="primary-button"
                      disabled={busy}
                      onClick={() =>
                        void act(`suggestions/${encodeURIComponent(s.id)}`, { action: 'adopt' })
                      }
                    >
                      {t('suggestions.adopt')}
                    </button>
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() =>
                        void act(`suggestions/${encodeURIComponent(s.id)}`, { action: 'ignore' })
                      }
                    >
                      {t('suggestions.ignore')}
                    </button>
                  </div>
                )}
              </Fold>
            </li>
          );
        })}
      </ol>
    </Fold>
  );
}
