import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Radio } from 'lucide-react';
import type { Project, Settings, Snapshot } from '../shared/types.ts';
import { api } from './api.ts';
import { ErrorText } from './error-text.tsx';
import { ProfileEditor } from './profile-editor.tsx';
import { RuntimeFields, profileNames, type RuntimeConfig } from './runtime-settings.tsx';
import { ProviderSettings } from './providers.tsx';
import { useLocale } from './locale/provider.tsx';

export default function SettingsPanel({
  showProviders,
  ...props
}: ComponentProps<typeof SettingsForm> & { showProviders: boolean }) {
  const { t } = useLocale();
  return (
    <>
      {showProviders && (
        <details className="settings-group provider-group">
          <summary>{t('ui.providerManagement')}</summary>
          <ProviderSettings />
        </details>
      )}
      <SettingsForm {...props} />
    </>
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
}: {
  providers: Snapshot['providers'];
  projectOnly: boolean;
  project?: Project;
  globalSettings: Settings;
  initial: Settings;
  submit: (s: Settings, runtime: RuntimeConfig) => Promise<{ warnings: string[] }>;
  busy: boolean;
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
  const codexDetails = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (codexDetails.current) codexDetails.current.open = effectiveAgent === 'codex';
  }, [effectiveAgent]);
  return (
    <form
      className="form"
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
      {!projectOnly && (
        <div className="form-columns">
          <label>
            {t('settings.devLimit')}
            <input
              type="number"
              min={1}
              max={32}
              required
              value={settings.globalDevLimit}
              onChange={(e) => setSettings({ ...settings, globalDevLimit: Number(e.target.value) })}
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
              onChange={(e) => setSettings({ ...settings, reviewLimit: Number(e.target.value) })}
            />
          </label>
        </div>
      )}
      <RuntimeFields
        settings={{ ...settings, ompProfiles: effectiveOmp }}
        project={project}
        runtime={runtime}
        changeRuntime={(next) => {
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
        }}
        change={(next) => {
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
        }}
      />
      <details className="settings-group" ref={codexDetails}>
        <summary>{t('runtime.codexProfiles')}</summary>
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
      </details>
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
      <div className="health-section">
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
        {health && (
          <div className="health-result">
            {health.error ?? (
              <>
                <p>{health.codex.ok ? t('settings.connected') : '! ' + health.codex.error}</p>
                <p>
                  {health.github.ok
                    ? `✓ GitHub · ${health.github.login}`
                    : '! ' + health.github.error}
                </p>
                {health.codex.models && (
                  <details>
                    <summary>{t('settings.available')}</summary>
                    {health.codex.models.map((m: any) => (
                      <p key={m.id}>
                        {m.model} ·{' '}
                        {m.supportedReasoningEfforts.map((e: any) => e.reasoningEffort).join(' / ')}
                      </p>
                    ))}
                  </details>
                )}
              </>
            )}
          </div>
        )}
      </div>
      <button className="primary-button" disabled={busy || saving}>
        {saving ? t('ui.saving') : t('ui.saveSettings')}
      </button>
    </form>
  );
}
