import React, { useEffect, useRef, useState } from 'react';
import type { Provider, ModelDiscovery } from '../shared/types.ts';
import { api } from './api.ts';
import { useLocale } from './locale/provider.tsx';
import type { StaticTranslationKey } from './locale/core.ts';
import { ModelPrices } from './model-prices.tsx';
import { ErrorText } from './error-text.tsx';

export function ProviderSettings() {
  const { t } = useLocale();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selected, setSelected] = useState('codex');
  const [error, setError] = useState<string | Error | { key: StaticTranslationKey }>('');
  const refresh = async () => setProviders(await api<Provider[]>('/providers'));
  useEffect(() => {
    void refresh().catch(() => setError({ key: 'ui.cannotLoadProviders' }));
  }, []);
  const provider = providers.find((p) => p.id === selected);
  return (
    <section className="form provider-settings" aria-label={t('ui.providerManagement')}>
      <h3>Provider</h3>
      <p className="muted"> {t('ui.saveUpstreamConnectionsAndFetchModelsRole')} </p>
      <div className="provider-toolbar">
        <label>
          {t('ui.selectProvider')}{' '}
          <select
            aria-label={t('ui.selectProvider')}
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.kind === 'codex' ? t('ui.officialCodexLogin') : p.name}
              </option>
            ))}
            {selected === 'new' && <option value="new"> {t('ui.addProvider')} </option>}
          </select>
        </label>
        <button type="button" className="secondary-button" onClick={() => setSelected('new')}>
          {t('ui.addProvider')}{' '}
        </button>
      </div>
      {error && (
        <p role="alert">
          {typeof error === 'string' || error instanceof Error ? (
            <ErrorText error={error} />
          ) : (
            t(error.key)
          )}
        </p>
      )}
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
  const { t, number } = useLocale();
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [replacement, setReplacement] = useState('');
  const [shown, setShown] = useState('');
  const [discovery, setDiscovery] = useState<ModelDiscovery>();
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | Error | { key: StaticTranslationKey }>('');
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
      if (alive.current) setError(e instanceof Error ? e : { key: 'ui.operationFailed' });
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
        setError({ key: 'ui.cannotRevealKeyRefreshTheSessionOr' });
    } finally {
      if (alive.current && generation.current === current) setRevealing(false);
    }
  };
  return (
    <div className="provider-detail">
      {official ? (
        <p> {t('ui.usesTheExistingOfficialCodexLoginNo')} </p>
      ) : (
        <>
          <label>
            {t('ui.providerName')}{' '}
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
            {provider ? t('ui.replaceApiKeyLeaveBlankToKeep') : 'API key'}
            <input
              type="password"
              autoComplete="new-password"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
            />
          </label>
          {provider && (
            <div className="provider-secret">
              <span>API key：{provider.hasKey ? t('ui.saved2') : t('ui.notSaved')}</span>
              {shown ? (
                <>
                  <output aria-label={t('ui.revealedApiKey')}>{shown}</output>
                  <button type="button" className="secondary-button" onClick={hide}>
                    {t('ui.hideKey')}{' '}
                  </button>
                  <small> {t('ui.automaticallyHiddenAfter30Seconds')} </small>
                </>
              ) : (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || revealing || !provider.hasKey}
                  onClick={() => void reveal()}
                >
                  {revealing ? t('ui.loading') : t('ui.revealKey')}
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
              {t('ui.saveProvider')}{' '}
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
                {t('ui.deleteProvider')}{' '}
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
            {busy ? t('ui.working') : t('ui.fetchModels')}
          </button>
          <p role="status">
            {discovery
              ? discovery.ok
                ? t('provider.connected', { count: discovery.models.length })
                : discovery.error
              : t('ui.modelsHaveNotBeenFetched')}
          </p>
          {discovery?.ok && (
            <label>
              {t('ui.availableModels')}{' '}
              <select
                aria-label={t('ui.availableModels')}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value=""> {t('ui.selectModelId')} </option>
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
            {t('ui.manualModelId')}{' '}
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t('ui.enterManuallyIfTheUpstreamDoesNot')}
            />
          </label>
          <small> {t('ui.useThisToCheckModelIdsSaving')} </small>
        </>
      )}
      {provider?.kind === 'custom' && <ModelPrices provider={provider} />}
      {error && (
        <p role="alert">
          {typeof error === 'string' || error instanceof Error ? (
            <ErrorText error={error} />
          ) : (
            t(error.key)
          )}
        </p>
      )}
    </div>
  );
}
