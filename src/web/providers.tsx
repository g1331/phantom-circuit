import React, { useEffect, useRef, useState } from 'react';
import type { Provider, ModelDiscovery } from '../shared/types.ts';
import { api } from './api.ts';

export function ProviderSettings() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selected, setSelected] = useState('codex');
  const [error, setError] = useState('');
  const refresh = async () => setProviders(await api<Provider[]>('/providers'));
  useEffect(() => {
    void refresh().catch(() => setError('无法读取 Provider'));
  }, []);
  const provider = providers.find((p) => p.id === selected);
  return (
    <section className="form provider-settings" aria-label="Provider 管理">
      <h3>Provider</h3>
      <p className="muted">保存上游连接并获取模型。角色与项目分配独立管理。</p>
      <div className="provider-toolbar">
        <label>
          选择 Provider
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {selected === 'new' && <option value="new">新增 Provider</option>}
          </select>
        </label>
        <button type="button" className="secondary-button" onClick={() => setSelected('new')}>
          新增 Provider
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {(provider || selected === 'new') && (
        <ProviderDetail
          key={selected}
          provider={provider}
          saved={async (id) => {
            await refresh();
            setSelected(id);
          }}
        />
      )}
    </section>
  );
}

function ProviderDetail({
  provider,
  saved,
}: {
  provider?: Provider;
  saved: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState(provider?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [replacement, setReplacement] = useState('');
  const [shown, setShown] = useState('');
  const [discovery, setDiscovery] = useState<ModelDiscovery>();
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const generation = useRef(0);
  const alive = useRef(true);
  const official = provider?.kind === 'codex';
  const hide = () => {
    generation.current++;
    setShown('');
    setRevealing(false);
  };
  useEffect(() => {
    alive.current = true;
    const clear = () => {
      hide();
      setReplacement('');
    };
    const visibility = () => {
      if (document.hidden) clear();
    };
    window.addEventListener('pagehide', clear);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      alive.current = false;
      generation.current++;
      window.removeEventListener('pagehide', clear);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(hide, 30_000);
    return () => clearTimeout(timer);
  }, [shown]);
  const run = async (work: () => Promise<void>) => {
    hide();
    setError('');
    setBusy(true);
    try {
      await work();
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const reveal = async () => {
    const current = ++generation.current;
    setRevealing(true);
    setError('');
    try {
      const result = await api<{ apiKey: string }>(`/providers/${provider!.id}/reveal-key`, {});
      if (alive.current && generation.current === current) setShown(result.apiKey);
    } catch {
      if (alive.current && generation.current === current)
        setError('无法显示密钥，请刷新会话或重新保存密钥');
    } finally {
      if (alive.current && generation.current === current) setRevealing(false);
    }
  };
  return (
    <div className="provider-detail">
      {official ? (
        <p>使用现有 Codex 官方登录，无需复制凭据。</p>
      ) : (
        <>
          <label>
            Provider 名称
            <input
              autoComplete="off"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Responses API base URL
            <input
              autoComplete="off"
              type="url"
              placeholder="https://example.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          <label>
            {provider ? '替换 API key（留空保留）' : 'API key'}
            <input
              type="password"
              autoComplete="new-password"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
            />
          </label>
          {provider && (
            <div className="provider-secret">
              <span>API key：{provider.hasKey ? '已保存' : '未保存'}</span>
              {shown ? (
                <>
                  <output aria-label="已显示的 API key">{shown}</output>
                  <button type="button" className="secondary-button" onClick={hide}>
                    隐藏密钥
                  </button>
                  <small>30 秒后自动隐藏。</small>
                </>
              ) : (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || revealing || !provider.hasKey}
                  onClick={() => void reveal()}
                >
                  {revealing ? '正在读取…' : '显示密钥'}
                </button>
              )}
            </div>
          )}
          <div className="provider-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy || !name.trim() || !baseUrl || (!provider && !replacement)}
              onClick={() =>
                void run(async () => {
                  const result = await api<Provider>(
                    provider ? `/providers/${provider.id}` : '/providers',
                    { name, baseUrl, apiKey: replacement },
                    provider ? 'PATCH' : 'POST',
                  );
                  setReplacement('');
                  setDiscovery(undefined);
                  await saved(result.id);
                })
              }
            >
              保存 Provider
            </button>
            {provider && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/providers/${provider.id}`, {}, 'DELETE');
                    setReplacement('');
                    await saved('codex');
                  })
                }
              >
                删除 Provider
              </button>
            )}
          </div>
        </>
      )}
      {provider && (
        <>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await api<ModelDiscovery>(`/providers/${provider.id}/models`, {});
                if (alive.current) setDiscovery(result);
              })
            }
          >
            {busy ? '正在处理…' : '获取模型'}
          </button>
          <p role="status">
            {discovery
              ? discovery.ok
                ? `已连接 · ${discovery.models.length} 个模型`
                : discovery.error
              : '尚未获取模型'}
          </p>
          {discovery?.ok && (
            <label>
              可用模型
              <select
                aria-label="可用模型"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">选择模型 ID</option>
                {discovery.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                    {m.reasoningEfforts?.length ? ` · ${m.reasoningEfforts.join(' / ')}` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            手工模型 ID
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="上游不支持列表时可手工填写"
            />
          </label>
          <small>此处用于核对模型 ID；保存 Provider 不会改变当前角色分配。</small>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
