import { useState, type ReactNode } from 'react';
import {
  ArrowUpRight,
  FileText,
  FolderGit2,
  GitBranch,
  Plus,
  RotateCw,
  Settings2,
} from 'lucide-react';
import type { AgentKind, Profile, Project, Repo, Snapshot, Task } from '../shared/types.ts';
import { api } from './api.ts';
import { Fold } from './fold.tsx';
import { MarkdownContent } from './markdown-content.tsx';
import { AllowancePanel } from './usage-panel.tsx';
import { useLocale } from './locale/provider.tsx';
import { isRunning } from './sidebar.tsx';
import { Empty, Metric } from './ui.tsx';
import { useWhen } from './work-list.tsx';

type Run = Snapshot['runs'][number];

/** The project's name and the settings that apply to all of it. */
export function ProjectHeader({
  project,
  onOpenModal,
}: {
  project: Project;
  onOpenModal: (kind: 'project-settings' | 'repo') => void;
}) {
  const { t } = useLocale();
  return (
    <header className="page-header project-heading">
      <div>
        <h1>{project.name}</h1>
        {project.description && <p className="muted">{project.description}</p>}
      </div>
      <div className="context-actions">
        {project.githubProjectUrl && (
          <a
            className="quiet-link"
            href={project.githubProjectUrl}
            target="_blank"
            rel="noreferrer"
          >
            GitHub Project <ArrowUpRight size={14} />
          </a>
        )}
        <button className="secondary-button" onClick={() => onOpenModal('project-settings')}>
          {t('ui.projectModelSettings')}
        </button>
        <button className="secondary-button" onClick={() => onOpenModal('repo')}>
          <Plus size={15} /> {t('repo.connect')}
        </button>
      </div>
    </header>
  );
}

function Section({
  label,
  meta,
  children,
  className = '',
}: {
  label: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel-section ${className}`} aria-label={label}>
      <header className="section-head">
        <h2>{label}</h2>
        {meta}
      </header>
      {children}
    </section>
  );
}

/** Project overview: who is working, the repositories and their switches, capacity, activity. */
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
  onOpenModal,
  onConfigureRepo,
  claims,
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
  onOpenModal: (kind: 'project-settings' | 'repo') => void;
  onConfigureRepo: (repo: Repo) => void;
  /** The current claim order, owned by the app because it polls the scheduler. */
  claims: ReactNode;
}) {
  const { t, host } = useLocale();
  const when = useWhen();
  const [recent, setRecent] = useState(6);
  const activity = state.events.filter((e) => e.projectId === project.id && e.type !== 'command');
  return (
    <>
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
      <Section
        label={t('project.repos')}
        meta={<span className="section-count">{t('repos.count', { count: repos.length })}</span>}
      >
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
                  <a
                    className="repo-slug"
                    href={`https://github.com/${r.github}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {r.github}
                    <ArrowUpRight size={12} />
                  </a>
                  <button
                    className="icon-button"
                    aria-label={t('repos.configure', { name: r.name })}
                    onClick={() => onConfigureRepo(r)}
                  >
                    <Settings2 size={15} />
                  </button>
                </div>
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
              </div>
            );
          })
        )}
      </Section>
      <Section label={t('project.capacity')}>
        <div className="project-capacity">
          <label>
            {t('ui.projectDevLimit')}
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
          <span className="muted">
            {t('project.capacityLine', {
              active: state.runs.filter((r) => r.role === 'dev' && isRunning(r.status)).length,
              limit: state.settings.globalDevLimit,
            })}
          </span>
        </div>
        {claims}
      </Section>
      <AllowancePanel
        key={`${project.id}-${projectAgent}-${pmProfile?.providerId}`}
        agent={projectAgent}
        providerId={pmProfile?.providerId ?? ''}
      />
      <Section
        label={t('activity.recent')}
        className="activity-section"
        meta={
          <button
            className="icon-button"
            title={t('activity.sync')}
            aria-label={t('activity.sync')}
            disabled={busy}
            onClick={() => void act(() => api('/sync', {}))}
          >
            <RotateCw size={14} />
          </button>
        }
      >
        {activity.length ? (
          <ol className="record-list activity-list">
            {activity.slice(0, recent).map((e) => (
              <li className="activity-item" key={e.id}>
                <time dateTime={e.at}>{when(e.at)}</time>
                <p>{host(e.message, e.descriptor)}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">{t('activity.empty')}</p>
        )}
        {activity.length > recent && (
          <button className="record-more" onClick={() => setRecent((n) => n + 20)}>
            {t('activity.more', { count: Math.min(20, activity.length - recent) })}
          </button>
        )}
      </Section>
    </>
  );
}

/** The project's vocabulary and decision records, one line each until opened. */
export function DomainDocuments({ state, project }: { state: Snapshot; project: Project }) {
  const { t, date } = useLocale();
  const repos = new Map(state.repos.map((r) => [r.id, r.name]));
  const documents = state.documents
    .filter((d) => d.projectId === project.id)
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path));
  const multiRepo = new Set(documents.map((d) => d.repoId)).size > 1;
  if (!documents.length)
    return (
      <Empty icon={<FileText size={26} />} title={t('ui.domainDocuments')} text={t('docs.empty')} />
    );
  return (
    <section className="domain-documents" aria-label={t('ui.domainDocuments')}>
      <div className="fold-list">
        {documents.map((doc) => {
          const slash = doc.path.lastIndexOf('/');
          return (
            <Fold
              key={doc.id}
              className="doc-row"
              title={
                <>
                  <FileText size={14} className="doc-icon" aria-hidden="true" />
                  <span className="doc-name">
                    {multiRepo && <span className="doc-dir">{repos.get(doc.repoId)} · </span>}
                    {slash >= 0 && <span className="doc-dir">{doc.path.slice(0, slash + 1)}</span>}
                    <strong>{doc.path.slice(slash + 1)}</strong>
                  </span>
                </>
              }
              meta={
                <>
                  <span className={`doc-state ${doc.accepted ? 'accepted' : 'draft'}`}>
                    {doc.accepted ? t('ui.accepted') : t('ui.draft')}
                  </span>
                  <span>{t('docs.version', { version: doc.version })}</span>
                  {doc.updatedAt && (
                    <time dateTime={doc.updatedAt}>
                      {date(doc.updatedAt, { month: 'numeric', day: 'numeric' })}
                    </time>
                  )}
                </>
              }
            >
              <MarkdownContent content={doc.content} label={t('docs.label', { path: doc.path })} />
            </Fold>
          );
        })}
      </div>
    </section>
  );
}
