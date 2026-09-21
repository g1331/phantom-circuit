import { ErrorText } from './error-text.tsx';
import { useState } from 'react';
import type { PriceCard, Provider } from '../shared/types.ts';
import { api } from './api.ts';
import { useLocale } from './locale/provider.tsx';

const fields = {
  inputPerMillion: 'prices.input',
  outputPerMillion: 'prices.output',
  cachedInputPerMillion: 'prices.cached',
  cacheWritePerMillion: 'prices.cacheWrite',
  reasoningOutputPerMillion: 'prices.reasoning',
} as const;
type MillionKey = keyof typeof fields;
type TokenKey =
  | 'inputPerToken'
  | 'outputPerToken'
  | 'cachedInputPerToken'
  | 'cacheWritePerToken'
  | 'reasoningOutputPerToken';
function rateField(card: PriceCard, millionKey: string) {
  const tokenKey = millionKey.replace('PerMillion', 'PerToken') as TokenKey;
  return { tokenKey, key: card[tokenKey] === undefined ? (millionKey as MillionKey) : tokenKey };
}
export function ModelPrices({
  provider,
}: {
  provider: Provider & { prices?: Record<string, PriceCard> };
}) {
  const { t } = useLocale();
  const [prices, setPrices] = useState(provider.prices ?? {});
  const [model, setModel] = useState('');
  const [card, setCard] = useState<PriceCard>({ currency: 'USD' });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | Error>('');
  if (provider.kind !== 'custom') return null;
  async function save() {
    setBusy(true);
    setError('');
    setSaved(false);
    const next = { ...prices, [model.trim()]: card };
    try {
      await api(`/providers/${provider.id}/prices`, { prices: next }, 'PATCH');
      setPrices(next);
      setSaved(true);
    } catch (error) {
      setError(error instanceof Error ? error : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="model-prices" aria-label={t('prices.title')}>
      <h3>{t('prices.title')}</h3>
      <p className="muted">{t('prices.note')}</p>
      <label>
        {t('prices.model')}
        <input
          value={model}
          list={`price-models-${provider.id}`}
          onChange={(event) => {
            setModel(event.target.value);
            setCard(prices[event.target.value] ?? { currency: 'USD' });
            setSaved(false);
          }}
        />
        <datalist id={`price-models-${provider.id}`}>
          {Object.keys(prices).map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      </label>
      <label>
        {t('prices.currency')}
        <input
          value={card.currency}
          maxLength={3}
          onChange={(event) => setCard({ ...card, currency: event.target.value.toUpperCase() })}
        />
      </label>
      <div className="form-columns">
        {Object.entries(fields).map(([millionKey, label]) => {
          const { key, tokenKey } = rateField(card, millionKey);
          return (
            <label key={millionKey}>
              {t(key === tokenKey ? `${label}Token` : label)}
              <input
                inputMode="decimal"
                pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]+)?"
                value={card[key] ?? ''}
                onChange={(event) => {
                  const next = { ...card };
                  delete next[millionKey as MillionKey];
                  delete next[tokenKey];
                  if (event.target.value !== '') next[key] = event.target.value;
                  setCard(next);
                  setSaved(false);
                }}
              />
            </label>
          );
        })}
      </div>
      <button
        className="secondary-button"
        type="button"
        disabled={
          busy ||
          !model.trim() ||
          !/^[A-Z]{3}$/.test(card.currency) ||
          Object.keys(fields).some((millionKey) => {
            const { key } = rateField(card, millionKey);
            return card[key] !== undefined && !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(card[key]));
          })
        }
        onClick={() => void save()}
      >
        {t('prices.save')}
      </button>
      {saved && <p role="status">{t('prices.saved')}</p>}
      {error && <p role="alert">{<ErrorText error={error} />}</p>}
    </section>
  );
}
