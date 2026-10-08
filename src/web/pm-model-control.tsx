import { useEffect, useLayoutEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react';
import type { AgentKind, ModelDiscovery, Profile, Project, Settings } from '../shared/types.ts';
import { api } from './api.ts';
import { ErrorText } from './error-text.tsx';
import { useLocale } from './locale/provider.tsx';

type Model = { id: string; provider?: string; reasoningEfforts?: string[] };

export function PMModelControl({
  project,
  settings,
  agent,
  profile,
  onSave,
}: {
  project: Project;
  settings: Settings;
  agent: AgentKind;
  profile?: Profile;
  onSave: () => Promise<void>;
}) {
  const { t } = useLocale();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root');
  const [query, setQuery] = useState('');
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    if (open) element.showPopover();
    else if (element.matches(':popover-open')) element.hidePopover();
  }, [open]);
  useEffect(() => {
    const element = menu.current;
    if (!element) return;
    const toggled = () => {
      if (!element.matches(':popover-open')) {
        setOpen(false);
        setPane('root');
        setQuery('');
      }
    };
    element.addEventListener('toggle', toggled);
    return () => element.removeEventListener('toggle', toggled);
  }, []);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error>();
  const [revision, setRevision] = useState(0);
  const providerId = profile?.providerId ?? '';
  const catalog = useRef<{ key: string; revision: number; at: number }>(undefined);
  useEffect(() => {
    if (!open) return;
    const key = agent === 'omp' ? 'omp' : `codex:${providerId}`;
    if (
      catalog.current?.key === key &&
      catalog.current.revision === revision &&
      Date.now() - catalog.current.at < 5 * 60_000
    )
      return;
    let current = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    setLoading(true);
    setError(undefined);
    const load = async () => {
      if (agent === 'omp') {
        const result = await api<{ models: Model[]; available: boolean; error?: string }>(
          '/agents/omp/models',
          undefined,
          'GET',
          controller.signal,
        );
        if (!result.available) throw new Error(result.error ?? t('runtime.unavailable'));
        return result.models;
      }
      const result = await api<ModelDiscovery>(
        `/providers/${encodeURIComponent(providerId)}/models`,
        {},
        'POST',
        controller.signal,
      );
      if (!result.ok) throw new Error(result.error);
      return result.models;
    };
    void load()
      .then((result) => {
        if (current) {
          catalog.current = { key, revision, at: Date.now() };
          setModels(result);
        }
      })
      .catch((error) => {
        if (current) setError(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        clearTimeout(timer);
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, agent, providerId, revision, t]);

  const key = (model: Model) =>
    JSON.stringify([agent === 'omp' ? (model.provider ?? '') : providerId, model.id]);
  const value = JSON.stringify([providerId, profile?.model ?? '']);
  const selected = models.find((model) => key(model) === value);
  const efforts = selected?.reasoningEfforts;
  async function save(next: Profile) {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      // Use the existing project settings boundary; each Run retains its pinned configuration.
      const profiles =
        agent === 'omp' ? (project.ompProfiles ?? settings.ompProfiles) : project.profiles;
      if (!profiles) throw new Error(t('runtime.unavailable'));
      await api(
        `/projects/${project.id}/runtime`,
        {
          [agent === 'omp' ? 'ompProfiles' : 'profiles']: { ...profiles, pm: next },
          profileModes: {
            ...Object.fromEntries(
              Object.keys(project.profiles).map((role) => [
                role,
                project.profileModes?.[role as keyof typeof project.profiles] ?? 'pinned',
              ]),
            ),
            pm: 'pinned',
          },
        },
        'PATCH',
      );
      await onSave();
      setOpen(false);
      trigger.current?.focus();
    } catch (error) {
      setError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setSaving(false);
    }
  }
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = trigger.current;
      const element = menu.current;
      if (!button || !element) return;
      const rect = button.getBoundingClientRect();
      element.style.left = `${Math.max(12, Math.min(rect.right - element.offsetWidth, window.innerWidth - element.offsetWidth - 12))}px`;
      element.style.top = `${Math.max(12, rect.top - element.offsetHeight - 8)}px`;
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, pane, models, loading, error, query]);
  useEffect(() => {
    if (!open) return;
    const element = menu.current;
    const focus = element?.querySelector<HTMLElement>(
      'input, [aria-checked="true"], button:not(:disabled)',
    );
    focus?.focus();
  }, [open, pane]);
  useEffect(() => {
    if (open && error && !saving) {
      (menu.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu.current)?.focus();
    }
  }, [open, error, saving]);
  function navigate(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (pane !== 'root') setPane('root');
      else {
        setOpen(false);
        trigger.current?.focus();
      }
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    );
    if (!rows.length) return;
    event.preventDefault();
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
  }
  const groups = [
    ...new Set(models.map((model) => (agent === 'omp' ? (model.provider ?? '') : providerId))),
  ];
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="pm-model-trigger"
        aria-label={t('chat.modelMenu')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        title={`${profile?.model ?? ''} · ${profile?.effort ?? ''}`}
        aria-disabled={saving}
        onKeyDown={(event) => {
          if (open) navigate(event);
        }}
        onClick={() => {
          if (saving) return;
          setError(undefined);
          setPane('root');
          setOpen((value) => !value);
        }}
      >
        <span>{profile?.model || t('ui.selectAModel')}</span>
        {profile?.effort && <small>{profile.effort}</small>}
        {saving ? <LoaderCircle size={13} className="model-spinner" /> : <ChevronDown size={13} />}
      </button>
      {createPortal(
        <div
          id={id}
          ref={menu}
          popover="auto"
          className="pm-model-menu"
          role="menu"
          tabIndex={-1}
          aria-label={t('chat.modelMenu')}
          onKeyDown={navigate}
        >
          {pane === 'root' ? (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={saving}
                onClick={() => setPane('model')}
              >
                <span>{t('ui.model')}</span>
                <small>{profile?.model}</small>
                <ChevronRight size={14} />
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={saving || !efforts?.length}
                onClick={() => setPane('effort')}
              >
                <span>{t('ui.reasoningEffort')}</span>
                <small>{profile?.effort}</small>
                <ChevronRight size={14} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="model-menu-back"
                onClick={() => {
                  setPane('root');
                  setQuery('');
                }}
              >
                <ChevronLeft size={14} />
                {t(pane === 'model' ? 'chat.pmModel' : 'chat.pmEffort')}
              </button>
              {pane === 'model' ? (
                <>
                  {models.length > 4 && (
                    <input
                      aria-label={t('chat.searchModels')}
                      placeholder={t('chat.searchModels')}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  )}
                  <div className="model-menu-list">
                    {groups.map((group) => (
                      <div role="group" aria-label={group} key={group}>
                        {groups.length > 1 && <div className="model-menu-provider">{group}</div>}
                        {models
                          .filter(
                            (model) =>
                              (agent === 'omp' ? (model.provider ?? '') : providerId) === group &&
                              model.id.toLowerCase().includes(query.toLowerCase()),
                          )
                          .map((model) => (
                            <button
                              type="button"
                              role="menuitemradio"
                              key={key(model)}
                              aria-checked={key(model) === value}
                              disabled={saving}
                              onClick={() => {
                                if (!profile) return;
                                void save({
                                  ...profile,
                                  customModel: false,
                                  model: model.id,
                                  providerId: agent === 'omp' ? (model.provider ?? '') : providerId,
                                  effort: model.reasoningEfforts?.includes(profile.effort)
                                    ? profile.effort
                                    : (model.reasoningEfforts?.[0] ?? profile.effort),
                                });
                              }}
                            >
                              <span>{model.id}</span>
                              {key(model) === value && <Check size={14} />}
                            </button>
                          ))}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                efforts?.map((effort) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    key={effort}
                    aria-checked={effort === profile?.effort}
                    disabled={saving}
                    onClick={() => {
                      if (profile) void save({ ...profile, effort });
                    }}
                  >
                    <span>{effort}</span>
                    {effort === profile?.effort && <Check size={14} />}
                  </button>
                ))
              )}
            </>
          )}
          {loading && <small role="status">{t('ui.fetchingModels')}</small>}
          {error && (
            <div role="alert">
              <ErrorText error={error} />
            </div>
          )}
          <button
            type="button"
            className="model-menu-refresh"
            disabled={loading || saving}
            onClick={() => setRevision((value) => value + 1)}
          >
            {t('ui.refreshModelList')}
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
