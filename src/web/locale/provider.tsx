import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createLocale, resolveLocale, type Locale } from './core.ts';
import { PreferenceControl } from '../preference-control.tsx';

export const localeStorageKey = 'phantom.locale';
const LocaleContext = createContext<
  | (ReturnType<typeof createLocale> & {
      locale: Locale;
      setLocale: (locale: Locale) => void;
    })
  | null
>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState(() =>
    resolveLocale(
      localStorage.getItem(localeStorageKey),
      navigator.languages?.length ? navigator.languages : [navigator.language ?? ''],
    ),
  );
  const value = useMemo(
    () => ({
      ...createLocale(
        locale,
        (import.meta as ImportMeta & { env?: { PROD: boolean } }).env?.PROD ?? false,
      ),
      locale,
      setLocale(next: Locale) {
        localStorage.setItem(localeStorageKey, next);
        updateLocale(next);
      },
    }),
    [locale],
  );
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = value.t('app.title');
  }, [locale, value]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('useLocale requires LocaleProvider');
  return value;
}

export function LanguageControl({ icon }: { icon?: ReactNode }) {
  const { locale, setLocale, t } = useLocale();
  return (
    <PreferenceControl
      className="language-control"
      icon={icon}
      label={t('controls.language')}
      value={locale}
      onChange={(value) => setLocale(value as Locale)}
      options={[
        { value: 'zh-CN', label: '简体中文' },
        { value: 'en', label: 'English' },
      ]}
    />
  );
}
