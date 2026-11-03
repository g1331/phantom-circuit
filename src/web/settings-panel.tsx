import { useEffect, useRef, useState, type ComponentProps, type KeyboardEvent } from 'react';
import { Cpu, KeyRound, Radio, Users } from 'lucide-react';
import type { AgentKind, Project, Settings, Snapshot } from '../shared/types.ts';
import { api } from './api.ts';
import { ErrorText } from './error-text.tsx';
import { ProfileEditor } from './profile-editor.tsx';
import {
  AgentFields,
  OmpProfiles,
  RoleModes,
  SecondaryReview,
  agentName,
  profileNames,
  type RuntimeConfig,
} from './runtime-settings.tsx';
import { ProviderSettings } from './providers.tsx';
import { useLocale } from './locale/provider.tsx';

type Section = 'team' | 'models' | 'providers';
const icons = { team: Users, models: Cpu, providers: KeyRound };

export default function SettingsPanel({
  showProviders,
  ...props
}: Omit<ComponentProps<typeof SettingsForm>, 'section' | 'reveal'> & { showProviders: boolean }) {
  const { t } = useLocale();
  const sections: Section[] = showProviders ? ['team', 'models', 'providers'] : ['team', 'models'];
  const [section, setSection] = useState<Section>('team');
  const tabs = useRef<HTMLDivElement>(null);
  // Arrow keys move between pages, as in any tab list.
  const keys = (event: KeyboardEvent) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = sections[(sections.indexOf(section) + step + sections.length) % sections.length];
    setSection(next);
    tabs.current?.querySelector<HTMLElement>(`#settings-tab-${next}`)?.focus();
  };
  return (
    <div className="settings-layout">
      <div
        ref={tabs}
        className="settings-nav"
        role="tablist"
        aria-label={t('settings.sections')}
        onKeyDown={keys}
      >
        {sections.map((name) => {
          const Icon = icons[name];
          return (
            <button
              key={name}
              type="button"
              role="tab"
              id={`settings-tab-${name}`}
              aria-controls={`settings-${name}`}
              aria-selected={section === name}
              tabIndex={section === name ? 0 : -1}
              onClick={() => setSection(name)}
            >
              <Icon size={16} aria-hidden="true" />
              {t(`settings.section.${name}`)}
            </button>
          );
        })}
      </div>
      <div className="settings-pages">
        <SettingsForm {...props} section={section} reveal={setSection} />
        {showProviders && (
          <div
            className="settings-page"
            role="tabpanel"
            id="settings-providers"
            aria-labelledby="settings-tab-providers"
            hidden={section !== 'providers'}
          >
            <ProviderSettings />
          </div>
        )}
      </div>
    </div>
  );
}

