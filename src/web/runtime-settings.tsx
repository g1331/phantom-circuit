import { useEffect, useState } from 'react';
import type { AgentKind, Profile, ProfileName, Project, Settings } from '../shared/types.ts';
import { api } from './api.ts';
import { useLocale } from './locale/provider.tsx';
import { unset } from './ui.tsx';

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
export const agentName = (agent: AgentKind) => (agent === 'omp' ? 'OMP' : 'Codex');
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
      {profileNames.map((role) => {
        const model = profiles?.[role]?.model;
        return (
          <button
            key={role}
            type="button"
            aria-pressed={selected === role}
            onClick={() => select(role)}
          >
            <strong>{t(`profile.${role}`)}</strong>
            <span title={model} className={unset(model) ? 'is-unset' : undefined}>
              {unset(model) ? t('runtime.unconfigured') : model}
            </span>
            {modes && (
              <small>{t(modes[role] === 'inherit' ? 'runtime.inherited' : 'runtime.pinned')}</small>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Which agent runs the team, and how interrupted work comes back. */
export function AgentFields({
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
  return (
    <section className="runtime-settings settings-block" aria-label={t('runtime.title')}>
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
        <p role="status">{t('runtime.effective', { agent: agentName(agent) })}</p>
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
          {checking ? t('settings.checking') : t('runtime.probe')}
        </button>
      </div>
      {probe?.agent === agent && (
        <p role={probe.ok ? 'status' : 'alert'} className={probe.ok ? 'check-ok' : 'check-failed'}>
          {t(probe.ok ? 'runtime.probeOk' : 'runtime.unavailable')} {probe.error}
        </p>
      )}
    </section>
  );
}

/** A project role either follows the global assignment or keeps its own. */
export function RoleModes({
  runtime,
  changeRuntime,
}: {
  runtime: RuntimeConfig;
  changeRuntime: (runtime: RuntimeConfig) => void;
}) {
  const { t } = useLocale();
  return (
    <section className="settings-block role-modes-group">
      <h3>{t('runtime.assignmentModes')}</h3>
      <p className="settings-hint">{t('runtime.assignmentModesHint')}</p>
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
                      profileNames.map((name) => [name, runtime.profileModes?.[name] ?? 'pinned']),
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
    </section>
  );
}

/** The second, different-model review for one agent. */
export function SecondaryReview({
  kind,
  agent,
  settings,
  change,
}: {
  kind: AgentKind;
  agent: AgentKind;
  settings: Settings;
  change: (settings: Settings) => void;
}) {
  const { t } = useLocale();
  const profile =
    settings.secondaryReviewProfiles?.[kind] ??
    (kind === agent ? settings.secondaryReviewProfile : undefined);
  const update = (value?: Profile) => {
    const profiles = { ...settings.secondaryReviewProfiles };
    if (value) profiles[kind] = value;
    else delete profiles[kind];
    change({ ...settings, secondaryReviewProfile: undefined, secondaryReviewProfiles: profiles });
  };
  const label = (field: keyof Profile) =>
    t(
      field === 'providerId'
        ? 'runtime.provider'
        : field === 'model'
          ? 'ui.model'
          : 'ui.reasoningEffort',
    );
  return (
    <section className="settings-block">
      <h3>{t('runtime.secondary')}</h3>
      <p className="settings-hint">{t('runtime.secondaryHint')}</p>
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
                      : settings.profiles.review) ?? { providerId: '', model: '', effort: '' }),
                  }
                : undefined,
            )
          }
        />
        {t('runtime.secondaryFor', { agent: agentName(kind) })}
      </label>
      {profile && (
        <div className="assignment-fields">
          {(['providerId', 'model', 'effort'] as const).map((field) => (
            <label key={field}>
              {label(field)}
              <input
                aria-label={`${kind} ${t('runtime.secondary')} ${label(field)}`}
                value={unset(profile[field]) ? '' : profile[field]}
                placeholder={t('runtime.unconfigured')}
                onChange={(event) => update({ ...profile, [field]: event.target.value })}
              />
            </label>
          ))}
        </div>
      )}
    </section>
  );
}

export function OmpProfiles({
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
  const roleName = t(`profile.${role}`);
  return (
    <div className="omp-profiles">
      <RolePicker selected={role} select={setRole} profiles={profiles} modes={modes} />
      {discovery && !discovery.available && (
        <p role="alert" className="check-failed">
          {t('runtime.unavailable')} {discovery.error}
        </p>
      )}
      <fieldset className="assignment" key={role}>
        <legend>{roleName}</legend>
        <div className="assignment-fields two">
          <label>
            {t('runtime.model', { role: roleName })}
            <select
              value={JSON.stringify([profile?.providerId ?? '', profile?.model ?? ''])}
              aria-label={t('runtime.model', { role: roleName })}
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
                  {unset(profile?.model) ? t('runtime.unconfigured') : profile!.model}
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
            {t('runtime.effort', { role: roleName })}
            {selected?.reasoningEfforts?.length ? (
              <select
                value={profile?.effort ?? ''}
                aria-label={t('runtime.effort', { role: roleName })}
                onChange={(event) => update(role, { ...profile!, effort: event.target.value })}
              >
                {!selected.reasoningEfforts.includes(profile?.effort ?? '') && (
                  <option value={profile?.effort ?? ''}>
                    {unset(profile?.effort) ? t('runtime.unconfigured') : profile!.effort}
                  </option>
                )}
                {selected.reasoningEfforts.map((effort) => (
                  <option key={effort}>{effort}</option>
                ))}
              </select>
            ) : (
              <input
                value={unset(profile?.effort) ? '' : profile!.effort}
                placeholder={t('runtime.unconfigured')}
                aria-label={t('runtime.effort', { role: roleName })}
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
        <div className="assignment-actions">
          <button
            className="text-button"
            type="button"
            onClick={() => setRevision((value) => value + 1)}
          >
            {t('runtime.refreshModels')}
          </button>
        </div>
      </fieldset>
    </div>
  );
}
