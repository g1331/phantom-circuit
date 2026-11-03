import {
  ArrowUpRight,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Pause,
  Play,
  Plus,
  RotateCw,
  Settings2,
  X,
} from 'lucide-react';
import type { AgentKind, Profile, Project, Repo, Snapshot, Task } from '../shared/types.ts';
import { api } from './api.ts';
import { MarkdownContent } from './markdown-content.tsx';
import { AllowancePanel } from './usage-panel.tsx';
import { useLocale } from './locale/provider.tsx';
import { isRunning } from './sidebar.tsx';
import { Metric } from './ui.tsx';

type Run = Snapshot['runs'][number];

/** Project overview: capacity, allowance, repository switches, recent events and design records. */
export function ProjectContext({
  project,
  state,
  repos,
  tasks,
  active,
  busy,
  act,
  projectAgent,
  pmProfile,
  onClose,
  onOpenModal,
  onConfigureRepo,
}: {
  project: Project;
  state: Snapshot;
  repos: Repo[];
  tasks: Task[];
  active: Run[];
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  projectAgent: AgentKind;
  pmProfile?: Profile;
  onClose: () => void;
  onOpenModal: (kind: 'project-settings' | 'repo') => void;
  onConfigureRepo: (repo: Repo) => void;
}) {
  const { t, time, host } = useLocale();
  const documents = state.documents.filter((d) => d.projectId === project.id);
  return (
    <>
      <div className="context-heading">
        <div>
          <h2>{project.name}</h2>
          {project.description && <p>{project.description}</p>}
        </div>
        <button className="icon-button" aria-label={t('common.close')} onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="context-actions">
        <button
          className="secondary-button"
          onClick={() => {
            onClose();
            onOpenModal('project-settings');
          }}
        >
          {t('ui.projectModelSettings')}
        </button>
        <button
          className="secondary-button"
          onClick={() => {
            onClose();
            onOpenModal('repo');
          }}
        >
          <Plus size={15} /> {t('repo.connect')}
        </button>
      </div>
      {project.githubProjectUrl && (
        <a className="quiet-link" href={project.githubProjectUrl} target="_blank" rel="noreferrer">
          GitHub Project <ArrowUpRight size={14} />
        </a>
      )}
      <section className="metrics" aria-label={t('project.overview')}>
        <Metric
          value={active.filter((r) => r.role === 'dev').length}
          label={t('metric.dev')}
          suffix={`/ ${project.devLimit}`}
          live
        />
        <Metric
          value={active.filter((r) => r.role === 'review').length}
          label={t('metric.review')}
        />
        <Metric value={tasks.filter((t) => t.stage === 'ready').length} label={t('metric.ready')} />
        <Metric value={tasks.filter((t) => t.stage === 'done').length} label={t('metric.done')} />
      </section>
      <AllowancePanel
        key={`${project.id}-${projectAgent}-${pmProfile?.providerId}`}
        agent={projectAgent}
        providerId={pmProfile?.providerId ?? ''}
      />
      <div className="panel-heading">
        <h2>{t('repos.controls')}</h2>
        <span>{t('repos.count', { count: repos.length })}</span>
      </div>
      {!repos.length ? (
        <div className="repo-empty">
          <FolderGit2 size={25} />
          <p>
            {t('repos.emptyIntro')}
            <br />
            {t('repos.emptyHint')}
          </p>
          <button className="text-button" onClick={() => onOpenModal('repo')}>
            {t('repos.first')} <Plus size={14} />
          </button>
        </div>
      ) : (
        repos.map((r) => {
          const count = active.filter((x) => x.repoId === r.id && x.role === 'dev').length;
          return (
            <div className="repo-control" key={r.id}>
              <div className="repo-title">
                <GitBranch size={16} />
                <strong title={r.github}>{r.name}</strong>
                <button
                  className="icon-button"
                  aria-label={t('repos.configure', { name: r.name })}
                  onClick={() => onConfigureRepo(r)}
                >
                  <Settings2 size={15} />
                </button>
              </div>
              <a
                className="repo-slug"
                href={`https://github.com/${r.github}`}
                target="_blank"
                rel="noreferrer"
              >
                {r.github}
                <ArrowUpRight size={12} />
              </a>
              <div className="switch-row">
                <div>
                  <strong>
                    {r.enabled ? t('ui.newTaskClaimsEnabled') : t('ui.newTaskClaimsStopped')}
                  </strong>
                  {!r.enabled && count > 0 && <small>{t('repos.running', { count })}</small>}
                </div>
                <button
                  className={`switch ${r.enabled ? 'on' : ''}`}
                  role="switch"
                  aria-checked={r.enabled}
                  aria-label={t('repos.switch', { name: r.name })}
                  disabled={busy}
                  onClick={() =>
                    void act(() => api(`/repos/${r.id}`, { enabled: !r.enabled }, 'PATCH'))
                  }
                >
                  <span />
                </button>
              </div>
              <div className="repo-capacity">
                <span>
                  <span className={`status-dot ${count ? 'live' : ''}`} />
                  {count} {t('ui.developing')}{' '}
                </span>
                <label>
                  {t('ui.limit')}{' '}
                  <input
                    aria-label={t('repos.limit', { name: r.name })}
                    type="number"
                    min="1"
                    max="32"
                    value={r.devLimit}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      if (value >= 1 && value <= 32)
                        void act(() => api(`/repos/${r.id}`, { devLimit: value }, 'PATCH'));
                    }}
                  />
                </label>
              </div>
              {r.blocked && <p className="inline-warning">{r.blocked}</p>}
              <div className="preview-row">
                {r.preview?.status === 'running' ? (
                  <>
                    <a
                      href={r.preview.url}
                      target="_blank"
                      rel="noreferrer"
                      className="preview-link"
                    >
                      {t('ui.openPreview')} <ExternalLink size={13} />
                    </a>
                    <button
                      className="icon-button"
                      aria-label={t('repos.stopPreview', { name: r.name })}
                      onClick={() => void act(() => api(`/repos/${r.id}/preview/stop`, {}))}
                    >
                      <Pause size={14} />
                    </button>
                  </>
                ) : (
                  <button
                    className="text-button"
                    disabled={busy || r.preview?.status === 'starting'}
                    onClick={() => void act(() => api(`/repos/${r.id}/preview/start`, {}))}
                  >
                    <Play size={13} />
                    {r.preview?.status === 'starting'
                      ? t('ui.preparingPreview')
                      : t('ui.startLocalPreview')}
                  </button>
                )}
              </div>
              {r.preview?.error && <p className="inline-warning">{host(r.preview.error)}</p>}
            </div>
          );
        })
      )}
      <div className="project-capacity">
        <label>
          {t('ui.projectDevLimit')}{' '}
          <input
            type="number"
            min="1"
            max="32"
            aria-label={t('ui.projectDevLimit')}
            value={project.devLimit}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (value >= 1 && value <= 32)
                void act(() => api(`/projects/${project.id}`, { devLimit: value }, 'PATCH'));
            }}
          />
        </label>
        <span>
          {t('ui.globalLimit')} {state.settings.globalDevLimit} {t('ui.active')}{' '}
          {state.runs.filter((r) => r.role === 'dev' && isRunning(r.status)).length}{' '}
          {t('ui.dev')}{' '}
        </span>
      </div>
      <div className="activity-heading">
        <h2>{t('activity.recent')}</h2>
        <button
          className="icon-button"
          title={t('activity.sync')}
          aria-label={t('activity.sync')}
          disabled={busy}
          onClick={() => void act(() => api('/sync', {}))}
        >
          <RotateCw size={14} />
        </button>
      </div>
      <div className="activity-list">
        {state.events
          .filter((e) => e.projectId === project.id && e.type !== 'command')
          .slice(0, 5)
          .map((e) => (
            <div className="activity-item" key={e.id}>
              <span className="activity-line-dot" />
              <div>
                <p>{host(e.message, e.descriptor)}</p>
                <time>{time(e.at)}</time>
              </div>
            </div>
          ))}
        {!state.events.some((e) => e.projectId === project.id) && (
          <p className="muted">{t('activity.empty')}</p>
        )}
      </div>
      {documents.length > 0 && (
        <section className="domain-documents" aria-label={t('ui.domainDocuments')}>
          <h2> {t('ui.domainDocuments')} </h2>
          {documents.map((doc) => (
            <details key={doc.id}>
              <summary>
                {repos.find((repo) => repo.id === doc.repoId)?.name} · {doc.path} · v{doc.version} ·{' '}
                {doc.accepted ? t('ui.accepted') : t('ui.draft')}
              </summary>
              <MarkdownContent content={doc.content} label={t('docs.label', { path: doc.path })} />
            </details>
          ))}
        </section>
      )}
    </>
  );
}
