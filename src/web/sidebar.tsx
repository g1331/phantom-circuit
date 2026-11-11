import {
  FolderGit2,
  Languages,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings2,
  Sun,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { Snapshot } from '../shared/types.ts';
import { LanguageControl, useLocale } from './locale/provider.tsx';
import { PreferenceControl } from './preference-control.tsx';
import { useTheme } from './theme.ts';

export const isRunning = (status: string) => status === 'running' || status === 'waiting';

export function Sidebar({
  state,
  selectedId,
  collapsed,
  connected,
  onToggle,
  onSelect,
  onNewProject,
  onSettings,
  projectNav,
}: {
  state?: Snapshot;
  selectedId?: string;
  collapsed: boolean;
  connected: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onNewProject: () => void;
  onSettings: () => void;
  /** The selected project's pages, listed under it. */
  projectNav?: ReactNode;
}) {
  const { t } = useLocale();
  const { preference, setPreference, resolved } = useTheme();
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <a className="brand" href="/" aria-label={t('app.home')}>
          Phantom Circuit
        </a>
        <button
          className="sidebar-toggle icon-button"
          aria-label={t(collapsed ? 'sidebar.expand' : 'sidebar.collapse')}
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>
      <div className="sidebar-heading">
        <span>{t('app.projects')}</span>
        <button className="icon-button" aria-label={t('app.newProject')} onClick={onNewProject}>
          <Plus size={16} />
        </button>
      </div>
      <nav className="project-nav">
        {state?.projects.map((p) => {
          const developing = state.runs.filter(
            (r) => r.projectId === p.id && r.role === 'dev' && isRunning(r.status),
          ).length;
          return [
            <button
              key={p.id}
              className={`project-link ${selectedId === p.id ? 'selected' : ''}`}
              title={p.name}
              aria-label={p.name}
              aria-current={selectedId === p.id ? 'page' : undefined}
              onClick={() => onSelect(p.id)}
            >
              <FolderGit2 size={17} />
              <span>{p.name}</span>
              {developing > 0 && (
                <span className="nav-count" title={t('metric.dev')}>
                  {developing}
                </span>
              )}
            </button>,
            selectedId === p.id && projectNav ? (
              <div key={`${p.id}:pages`} className="project-pages-slot">
                {projectNav}
              </div>
            ) : null,
          ];
        })}
      </nav>
      <div className="sidebar-bottom">
        <LanguageControl icon={<Languages size={17} />} />
        <button
          className="sidebar-action"
          aria-label={t('settings.title')}
          title={t('settings.title')}
          onClick={onSettings}
        >
          <Settings2 size={17} />
          <span className="control-label">{t('settings.title')}</span>
        </button>
        <PreferenceControl
          className="theme-control"
          label={t('theme.preference')}
          icon={resolved === 'dark' ? <Moon size={17} /> : <Sun size={17} />}
          value={preference}
          onChange={setPreference}
          options={['system', 'light', 'dark'].map((value) => ({
            value,
            label: t(`theme.${value}` as 'theme.system' | 'theme.light' | 'theme.dark'),
          }))}
        />
        <div className="connection" role="status">
          <span className={`status-dot ${connected ? 'live' : ''}`} />
          <span>{connected ? t('connection.ready') : t('connection.waiting')}</span>
        </div>
      </div>
    </aside>
  );
}
