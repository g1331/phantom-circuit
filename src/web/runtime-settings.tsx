import { useEffect, useRef, useState } from 'react';
import type { AgentKind, Profile, ProfileName, Project, Settings } from '../shared/types.ts';
import { api } from './api.ts';
import { useLocale } from './locale/provider.tsx';

export type RuntimeConfig = Pick<
  Project,
  'agentSelection' | 'profileModes' | 'recoveryPolicy' | 'secondaryReviewProfile'
>;
export const profileNames: ProfileName[] = [
  'pm',
  'review',
  'backend',
  'frontend',
  'fullstack',
  'complex',
];
type AgentModel = { id: string; provider?: string; reasoningEfforts?: string[] };

export function RolePicker({
  selected,
  select,
  profiles,
  modes,
}: {
  selected: ProfileName;
  select: (role: ProfileName) => void;
  profiles?: Partial<Record<ProfileName, Profile>>;
  modes?: Project['profileModes'];
}) {
  const { t } = useLocale();
  return (
    <div className="role-picker" role="group" aria-label={t('runtime.roleSelection')}>
      {profileNames.map((role) => (
        <button
          key={role}
          type="button"
          aria-pressed={selected === role}
          onClick={() => select(role)}
        >
          <strong>{t(`profile.${role}`)}</strong>
          <span title={profiles?.[role]?.model}>
            {profiles?.[role]?.model || t('usage.unknown')}
          </span>
          {modes && (
            <small>{t(modes[role] === 'inherit' ? 'runtime.inherited' : 'runtime.pinned')}</small>
          )}
        </button>
      ))}
    </div>
  );
}

