import { en } from './en.ts';
import { zhCN } from './zh-CN.ts';

export type Locale = 'zh-CN' | 'en';
export type TranslationKey = keyof typeof en;
type Plural = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;
export type Resource = { [K in TranslationKey]: (typeof en)[K] extends string ? string : Plural };
type Variables<S extends string> = S extends `${string}{${infer P}}${infer Rest}`
  ? P | Variables<Rest>
  : never;
type Text<K extends TranslationKey> = (typeof en)[K] extends string
  ? (typeof en)[K]
  : (typeof en)[K] extends { other: infer S extends string }
    ? S
    : never;
type Parameters<K extends TranslationKey> = [Variables<Text<K>>] extends [never]
  ? []
  : [params: Record<Variables<Text<K>>, string | number>];

export function resolveLocale(saved: string | null, languages: readonly string[]): Locale {
  if (saved === 'en' || saved === 'zh-CN') return saved;
  return languages.some((language) => language.toLowerCase().startsWith('zh')) ? 'zh-CN' : 'en';
}

export function createLocale(locale: Locale, production = false) {
  const resource: Resource = locale === 'zh-CN' ? zhCN : en;
  const number = (value: number, options?: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat(locale, options).format(value);
  function t<K extends TranslationKey>(key: K, ...args: Parameters<K>): string {
    const params = (args as [Record<string, string | number>?])[0];
    let resourceLocale = locale;
    let entry: string | Plural | undefined = Object.hasOwn(resource, key)
      ? resource[key]
      : undefined;
    if (entry === undefined) {
      if (!production) throw new Error(`Missing translation: ${key}`);
      entry = Object.hasOwn(en, key) ? en[key] : en['app.title'];
      resourceLocale = 'en';
    }
    if (typeof entry !== 'string') {
      if (typeof params?.count !== 'number') throw new Error(`Missing parameter: count (${key})`);
      entry = entry[new Intl.PluralRules(resourceLocale).select(params.count)] ?? entry.other;
    }
    return entry.replace(/\{(\w+)\}/g, (_, name: string) => {
      if (!params || !Object.hasOwn(params, name))
        throw new Error(`Missing parameter: ${name} (${key})`);
      return typeof params[name] === 'number' ? number(params[name]) : String(params[name]);
    });
  }
  const date = (value: string | number | Date, options?: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, options).format(new Date(value));
  const time = (value: string | number | Date, options?: Intl.DateTimeFormatOptions) =>
    date(value, { hour: '2-digit', minute: '2-digit', ...options });
  // Durations are elapsed seconds, rounded down to whole seconds.
  const duration = (seconds: number) => {
    const whole = Math.max(0, Math.floor(seconds));
    return [
      whole >= 3600 ? t('duration.hours', { value: Math.floor(whole / 3600) }) : '',
      whole >= 60 ? t('duration.minutes', { value: Math.floor(whole / 60) % 60 }) : '',
      t('duration.seconds', { value: whole % 60 }),
    ]
      .filter(Boolean)
      .join(' ');
  };
  return { t, number, date, time, duration };
}
