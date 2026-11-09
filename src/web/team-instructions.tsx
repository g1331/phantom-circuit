import { useState } from 'react';
import type {
  Snapshot,
  TeamInstructionSections,
  TeamInstructionsVersion,
} from '../shared/types.ts';
import {
  TEAM_INSTRUCTIONS_LIMIT,
  teamInstructionKeys,
  teamInstructionsLength,
} from '../shared/team-instructions.ts';
import { api } from './api.ts';
import { Fold } from './fold.tsx';
import { ErrorText } from './error-text.tsx';
import { MarkdownContent } from './markdown-content.tsx';
import { useLocale } from './locale/provider.tsx';
import { routeHref } from './route.ts';

const empty: TeamInstructionSections = { repository: '', engineering: '', delivery: '' };
export function TeamInstructionText({ sections }: { sections: TeamInstructionSections }) {
  const { t } = useLocale();
  return (
    <div className="team-instruction-text">
      {teamInstructionKeys.map((key) => (
        <section key={key}>
          <h4>{t(`teamInstructions.${key}`)}</h4>
          {sections[key] ? (
            <MarkdownContent content={sections[key]} copyable={false} />
          ) : (
            <p className="muted">{t('teamInstructions.empty')}</p>
          )}
        </section>
      ))}
    </div>
  );
}

export function TeamInstructions({
  state,
  projectId,
  refresh,
}: {
  state: Snapshot;
  projectId: string;
  refresh: () => Promise<unknown>;
}) {
  const { t, date } = useLocale();
  const versions = (state.teamInstructions ?? [])
    .filter((v) => v.projectId === projectId)
    .sort((a, b) => a.version - b.version);
  const current = versions.at(-1);
  const version = current?.version ?? 0;
  const [draft, setDraft] = useState<{ sections: TeamInstructionSections; baseVersion: number }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>();
  const [from, setFrom] = useState<number>();
  const [to, setTo] = useState<number>();
  const before = versions.find((v) => v.version === (from ?? versions.at(-2)?.version));
  const after = versions.find((v) => v.version === (to ?? version));
  const length = draft ? teamInstructionsLength(draft.sections) : 0;
  async function save(restore?: TeamInstructionsVersion) {
    setBusy(true);
    setError(undefined);
    try {
      await api(
        `/projects/${projectId}/team-instructions${restore ? '/restore' : ''}`,
        restore ? { version: restore.version, baseVersion: version } : draft,
      );
      setDraft(undefined);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="doc-section team-instructions" aria-label={t('teamInstructions.title')}>
      <h2>{t('teamInstructions.title')}</h2>
      <p className="muted">{t('teamInstructions.intro')}</p>
      <Fold title={t('teamInstructions.current')} meta={`v${version}`} open>
        {draft ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {teamInstructionKeys.map((key) => (
              <label key={key}>
                {t(`teamInstructions.${key}`)}
                <textarea
                  aria-label={t(`teamInstructions.${key}`)}
                  rows={4}
                  value={draft.sections[key]}
                  disabled={busy}
                  onChange={(e) =>
                    setDraft({ ...draft, sections: { ...draft.sections, [key]: e.target.value } })
                  }
                />
              </label>
            ))}
            <p aria-live="polite" className={length > TEAM_INSTRUCTIONS_LIMIT ? 'error' : 'muted'}>
              {length} / {TEAM_INSTRUCTIONS_LIMIT} {t('teamInstructions.characters')}
            </p>
            <div className="team-instruction-actions">
              <button
                className="primary-button"
                type="submit"
                disabled={busy || length > TEAM_INSTRUCTIONS_LIMIT}
              >
                {t('teamInstructions.save')}
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft(undefined);
                  setError(undefined);
                }}
              >
                {t('teamInstructions.cancel')}
              </button>
            </div>
          </form>
        ) : (
          <>
            <TeamInstructionText sections={current?.sections ?? empty} />
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                setDraft({
                  sections: structuredClone(current?.sections ?? empty),
                  baseVersion: version,
                })
              }
            >
              {t('teamInstructions.edit')}
            </button>
          </>
        )}
      </Fold>
      {error !== undefined && (
        <div role="alert">
          <ErrorText error={error} />
        </div>
      )}
      <Fold title={t('teamInstructions.history')} meta={versions.length}>
        {!versions.length && <p>{t('teamInstructions.noHistory')}</p>}
        <ol className="record-list">
          {versions
            .slice()
            .reverse()
            .map((v) => (
              <li key={v.version}>
                <Fold
                  title={`v${v.version} · ${t(`teamInstructions.source.${v.source}`)}`}
                  meta={date(v.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
                >
                  {v.taskId && (
                    <p>
                      <a href={routeHref({ page: 'task', projectId, taskId: v.taskId })}>
                        {state.tasks.find((task) => task.id === v.taskId)?.title ?? v.taskId}
                      </a>
                    </p>
                  )}
                  {v.restoredFromVersion && (
                    <p>{t('teamInstructions.restored', { version: v.restoredFromVersion })}</p>
                  )}
                  <TeamInstructionText sections={v.sections} />
                  <button
                    className="secondary-button"
                    disabled={busy || !!draft}
                    onClick={() => void save(v)}
                  >
                    {t('teamInstructions.restore', { version: v.version })}
                  </button>
                </Fold>
              </li>
            ))}
        </ol>
      </Fold>
      <Fold title={t('teamInstructions.diff')}>
        {versions.length < 2 ? (
          <p>{t('teamInstructions.noDiff')}</p>
        ) : (
          <>
            <div className="team-instruction-selects">
              {(['from', 'to'] as const).map((side) => (
                <label key={side}>
                  {t(`teamInstructions.${side}`)}
                  <select
                    aria-label={t(`teamInstructions.${side}`)}
                    value={(side === 'from' ? before : after)?.version}
                    onChange={(e) => (side === 'from' ? setFrom : setTo)(Number(e.target.value))}
                  >
                    {versions.map((v) => (
                      <option key={v.version} value={v.version}>
                        v{v.version}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            {before &&
              after &&
              (teamInstructionKeys.every((key) => before.sections[key] === after.sections[key]) ? (
                <p>{t('teamInstructions.identical')}</p>
              ) : (
                teamInstructionKeys
                  .filter((key) => before.sections[key] !== after.sections[key])
                  .map((key) => (
                    <section key={key} className="team-instruction-change">
                      <h4>{t(`teamInstructions.${key}`)}</h4>
                      <div className="team-instruction-comparison">
                        <div>
                          <strong>
                            {t('teamInstructions.from')} · v{before.version}
                          </strong>
                          <pre className="removed">
                            {before.sections[key] || t('teamInstructions.empty')}
                          </pre>
                        </div>
                        <div>
                          <strong>
                            {t('teamInstructions.to')} · v{after.version}
                          </strong>
                          <pre className="added">
                            {after.sections[key] || t('teamInstructions.empty')}
                          </pre>
                        </div>
                      </div>
                    </section>
                  ))
              ))}
          </>
        )}
      </Fold>
    </section>
  );
}
