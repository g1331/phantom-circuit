import { useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { Repo } from '../shared/types.ts';
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
            ...repo.commands,
            install: String(f.get('install')),
            build: String(f.get('build')),
            test: String(f.get('test')),
          },
          requiredChecks: String(f.get('checks'))
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
        });
      }}
    >
      {(['install', 'build', 'test'] as const).map((k) => (
        <label key={k}>
          {
            {
              install: t('ui.installDependencies'),
              build: t('ui.build'),
              test: t('ui.acceptanceTestsRequiredForDelivery'),
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
              }[k]
            }
          />
        </label>
      ))}
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
