import { Menu, Pause, Play, Plus, Search } from 'lucide-react';
import type { Project, Snapshot } from '../shared/types.ts';
import { useLocale } from './locale/provider.tsx';
import { routeHref } from './route.ts';

export function WorkspaceHeader({
  state,
  project,
  waiting,
  moving,
  query,
  busy,
  onProject,
  onNewProject,
  onQuery,
  onTeam,
  onMenu,
}: {
  state?: Snapshot;
  project: Project;
  waiting: number;
  moving: number;
  query: string;
  busy: boolean;
  onProject: (id: string) => void;
  onNewProject: () => void;
  onQuery: (query: string) => void;
  onTeam: (action: 'pause' | 'resume') => void;
  onMenu: () => void;
}) {
  const { t } = useLocale();
  return (
    <header className="workspace-header console-header">
      <button className="workspace-menu icon-button" aria-label={t('nav.menu')} onClick={onMenu}>
        <Menu size={18} />
      </button>
      <div className="workspace-project-picker">
        <select
          aria-label={t('app.projects')}
          value={project.id}
          onChange={(event) => onProject(event.target.value)}
        >
          {state?.projects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <button className="icon-button" aria-label={t('app.newProject')} onClick={onNewProject}>
          <Plus size={15} />
        </button>
      </div>
      <a className="console-moving" href={routeHref({ page: 'team', projectId: project.id })}>
        {moving ? t('home.status.moving', { count: moving }) : t('home.status.idle')}
      </a>

      <label className="console-search">
        <Search size={17} aria-hidden="true" />
        <input
          type="search"
          value={query}
          aria-label={t('flow.search')}
          placeholder={t('flow.search')}
          onChange={(event) => onQuery(event.target.value)}
        />
      </label>
      {waiting > 0 && (
        <a className="console-attention" href={routeHref({ page: 'brief', projectId: project.id })}>
          {t('home.status.waiting', { count: waiting })}
        </a>
      )}
      <button
        className="secondary-button console-team-control"
        disabled={busy}
        onClick={() => onTeam(project.admissionPaused ? 'resume' : 'pause')}
      >
        {project.admissionPaused ? <Play size={14} /> : <Pause size={14} />}
        {t(project.admissionPaused ? 'flow.resume' : 'flow.pause')}
      </button>
    </header>
  );
}
