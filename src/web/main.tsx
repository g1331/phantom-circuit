import { PriorityBadge, PriorityEditor, ClaimConditions, ClaimOrder } from './task-priority.tsx';
import type { SchedulingExplanation } from '../shared/types.ts';
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
import type { Snapshot, Project, Repo, Task, Settings, Message, Stage } from '../shared/types.ts';
import { stageLabels } from '../shared/types.ts';
import { api, session, LocalRequestError, LocalUiError, HostRequestError } from './api.ts';
import { ErrorText } from './error-text.tsx';
import { MarkdownContent } from './markdown-content.tsx';
import { ActivityRow, PMProgress } from './pm-activity.tsx';
import { ProfileEditor } from './profile-editor.tsx';
import { ProviderSettings } from './providers.tsx';
import { RuntimeFields, profileNames, type RuntimeConfig } from './runtime-settings.tsx';
import { ProjectActions, TaskRuntimeBadges } from './project-actions.tsx';
import { AllowancePanel, RunRecord, TaskUsagePanel } from './usage-panel.tsx';
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
  const { t, time, number, host, locale: priorityLocale } = useLocale();
  const [schedule, setSchedule] = useState<SchedulingExplanation>();
  const [scheduleError, setScheduleError] = useState('');
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleRefresh, setScheduleRefresh] = useState(0);
  const [state, setState] = useState<Snapshot>();
  const [selected, setSelected] = useState(localStorage.getItem('phantom.project') ?? '');
  const [view, setView] = useState<'chat' | 'tasks' | 'runs'>('chat');
  const [contextOpen, setContextOpen] = useState(false);
  const contextRef = useRef<HTMLDialogElement>(null);
  const [modal, setModal] = useState<'project' | 'repo' | 'settings' | 'project-settings' | null>(
    null,
  );
  const [repoConfig, setRepoConfig] = useState<Repo>();
  const [taskDetail, setTaskDetail] = useState<string>();
  const [error, setError] = useState<string | Error>('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem('phantom.theme') ?? 'dark');
  const [stream, setStream] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<{ file: File; url: string }[]>([]);
  const imageDrafts = useRef(images);
  const sending = useRef(false);
  function updateImages(next: typeof images) {
    for (const image of imageDrafts.current) {
      if (!next.includes(image)) URL.revokeObjectURL(image.url);
    }
    imageDrafts.current = next;
    setImages(next);
  }
  useEffect(
    () => () => {
      for (const image of imageDrafts.current) URL.revokeObjectURL(image.url);
    },
    [],
  );
  const [intent, setIntent] = useState<Message['intent']>('discuss');
  const [deliveryMode, setDeliveryMode] = useState<'queue' | 'steer'>('queue');
  const [filter, setFilter] = useState('all');
  const [controlFilter, setControlFilter] = useState('all');
  const [taskView, setTaskView] = useState<'board' | 'list'>(() =>
    localStorage.getItem('phantom.taskView') === 'list' ? 'list' : 'board',
  );
  const [query, setQuery] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  const stateRequest = useRef(0);
  const reload = useCallback(async () => {
    const request = ++stateRequest.current;
    const result = await api<Snapshot>('/state');
    if (request === stateRequest.current) setState(result);
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
          if (d.role === 'pm')
            setStream((s) => ({
              ...s,
              [d.runId]: d.replace ? d.text : (s[d.runId] ?? '') + d.text,
            }));
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
    setContextOpen(false);
    setDraft('');
    setDeliveryMode('queue');
    updateImages([]);
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
  useEffect(() => {
    const dialog = contextRef.current;
    if (!dialog) return;
    if (contextOpen && !dialog.open) dialog.showModal();
    if (!contextOpen && dialog.open) dialog.close();
  }, [contextOpen, project?.id]);
  const projectAgent =
    project?.agentSelection?.mode === 'override'
      ? project.agentSelection.agent
      : (state?.settings.defaultAgent ?? 'omp');
  const pmProfile =
    project?.profileModes?.pm === 'inherit'
      ? projectAgent === 'omp'
        ? state?.settings.ompProfiles?.pm
        : state?.settings.profiles.pm
      : projectAgent === 'omp'
        ? (project?.ompProfiles?.pm ?? state?.settings.ompProfiles?.pm)
        : project?.profiles.pm;
  const repos = state?.repos.filter((r) => r.projectId === project?.id) ?? [];
  const tasks = state?.tasks.filter((t) => t.projectId === project?.id) ?? [];
  const runs = state?.runs.filter((r) => r.projectId === project?.id) ?? [];
  const active = runs.filter((r) => isRunning(r.status));
  const messages = state?.messages.filter((m) => m.projectId === project?.id) ?? [];
  const activities = state?.activities?.filter((a) => a.projectId === project?.id) ?? [];
  const timeline = [
    ...messages.map((message) => ({
      at: message.createdAt,
      order: message.timelineOrder ?? 0,
      message,
      activity: undefined,
    })),
    ...activities.map((activity) => ({
      at: activity.startedAt,
      order: activity.timelineOrder ?? 0,
      activity,
      message: undefined,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  const documents = state?.documents.filter((d) => d.projectId === project?.id) ?? [];
  const shown = tasks.filter(
    (t) =>
      (filter === 'all' ||
        (filter === 'active' ? !['done', 'cancelled'].includes(t.stage) : t.stage === filter)) &&
      (controlFilter === 'all' || t.control === controlFilter) &&
      `${t.title} ${t.spec}`.toLowerCase().includes(query.toLowerCase()),
  );
  const pmBusy = active.some((r) => r.role === 'pm');
  useEffect(() => {
    if (!pmBusy) setDeliveryMode('queue');
  }, [pmBusy]);
  const detail = state?.tasks.find((t) => t.id === taskDetail);
  const currentSchedule = schedule?.projectId === project?.id ? schedule : undefined;
  const stages = Object.keys(stageLabels) as Stage[];
  useEffect(() => {
    let current = true;
    setScheduleLoading(!!project);
    setScheduleError('');
    if (project)
      void api<SchedulingExplanation>(`/projects/${project.id}/scheduling`)
        .then((result) => {
          if (current) setSchedule(result);
        })
        .catch((error) => {
          if (current) setScheduleError(String(error));
        })
        .finally(() => {
          if (current) setScheduleLoading(false);
        });
    return () => {
      current = false;
    };
  }, [state, project?.id, scheduleRefresh]);
  async function send() {
    if ((!draft.trim() && !images.length) || !project || busy || sending.current) return;
    sending.current = true;
    const content = draft;
    try {
      await act(async () => {
        let body: unknown = { content, intent, deliveryMode: pmBusy ? deliveryMode : 'queue' };
        if (images.length) {
          const form = new FormData();
          form.append('content', content);
          form.append('intent', intent ?? 'discuss');
          form.append('deliveryMode', pmBusy ? deliveryMode : 'queue');
          for (const image of images) form.append('images', image.file);
          body = form;
        }
        await api(`/projects/${project.id}/messages`, body);
        setDraft('');
        updateImages([]);
      });
    } finally {
      sending.current = false;
    }
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
        {!project && (
          <header className="topbar">
            <div className="breadcrumb">
              {t('app.workspace')} <span>/</span>
              <strong>{t('app.start')}</strong>
            </div>
            <div className="topbar-actions">
              <span className="local-badge">
                <ShieldCheck size={13} /> {t('app.local')}
              </span>
            </div>
          </header>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <span>
              {error instanceof LocalUiError ? (
                t(error.key)
              ) : error instanceof HostRequestError ? (
                <ErrorText error={error} />
              ) : error instanceof LocalRequestError ? (
                error.kind === 'connection' ? (
                  t('connection.failed')
                ) : (
                  t('request.failed', { status: error.status })
                )
              ) : error instanceof Error ? (
                error.message
              ) : (
                error
              )}
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
                <h1>{project.name}</h1>
              </div>
              <button
                className="secondary-button context-trigger"
                aria-controls="project-context"
                aria-expanded={contextOpen}
                onClick={() => setContextOpen(true)}
              >
                <Settings2 size={15} /> {t('project.overview')}
              </button>
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
                      <ProjectActions
                        key={project.id}
                        state={state}
                        project={project}
                        reload={reload}
                      />
                      {!timeline.length && (
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
                      {timeline.map((entry) => {
                        if (entry.activity)
                          return (
                            <ActivityRow
                              key={entry.activity.id}
                              activity={entry.activity}
                              roots={repos.map((r) => r.path)}
                            />
                          );
                        const m = entry.message!;
                        const messageRun =
                          m.role === 'assistant'
                            ? active.find((run) => run.id === m.runId)
                            : undefined;
                        return (
                          <article
                            key={`${m.role}:${m.draftId ?? m.id}`}
                            className={`message ${m.role}`}
                          >
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
                                    ? t('ui.you')
                                    : t('ui.runNotice')}
                              </strong>
                              {m.intent && (
                                <span className="message-intent">
                                  {
                                    {
                                      discuss: t('ui.discussion'),
                                      implement: t('ui.implementationRequest'),
                                      feedback: t('ui.experienceFeedback'),
                                    }[m.intent]
                                  }
                                </span>
                              )}
                              <time>{time(m.createdAt)}</time>
                              {(m.draftStatus ?? m.status) && (
                                <span className="runtime-badge">
                                  {t(`delivery.${m.draftStatus ?? m.status!}`)}
                                </span>
                              )}
                            </div>
                            {messageRun && <PMProgress run={messageRun} activities={activities} />}
                            <div className="message-content">
                              {m.role === 'system' ? (
                                host(m.content, m.descriptor)
                              ) : (
                                <MarkdownContent
                                  content={
                                    m.runId &&
                                    isRunning(m.draftStatus ?? m.status ?? '') &&
                                    stream[m.runId]
                                      ? stream[m.runId]
                                      : m.content
                                  }
                                />
                              )}
                            </div>
                            {!!m.attachments?.length && (
                              <div className="message-images">
                                {m.attachments.map((attachment) => {
                                  const url = `/api/projects/${m.projectId}/messages/${m.id}/images/${attachment.id}`;
                                  return (
                                    <a
                                      key={attachment.id}
                                      href={url}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      <img src={url} alt={attachment.name} />
                                      <span>{attachment.name}</span>
                                    </a>
                                  );
                                })}
                              </div>
                            )}
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
                        );
                      })}
                      {active
                        .filter(
                          (r) =>
                            r.role === 'pm' &&
                            !messages.some(
                              (message) => message.role === 'assistant' && message.runId === r.id,
                            ),
                        )
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
                            <PMProgress run={r} activities={activities} />
                            {stream[r.id] ? (
                              <div className="message-content">
                                <MarkdownContent content={stream[r.id]} />
                              </div>
                            ) : null}
                          </article>
                        ))}
                    </div>
                    <div className="composer">
                      {pmBusy && (
                        <label className="delivery-mode">
                          {t('delivery.mode')}
                          <select
                            value={deliveryMode}
                            onChange={(event) =>
                              setDeliveryMode(event.target.value as 'queue' | 'steer')
                            }
                          >
                            <option value="queue">{t('delivery.queue')}</option>
                            <option value="steer">{t('delivery.steer')}</option>
                          </select>
                        </label>
                      )}
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
                      <div className="image-picker">
                        <label>
                          {t('ui.addImages')}{' '}
                          <input
                            aria-label={t('ui.chooseImages')}
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            multiple
                            disabled={busy}
                            onChange={(event) => {
                              const files = Array.from(event.target.files ?? []);
                              event.target.value = '';
                              if (images.length + files.length > 4) {
                                setError(new LocalUiError('ui.atMost4ImagesPerMessage'));
                                return;
                              }
                              if (
                                files.some(
                                  (file) =>
                                    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type),
                                )
                              ) {
                                setError(new LocalUiError('ui.onlyPngJpegAndWebpImagesAre'));
                                return;
                              }
                              if (files.some((file) => file.size > 10 * 1024 * 1024)) {
                                setError(new LocalUiError('ui.eachImageMustBe10MibOr'));
                                return;
                              }
                              setError('');
                              updateImages([
                                ...images,
                                ...files.map((file) => ({ file, url: URL.createObjectURL(file) })),
                              ]);
                            }}
                          />
                        </label>
                        <small> {t('ui.pngJpegWebpUpTo4Images')} </small>
                      </div>
                      {!!images.length && (
                        <div className="image-drafts">
                          {images.map((image) => (
                            <div key={image.url} className="image-draft">
                              <img
                                src={image.url}
                                alt={t('images.pending', { name: image.file.name })}
                              />
                              <span>
                                {image.file.name}
                                <small>{Math.max(1, Math.ceil(image.file.size / 1024))} KiB</small>
                              </span>
                              <button
                                aria-label={t('images.remove', { name: image.file.name })}
                                disabled={busy}
                                onClick={() =>
                                  updateImages(images.filter((item) => item !== image))
                                }
                              >
                                <X size={16} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      <textarea
                        aria-label={t('chat.message')}
                        disabled={busy}
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
                          disabled={(!draft.trim() && !images.length) || busy}
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
                    <ClaimOrder
                      schedule={currentSchedule}
                      projects={state?.projects ?? []}
                      locale={priorityLocale}
                      refresh={() => setScheduleRefresh((n) => n + 1)}
                      error={scheduleError}
                      refreshing={scheduleLoading}
                    />
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
                        {stages.map((stage) => (
                          <option key={stage} value={stage}>
                            {t(`stage.${stage}`)}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label={t('tasks.control')}
                        value={controlFilter}
                        onChange={(event) => setControlFilter(event.target.value)}
                      >
                        <option value="all">{t('tasks.allControls')}</option>
                        <option value="active">{t('tasks.activeControl')}</option>
                        <option value="paused">{t('tasks.pausedControl')}</option>
                      </select>
                      <div className="view-switch" role="group" aria-label={t('tasks.view')}>
                        {(['board', 'list'] as const).map((mode) => (
                          <button
                            key={mode}
                            aria-pressed={taskView === mode}
                            onClick={() => {
                              setTaskView(mode);
                              localStorage.setItem('phantom.taskView', mode);
                            }}
                          >
                            {t(`tasks.${mode}`)}
                          </button>
                        ))}
                      </div>
                    </div>
                    {taskView === 'board' ? (
                      <div className="task-board" tabIndex={0} aria-label={t('tasks.board')}>
                        {stages
                          .filter((stage) => !stages.includes(filter as Stage) || stage === filter)
                          .map((stage) => {
                            const column = shown.filter((task) => task.stage === stage);
                            return (
                              <section
                                className="board-column"
                                key={stage}
                                aria-label={t(`stage.${stage}`)}
                              >
                                <h3>
                                  {t(`stage.${stage}`)} <span>{number(column.length)}</span>
                                </h3>
                                {column.map((task) => (
                                  <button
                                    className="task-card"
                                    key={task.id}
                                    onClick={() => setTaskDetail(task.id)}
                                  >
                                    <strong>{task.title}</strong>
                                    <span>
                                      {repos.find((repo) => repo.id === task.repoId)?.name} ·{' '}
                                      {t(profileKeys[task.profile])}
                                    </span>
                                    <PriorityBadge value={task.priority} locale={priorityLocale} />
                                    <TaskRuntimeBadges state={state} taskId={task.id} />
                                    <span>
                                      {t('tasks.dependencies', { count: task.dependencies.length })}
                                    </span>
                                    {task.control === 'paused' && (
                                      <em>{t('tasks.pausedControl')}</em>
                                    )}
                                    {task.blocked && (
                                      <em>{host(task.blocked, task.blockedDescriptor)}</em>
                                    )}
                                  </button>
                                ))}
                                {!column.length && (
                                  <p className="muted">{t('tasks.columnEmpty')}</p>
                                )}
                              </section>
                            );
                          })}
                      </div>
                    ) : shown.length ? (
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
                              <PriorityBadge value={task.priority} locale={priorityLocale} />
                              <TaskRuntimeBadges state={state} taskId={task.id} />
                              <span>
                                {repos.find((r) => r.id === task.repoId)?.name} <i>·</i>{' '}
                                {t(profileKeys[task.profile])}{' '}
                                {task.blocked && (
                                  <em>· {host(task.blocked, task.blockedDescriptor)}</em>
                                )}
                              </span>
                            </div>
                            <span className={`stage ${task.stage}`}>
                              {t(`stage.${task.stage}`)}
                              {task.control === 'paused' && <> · {t('tasks.pausedControl')}</>}
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
                                  {r.agentKind === 'omp'
                                    ? (r.modelIdentity?.providerId ??
                                      r.profileConfig?.providerId ??
                                      t('usage.unknown'))
                                    : r.provider?.kind === 'custom'
                                      ? r.provider.name
                                      : t('ui.officialCodexLogin')}{' '}
                                  ({r.profileConfig?.providerId ?? 'codex'}) ·{' '}
                                  {r.modelIdentity?.model ??
                                    r.model?.model ??
                                    r.profileConfig?.model ??
                                    t('ui.modelNotRecorded')}{' '}
                                  / {r.profileConfig?.effort ?? t('ui.unknownEffort')}
                                </span>
                              </strong>
                              <p>
                                {tasks.find((t) => t.id === r.taskId)?.title ??
                                  t('ui.projectRequirementsAndCoordination')}
                                {r.error && <em>{host(r.error, r.errorDescriptor)}</em>}
                              </p>
                              <TaskRuntimeBadges state={state} taskId={r.taskId} runId={r.id} />
                              <RunRecord run={r} />
                            </div>
                            <div className="run-meta">
                              <span>
                                {
                                  {
                                    running: t('ui.running'),
                                    waiting: t('ui.waiting'),
                                    paused: t('ui.paused'),
                                    interrupted: t('ui.interrupted'),
                                    failed: t('ui.failed'),
                                    completed: t('ui.completed'),
                                    queued: t('ui.queued'),
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
              <dialog
                id="project-context"
                className="context-panel"
                ref={contextRef}
                onClose={() => setContextOpen(false)}
                aria-label={t('project.overview')}
              >
                <div className="context-heading">
                  <div>
                    <h2>{project.name}</h2>
                    <p>{project.description || t('project.description')}</p>
                  </div>
                  <button
                    className="icon-button"
                    aria-label={t('common.close')}
                    onClick={() => setContextOpen(false)}
                  >
                    <X size={18} />
                  </button>
                </div>
                <div className="context-actions">
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setContextOpen(false);
                      setModal('project-settings');
                    }}
                  >
                    {t('ui.projectModelSettings')}
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setContextOpen(false);
                      setModal('repo');
                    }}
                  >
                    <Plus size={15} /> {t('repo.connect')}
                  </button>
                </div>
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
                            aria-label={t('repos.configure', { name: r.name })}
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
                            <strong>
                              {r.enabled
                                ? t('ui.newTaskClaimsEnabled')
                                : t('ui.newTaskClaimsStopped')}
                            </strong>
                            <small>
                              {!r.enabled && count
                                ? t('repos.running', { count })
                                : r.enabled
                                  ? t('ui.respectsDependenciesAndConcurrencyLimits')
                                  : t('ui.pmDiscussionAndTaskPreparationRemainAvailable')}
                            </small>
                          </div>
                          <button
                            className={`switch ${r.enabled ? 'on' : ''}`}
                            role="switch"
                            aria-checked={r.enabled}
                            aria-label={t('repos.switch', { name: r.name })}
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
                                {t('ui.openPreview')} <ExternalLink size={13} />
                              </a>
                              <button
                                className="icon-button"
                                aria-label={t('repos.stopPreview', { name: r.name })}
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
                              {r.preview?.status === 'starting'
                                ? t('ui.preparingPreview')
                                : t('ui.startLocalPreview')}
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
                          void act(() =>
                            api(`/projects/${project.id}`, { devLimit: value }, 'PATCH'),
                          );
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
                          {repos.find((repo) => repo.id === doc.repoId)?.name} · {doc.path} · v
                          {doc.version} · {doc.accepted ? t('ui.accepted') : t('ui.draft')}
                        </summary>
                        <MarkdownContent
                          content={doc.content}
                          label={t('docs.label', { path: doc.path })}
                        />
                      </details>
                    ))}
                  </section>
                )}
              </dialog>
            </div>
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
          subtitle={t('ui.connectAnExistingLocalCheckoutToIts')}
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
      {(modal === 'settings' || modal === 'project-settings') && state && (
        <Modal
          title={modal === 'settings' ? t('ui.runtimeSettings') : t('ui.projectModelSettings')}
          subtitle={
            modal === 'settings'
              ? t('ui.globalAssignmentsAreDefaultsForNewProjects')
              : t('ui.changesAffectFutureRunsActiveAndHistorical')
          }
          wide
          onClose={() => setModal(null)}
        >
          {modal === 'settings' && (
            <details className="settings-group provider-group">
              <summary>{t('ui.providerManagement')}</summary>
              <ProviderSettings />
            </details>
          )}
          <SettingsForm
            key={`${modal}-${project?.id}`}
            initial={
              modal === 'project-settings' && project
                ? {
                    ...state.settings,
                    profiles: project.profiles,
                    ompProfiles: project.ompProfiles ?? state.settings.ompProfiles,
                    secondaryReviewProfile: project.secondaryReviewProfile,
                    secondaryReviewProfiles: project.secondaryReviewProfiles ?? {},
                  }
                : state.settings
            }
            providers={state.providers}
            project={modal === 'project-settings' ? project : undefined}
            globalSettings={state.settings}
            projectOnly={modal === 'project-settings'}
            busy={busy}
            submit={async (settings, runtime) => {
              const result = await api<{ warnings?: string[] }>(
                modal === 'project-settings' ? `/projects/${project!.id}/runtime` : '/settings',
                modal === 'project-settings'
                  ? {
                      ...runtime,
                      ...(JSON.stringify(settings.profiles) !== JSON.stringify(project!.profiles)
                        ? { profiles: settings.profiles }
                        : {}),
                      ...(JSON.stringify(settings.ompProfiles) !==
                      JSON.stringify(project!.ompProfiles)
                        ? { ompProfiles: settings.ompProfiles }
                        : {}),
                      secondaryReviewProfile: settings.secondaryReviewProfile ?? null,
                      secondaryReviewProfiles: settings.secondaryReviewProfiles ?? {},
                    }
                  : {
                      ...settings,
                      secondaryReviewProfile: settings.secondaryReviewProfile ?? null,
                    },
                'PATCH',
              );
              await reload();
              const warnings = result.warnings ?? [];
              if (!warnings.length) setModal(null);
              return { warnings };
            }}
          />
        </Modal>
      )}
      {repoConfig && (
        <Modal
          title={t('repos.configure', { name: repoConfig.name })}
          subtitle={t('ui.thePmCanInferTheseCommandsFrom')}
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
          subtitle={`${t(`stage.${detail.stage}`)} · ${detail.routingReason}`}
          wide
          onClose={() => setTaskDetail(undefined)}
        >
          <div className="task-detail">
            <PriorityEditor key={detail.id} task={detail} locale={priorityLocale} reload={reload} />
            <ClaimConditions
              entry={currentSchedule?.tasks.find((t) => t.taskId === detail.id)}
              locale={priorityLocale}
            />
            <TaskRuntimeBadges state={state!} taskId={detail.id} />
            <TaskUsagePanel key={detail.id} taskId={detail.id} revision={detail.updatedAt} />
            <MarkdownContent content={detail.spec} label={t('ui.taskSpecification')} />
            <h3> {t('ui.acceptanceCriteria')} </h3>
            <ul>
              {detail.acceptance.map((x, i) => (
                <li key={i}>
                  <MarkdownContent content={x} label={t('acceptance.label', { count: i + 1 })} />
                </li>
              ))}
            </ul>
            {detail.dependencies.length > 0 && (
              <>
                <h3> {t('ui.waitingForTasks')} </h3>
                <ul>
                  {detail.dependencies.map((id) => (
                    <li key={id}>{state?.tasks.find((t) => t.id === id)?.title ?? id}</li>
                  ))}
                </ul>
              </>
            )}
            {detail.blocked && (
              <div className="inline-warning">{host(detail.blocked, detail.blockedDescriptor)}</div>
            )}
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
                    {detail.control === 'paused' ? t('ui.resumeTask') : t('ui.pauseTask')}
                  </button>
                  <button
                    className="danger-button"
                    disabled={busy}
                    onClick={() => void act(() => api(`/tasks/${detail.id}/cancel`, {}))}
                  >
                    {t('ui.cancelTask')}{' '}
                  </button>
                </>
              )}
            </div>
            {detail.reviews.map((r) => (
              <section className="review-result" key={r.axis}>
                <h3>
                  {r.axis === 'standards' ? 'Standards' : 'Spec'}{' '}
                  <span>{r.approved ? t('ui.approved') : t('ui.changesRequested')}</span>
                </h3>
                <MarkdownContent
                  content={r.summary}
                  label={t('review.summary', { axis: r.axis })}
                />
                {r.findings.map((f, i) => (
                  <MarkdownContent
                    key={i}
                    content={f}
                    label={t('review.finding', { axis: r.axis, count: i + 1 })}
                  />
                ))}
              </section>
            ))}
            {detail.feedback.length > 0 && <h3> {t('ui.feedback')} </h3>}
            {detail.feedback.map((content, i) => (
              <MarkdownContent
                key={i}
                content={content}
                label={t('feedback.label', { count: i + 1 })}
              />
            ))}
            {!!detail.pendingFeedback?.length && <h3> {t('ui.pendingFeedback')} </h3>}
            {detail.pendingFeedback?.map((content, i) => (
              <MarkdownContent
                key={i}
                content={content}
                label={t('feedback.pending', { count: i + 1 })}
              />
            ))}
            {!!detail.documentChanges?.length && <h3> {t('ui.domainDocumentChanges')} </h3>}
            {detail.documentChanges?.map((doc) => (
              <section key={doc.path}>
                <h4>
                  {doc.path} · v{doc.version}
                </h4>
                <MarkdownContent
                  content={doc.content}
                  label={t('docs.change', { path: doc.path })}
                />
              </section>
            ))}
            {detail.issueBody && (
              <section>
                <h3> {t('ui.issueBody')} </h3>
                <MarkdownContent content={detail.issueBody} label={t('ui.issueBody')} />
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
              <summary> {t('ui.technicalRecords')} </summary>
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
          <div className="modal-heading">
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <div className="modal-toolbar">
            <LanguageControl />
            <button className="icon-button" aria-label={t('common.close')} onClick={onClose}>
              <X size={19} />
            </button>
          </div>
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
        {t('ui.githubRepository')}{' '}
        <input
          name="github"
          placeholder="owner/repository"
          required
          pattern="[\w.\-]+/[\w.\-]+"
          autoFocus
        />
      </label>
      <label>
        {t('ui.localRepositoryPath')}{' '}
        <input name="path" placeholder="D:\Codebase\my-project" required />
      </label>
      <label className="checkbox-label">
        <input name="authorized" type="checkbox" />
        <span>{t('ui.authorizeLocalDevelopmentAndVerificationGithubTasks')} </span>
      </label>
      <p className="field-note">{t('ui.usesTheGithubIdentitySignedInOn')} </p>
      <button className="primary-button" disabled={busy}>
        {busy ? t('ui.verifyingRepository') : t('repo.connect')} <ArrowUpRight size={16} />
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
              install: t('ui.installDependencies'),
              build: t('ui.build'),
              test: t('ui.acceptanceTestsRequiredForDelivery'),
              start: t('ui.previewStartCommand'),
            }[k]
          }
          <input
            name={k}
            defaultValue={repo.commands[k]}
            placeholder={k === 'start' ? 'npm run dev -- --port {port}' : t('ui.forExampleNpmTest')}
          />
        </label>
      ))}
      <label>
        {t('ui.previewPort')}{' '}
        <input name="port" type="number" min={1024} max={65535} defaultValue={repo.commands.port} />
      </label>
      <label>
        {t('ui.requiredGithubChecks')}{' '}
        <input
          name="checks"
          defaultValue={repo.requiredChecks.join(', ')}
          placeholder={t('ui.checkNamesSeparatedByCommas')}
        />
      </label>
      <label className="checkbox-label">
        <input type="checkbox" name="authorized" defaultChecked={repo.authorized} />
        <span> {t('ui.authorizeLocalDevelopmentVerificationAndGithubEngineering')} </span>
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
  providers,
  projectOnly,
  project,
  globalSettings,
}: {
  providers: Snapshot['providers'];
  projectOnly: boolean;
  project?: Project;
  globalSettings: Settings;
  initial: Settings;
  submit: (s: Settings, runtime: RuntimeConfig) => Promise<{ warnings: string[] }>;
  busy: boolean;
}) {
  const [settings, setSettings] = useState(structuredClone(initial));
  const [runtime, setRuntime] = useState<RuntimeConfig>({
    agentSelection: project?.agentSelection,
    profileModes: project?.profileModes,
    recoveryPolicy: project?.recoveryPolicy,
  });
  const effectiveProfiles = Object.fromEntries(
    profileNames.map((role) => [
      role,
      project && runtime.profileModes?.[role] === 'inherit'
        ? globalSettings.profiles[role]
        : settings.profiles[role],
    ]),
  ) as Settings['profiles'];
  const effectiveOmp = Object.fromEntries(
    profileNames.map((role) => [
      role,
      project && runtime.profileModes?.[role] === 'inherit'
        ? globalSettings.ompProfiles?.[role]
        : settings.ompProfiles?.[role],
    ]),
  ) as Settings['ompProfiles'];
  const { t } = useLocale();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | Error>('');
  const [saved, setSaved] = useState<string[]>();
  const [health, setHealth] = useState<any>();
  const [checking, setChecking] = useState(false);
  const effectiveAgent =
    runtime.agentSelection?.mode === 'override'
      ? runtime.agentSelection.agent
      : (settings.defaultAgent ?? 'omp');
  const codexDetails = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (codexDetails.current) codexDetails.current.open = effectiveAgent === 'codex';
  }, [effectiveAgent]);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        setSaveError('');
        setSaved(undefined);
        void submit(settings, runtime)
          .then((result) => setSaved(result.warnings))
          .catch((error) => setSaveError(error instanceof Error ? error : String(error)))
          .finally(() => setSaving(false));
      }}
    >
      {!projectOnly && (
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
      )}
      <RuntimeFields
        settings={{ ...settings, ompProfiles: effectiveOmp }}
        project={project}
        runtime={runtime}
        changeRuntime={(next) => {
          const pinned = profileNames.filter(
            (role) =>
              runtime.profileModes?.[role] === 'inherit' && next.profileModes?.[role] === 'pinned',
          );
          if (pinned.length)
            setSettings((current) => ({
              ...current,
              profiles: {
                ...current.profiles,
                ...Object.fromEntries(pinned.map((role) => [role, effectiveProfiles[role]])),
              },
              ompProfiles: {
                ...current.ompProfiles,
                ...Object.fromEntries(pinned.map((role) => [role, effectiveOmp?.[role]])),
              } as Settings['ompProfiles'],
            }));
          setRuntime(next);
        }}
        change={(next) => {
          setSettings(next);
          if (project && next.ompProfiles !== effectiveOmp)
            setRuntime((current) => ({
              ...current,
              profileModes: Object.fromEntries(
                profileNames.map((role) => [
                  role,
                  next.ompProfiles?.[role] !== effectiveOmp?.[role]
                    ? 'pinned'
                    : (current.profileModes?.[role] ?? 'pinned'),
                ]),
              ) as NonNullable<Project['profileModes']>,
            }));
        }}
      />
      <details className="settings-group" ref={codexDetails}>
        <summary>{t('runtime.codexProfiles')}</summary>
        <fieldset className="assignment-form" disabled={saving || busy}>
          <ProfileEditor
            profiles={effectiveProfiles}
            providers={providers}
            modes={project ? runtime.profileModes : undefined}
            required={effectiveAgent === 'codex'}
            change={(profiles) => {
              setSettings({ ...settings, profiles });
              if (project)
                setRuntime((current) => ({
                  ...current,
                  profileModes: Object.fromEntries(
                    profileNames.map((role) => [
                      role,
                      profiles[role] !== effectiveProfiles[role]
                        ? 'pinned'
                        : (current.profileModes?.[role] ?? 'pinned'),
                    ]),
                  ) as NonNullable<Project['profileModes']>,
                }));
            }}
          />
        </fieldset>
      </details>
      {saveError && (
        <p role="alert">
          <ErrorText error={saveError} />
        </p>
      )}
      {saved && (
        <p role="status">
          {t('ui.saved')} {saved.join('; ')}
        </p>
      )}
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
      <button className="primary-button" disabled={busy || saving}>
        {saving ? t('ui.validating') : t('ui.saveSettings')}
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
