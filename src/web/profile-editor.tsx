import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelDiscovery, Profile, ProfileName, Provider, Settings } from '../shared/types.ts';
import { api } from './api.ts';

const labels: Record<ProfileName, string> = {
  pm: '项目 PM',
  review: '独立 Review',
  backend: '常规后端',
  frontend: '前端',
  fullstack: '前后端',
  complex: '复杂任务',
};

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
          label={labels[role]}
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
              <option value={profile.providerId}>Provider 不存在：{profile.providerId}</option>
            )}
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          模型
          {profile.customModel && custom ? (
            <input
              aria-label={`${label}自定义模型 ID`}
              required
              maxLength={256}
              value={profile.model}
              onChange={(e) => change({ ...profile, model: e.target.value })}
            />
          ) : (
            <select
              aria-label={`${label}模型`}
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
              <option value="">{loading ? '正在获取模型…' : '选择模型'}</option>
              {profile.model && !model && (
                <option value={profile.model}>
                  {profile.model}（{loading ? '正在获取列表…' : '未在当前列表中'}）
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
          推理档位
          {efforts ? (
            <select
              aria-label={`${label}推理等级`}
              value={profile.effort}
              required
              disabled={loading}
              onChange={(e) => change({ ...profile, effort: e.target.value })}
            >
              {!efforts.includes(profile.effort) && (
                <option value={profile.effort}>{profile.effort || '选择档位'}（未验证）</option>
              )}
              {efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-label={`${label}推理等级`}
              required
              value={profile.effort}
              onChange={(e) => change({ ...profile, effort: e.target.value })}
              placeholder="如 low / medium / high"
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
          刷新模型列表
        </button>
        {custom && (
          <label className="assignment-custom">
            <input
              type="checkbox"
              checked={!!profile.customModel}
              onChange={(e) => change({ ...profile, customModel: e.target.checked })}
            />
            自定义模型 ID
          </label>
        )}
      </div>
      {!provider && <p role="alert">Provider 已失效，请重新选择。</p>}
      {discovery && !discovery.ok && (
        <p role="status">
          {discovery.error}
          {custom ? '；可明确切换到自定义模型 ID。' : '；官方模型必须从有效列表选择。'}
        </p>
      )}
      {custom && (
        <p className="muted">
          {!efforts && '上游未提供已知推理档位，保存时将核对有效配置。'} 上游兼容性将在首次 Run
          验证。
        </p>
      )}
    </fieldset>
  );
}