export function RuntimeFields({
  settings,
  change,
  project,
  runtime,
  changeRuntime,
}: {
  settings: Settings;
  change: (settings: Settings) => void;
  project?: Project;
  runtime: RuntimeConfig;
  changeRuntime: (runtime: RuntimeConfig) => void;
}) {
  const { t } = useLocale();
  const agent =
    runtime.agentSelection?.mode === 'override'
      ? runtime.agentSelection.agent
      : (settings.defaultAgent ?? 'omp');
  const [probe, setProbe] = useState<{ agent: AgentKind; ok: boolean; error?: string }>();
  const [checking, setChecking] = useState(false);
  const ompDetails = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (ompDetails.current) ompDetails.current.open = agent === 'omp';
  }, [agent]);
  return (
    <section className="runtime-settings" aria-label={t('runtime.title')}>
      <h3>{t('runtime.title')}</h3>
      <div className="runtime-primary">
        {project ? (
          <label>
            {t('runtime.selection')}
            <select
              aria-label={t('runtime.selection')}
              value={
                runtime.agentSelection?.mode === 'override'
                  ? runtime.agentSelection.agent
                  : 'inherit'
              }
              onChange={(event) =>
                changeRuntime({
                  ...runtime,
                  agentSelection:
                    event.target.value === 'inherit'
                      ? { mode: 'inherit' }
                      : { mode: 'override', agent: event.target.value as AgentKind },
                })
              }
            >
              <option value="inherit">{t('runtime.inherit')}</option>
              <option value="omp">OMP</option>
              <option value="codex">Codex</option>
            </select>
          </label>
        ) : (
          <label>
            {t('runtime.default')}
            <select
              aria-label={t('runtime.default')}
              value={settings.defaultAgent ?? 'omp'}
              onChange={(event) =>
                change({ ...settings, defaultAgent: event.target.value as AgentKind })
              }
            >
              <option value="omp">OMP</option>
              <option value="codex">Codex</option>
            </select>
          </label>
        )}
        {project && (
          <label>
            {t('runtime.recovery')}
            <select
              value={runtime.recoveryPolicy ?? 'automatic'}
              aria-label={t('runtime.recovery')}
              onChange={(event) =>
                changeRuntime({
                  ...runtime,
                  recoveryPolicy: event.target.value as 'automatic' | 'manual',
                })
              }
            >
              <option value="automatic">{t('runtime.automatic')}</option>
              <option value="manual">{t('runtime.manual')}</option>
            </select>
          </label>
        )}
      </div>
      <div className="runtime-summary">
        <p role="status">{t('runtime.effective', { agent: agent === 'omp' ? 'OMP' : 'Codex' })}</p>
        <p className="muted">{t('runtime.future')}</p>
        <button
          className="secondary-button"
          type="button"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            setProbe(undefined);
            void api<{ available?: boolean; ok?: boolean; error?: string }>(
              `/agents/${agent}/probe`,
            )
              .then((result) =>
                setProbe({
                  agent,
                  ok: result.available ?? result.ok ?? false,
                  error: result.error,
                }),
              )
              .catch((error) => setProbe({ agent, ok: false, error: String(error) }))
              .finally(() => setChecking(false));
          }}
        >
          {t('runtime.probe')}
        </button>
      </div>
      {probe?.agent === agent && (
        <p role={probe.ok ? 'status' : 'alert'}>
          {t(probe.ok ? 'runtime.probeOk' : 'runtime.unavailable')} {probe.error}
        </p>
      )}
      {project && (
        <details className="settings-group role-modes-group">
          <summary>{t('runtime.assignmentModes')}</summary>
          <p className="muted">{t('runtime.assignmentModesHint')}</p>
          <div className="role-modes">
            {profileNames.map((role) => (
              <label key={role}>
                {t('runtime.mode', { role: t(`profile.${role}`) })}
                <select
                  value={runtime.profileModes?.[role] ?? 'pinned'}
                  onChange={(event) =>
                    changeRuntime({
                      ...runtime,
                      profileModes: {
                        ...Object.fromEntries(
                          profileNames.map((name) => [
                            name,
                            runtime.profileModes?.[name] ?? 'pinned',
                          ]),
                        ),
                        [role]: event.target.value,
                      } as NonNullable<Project['profileModes']>,
                    })
                  }
                >
                  <option value="inherit">{t('runtime.inherited')}</option>
                  <option value="pinned">{t('runtime.pinned')}</option>
                </select>
              </label>
            ))}
          </div>
        </details>
      )}
      <details className="settings-group" ref={ompDetails}>
        <summary>{t('runtime.ompProfiles')}</summary>
        <OmpProfiles
          profiles={settings.ompProfiles}
          modes={project ? runtime.profileModes : undefined}
          change={(profiles) => change({ ...settings, ompProfiles: profiles })}
        />
      </details>
      <details className="settings-group">
        <summary>{t('runtime.secondary')}</summary>
        <p className="muted">{t('runtime.secondaryHint')}</p>
        {(['omp', 'codex'] as const).map((kind) => {
          const profile =
            settings.secondaryReviewProfiles?.[kind] ??
            (kind === agent ? settings.secondaryReviewProfile : undefined);
          const update = (value?: Profile) => {
            const profiles = { ...settings.secondaryReviewProfiles };
            if (value) profiles[kind] = value;
            else delete profiles[kind];
            change({
              ...settings,
              secondaryReviewProfile: undefined,
              secondaryReviewProfiles: profiles,
            });
          };
          return (
            <fieldset className="assignment" key={kind}>
              <legend>
                {kind === 'omp' ? 'OMP' : 'Codex'} · {t('runtime.secondary')}
              </legend>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={!!profile}
                  onChange={(event) =>
                    update(
                      event.target.checked
                        ? {
                            ...((kind === 'omp'
                              ? settings.ompProfiles?.review
                              : settings.profiles.review) ?? {
                              providerId: '',
                              model: '',
                              effort: '',
                            }),
                          }
                        : undefined,
                    )
                  }
                />
                {t('runtime.secondaryFor', { agent: kind === 'omp' ? 'OMP' : 'Codex' })}
              </label>
              {profile && (
                <div className="assignment-fields">
                  {(['providerId', 'model', 'effort'] as const).map((field) => (
                    <label key={field}>
                      {t(
                        field === 'providerId'
                          ? 'runtime.provider'
                          : field === 'model'
                            ? 'ui.model'
                            : 'ui.reasoningEffort',
                      )}
                      <input
                        aria-label={`${kind} ${t('runtime.secondary')} ${t(field === 'providerId' ? 'runtime.provider' : field === 'model' ? 'ui.model' : 'ui.reasoningEffort')}`}
                        value={profile[field]}
                        onChange={(event) => update({ ...profile, [field]: event.target.value })}
                      />
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
          );
        })}
      </details>
    </section>
  );
}

function OmpProfiles({
  profiles,
  modes,
  change,
}: {
  profiles?: Settings['ompProfiles'];
  modes?: Project['profileModes'];
  change: (profiles: NonNullable<Settings['ompProfiles']>) => void;
}) {
  const { t } = useLocale();
  const [role, setRole] = useState<ProfileName>('pm');
  const [discovery, setDiscovery] = useState<{
    models: AgentModel[];
    available: boolean;
    error?: string;
  }>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    void api<{ models: AgentModel[]; available: boolean; error?: string }>('/agents/omp/models')
      .then((result) => {
        if (current) setDiscovery(result);
      })
      .catch((error) => {
        if (current) setDiscovery({ models: [], available: false, error: String(error) });
      });
    return () => {
      current = false;
    };
  }, [revision]);
  function update(role: ProfileName, profile: Profile) {
    change({
      ...Object.fromEntries(
        profileNames.map((name) => [
          name,
          profiles?.[name] ?? { providerId: '', model: '', effort: '' },
        ]),
      ),
      [role]: profile,
    } as NonNullable<Settings['ompProfiles']>);
  }
  const profile = profiles?.[role];
  const selected = discovery?.models.find(
    (model) => model.id === profile?.model && (model.provider ?? '') === profile?.providerId,
  );
  return (
    <div className="omp-profiles">
      <RolePicker selected={role} select={setRole} profiles={profiles} modes={modes} />
      <button
        className="text-button"
        type="button"
        onClick={() => setRevision((value) => value + 1)}
      >
        {t('runtime.refreshModels')}
      </button>
      {discovery && !discovery.available && (
        <p role="alert">
          {t('runtime.unavailable')} {discovery.error}
        </p>
      )}
      <div className="role-panel">
        <fieldset className="assignment" key={role}>
          <legend>OMP · {t(`profile.${role}`)}</legend>
          <div className="assignment-fields">
            <label>
              {t('runtime.model', { role: t(`profile.${role}`) })}
              <select
                value={JSON.stringify([profile?.providerId ?? '', profile?.model ?? ''])}
                aria-label={t('runtime.model', { role: t(`profile.${role}`) })}
                onChange={(event) => {
                  const [providerId, model] = JSON.parse(event.target.value) as string[];
                  const item = discovery?.models.find(
                    (item) => item.id === model && (item.provider ?? '') === providerId,
                  );
                  update(role, {
                    providerId,
                    model,
                    effort: item?.reasoningEfforts?.[0] ?? profile?.effort ?? '',
                  });
                }}
              >
                {!selected && (
                  <option value={JSON.stringify([profile?.providerId ?? '', profile?.model ?? ''])}>
                    {profile?.model || t('usage.unknown')}
                  </option>
                )}
                {discovery?.models.map((model) => (
                  <option
                    key={`${model.provider}/${model.id}`}
                    value={JSON.stringify([model.provider ?? '', model.id])}
                  >
                    {model.provider} / {model.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('runtime.effort', { role: t(`profile.${role}`) })}
              {selected?.reasoningEfforts?.length ? (
                <select
                  value={profile?.effort ?? ''}
                  aria-label={t('runtime.effort', { role: t(`profile.${role}`) })}
                  onChange={(event) => update(role, { ...profile!, effort: event.target.value })}
                >
                  {!selected.reasoningEfforts.includes(profile?.effort ?? '') && (
                    <option value={profile?.effort ?? ''}>
                      {profile?.effort || t('usage.unknown')}
                    </option>
                  )}
                  {selected.reasoningEfforts.map((effort) => (
                    <option key={effort}>{effort}</option>
                  ))}
                </select>
              ) : (
                <input
                  value={profile?.effort ?? ''}
                  aria-label={t('runtime.effort', { role: t(`profile.${role}`) })}
                  onChange={(event) =>
                    update(role, {
                      ...(profile ?? { providerId: '', model: '' }),
                      effort: event.target.value,
                    })
                  }
                />
              )}
            </label>
          </div>
        </fieldset>
      </div>
    </div>
  );
}