export function SettingsForm({
  initial,
  submit,
  busy,
  providers,
  projectOnly,
  project,
  globalSettings,
  section,
  reveal,
}: {
  providers: Snapshot['providers'];
  projectOnly: boolean;
  project?: Project;
  globalSettings: Settings;
  initial: Settings;
  submit: (s: Settings, runtime: RuntimeConfig) => Promise<{ warnings: string[] }>;
  busy: boolean;
  section: Section;
  reveal: (section: Section) => void;
}) {
  const [settings, setSettings] = useState(structuredClone(initial));
  const [runtime, setRuntime] = useState<RuntimeConfig>({
    agentSelection: project?.agentSelection,
    profileModes: project?.profileModes,
    recoveryPolicy: project?.recoveryPolicy,
  });
  const effectiveProfiles = Object.fromEntries(
    profileNames.map((role) => [
      role,
      project && runtime.profileModes?.[role] === 'inherit'
        ? globalSettings.profiles[role]
        : settings.profiles[role],
    ]),
  ) as Settings['profiles'];
  const effectiveOmp = Object.fromEntries(
    profileNames.map((role) => [
      role,
      project && runtime.profileModes?.[role] === 'inherit'
        ? globalSettings.ompProfiles?.[role]
        : settings.ompProfiles?.[role],
    ]),
  ) as Settings['ompProfiles'];
  const { t } = useLocale();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | Error>('');
  const [saved, setSaved] = useState<string[]>();
  useEffect(() => {
    setSaved(undefined);
    setSaveError('');
  }, [settings, runtime]);
  const [health, setHealth] = useState<any>();
  const [checking, setChecking] = useState(false);
  const effectiveAgent =
    runtime.agentSelection?.mode === 'override'
      ? runtime.agentSelection.agent
      : (settings.defaultAgent ?? 'omp');
  // The models page follows the agent in use, and the user may look at the other one.
  const [view, setView] = useState<AgentKind>(effectiveAgent);
  useEffect(() => setView(effectiveAgent), [effectiveAgent]);
  const ompSettings = { ...settings, ompProfiles: effectiveOmp };
  const changeSettings = (next: Settings) => {
    setSettings(next);
    if (project && next.ompProfiles !== effectiveOmp)
      setRuntime((current) => ({
        ...current,
        profileModes: Object.fromEntries(
          profileNames.map((role) => [
            role,
            next.ompProfiles?.[role] !== effectiveOmp?.[role]
              ? 'pinned'
              : (current.profileModes?.[role] ?? 'pinned'),
          ]),
        ) as NonNullable<Project['profileModes']>,
      }));
  };
  const changeRuntime = (next: RuntimeConfig) => {
    const pinned = profileNames.filter(
      (role) =>
        runtime.profileModes?.[role] === 'inherit' && next.profileModes?.[role] === 'pinned',
    );
    if (pinned.length)
      setSettings((current) => ({
        ...current,
        profiles: {
          ...current.profiles,
          ...Object.fromEntries(pinned.map((role) => [role, effectiveProfiles[role]])),
        },
        ompProfiles: {
          ...current.ompProfiles,
          ...Object.fromEntries(pinned.map((role) => [role, effectiveOmp?.[role]])),
        } as Settings['ompProfiles'],
      }));
    setRuntime(next);
  };
  return (
    <form
      className="form settings-form"
      hidden={section === 'providers'}
      // A required field on a hidden page would block saving without a word; show it instead.
      onInvalidCapture={(event) => {
        const field = event.target as HTMLInputElement;
        const page = field.closest<HTMLElement>('[data-section]')?.dataset.section as Section;
        const agent = field.closest<HTMLElement>('[data-agent]')?.dataset.agent as AgentKind;
        if (page && page !== section) reveal(page);
        if (agent && agent !== view) setView(agent);
        if ((page && page !== section) || (agent && agent !== view))
          requestAnimationFrame(() => field.reportValidity());
      }}
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        setSaveError('');
        setSaved(undefined);
        void submit(settings, runtime)
          .then((result) => setSaved(result.warnings))
          .catch((error) => setSaveError(error instanceof Error ? error : String(error)))
          .finally(() => setSaving(false));
      }}
    >
      <div
        className="settings-page"
        role="tabpanel"
        id="settings-team"
        aria-labelledby="settings-tab-team"
        data-section="team"
        hidden={section !== 'team'}
      >
        {!projectOnly && (
          <section className="settings-block">
            <h3>{t('settings.capacity')}</h3>
            <p className="settings-hint">{t('settings.capacityHint')}</p>
            <div className="form-columns">
              <label>
                {t('settings.devLimit')}
                <input
                  type="number"
                  min={1}
                  max={32}
                  required
                  value={settings.globalDevLimit}
                  onChange={(e) =>
                    setSettings({ ...settings, globalDevLimit: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                {t('settings.reviewLimit')}
                <input
                  type="number"
                  min={1}
                  max={32}
                  required
                  value={settings.reviewLimit}
                  onChange={(e) =>
                    setSettings({ ...settings, reviewLimit: Number(e.target.value) })
                  }
                />
              </label>
            </div>
          </section>
        )}
        <AgentFields
          settings={ompSettings}
          project={project}
          runtime={runtime}
          changeRuntime={changeRuntime}
          change={changeSettings}
        />
        <section className="settings-block health-section">
          <h3>{t('settings.connection')}</h3>
          <div className="runtime-summary">
            <p>{t('settings.connectionHint')}</p>
            <button
              className="secondary-button"
              type="button"
              disabled={checking}
              onClick={() => {
                setChecking(true);
                void api('/health')
                  .then(setHealth)
                  .catch((e) => setHealth({ error: String(e) }))
                  .finally(() => setChecking(false));
              }}
            >
              <Radio size={15} />
              {checking ? t('settings.checking') : t('settings.check')}
            </button>
          </div>
          {health && (
            <div className="health-result">
              {health.error ? (
                <p className="check-failed">{health.error}</p>
              ) : (
                <>
                  <p className={health.codex.ok ? 'check-ok' : 'check-failed'}>
                    {health.codex.ok ? t('settings.connected') : health.codex.error}
                  </p>
                  <p className={health.github.ok ? 'check-ok' : 'check-failed'}>
                    {health.github.ok ? `GitHub · ${health.github.login}` : health.github.error}
                  </p>
                  {health.codex.models && (
                    <details>
                      <summary>{t('settings.available')}</summary>
                      {health.codex.models.map((m: any) => (
                        <p key={m.id}>
                          {m.model} ·{' '}
                          {m.supportedReasoningEfforts
                            .map((e: any) => e.reasoningEffort)
                            .join(' / ')}
                        </p>
                      ))}
                    </details>
                  )}
                </>
              )}
            </div>
          )}
        </section>
      </div>
      <div
        className="settings-page"
        role="tabpanel"
        id="settings-models"
        aria-labelledby="settings-tab-models"
        data-section="models"
        hidden={section !== 'models'}
      >
        <div className="agent-switch" role="group" aria-label={t('runtime.modelsFor')}>
          {(['omp', 'codex'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              data-agent-view={kind}
              aria-pressed={view === kind}
              onClick={() => setView(kind)}
            >
              {agentName(kind)}
              {kind === effectiveAgent && <small>{t('runtime.inUse')}</small>}
            </button>
          ))}
        </div>
        <div data-agent="omp" hidden={view !== 'omp'} className="agent-models">
          <section className="settings-block">
            <h3>{t('runtime.ompProfiles')}</h3>
            <OmpProfiles
              profiles={effectiveOmp}
              modes={project ? runtime.profileModes : undefined}
              change={(profiles) => changeSettings({ ...ompSettings, ompProfiles: profiles })}
            />
          </section>
          <SecondaryReview
            kind="omp"
            agent={effectiveAgent}
            settings={ompSettings}
            change={changeSettings}
          />
        </div>
        <div data-agent="codex" hidden={view !== 'codex'} className="agent-models">
          <section className="settings-block">
            <h3>{t('runtime.codexProfiles')}</h3>
            <fieldset className="assignment-form" disabled={saving || busy}>
              <ProfileEditor
                profiles={effectiveProfiles}
                providers={providers}
                modes={project ? runtime.profileModes : undefined}
                required={effectiveAgent === 'codex'}
                change={(profiles) => {
                  setSettings({ ...settings, profiles });
                  if (project)
                    setRuntime((current) => ({
                      ...current,
                      profileModes: Object.fromEntries(
                        profileNames.map((role) => [
                          role,
                          profiles[role] !== effectiveProfiles[role]
                            ? 'pinned'
                            : (current.profileModes?.[role] ?? 'pinned'),
                        ]),
                      ) as NonNullable<Project['profileModes']>,
                    }));
                }}
              />
            </fieldset>
          </section>
          <SecondaryReview
            kind="codex"
            agent={effectiveAgent}
            settings={ompSettings}
            change={changeSettings}
          />
        </div>
        {project && <RoleModes runtime={runtime} changeRuntime={changeRuntime} />}
      </div>
      <footer className="settings-footer">
        <div className="settings-footer-status">
          {saveError && (
            <p role="alert">
              <ErrorText error={saveError} />
            </p>
          )}
          {saved && (
            <p role="status">
              {t('ui.saved')} {saved.join('; ')}
            </p>
          )}
          {!saveError && !saved && <p className="settings-hint">{t('runtime.future')}</p>}
        </div>
        <button className="primary-button" disabled={busy || saving}>
          {saving ? t('ui.saving') : t('ui.saveSettings')}
        </button>
      </footer>
    </form>
  );
}
