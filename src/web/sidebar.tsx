import type { ReactNode } from 'react';
import { Languages, Moon, Plus, Settings2, Sun } from 'lucide-react';
import { LanguageControl, useLocale } from './locale/provider.tsx';
import { PreferenceControl } from './preference-control.tsx';
import { useTheme } from './theme.ts';

export const isRunning = (status: string) => status === 'running' || status === 'waiting';

export function Sidebar({
  connected,
  onNewProject,
  onSettings,
  projectNav,
}: {
  connected: boolean;
  onNewProject: () => void;
  onSettings: () => void;
  projectNav?: ReactNode;
}) {
  const { t } = useLocale();
  const { preference, setPreference, resolved } = useTheme();
  return (
    <aside className="sidebar console-rail">
      <a className="brand" href="/" aria-label={t('app.home')}>
        P-C
      </a>
      {projectNav}
      <div className="sidebar-bottom">
        <button
          className="sidebar-action mobile-project-create"
          title={t('app.newProject')}
          onClick={onNewProject}
        >
          <Plus size={18} />
          <span className="control-label">{t('app.newProject')}</span>
        </button>
        <LanguageControl icon={<Languages size={18} />} />
        <PreferenceControl
          className="theme-control"
          label={t('theme.preference')}
          icon={resolved === 'dark' ? <Moon size={18} /> : <Sun size={18} />}
          value={preference}
          onChange={setPreference}
          options={['system', 'light', 'dark'].map((value) => ({
            value,
            label: t(`theme.${value}` as 'theme.system' | 'theme.light' | 'theme.dark'),
          }))}
        />
        <button
          className="sidebar-action"
          aria-label={t('settings.title')}
          title={t('settings.title')}
          onClick={onSettings}
        >
          <Settings2 size={18} />
          <span className="control-label">{t('settings.title')}</span>
        </button>
        <div
          className="connection sr-only"
          role="status"
          title={t(connected ? 'connection.ready' : 'connection.waiting')}
          aria-label={t(connected ? 'connection.ready' : 'connection.waiting')}
        >
          <span className={`status-dot ${connected ? 'live' : ''}`} />
          <span>{connected ? t('connection.ready') : t('connection.waiting')}</span>
        </div>
      </div>
    </aside>
  );
}
