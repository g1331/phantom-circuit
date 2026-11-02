import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Radio } from 'lucide-react';
import type { Project, Repo, Settings, Snapshot } from '../shared/types.ts';
import { api } from './api.ts';
import { ErrorText } from './error-text.tsx';
import { ProfileEditor } from './profile-editor.tsx';
import { RuntimeFields, profileNames, type RuntimeConfig } from './runtime-settings.tsx';
import { useLocale } from './locale/provider.tsx';

export function ProjectForm({
  submit,
  busy,
}: {
  submit: (b: { name: string; description: string }) => Promise<void>;
  busy: boolean;
}) {
  const { t } = useLocale();
  const [validation, setValidation] = useState<
    'project.required' | 'project.nameLength' | 'project.goalLength'
  >();
  return (
    <form
      className="form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const name = String(f.get('name'));
        const description = String(f.get('description'));
        const issue = !name.trim()
          ? 'project.required'
          : name.trim().length > 100
            ? 'project.nameLength'
            : description.length > 3000
              ? 'project.goalLength'
              : undefined;
        setValidation(issue);
        if (issue) return;
        void submit({ name, description });
      }}
    >
      <label>
        {t('project.name')}
        <input
          name="name"
          placeholder={t('project.namePlaceholder')}
          required
          maxLength={100}
          autoFocus
          aria-invalid={validation === 'project.required' || validation === 'project.nameLength'}
          aria-describedby={
            validation && validation !== 'project.goalLength' ? 'project-validation' : undefined
          }
        />
      </label>
      <label>
        {t('project.goal')}
        <textarea
          name="description"
          placeholder={t('project.goalPlaceholder')}
          maxLength={3000}
          aria-invalid={validation === 'project.goalLength'}
          aria-describedby={validation === 'project.goalLength' ? 'project-validation' : undefined}
        />
      </label>
      {validation && (
        <p id="project-validation" role="alert">
          {t(validation)}
        </p>
      )}
      <button className="primary-button" disabled={busy}>
        {t('project.create')} <ArrowUpRight size={16} />
      </button>
    </form>
  );
}
export function RepoForm({
  submit,
  busy,
}: {
  submit: (b: { path: string; github: string; authorized: boolean }) => Promise<void>;
  busy: boolean;
}) {
  const { t } = useLocale();
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void submit({
          path: String(f.get('path')),
          github: String(f.get('github')),
          authorized: f.get('authorized') === 'on',
        });
      }}
    >
      <label>
        {t('ui.githubRepository')}{' '}
        <input
          name="github"
          placeholder="owner/repository"
          required
          pattern="[\w.\-]+/[\w.\-]+"
          autoFocus
        />
      </label>
      <label>
        {t('ui.localRepositoryPath')}{' '}
        <input name="path" placeholder="D:\Codebase\my-project" required />
      </label>
      <label className="checkbox-label">
        <input name="authorized" type="checkbox" />
        <span>{t('ui.authorizeLocalDevelopmentAndVerificationGithubTasks')} </span>
      </label>
      <p className="field-note">{t('ui.usesTheGithubIdentitySignedInOn')} </p>
      <button className="primary-button" disabled={busy}>
        {busy ? t('ui.verifyingRepository') : t('repo.connect')} <ArrowUpRight size={16} />
      </button>
    </form>
  );
}
export function CommandsForm({
  repo,
  submit,
  busy,
}: {
  repo: Repo;
  submit: (b: unknown) => Promise<void>;
  busy: boolean;
}) {
  const { t } = useLocale();
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void submit({
          authorized: f.get('authorized') === 'on',
          commands: {
            install: String(f.get('install')),
            build: String(f.get('build')),
            test: String(f.get('test')),
            start: String(f.get('start')),
            port: Number(f.get('port')),
          },
          requiredChecks: String(f.get('checks'))
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
        });
      }}
    >
      {(['install', 'build', 'test', 'start'] as const).map((k) => (
        <label key={k}>
          {
            {
              install: t('ui.installDependencies'),
              build: t('ui.build'),
              test: t('ui.acceptanceTestsRequiredForDelivery'),
              start: t('ui.previewStartCommand'),
            }[k]
          }
          <input
            name={k}
            defaultValue={repo.commands[k]}
            placeholder={
              {
                install: t('ui.installExample'),
                build: t('ui.buildExample'),
                test: t('ui.forExampleNpmTest'),
                start: 'npm run dev -- --port {port}',
              }[k]
            }
          />
        </label>
      ))}
      <label>
        {t('ui.previewPort')}{' '}
        <input name="port" type="number" min={1024} max={65535} defaultValue={repo.commands.port} />
      </label>
      <label>
        {t('ui.requiredGithubChecks')}{' '}
        <input
          name="checks"
          defaultValue={repo.requiredChecks.join(', ')}
          placeholder={t('ui.checkNamesSeparatedByCommas')}
        />
      </label>
      <label className="checkbox-label">
        <input type="checkbox" name="authorized" defaultChecked={repo.authorized} />
        <span> {t('ui.authorizeLocalDevelopmentVerificationAndGithubEngineering')} </span>
      </label>
      <button className="primary-button" disabled={busy}>
        {t('common.saveConfig')}
      </button>
    </form>
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
