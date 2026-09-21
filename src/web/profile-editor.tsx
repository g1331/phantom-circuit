import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelDiscovery, Profile, ProfileName, Provider, Settings } from '../shared/types.ts';
import { api } from './api.ts';
import { useLocale } from './locale/provider.tsx';

const labels = {
  pm: 'ui.projectPm',
  review: 'ui.independentReview',
  backend: 'ui.backend',
  frontend: 'ui.frontend',
  fullstack: 'ui.fullStack',
  complex: 'ui.complexTasks',
} as const;

export function ProfileEditor({
  profiles,
  providers,
  change,
}: {
  profiles: Settings['profiles'];
  providers: Provider[];
  change: (profiles: Settings['profiles']) => void;
}) {
  const cache = useRef(new Map<string, Promise<ModelDiscovery>>());
  const { t } = useLocale();
  const discover = useCallback((id: string, refresh = false) => {
    if (refresh || !cache.current.has(id))
      cache.current.set(
        id,
        api<ModelDiscovery>(`/providers/${encodeURIComponent(id)}/models`, {}).catch((error) => ({
          ok: false,
          code: 'connection',
          error: String(error),
        })),
      );
    return cache.current.get(id)!;
  }, []);
  return (
    <div className="assignment-editor">
      {(Object.keys(labels) as ProfileName[]).map((role) => (
        <Assignment
          key={role}
          label={t(labels[role])}
          profile={profiles[role]}
          providers={providers}
          discover={discover}
          change={(profile) => change({ ...profiles, [role]: profile })}
        />
      ))}
    </div>
  );
}

function Assignment({
  label,
  profile,
  providers,
  change,
  discover,
}: {
  label: string;
  profile: Profile;
  providers: Provider[];
  change: (profile: Profile) => void;
  discover: (id: string, refresh?: boolean) => Promise<ModelDiscovery>;
}) {
  const [discovery, setDiscovery] = useState<ModelDiscovery>();
  const { t } = useLocale();
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const provider = providers.find((p) => p.id === profile.providerId);
  useEffect(() => {
    let alive = true;
    setDiscovery(undefined);
    setLoading(true);
    void discover(profile.providerId).then((result) => {
      if (alive) {
        setDiscovery(result);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [profile.providerId, discover, revision]);
  const models = discovery?.ok ? discovery.models : [];
  const model = models.find((m) => m.id === profile.model);
  const custom = provider?.kind === 'custom';
  const efforts = model?.reasoningEfforts ?? (custom ? undefined : []);
  return (
    <fieldset className="assignment">
      <legend>{label}</legend>
      <div className="assignment-fields">
        <label>
          Provider
          <select
            aria-label={`${label} Provider`}
            value={profile.providerId}
            required
            onChange={(e) => change({ providerId: e.target.value, model: '', effort: '' })}
          >
            {!provider && (
              <option value={profile.providerId}>
                {' '}
                {t('ui.providerUnavailable')} {profile.providerId}
              </option>
            )}
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.kind === 'codex' ? t('ui.officialCodexLogin') : p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('ui.model')}{' '}
          {profile.customModel && custom ? (
            <input
              aria-label={t('profile.customLabel', { profile: label })}
              required
              maxLength={256}
              value={profile.model}
              onChange={(e) => change({ ...profile, model: e.target.value })}
            />
          ) : (
            <select
              aria-label={t('settings.modelLabel', { profile: label })}
              value={profile.model}
              required
              disabled={loading}
              onChange={(e) => {
                const selected = models.find((m) => m.id === e.target.value);
                change({
                  ...profile,
                  model: e.target.value,
                  effort: selected?.reasoningEfforts?.includes(profile.effort)
                    ? profile.effort
                    : (selected?.reasoningEfforts?.[0] ?? profile.effort),
                });
              }}
            >
              <option value="">{loading ? t('ui.fetchingModels') : t('ui.selectAModel')}</option>
              {profile.model && !model && (
                <option value={profile.model}>
                  {profile.model}（{loading ? t('ui.fetchingList') : t('ui.notInCurrentList')}）
                </option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          )}
        </label>
        <label>
          {t('ui.reasoningEffort')}{' '}
          {efforts ? (
            <select
              aria-label={t('settings.effortLabel', { profile: label })}
              value={profile.effort}
              required
              disabled={loading}
              onChange={(e) => change({ ...profile, effort: e.target.value })}
            >
              {!efforts.includes(profile.effort) && (
                <option value={profile.effort}>
                  {profile.effort || t('ui.selectEffort')} {t('ui.unverified')}{' '}
                </option>
              )}
              {efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-label={t('settings.effortLabel', { profile: label })}
              required
              value={profile.effort}
              onChange={(e) => change({ ...profile, effort: e.target.value })}
              placeholder={t('ui.forExampleLowMediumHigh')}
            />
          )}
        </label>
      </div>
      <div className="assignment-actions">
        <button
          className="text-button"
          type="button"
          disabled={loading || !provider}
          onClick={() => {
            void discover(profile.providerId, true);
            setRevision((r) => r + 1);
          }}
        >
          {t('ui.refreshModelList')}{' '}
        </button>
        {custom && (
          <label className="assignment-custom">
            <input
              type="checkbox"
              checked={!!profile.customModel}
              onChange={(e) => change({ ...profile, customModel: e.target.checked })}
            />
            {t('ui.customModelId')}{' '}
          </label>
        )}
      </div>
      {!provider && <p role="alert"> {t('ui.providerIsUnavailableSelectAnotherProvider')} </p>}
      {discovery && !discovery.ok && (
        <p role="status">
          {discovery.error}
          {custom
            ? t('ui.youCanExplicitlyChooseACustomModel')
            : t('ui.officialModelsMustBeSelectedFromA')}
        </p>
      )}
      {custom && (
        <p className="muted">
          {!efforts && t('ui.theUpstreamDidNotProvideKnownReasoning')}{' '}
          {t('ui.upstreamCompatibilityIsVerifiedOnTheFirst')}{' '}
        </p>
      )}
    </fieldset>
  );
}
