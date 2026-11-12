import { useState, type FormEvent } from 'react';
import type { MaintenanceRule } from '../shared/maintenance.ts';
import { api } from './api.ts';
import { useLocale } from './locale/provider.tsx';

export function MaintenanceRuleForm({
  repoId,
  rule,
  onSaved,
}: {
  repoId: string;
  rule?: MaintenanceRule;
  onSaved: () => Promise<void>;
}) {
  const { t, host } = useLocale();
  const [name, setName] = useState(rule?.name ?? '');
  const [mode, setMode] = useState<MaintenanceRule['mode']>(rule?.mode ?? 'observe');
  const [kind, setKind] = useState<MaintenanceRule['kind']>(rule?.kind ?? 'issue');
  const [selector, setSelector] = useState(rule?.selector ?? '');
  const [age, setAge] = useState(rule?.minimumAgeMinutes ?? 0);
  const [scope, setScope] = useState(rule?.scope ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(
        `/repos/${repoId}/maintenance/rules${rule ? `/${rule.ruleId}` : ''}`,
        {
          name,
          mode,
          kind,
          selector,
          minimumAgeMinutes: age,
          scope,
          expectedVersion: rule?.version ?? 0,
        },
        rule ? 'PUT' : 'POST',
      );
      await onSaved();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="flow-receiving-form maintenance-rule-form" onSubmit={save}>
      <label>
        {t('maintenance.name')}
        <input required value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        {t('maintenance.mode')}
        <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
          {(['off', 'observe', 'auto'] as const).map((value) => (
            <option key={value} value={value}>
              {t(`maintenance.${value}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('maintenance.kind')}
        <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
          <option value="issue">{t('maintenance.issue')}</option>
          <option value="ci">{t('maintenance.ci')}</option>
        </select>
      </label>
      <label>
        {t(kind === 'issue' ? 'maintenance.label' : 'maintenance.workflow')}
        <input required value={selector} onChange={(event) => setSelector(event.target.value)} />
      </label>
      <label>
        {t('maintenance.age')}
        <input
          type="number"
          min="0"
          step="1"
          required
          value={age}
          onChange={(event) => setAge(event.target.valueAsNumber)}
        />
      </label>
      <label>
        {t('maintenance.scope')}
        <textarea required value={scope} onChange={(event) => setScope(event.target.value)} />
      </label>
      {error && (
        <p className="error-inline" role="alert">
          {host(error)}
        </p>
      )}
      <button className="primary-button" disabled={busy}>
        {t('maintenance.save')}
      </button>
    </form>
  );
}
