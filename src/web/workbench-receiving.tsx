import { useState, type FormEvent } from 'react';
import type { IntakeSource } from '../shared/intake.ts';
import type { Repo } from '../shared/types.ts';
import { api } from './api.ts';
import { Modal } from './ui.tsx';
import { useLocale } from './locale/provider.tsx';

function localDate(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

export function ReceivingForm({
  repo,
  source,
  onSaved,
  autoFocus = true,
}: {
  repo: Repo;
  source?: IntakeSource;
  autoFocus?: boolean;
  onSaved: () => Promise<void>;
}) {
  const { t, host } = useLocale();
  const [enabled, setEnabled] = useState(source?.enabled ?? false);
  const [command, setCommand] = useState(source?.command ?? '/phantom');
  const [actors, setActors] = useState(
    source?.allowedActors.map((actor) => actor.login).join(', ') ?? '',
  );
  const [since, setSince] = useState(localDate(source?.since ?? new Date().toISOString()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(
        `/repos/${repo.id}/intake`,
        {
          enabled,
          command,
          since: new Date(since).toISOString(),
          allowedActors: actors.split(/[,，\s]+/).filter(Boolean),
          expectedVersion: source?.version ?? 0,
        },
        'PUT',
      );
      await onSaved();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="flow-receiving-form" onSubmit={save}>
      {error && (
        <div className="error-inline" role="alert">
          {host(error)}
        </div>
      )}
      <label className="flow-receiving-enabled">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        {t('flow.enabled')}
      </label>
      <label>
        {t('flow.command')}
        <input
          autoFocus={autoFocus}
          required
          value={command}
          pattern={'/[a-z][a-z0-9\\-]*'}
          title={t('flow.commandHint')}
          onChange={(event) => setCommand(event.target.value)}
        />
      </label>
      <label>
        {t('flow.actors')}
        <input
          required={enabled}
          value={actors}
          title={t('flow.actorsHint')}
          onChange={(event) => setActors(event.target.value)}
        />
      </label>
      <label>
        {t('flow.since')}
        <input
          required
          type="datetime-local"
          step="1"
          value={since}
          onChange={(event) => setSince(event.target.value)}
        />
      </label>
      <button className="primary-button" disabled={busy} type="submit">
        {busy ? t('ui.saving') : t('flow.save')}
      </button>
    </form>
  );
}

export function ReceivingSettings({
  repos,
  sources,
  initialRepoId,
  onClose,
  onSaved,
}: {
  repos: Repo[];
  sources: IntakeSource[];
  initialRepoId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLocale();
  const [repoId, setRepoId] = useState(initialRepoId);
  const repo = repos.find((item) => item.id === repoId);
  return (
    <Modal title={t('flow.settings')} onClose={onClose}>
      {repos.length > 1 && (
        <label className="flow-receiving-repo">
          {t('flow.repo')}
          <select value={repoId} onChange={(event) => setRepoId(event.target.value)}>
            {repos.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {repo && (
        <ReceivingForm
          key={repo.id}
          repo={repo}
          source={sources.find((item) => item.repoId === repo.id)}
          onSaved={onSaved}
        />
      )}
    </Modal>
  );
}
