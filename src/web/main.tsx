import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  Circle,
  Code2,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Layers3,
  MessageSquare,
  Moon,
  Pause,
  Play,
  Plus,
  Radio,
  RotateCw,
  Send,
  Settings2,
  ShieldCheck,
  Sun,
  Terminal,
  X,
} from 'lucide-react';
import type {
  Snapshot,
  Project,
  Repo,
  Task,
  Settings,
  ProfileName,
  Message,
} from '../shared/types.ts';
import { stageLabels } from '../shared/types.ts';
import { api, session, LocalRequestError } from './api.ts';
import { MarkdownContent } from './markdown-content.tsx';
import './style.css';
import { LocaleProvider, useLocale, LanguageControl } from './locale/provider.tsx';

const profileKeys = {
  backend: 'profile.backend',
  frontend: 'profile.frontend',
  fullstack: 'profile.fullstack',
  complex: 'profile.complex',
  pm: 'profile.pm',
  review: 'profile.review',
} as const;
const isRunning = (status: string) => status === 'running' || status === 'waiting';
function App() {
  const { t, time, number } = useLocale();
  const [state, setState] = useState<Snapshot>();
  const [selected, setSelected] = useState(localStorage.getItem('phantom.project') ?? '');
  const [view, setView] = useState<'chat' | 'tasks' | 'runs'>('chat');
  const [modal, setModal] = useState<'project' | 'repo' | 'settings' | null>(null);
  const [repoConfig, setRepoConfig] = useState<Repo>();
  const [taskDetail, setTaskDetail] = useState<string>();
  const [error, setError] = useState<string | Error>('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem('phantom.theme') ?? 'dark');
  const [stream, setStream] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState('');
  const [intent, setIntent] = useState<Message['intent']>('discuss');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  const reload = useCallback(async () => {
    const result = await api<Snapshot>('/state');
    setState(result);
  }, []);
  useEffect(() => {
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    void session()
      .then(reload)
      .then(() => {
        if (!alive) return;
        source = new EventSource('/api/events');
        source.addEventListener('ready', () => setConnected(true));
        source.onerror = () => setConnected(false);
        source.addEventListener('change', () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(
            () => void reload().catch((e) => setError(e instanceof Error ? e : String(e))),
            180,
          );
        });
        source.addEventListener('delta', (event) => {
          const d = JSON.parse((event as MessageEvent).data);
          if (d.role === 'pm') setStream((s) => ({ ...s, [d.runId]: (s[d.runId] ?? '') + d.text }));
        });
      })
      .catch((e) => setError(e instanceof Error ? e : String(e)));
    return () => {
      alive = false;
      source?.close();
      if (timer) clearTimeout(timer);
    };
  }, [reload]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('phantom.theme', theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem('phantom.project', selected);
    setTaskDetail(undefined);
    setDraft('');
  }, [selected]);
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' });
  }, [state?.messages.length, stream]);
  async function act(fn: () => Promise<unknown>) {
    setError('');
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e : String(e));
    } finally {
      setBusy(false);
    }
  }
  const project = state?.projects.find((p) => p.id === selected) ?? state?.projects[0];
  const repos = state?.repos.filter((r) => r.projectId === project?.id) ?? [];
  const tasks = state?.tasks.filter((t) => t.projectId === project?.id) ?? [];
  const runs = state?.runs.filter((r) => r.projectId === project?.id) ?? [];
  const active = runs.filter((r) => isRunning(r.status));
  const messages = state?.messages.filter((m) => m.projectId === project?.id) ?? [];
  const documents = state?.documents.filter((d) => d.projectId === project?.id) ?? [];
  const shown = tasks.filter(
    (t) =>
      (filter === 'all' ||
        (filter === 'active' ? !['done', 'cancelled'].includes(t.stage) : t.stage === filter)) &&
      `${t.title} ${t.spec}`.toLowerCase().includes(query.toLowerCase()),
  );
  const pmBusy = active.some((r) => r.role === 'pm');
  const detail = state?.tasks.find((t) => t.id === taskDetail);
  async function send() {
    if (!draft.trim() || !project) return;
    const content = draft;
    await act(async () => {
      await api(`/projects/${project.id}/messages`, { content, intent });
      setDraft('');
    });
  }
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label={t('app.home')}>
          <span className="brand-mark">
            <Layers3 size={23} />
          </span>
          <span>
            PHANTOM<span className="brand-sub">CIRCUIT</span>
          </span>
        </a>
        <div className="workspace-label">
          {t('app.localWorkspace')} <span className="local-dot" />
        </div>
        <div className="sidebar-heading">
          <span>{t('app.projects')}</span>
          <button
            className="icon-button"
            aria-label={t('app.newProject')}
            onClick={() => setModal('project')}
          >
            <Plus size={16} />
          </button>
        </div>
        <nav className="project-nav">
          {state?.projects.map((p) => (
            <button
              key={p.id}
              className={`project-link ${project?.id === p.id ? 'selected' : ''}`}
              onClick={() => setSelected(p.id)}
            >
              <FolderGit2 size={17} />
              <span>{p.name}</span>
              <span className="nav-count">
                {
                  state.runs.filter(
                    (r) => r.projectId === p.id && r.role === 'dev' && isRunning(r.status),
                  ).length
                }
              </span>
            </button>
          ))}
        </nav>
        {!state?.projects.length && (
          <p className="sidebar-hint">
            {t('app.firstProject')}
            <br />
            {t('app.firstProjectHint')}
          </p>
        )}
        <div className="sidebar-bottom">
          <LanguageControl />
          <button
            className="sidebar-action"
            aria-label={t('settings.title')}
            onClick={() => setModal('settings')}
          >
            <Settings2 size={17} />
            <span>{t('settings.title')}</span>
          </button>
          <button
            className="sidebar-action"
            aria-label={theme === 'dark' ? t('controls.light') : t('controls.dark')}
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            <span>{theme === 'dark' ? t('controls.light') : t('controls.dark')}</span>
          </button>
          <div className="connection">
            <span className={`status-dot ${connected ? 'live' : ''}`} />
            <span>{connected ? t('connection.ready') : t('connection.waiting')}</span>
            <span className="version">v0.1</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            {t('app.workspace')} <span>/</span>
            <strong>{project?.name ?? t('app.start')}</strong>
          </div>
          <div className="topbar-actions">
            <span className="local-badge">
              <ShieldCheck size={13} /> {t('app.local')}
            </span>
            {project?.githubProjectUrl && (
              <a
                className="quiet-link"
                href={project.githubProjectUrl}
                target="_blank"
                rel="noreferrer"
              >
                GitHub Project <ArrowUpRight size={14} />
              </a>
            )}
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <span>
              {error instanceof LocalRequestError
                ? error.kind === 'connection'
                  ? t('connection.failed')
                  : t('request.failed', { status: error.status })
                : error instanceof Error
                  ? error.message
                  : error}
            </span>
            <button
              className="icon-button"
              aria-label={t('common.dismissError')}
              onClick={() => setError('')}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {!state ? (
          <div className="loading">
            <span className="spinner" />
            {t('connection.loading')}
          </div>
        ) : !project ? (
          <div className="onboarding">
            <div className="eyebrow">
              <Radio size={16} /> PHANTOM CIRCUIT
            </div>
            <h1>{t('onboarding.title')}</h1>
            <p>
              {t('onboarding.intro')}
              <br />
              {t('onboarding.description')}
            </p>
            <button className="primary-button" onClick={() => setModal('project')}>
              <Plus size={17} /> {t('project.create')}
            </button>
            <div className="onboarding-flow">
              <div>
                <span>01</span>
                <strong>{t('onboarding.discuss')}</strong>
                <small>{t('onboarding.align')}</small>
              </div>
              <div>
                <span>02</span>
                <strong>{t('onboarding.switch')}</strong>
                <small>{t('onboarding.pace')}</small>
              </div>
              <div>
                <span>03</span>
                <strong>{t('onboarding.feedback')}</strong>
                <small>{t('onboarding.delivery')}</small>
              </div>
            </div>
          </div>
        ) : (
          <>
            <section className="project-header">
              <div>
                <div className="eyebrow">PROJECT WORKSPACE</div>
                <h1>{project.name}</h1>
                <p>{project.description || t('project.description')}</p>
              </div>
              <button className="secondary-button" onClick={() => setModal('repo')}>
                <Plus size={16} /> {t('repo.connect')}
              </button>
            </section>
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
              <Metric
                value={tasks.filter((t) => t.stage === 'ready').length}
                label={t('metric.ready')}
              />
              <Metric
                value={tasks.filter((t) => t.stage === 'done').length}
                label={t('metric.done')}
              />
            </section>
            <div className="workspace-grid">
              <section className="primary-workspace">
                <div className="tabs" role="tablist" aria-label={t('project.views')}>
                  {(
                    [
                      { key: 'chat', label: t('tabs.chat'), icon: MessageSquare },
                      { key: 'tasks', label: t('tabs.tasks'), icon: Layers3 },
                      { key: 'runs', label: t('tabs.runs'), icon: Activity },
                    ] as const
                  ).map((t) => (
                    <button
                      role="tab"
                      aria-selected={view === t.key}
                      className={view === t.key ? 'active' : ''}
                      key={t.key}
                      onClick={() => setView(t.key)}
                    >
                      <t.icon size={15} />
                      {t.label}
                      {t.key === 'tasks' && (
                        <span className="tab-count">{number(tasks.length)}</span>
                      )}
                    </button>
                  ))}
                </div>
                {view === 'chat' ? (
                  <div className="chat-workspace">
                    <div className="conversation" ref={scroll} aria-live="polite">
                      {!messages.length && (
                        <div className="chat-empty">
                          <div className="pm-avatar">
                            <Layers3 size={22} />
                          </div>
                          <h2>{t('chat.emptyTitle')}</h2>
                          <p>
                            {t('chat.emptyDescription')}
                            <br />
                            {t('chat.emptyHint')}
                          </p>
                          <div className="suggestions">
                            <button onClick={() => setDraft(t('chat.requirementsDraft'))}>
                              {t('chat.requirements')} <ArrowUpRight size={13} />
                            </button>
                            <button onClick={() => setDraft(t('chat.exploreDraft'))}>
                              {t('chat.explore')} <ArrowUpRight size={13} />
                            </button>
                          </div>
                        </div>
                      )}
                      {messages.map((m) => (
                        <article key={m.id} className={`message ${m.role}`}>
                          <div className="message-heading">
                            <span
                              className={m.role === 'assistant' ? 'mini-avatar' : 'user-avatar'}
                            >
                              {m.role === 'assistant' ? (
                                <Layers3 size={13} />
                              ) : m.role === 'user' ? (
                                t('chat.you')
                              ) : (
                                '!'
                              )}
                            </span>
                            <strong>
                              {m.role === 'assistant'
                                ? t('profile.pm')
                                : m.role === 'user'
                                  ? t('chat.you')
                                  : t('chat.notice')}
                            </strong>
                            {m.intent && (
                              <span className="message-intent">
                                {
                                  {
                                    discuss: t('chat.discuss'),
                                    implement: t('chat.implement'),
                                    feedback: t('chat.feedback'),
                                  }[m.intent]
                                }
                              </span>
                            )}
                            <time>{time(m.createdAt)}</time>
                          </div>
                          <div className="message-content">
                            {m.role === 'system' ? (
                              m.content
                            ) : (
                              <MarkdownContent content={m.content} />
                            )}
                          </div>
                          {m.role === 'user' && (
                            <button
                              className="retry-message"
                              disabled={busy || pmBusy}
                              onClick={() => void act(() => api(`/messages/${m.id}/retry`, {}))}
                            >
                              {t('common.retry')}
                            </button>
                          )}
                        </article>
                      ))}
                      {active
                        .filter((r) => r.role === 'pm')
                        .map((r) => (
                          <article className="message assistant" key={r.id}>
                            <div className="message-heading">
                              <span className="mini-avatar">
                                <Layers3 size={13} />
                              </span>
                              <strong>{t('profile.pm')}</strong>
                              <span className="thinking">
                                {t('chat.thinking')}
                                <span>…</span>
                              </span>
                            </div>
                            {stream[r.id] ? (
                              <div className="message-content">
                                <MarkdownContent content={stream[r.id]} />
                              </div>
                            ) : (
                              <div className="message-content">{t('chat.reading')}</div>
                            )}
                          </article>
                        ))}
                    </div>
                    <div className="composer">
                      <div className="intent-row">
                        {(['discuss', 'implement', 'feedback'] as const).map((i) => (
                          <button
                            key={i}
                            className={intent === i ? 'selected' : ''}
                            onClick={() => setIntent(i)}
                          >
                            {
                              {
                                discuss: t('chat.talk'),
                                implement: t('chat.delegate'),
                                feedback: t('chat.feedback'),
                              }[i]
                            }
                          </button>
                        ))}
                      </div>
                      <textarea
                        aria-label={t('chat.message')}
                        placeholder={
                          intent === 'discuss'
                            ? t('chat.discussPlaceholder')
                            : intent === 'implement'
                              ? t('chat.implementPlaceholder')
                              : t('chat.feedbackPlaceholder')
                        }
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                            e.preventDefault();
                            void send();
                          }
                        }}
                      />
                      <div className="composer-footer">
                        <span>
                          {intent === 'discuss' ? t('chat.discussNote') : t('chat.implementNote')}
                          <small>{t('chat.shortcut')}</small>
                        </span>
                        <button
                          className="send-button"
                          disabled={!draft.trim() || busy}
                          onClick={() => void send()}
                          aria-label={t('common.send')}
                        >
                          <Send size={17} />
                        </button>
                      </div>
                    </div>
                  </div>
                ) : view === 'tasks' ? (
                  <div className="task-workspace">
                    <div className="list-toolbar">
                      <input
                        aria-label={t('tasks.search')}
                        placeholder={t('tasks.searchPlaceholder')}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                      <select
                        aria-label={t('tasks.filter')}
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      >
                        <option value="all">{t('tasks.all')}</option>
                        <option value="active">{t('tasks.active')}</option>
                        <option value="ready">{t('tasks.ready')}</option>
                        <option value="done">{t('metric.done')}</option>
                      </select>
                    </div>
                    {shown.length ? (
                      <div className="task-list">
                        {shown.map((task) => (
                          <button
                            className="task-row"
                            key={task.id}
                            onClick={() => setTaskDetail(task.id)}
                          >
                            <span className={`task-icon ${task.stage}`}>
                              {task.stage === 'done' ? (
                                <Check size={17} />
                              ) : task.blocked ? (
                                <Pause size={17} />
                              ) : (
                                <Circle size={16} />
                              )}
                            </span>
                            <div className="task-row-main">
                              <strong>{task.title}</strong>
                              <span>
                                {repos.find((r) => r.id === task.repoId)?.name} <i>·</i>{' '}
                                {t(profileKeys[task.profile])}{' '}
                                {task.blocked && <em>· {task.blocked}</em>}
                              </span>
                            </div>
                            <span className={`stage ${task.stage}`}>
                              {task.control === 'paused' ? '已暂停' : stageLabels[task.stage]}
                            </span>
                            <ArrowUpRight size={14} />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <Empty
                        icon={<Layers3 size={26} />}
                        title={t('tasks.emptyTitle')}
                        text={t('tasks.emptyDescription')}
                      />
                    )}
                  </div>
                ) : (
                  <div className="run-workspace">
                    {runs.length ? (
                      runs
                        .slice()
                        .reverse()
                        .map((r) => (
                          <div className="run-row" key={r.id}>
                            <span className={`status-dot ${isRunning(r.status) ? 'live' : ''}`} />
                            <div>
                              <strong>
                                {r.role.toUpperCase()}{' '}
                                <span>
                                  {(r.profileConfig ?? state.settings.profiles[r.profile]).model} /{' '}
                                  {(r.profileConfig ?? state.settings.profiles[r.profile]).effort}
                                </span>
                              </strong>
                              <p>
                                {tasks.find((t) => t.id === r.taskId)?.title ?? '项目需求与协调'}
                                {r.error && <em>{r.error}</em>}
                              </p>
                            </div>
                            <div className="run-meta">
                              <span>
                                {
                                  {
                                    running: '运行中',
                                    waiting: '等待中',
                                    paused: '已暂停',
                                    interrupted: '已中断',
                                    failed: '失败',
                                    completed: '已结束',
                                    queued: '排队中',
                                  }[r.status]
                                }
                              </span>
                              <time>{time(r.startedAt)}</time>
                            </div>
                          </div>
                        ))
                    ) : (
                      <Empty
                        icon={<Activity size={26} />}
                        title={t('runs.emptyTitle')}
                        text={t('runs.emptyDescription')}
                      />
                    )}
                  </div>
                )}
              </section>
              <aside className="context-panel">
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
                    <button className="text-button" onClick={() => setModal('repo')}>
                      {t('repos.first')} <Plus size={14} />
                    </button>
                  </div>
                ) : (
                  repos.map((r) => {
                    const count = active.filter(
                      (x) => x.repoId === r.id && x.role === 'dev',
                    ).length;
                    return (
                      <div className="repo-control" key={r.id}>
                        <div className="repo-title">
                          <GitBranch size={16} />
                          <strong title={r.github}>{r.name}</strong>
                          <button
                            className="icon-button"
                            aria-label={`配置 ${r.name}`}
                            onClick={() => setRepoConfig(r)}
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
                            <strong>{r.enabled ? '允许认领新任务' : '停止新任务认领'}</strong>
                            <small>
                              {!r.enabled && count
                                ? `仍有 ${count} 个 Dev 在完成当前任务`
                                : r.enabled
                                  ? '按依赖与并发上限运行'
                                  : 'PM 对话与任务准备不受影响'}
                            </small>
                          </div>
                          <button
                            className={`switch ${r.enabled ? 'on' : ''}`}
                            role="switch"
                            aria-checked={r.enabled}
                            aria-label={`${r.name} 开工开关`}
                            disabled={busy}
                            onClick={() =>
                              void act(() =>
                                api(`/repos/${r.id}`, { enabled: !r.enabled }, 'PATCH'),
                              )
                            }
                          >
                            <span />
                          </button>
                        </div>
                        <div className="repo-capacity">
                          <span>
                            <span className={`status-dot ${count ? 'live' : ''}`} />
                            {count} 正在开发
                          </span>
                          <label>
                            上限{' '}
                            <input
                              aria-label={`${r.name} 并行上限`}
                              type="number"
                              min="1"
                              max="32"
                              value={r.devLimit}
                              onChange={(e) => {
                                const value = Number(e.target.value);
                                if (value >= 1 && value <= 32)
                                  void act(() =>
                                    api(`/repos/${r.id}`, { devLimit: value }, 'PATCH'),
                                  );
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
                                打开体验 <ExternalLink size={13} />
                              </a>
                              <button
                                className="icon-button"
                                aria-label={`停止 ${r.name} 体验`}
                                onClick={() =>
                                  void act(() => api(`/repos/${r.id}/preview/stop`, {}))
                                }
                              >
                                <Pause size={14} />
                              </button>
                            </>
                          ) : (
                            <button
                              className="text-button"
                              disabled={busy || r.preview?.status === 'starting'}
                              onClick={() =>
                                void act(() => api(`/repos/${r.id}/preview/start`, {}))
                              }
                            >
                              <Play size={13} />
                              {r.preview?.status === 'starting' ? '正在准备体验…' : '启动本地体验'}
                            </button>
                          )}
                        </div>
                        {r.preview?.error && <p className="inline-warning">{r.preview.error}</p>}
                      </div>
                    );
                  })
                )}
                <div className="project-capacity">
                  <label>
                    项目 Dev 上限{' '}
                    <input
                      type="number"
                      min="1"
                      max="32"
                      aria-label="项目 Dev 上限"
                      value={project.devLimit}
                      onChange={(e) => {
                        const value = Number(e.target.value);
                        if (value >= 1 && value <= 32)
                          void act(() =>
                            api(`/projects/${project.id}`, { devLimit: value }, 'PATCH'),
                          );
                      }}
                    />
                  </label>
                  <span>
                    全局上限 {state.settings.globalDevLimit} · 当前{' '}
                    {state.runs.filter((r) => r.role === 'dev' && isRunning(r.status)).length} 个
                    Dev
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
                          <p>{e.message}</p>
                          <time>{time(e.at)}</time>
                        </div>
                      </div>
                    ))}
                  {!state.events.some((e) => e.projectId === project.id) && (
                    <p className="muted">{t('activity.empty')}</p>
                  )}
                </div>
              </aside>
            </div>
            {documents.length > 0 && (
              <section className="domain-documents" aria-label="领域文档">
                <h2>领域文档</h2>
                {documents.map((doc) => (
                  <details key={doc.id}>
                    <summary>
                      {repos.find((repo) => repo.id === doc.repoId)?.name} · {doc.path} · v
                      {doc.version} · {doc.accepted ? '已接受' : '草案'}
                    </summary>
                    <MarkdownContent content={doc.content} label={`领域文档 ${doc.path}`} />
                  </details>
                ))}
              </section>
            )}
          </>
        )}
      </main>
      {modal === 'project' && (
        <Modal
          title={t('project.create')}
          subtitle={t('project.subtitle')}
          onClose={() => setModal(null)}
        >
          <ProjectForm
            busy={busy}
            submit={async (name) =>
              act(async () => {
                const p = await api<Project>('/projects', name);
                setSelected(p.id);
                setModal(null);
              })
            }
          />
        </Modal>
      )}
      {modal === 'repo' && project && (
        <Modal
          title={t('repo.connect')}
          subtitle="关联已有本地 checkout 与 GitHub 仓库。接入后默认不开工。"
          onClose={() => setModal(null)}
        >
          <RepoForm
            busy={busy}
            submit={async (b) =>
              act(async () => {
                await api('/repos', { ...b, projectId: project.id });
                setModal(null);
              })
            }
          />
        </Modal>
      )}
      {modal === 'settings' && state && (
        <Modal
          title={t('settings.title')}
          subtitle={t('settings.subtitle')}
          wide
          onClose={() => setModal(null)}
        >
          <SettingsForm
            initial={state.settings}
            busy={busy}
            submit={async (settings) =>
              act(async () => {
                await api('/settings', settings, 'PATCH');
                setModal(null);
              })
            }
          />
        </Modal>
      )}
      {repoConfig && (
        <Modal
          title={`配置 ${repoConfig.name}`}
          subtitle="PM 可以从仓库推导这些命令，也可以在这里手动调整。"
          onClose={() => setRepoConfig(undefined)}
        >
          <CommandsForm
            repo={repoConfig}
            busy={busy}
            submit={async (body) =>
              act(async () => {
                await api(`/repos/${repoConfig.id}`, body, 'PATCH');
                setRepoConfig(undefined);
              })
            }
          />
        </Modal>
      )}
      {detail && (
        <Modal
          title={detail.title}
          subtitle={`${stageLabels[detail.stage]} · ${detail.routingReason}`}
          wide
          onClose={() => setTaskDetail(undefined)}
        >
          <div className="task-detail">
            <MarkdownContent content={detail.spec} label="任务说明" />
            <h3>验收条件</h3>
            <ul>
              {detail.acceptance.map((x, i) => (
                <li key={i}>
                  <MarkdownContent content={x} label={`验收条件 ${i + 1}`} />
                </li>
              ))}
            </ul>
            {detail.dependencies.length > 0 && (
              <>
                <h3>等待任务</h3>
                <ul>
                  {detail.dependencies.map((id) => (
                    <li key={id}>{state?.tasks.find((t) => t.id === id)?.title ?? id}</li>
                  ))}
                </ul>
              </>
            )}
            {detail.blocked && <div className="inline-warning">{detail.blocked}</div>}
            <div className="detail-actions">
              {detail.issueUrl && (
                <a
                  className="secondary-button"
                  href={detail.issueUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub Issue <ExternalLink size={13} />
                </a>
              )}
              {detail.prUrl && (
                <a
                  className="secondary-button"
                  href={detail.prUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <GitPullRequest size={14} /> PR <ExternalLink size={13} />
                </a>
              )}
              {!['done', 'cancelled'].includes(detail.stage) && (
                <>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        api(
                          `/tasks/${detail.id}/${detail.control === 'paused' ? 'resume' : 'pause'}`,
                          {},
                        ),
                      )
                    }
                  >
                    {detail.control === 'paused' ? <Play size={14} /> : <Pause size={14} />}{' '}
                    {detail.control === 'paused' ? '恢复任务' : '暂停任务'}
                  </button>
                  <button
                    className="danger-button"
                    disabled={busy}
                    onClick={() => void act(() => api(`/tasks/${detail.id}/cancel`, {}))}
                  >
                    取消任务
                  </button>
                </>
              )}
            </div>
            {detail.reviews.map((r) => (
              <section className="review-result" key={r.axis}>
                <h3>
                  {r.axis === 'standards' ? 'Standards' : 'Spec'}{' '}
                  <span>{r.approved ? '通过' : '需要修改'}</span>
                </h3>
                <MarkdownContent content={r.summary} label={`${r.axis} Review 总结`} />
                {r.findings.map((f, i) => (
                  <MarkdownContent key={i} content={f} label={`${r.axis} Review 发现 ${i + 1}`} />
                ))}
              </section>
            ))}
            {detail.feedback.length > 0 && <h3>反馈</h3>}
            {detail.feedback.map((content, i) => (
              <MarkdownContent key={i} content={content} label={`反馈 ${i + 1}`} />
            ))}
            {!!detail.pendingFeedback?.length && <h3>待处理反馈</h3>}
            {detail.pendingFeedback?.map((content, i) => (
              <MarkdownContent key={i} content={content} label={`待处理反馈 ${i + 1}`} />
            ))}
            {!!detail.documentChanges?.length && <h3>领域文档变更</h3>}
            {detail.documentChanges?.map((doc) => (
              <section key={doc.path}>
                <h4>
                  {doc.path} · v{doc.version}
                </h4>
                <MarkdownContent content={doc.content} label={`文档变更 ${doc.path}`} />
              </section>
            ))}
            {detail.issueBody && (
              <section>
                <h3>Issue 正文</h3>
                <MarkdownContent content={detail.issueBody} label="Issue 正文" />
              </section>
            )}
            {detail.tests.map((t, i) => (
              <details key={i}>
                <summary>
                  {t.exitCode === 0 ? '✓' : '!'} {t.command}
                </summary>
                <pre>{t.output}</pre>
              </details>
            ))}
            <details>
              <summary>技术记录</summary>
              <pre>
                {state?.events
                  .filter((e) => e.taskId === detail.id)
                  .slice(0, 30)
                  .map((e) => `${e.at} ${e.type}\n${e.message}`)
                  .join('\n\n')}
              </pre>
            </details>
          </div>
        </Modal>
      )}
    </div>
  );
}
function Metric({
  value,
  label,
  suffix,
  live,
}: {
  value: number;
  label: string;
  suffix?: string;
  live?: boolean;
}) {
  const { number } = useLocale();
  return (
    <div className="metric">
      <div className="metric-value">
        {number(value)}
        <span>{suffix}</span>
        {live && value > 0 && <span className="pulse-dot" />}
      </div>
      <div className="metric-label">{label}</div>
    </div>
  );
}
function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="empty-state">
      {icon}
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}
function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const { t } = useLocale();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    const dialog = ref.current;
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={`modal ${wide ? 'wide' : ''}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-content">
        <header>
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
            <LanguageControl />
          </div>
          <button className="icon-button" aria-label={t('common.close')} onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
function ProjectForm({
  submit,
  busy,
}: {
  submit: (b: { name: string; description: string }) => Promise<void>;
  busy: boolean;
}) {
  const { t } = useLocale();
  const [validation, setValidation] = useState<
    'project.required' | 'project.nameLength' | 'project.goalLength'
  >();
  return (
    <form
      className="form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const name = String(f.get('name'));
        const description = String(f.get('description'));
        const issue = !name.trim()
          ? 'project.required'
          : name.trim().length > 100
            ? 'project.nameLength'
            : description.length > 3000
              ? 'project.goalLength'
              : undefined;
        setValidation(issue);
        if (issue) return;
        void submit({ name, description });
      }}
    >
      <label>
        {t('project.name')}
        <input
          name="name"
          placeholder={t('project.namePlaceholder')}
          required
          maxLength={100}
          autoFocus
          aria-invalid={validation === 'project.required' || validation === 'project.nameLength'}
          aria-describedby={
            validation && validation !== 'project.goalLength' ? 'project-validation' : undefined
          }
        />
      </label>
      <label>
        {t('project.goal')}
        <textarea
          name="description"
          placeholder={t('project.goalPlaceholder')}
          maxLength={3000}
          aria-invalid={validation === 'project.goalLength'}
          aria-describedby={validation === 'project.goalLength' ? 'project-validation' : undefined}
        />
      </label>
      {validation && (
        <p id="project-validation" role="alert">
          {t(validation)}
        </p>
      )}
      <button className="primary-button" disabled={busy}>
        {t('project.create')} <ArrowUpRight size={16} />
      </button>
    </form>
  );
}
function RepoForm({
  submit,
  busy,
}: {
  submit: (b: { path: string; github: string; authorized: boolean }) => Promise<void>;
  busy: boolean;
}) {
  const { t } = useLocale();
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void submit({
          path: String(f.get('path')),
          github: String(f.get('github')),
          authorized: f.get('authorized') === 'on',
        });
      }}
    >
      <label>
        GitHub 仓库
        <input
          name="github"
          placeholder="owner/repository"
          required
          pattern="[\w.\-]+/[\w.\-]+"
          autoFocus
        />
      </label>
      <label>
        本地仓库路径
        <input name="path" placeholder="D:\Codebase\my-project" required />
      </label>
      <label className="checkbox-label">
        <input name="authorized" type="checkbox" />
        <span>
          授权此仓库的本地开发与验证，以及 GitHub 任务、Project、Milestone、任务分支、PR
          和合并操作。生产部署不包含在内。
        </span>
      </label>
      <p className="field-note">
        使用本机已登录的 GitHub 身份。系统会核对本地 origin；原 checkout 中的修改会保留。
      </p>
      <button className="primary-button" disabled={busy}>
        {busy ? '正在核对仓库…' : t('repo.connect')} <ArrowUpRight size={16} />
      </button>
    </form>
  );
}
function CommandsForm({
  repo,
  submit,
  busy,
}: {
  repo: Repo;
  submit: (b: unknown) => Promise<void>;
  busy: boolean;
}) {
  const { t } = useLocale();
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void submit({
          authorized: f.get('authorized') === 'on',
          commands: {
            install: String(f.get('install')),
            build: String(f.get('build')),
            test: String(f.get('test')),
            start: String(f.get('start')),
            port: Number(f.get('port')),
          },
          requiredChecks: String(f.get('checks'))
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
        });
      }}
    >
      {(['install', 'build', 'test', 'start'] as const).map((k) => (
        <label key={k}>
          {
            {
              install: '安装依赖',
              build: '构建',
              test: '验收测试（交付必需）',
              start: '体验启动命令',
            }[k]
          }
          <input
            name={k}
            defaultValue={repo.commands[k]}
            placeholder={k === 'start' ? 'npm run dev -- --port {port}' : '例如 npm test'}
          />
        </label>
      ))}
      <label>
        体验端口
        <input name="port" type="number" min={1024} max={65535} defaultValue={repo.commands.port} />
      </label>
      <label>
        GitHub 必需检查
        <input
          name="checks"
          defaultValue={repo.requiredChecks.join(', ')}
          placeholder="检查名称，以逗号分隔"
        />
      </label>
      <label className="checkbox-label">
        <input type="checkbox" name="authorized" defaultChecked={repo.authorized} />
        <span>授权本地开发验证与 GitHub 工程交付操作（不含生产部署）</span>
      </label>
      <button className="primary-button" disabled={busy}>
        {t('common.saveConfig')}
      </button>
    </form>
  );
}
function SettingsForm({
  initial,
  submit,
  busy,
}: {
  initial: Settings;
  submit: (s: Settings) => Promise<void>;
  busy: boolean;
}) {
  const { t } = useLocale();
  const [settings, setSettings] = useState(structuredClone(initial));
  const [health, setHealth] = useState<any>();
  const [checking, setChecking] = useState(false);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(settings);
      }}
    >
      <div className="form-columns">
        <label>
          {t('settings.devLimit')}
          <input
            type="number"
            min={1}
            max={32}
            required
            value={settings.globalDevLimit}
            onChange={(e) => setSettings({ ...settings, globalDevLimit: Number(e.target.value) })}
          />
        </label>
        <label>
          {t('settings.reviewLimit')}
          <input
            type="number"
            min={1}
            max={32}
            required
            value={settings.reviewLimit}
            onChange={(e) => setSettings({ ...settings, reviewLimit: Number(e.target.value) })}
          />
        </label>
      </div>
      <h3>{t('settings.models')}</h3>
      <div className="profile-table">
        {(Object.keys(profileKeys) as ProfileName[]).map((key) => (
          <div className="profile-row" key={key}>
            <label htmlFor={`model-${key}`}>{t(profileKeys[key])}</label>
            <input
              id={`model-${key}`}
              aria-label={t('settings.modelLabel', { profile: t(profileKeys[key]) })}
              required
              value={settings.profiles[key].model}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  profiles: {
                    ...settings.profiles,
                    [key]: { ...settings.profiles[key], model: e.target.value },
                  },
                })
              }
            />
            <select
              aria-label={t('settings.effortLabel', { profile: t(profileKeys[key]) })}
              value={settings.profiles[key].effort}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  profiles: {
                    ...settings.profiles,
                    [key]: { ...settings.profiles[key], effort: e.target.value },
                  },
                })
              }
            >
              {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <div className="health-section">
        <button
          className="secondary-button"
          type="button"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            void api('/health')
              .then(setHealth)
              .catch((e) => setHealth({ error: String(e) }))
              .finally(() => setChecking(false));
          }}
        >
          <Radio size={15} />
          {checking ? t('settings.checking') : t('settings.check')}
        </button>
        {health && (
          <div className="health-result">
            {health.error ?? (
              <>
                <p>{health.codex.ok ? t('settings.connected') : '! ' + health.codex.error}</p>
                <p>
                  {health.github.ok
                    ? `✓ GitHub · ${health.github.login}`
                    : '! ' + health.github.error}
                </p>
                {health.codex.models && (
                  <details>
                    <summary>{t('settings.available')}</summary>
                    {health.codex.models.map((m: any) => (
                      <p key={m.id}>
                        {m.model} ·{' '}
                        {m.supportedReasoningEfforts.map((e: any) => e.reasoningEffort).join(' / ')}
                      </p>
                    ))}
                  </details>
                )}
              </>
            )}
          </div>
        )}
      </div>
      <button className="primary-button" disabled={busy}>
        {t('settings.save')}
      </button>
    </form>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </React.StrictMode>,
);
