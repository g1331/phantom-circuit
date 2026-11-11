import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChevronDown, Menu, Plus, X } from 'lucide-react';
import type { Project, Repo, SchedulingExplanation, Snapshot } from '../shared/types.ts';
import { teamView, workGroup } from '../shared/team.ts';
import { api, session, LocalRequestError, LocalUiError, HostRequestError } from './api.ts';
import { ErrorText } from './error-text.tsx';
import { PMComposer, type PMComposerHandle, type PMSubmission } from './pm-composer.tsx';
import { PMModelControl } from './pm-model-control.tsx';
import { DeferredSettings } from './deferred-panels.tsx';
import { ProjectActions } from './project-actions.tsx';
import { ConversationFlow, TurnNavigator, useReadingAnchor } from './conversation.tsx';
import { useConversation } from './use-conversation.ts';
import { LocaleProvider, useLocale } from './locale/provider.tsx';
import { Sidebar, isRunning } from './sidebar.tsx';
import { ChatMessage, PendingReply } from './chat-message.tsx';
import { TeamInstructions } from './team-instructions.tsx';
import { RunList } from './run-list.tsx';
import { ClaimOrder } from './task-priority.tsx';
import { DomainDocuments, ProjectContext, ProjectHeader } from './project-context.tsx';
import { PageTabs } from './fold.tsx';
import { Modal } from './ui.tsx';
import { CommandsForm, ProjectForm, RepoForm } from './forms.tsx';
import { TeamRoom } from './team-room.tsx';
import { useRoute, routeHref } from './route.ts';
import { Brief } from './brief.tsx';
import { WorkList } from './work-list.tsx';
import { TaskPage } from './task-page.tsx';
import { ProjectNav } from './project-nav.tsx';
import { Workbench } from './workbench.tsx';
import './style.css';

function App() {
  const { t, locale } = useLocale();
  const [schedule, setSchedule] = useState<SchedulingExplanation>();
  const [scheduleError, setScheduleError] = useState<{ projectId: string; message: string }>();
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleRefresh, setScheduleRefresh] = useState(0);
  const [state, setState] = useState<Snapshot>();
  const [route, go] = useRoute();
  const page = route.page;
  const projectView = route.view === 'docs' || route.view === 'runs' ? route.view : 'overview';
  const [drawer, setDrawer] = useState(false);
  const [workQuery, setWorkQuery] = useState('');
  const [modal, setModal] = useState<'project' | 'repo' | 'settings' | 'project-settings' | null>(
    null,
  );
  const [repoConfig, setRepoConfig] = useState<Repo>();
  const [actionError, setError] = useState<string | Error>('');
  const [connectionError, setConnectionError] = useState<Error>();
  const error = actionError || connectionError || '';
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    localStorage.getItem('phantom.sidebar') === 'collapsed',
  );
  const composerRef = useRef<PMComposerHandle>(null);
  useEffect(() => {
    localStorage.setItem('phantom.sidebar', sidebarCollapsed ? 'collapsed' : 'expanded');
  }, [sidebarCollapsed]);
  const [stream, setStream] = useState<Record<string, string>>({});
  const scroll = useRef<HTMLDivElement>(null);
  const conversationContent = useRef<HTMLDivElement>(null);
  const processDisclosures = useRef({ projectId: '', items: new Map<string, boolean>() });
  const followingLatest = useRef(true);
  const [atLatest, setAtLatest] = useState(true);
  const historyBefore = useRef<HTMLDivElement>(null);
  const historyAfter = useRef<HTMLDivElement>(null);
  const userScrollIntent = useRef<
    { direction: 'before' | 'after'; movement?: number } | 'drag' | undefined
  >(undefined);
  const scrollPosition = useRef(0);
  const touchPosition = useRef<number | undefined>(undefined);
  const clearScrollIntent = useCallback(() => {
    userScrollIntent.current = undefined;
  }, []);
  const stateRequest = useRef(0);
  const reload = useCallback(async (signal?: AbortSignal) => {
    const request = ++stateRequest.current;
    const result = await api<Snapshot>('/state?messages=none', undefined, 'GET', signal);
    if (!signal?.aborted && request === stateRequest.current) {
      setState(result);
    }
  }, []);
  useEffect(() => {
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let delay = 500;
    let alive = true;
    function reconnect() {
      if (!alive || retry !== undefined) return;
      source?.close();
      controller?.abort();
      if (timer) clearTimeout(timer);
      if (deadline) clearTimeout(deadline);
      setConnected(false);
      setConnectionError(new LocalRequestError('connection'));
      setStream({});
      retry = setTimeout(() => {
        retry = undefined;
        void connect();
      }, delay);
      delay = Math.min(delay * 2, 5000);
    }
    async function connect() {
      const attempt = new AbortController();
      controller = attempt;
      deadline = setTimeout(reconnect, 10_000);
      try {
        await session(attempt.signal);
        await reload(attempt.signal);
        if (!alive || attempt.signal.aborted) return;
        const events = new EventSource('/api/events');
        source = events;
        events.addEventListener('ready', () => {
          if (!alive || attempt.signal.aborted) return;
          // Catch changes between the initial snapshot and the stream becoming ready.
          void reload(attempt.signal)
            .then(() => {
              if (!alive || attempt.signal.aborted) return;
              if (deadline) clearTimeout(deadline);
              delay = 500;
              setConnectionError(undefined);
              setConnected(true);
            })
            .catch(() => {
              if (!attempt.signal.aborted) reconnect();
            });
        });
        events.onerror = () => {
          if (!attempt.signal.aborted) reconnect();
        };
        events.addEventListener('change', () => {
          if (!alive || attempt.signal.aborted) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            void reload(attempt.signal).catch(() => {
              if (!attempt.signal.aborted) reconnect();
            });
          }, 180);
        });
        events.addEventListener('delta', (event) => {
          if (!alive || attempt.signal.aborted) return;
          const d = JSON.parse((event as MessageEvent).data);
          if (d.role === 'pm')
            setStream((s) => ({
              ...s,
              [d.runId]: d.replace ? d.text : (s[d.runId] ?? '') + d.text,
            }));
        });
      } catch {
        if (!attempt.signal.aborted) reconnect();
      }
    }
    void connect();
    return () => {
      alive = false;
      source?.close();
      controller?.abort();
      if (timer) clearTimeout(timer);
      if (retry) clearTimeout(retry);
      if (deadline) clearTimeout(deadline);
    };
  }, [reload]);
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
  const selected = route.projectId ?? localStorage.getItem('phantom.project') ?? '';
  const project = state?.projects.find((p) => p.id === selected) ?? state?.projects[0];
  const history = useConversation(project?.id, state, followingLatest);
  const messages = history.messages;
  const activities = history.activities;
  const scrollToLatest = useCallback(() => {
    clearScrollIntent();
    const finish = () => {
      followingLatest.current = true;
      setAtLatest(true);
      requestAnimationFrame(() => {
        clearScrollIntent();
        if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
      });
    };
    if (history.hasAfter)
      void history.load('latest').then((loaded) => {
        if (loaded) finish();
      });
    else finish();
  }, [history.hasAfter, history.load, clearScrollIntent]);
  // Every page names its project in the address, so links and the back button land in place.
  useEffect(() => {
    if (!project) return;
    localStorage.setItem('phantom.project', project.id);
    if (route.projectId !== project.id) go({ page: 'home', projectId: project.id }, true);
  }, [project?.id, route.projectId]);
  useEffect(() => setDrawer(false), [route.page, route.projectId, route.taskId]);
  const openTask = (taskId: string) =>
    project && go({ page: 'task', projectId: project.id, taskId });
  if (processDisclosures.current.projectId !== (project?.id ?? '')) {
    processDisclosures.current = { projectId: project?.id ?? '', items: new Map() };
  }
  const requestId = page === 'conversation' ? route.view : undefined;
  const requestReady =
    !!requestId &&
    [...(state?.clarifications ?? []), ...(state?.incidents ?? [])].some(
      (request) => request.id === requestId,
    );
  // Explicit navigation owns the initial viewport. Position it before the reading-anchor
  // hook captures this route, so its resize restoration preserves the requested form.
  useLayoutEffect(() => {
    if (page !== 'conversation') return;
    const element = scroll.current;
    if (!element) return;
    clearScrollIntent();
    followingLatest.current = !requestId;
    setAtLatest(!requestId);
    if (requestId) {
      const request = document.getElementById(`project-request-${requestId}`);
      request?.scrollIntoView({ block: 'start' });
      request?.focus({ preventScroll: true });
    } else element.scrollTop = element.scrollHeight;
    const observer = new ResizeObserver(() => {
      if (followingLatest.current) {
        clearScrollIntent();
        element.scrollTop = element.scrollHeight;
      }
    });
    observer.observe(element);
    if (conversationContent.current) observer.observe(conversationContent.current);
    return () => {
      clearScrollIntent();
      observer.disconnect();
    };
  }, [project?.id, page, requestId, requestReady]);
  const captureReadingAnchor = useReadingAnchor(
    scroll,
    conversationContent,
    followingLatest,
    `${project?.id}:${page}:${requestId ?? ''}:${requestReady}`,
    clearScrollIntent,
  );
  const considerHistory = (direction: 'before' | 'after', movement = 0) => {
    const element = scroll.current;
    const boundary = direction === 'before' ? historyBefore.current : historyAfter.current;
    if (!element || !boundary || history.loading || history.failure) return;
    if (!(direction === 'before' ? history.hasBefore : history.hasAfter)) return;
    const viewport = element.getBoundingClientRect();
    const edge = boundary.getBoundingClientRect();
    const distance =
      direction === 'before' ? edge.top - viewport.top : viewport.bottom - edge.bottom;
    const previousDistance = distance + (direction === 'before' ? movement : -movement);
    if (Math.max(distance, previousDistance) < -200 || Math.min(distance, previousDistance) > 200)
      return;
    clearScrollIntent();
    followingLatest.current = false;
    setAtLatest(false);
    captureReadingAnchor();
    void history.load(direction);
  };
  const markUserScroll = (direction: 'before' | 'after', movement?: number) => {
    const position = scroll.current?.scrollTop ?? 0;
    const delta = position - scrollPosition.current;
    scrollPosition.current = position;
    userScrollIntent.current = history.loading ? undefined : { direction, movement };
    if (direction === 'before') {
      followingLatest.current = false;
      setAtLatest(false);
    }
    // Compositor scrolling can precede wheel delivery.
    // Pending programmatic jumps must not count as input.
    const applied =
      movement !== undefined &&
      Math.sign(delta) === Math.sign(movement) &&
      Math.abs(delta) <= Math.abs(movement)
        ? delta
        : 0;
    if (userScrollIntent.current) considerHistory(direction, applied);
  };
  const trackConversationScroll = () => {
    const element = scroll.current;
    if (!element) return;
    const delta = element.scrollTop - scrollPosition.current;
    scrollPosition.current = element.scrollTop;
    const permit = userScrollIntent.current;
    if (!permit || !delta) return;
    const direction = delta < 0 ? 'before' : 'after';
    if (
      permit !== 'drag' &&
      (permit.direction !== direction ||
        (permit.movement !== undefined && Math.abs(delta) > Math.abs(permit.movement)))
    ) {
      clearScrollIntent();
      return;
    }
    const atBottom =
      element.scrollHeight - element.clientHeight - element.scrollTop <= 64 && !history.hasAfter;
    followingLatest.current = atBottom;
    setAtLatest(atBottom);
    considerHistory(direction, delta);
  };
  const retryHistory = () => {
    clearScrollIntent();
    followingLatest.current = false;
    setAtLatest(false);
    captureReadingAnchor();
    void history.retry();
  };
  const historyStatus = (history.loading || history.failure) && (
    <div className="history-control">
      {history.failure ? (
        <button onClick={retryHistory}>{t('chat.historyRetry')}</button>
      ) : (
        <span role="status">{t('ui.loading')}</span>
      )}
    </div>
  );
  const historyAtEnd = (history.failure?.direction ?? history.loadingDirection) === 'after';
  useEffect(() => {
    const element = scroll.current;
    if (followingLatest.current && element) {
      clearScrollIntent();
      element.scrollTop = element.scrollHeight;
    }
  }, [history.entries.at(-1)?.cursor, stream]);
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
  const runs = history.runs;
  useEffect(() => {
    const live = new Set([
      ...runs.filter((run) => isRunning(run.status)).map((run) => run.id),
      ...(state?.runs.filter((run) => isRunning(run.status)).map((run) => run.id) ?? []),
    ]);
    setStream((previous) => {
      const entries = Object.entries(previous);
      return entries.every(([runId]) => live.has(runId))
        ? previous
        : Object.fromEntries(entries.filter(([runId]) => live.has(runId)));
    });
  }, [runs, state?.runs]);
  const active = runs.filter((r) => isRunning(r.status));
  const pmBusy = active.some((r) => r.role === 'pm');
  const team = useMemo(
    () => (state && project ? teamView(state, project.id) : undefined),
    [state, project?.id],
  );
  const waitingCount = team?.waiting.length ?? 0;
  const movingCount = team?.work.filter((w) => workGroup(w) === 'moving').length ?? 0;
  const currentSchedule = schedule?.projectId === project?.id ? schedule : undefined;
  useEffect(() => {
    let current = true;
    setScheduleLoading(!!project);
    if (project)
      void api<SchedulingExplanation>(`/projects/${project.id}/scheduling`)
        .then((result) => {
          if (current) {
            setSchedule(result);
            setScheduleError(undefined);
          }
        })
        .catch((error) => {
          if (current) setScheduleError({ projectId: project.id, message: String(error) });
        })
        .finally(() => {
          if (current) setScheduleLoading(false);
        });
    return () => {
      current = false;
    };
  }, [state, project?.id, scheduleRefresh]);
  async function send({ content, images, intent, deliveryMode }: PMSubmission) {
    if (!project || busy) return false;
    let submitted = false;
    await act(async () => {
      let body: unknown = { content, intent, deliveryMode };
      if (images.length) {
        const form = new FormData();
        form.append('content', content);
        form.append('intent', intent);
        form.append('deliveryMode', deliveryMode);
        for (const image of images) form.append('images', image);
        body = form;
      }
      await api(`/projects/${project.id}/messages`, body);
      submitted = true;
    });
    if (submitted) {
      followingLatest.current = true;
      setAtLatest(true);
      requestAnimationFrame(scrollToLatest);
    }
    return submitted;
  }

  const onTeam = (action: 'pause' | 'resume') =>
    project && void act(() => api(`/projects/${project.id}/team/${action}`, {}));
  const brief =
    state && project && team ? (
      <Brief
        key={project.id}
        state={state}
        project={project}
        view={team}
        busy={busy}
        act={act}
        onTeam={onTeam}
        onFeedback={(draft) => {
          if (page !== 'conversation') go({ page: 'conversation', projectId: project.id });
          composerRef.current?.setDraft(draft, 'feedback');
        }}
      />
    ) : null;
  const nav = (variant: 'sidebar' | 'bar') =>
    project ? (
      <ProjectNav
        route={route}
        projectId={project.id}
        waiting={waitingCount}
        working={team?.members.length ?? 0}
        variant={variant}
      />
    ) : null;
  return (
    <div
      className={
        `shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ` + `${drawer ? 'drawer-open' : ''}`
      }
    >
      {drawer && (
        <button
          className="drawer-scrim"
          aria-label={t('nav.closeMenu')}
          onClick={() => setDrawer(false)}
        />
      )}
      <Sidebar
        state={state}
        selectedId={project?.id}
        collapsed={sidebarCollapsed}
        connected={connected}
        onToggle={() => setSidebarCollapsed((value) => !value)}
        onSelect={(id) => go({ page: 'home', projectId: id })}
        onNewProject={() => setModal('project')}
        onSettings={() => setModal('settings')}
        projectNav={nav('sidebar')}
      />
      <main className="main">
        {project && (
          <header className="workspace-header">
            <button
              className="workspace-menu icon-button"
              aria-label={t('nav.menu')}
              aria-expanded={drawer}
              onClick={() => setDrawer(true)}
            >
              <Menu size={18} />
            </button>
            <strong>{project.name}</strong>
            <div className="workspace-status">
              {waitingCount > 0 && (
                <a
                  className="status-attention"
                  href={routeHref({ page: 'work', projectId: project.id })}
                >
                  {t('home.status.waiting', { count: waitingCount })}
                </a>
              )}
              {movingCount > 0 && (
                <a href={routeHref({ page: 'work', projectId: project.id })}>
                  {t('home.status.moving', { count: movingCount })}
                </a>
              )}
            </div>
          </header>
        )}
        {!project && (
          <header className="topbar">
            <strong>{t('app.workspace')}</strong>
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
            <h1>{t('onboarding.title')}</h1>
            <p>{t('onboarding.intro')}</p>
            <button className="primary-button" onClick={() => setModal('project')}>
              <Plus size={17} /> {t('project.create')}
            </button>
          </div>
        ) : (
          <>
            {(page === 'home' || page === 'input') && (
              <Workbench
                key={project.id}
                state={state}
                project={project}
                inputId={route.inputId}
                busy={busy}
                onTeam={onTeam}
              />
            )}
            {/* Keep drafts and reading position mounted across navigation. */}
            <div className="home-grid" hidden={page !== 'conversation'}>
              <section className="home-main" aria-label={t('nav.conversation')}>
                <h1 className="sr-only">{project.name}</h1>
                <div className="chat-workspace">
                  <div className="conversation-shell">
                    <div
                      className="conversation"
                      ref={scroll}
                      role="region"
                      aria-label={t('tabs.chat')}
                      aria-live="polite"
                      tabIndex={0}
                      onScroll={trackConversationScroll}
                      onWheel={(event) => {
                        if (!event.deltaY) return;
                        const unit =
                          event.deltaMode === 2
                            ? event.currentTarget.clientHeight
                            : event.deltaMode === 1
                              ? parseFloat(getComputedStyle(event.currentTarget).lineHeight) ||
                                parseFloat(getComputedStyle(event.currentTarget).fontSize)
                              : 1;
                        markUserScroll(event.deltaY < 0 ? 'before' : 'after', event.deltaY * unit);
                      }}
                      onTouchStart={(event) => {
                        touchPosition.current = event.touches[0]?.clientY;
                      }}
                      onTouchMove={(event) => {
                        const y = event.touches[0]?.clientY;
                        const previous = touchPosition.current;
                        touchPosition.current = y;
                        if (y !== undefined && previous !== undefined && y !== previous)
                          markUserScroll(y > previous ? 'before' : 'after', previous - y);
                      }}
                      onTouchEnd={() => {
                        touchPosition.current = undefined;
                      }}
                      onTouchCancel={() => {
                        touchPosition.current = undefined;
                        clearScrollIntent();
                      }}
                      onPointerDown={(event) => {
                        if (event.target === event.currentTarget) {
                          scrollPosition.current = event.currentTarget.scrollTop;
                          userScrollIntent.current = 'drag';
                        }
                      }}
                      onPointerMove={(event) => {
                        if (event.buttons && event.target === event.currentTarget)
                          userScrollIntent.current = history.loading ? undefined : 'drag';
                      }}
                      onPointerUp={clearScrollIntent}
                      onPointerCancel={clearScrollIntent}
                      onKeyDown={(event) => {
                        if (
                          event.defaultPrevented ||
                          (event.target instanceof Element &&
                            event.target.closest(
                              'input, textarea, select, button, a, summary, ' +
                                '[contenteditable="true"]',
                            ))
                        )
                          return;
                        if (
                          ['ArrowUp', 'Home', 'PageUp'].includes(event.key) ||
                          (event.key === ' ' && event.shiftKey)
                        )
                          markUserScroll('before');
                        else if (['ArrowDown', 'End', 'PageDown', ' '].includes(event.key))
                          markUserScroll('after');
                      }}
                    >
                      <div className="conversation-content" ref={conversationContent}>
                        <ProjectActions
                          key={`project-actions:${project.id}`}
                          onOpenTask={openTask}
                          state={state}
                          project={project}
                          reload={reload}
                        />
                        <div className="history-before" ref={historyBefore} />
                        {!historyAtEnd && historyStatus}
                        {!history.loading &&
                          !history.failure &&
                          !messages.length &&
                          !activities.length && (
                            <div className="chat-empty">
                              <h2>{t('chat.emptyTitle')}</h2>
                              <p>{t('chat.emptyDescription')}</p>
                              <div className="suggestions">
                                <button
                                  onClick={() =>
                                    composerRef.current?.setDraft(t('chat.requirementsDraft'))
                                  }
                                >
                                  {t('chat.requirements')}
                                </button>
                                <button
                                  onClick={() =>
                                    composerRef.current?.setDraft(t('chat.exploreDraft'))
                                  }
                                >
                                  {t('chat.explore')}
                                </button>
                              </div>
                            </div>
                          )}
                        <ConversationFlow
                          key={`conversation-flow:${project.id}`}
                          messages={messages}
                          activities={activities}
                          runs={runs}
                          disclosures={processDisclosures.current.items}
                          following={followingLatest}
                          positions={
                            new Map(history.entries.map((entry, index) => [entry.cursor, index]))
                          }
                          roots={repos.map((repo) => repo.path)}
                          renderMessage={(m) => (
                            <ChatMessage
                              key={`${m.role}:${m.draftId ?? m.id}`}
                              message={m}
                              activeRun={
                                m.role === 'assistant'
                                  ? active.find((run) => run.id === m.runId)
                                  : undefined
                              }
                              activities={activities}
                              streamText={m.runId ? stream[m.runId] : undefined}
                              retryDisabled={busy || pmBusy}
                              onRetry={() => void act(() => api(`/messages/${m.id}/retry`, {}))}
                            />
                          )}
                        />
                        <div className="history-after" ref={historyAfter} />
                        {historyAtEnd && historyStatus}
                        {!history.hasAfter &&
                          active
                            .filter(
                              (r) =>
                                r.role === 'pm' &&
                                !messages.some(
                                  (message) =>
                                    message.role === 'assistant' && message.runId === r.id,
                                ),
                            )
                            .slice(0, Math.max(0, 150 - messages.length))
                            .map((r) => (
                              <PendingReply
                                key={r.id}
                                run={r}
                                activities={activities}
                                streamText={stream[r.id]}
                              />
                            ))}
                      </div>
                    </div>
                    <TurnNavigator
                      key={project.id}
                      messages={messages}
                      runs={runs}
                      scroll={scroll}
                      onNavigate={() => {
                        clearScrollIntent();
                        followingLatest.current = false;
                        setAtLatest(false);
                      }}
                    />
                    {(!atLatest || history.hasAfter) && (
                      <button className="latest-message" onClick={scrollToLatest}>
                        <ChevronDown size={15} />
                        {t('chat.backToLatest')}
                      </button>
                    )}
                  </div>
                  <PMComposer
                    key={project.id}
                    ref={composerRef}
                    busy={busy}
                    pmBusy={pmBusy}
                    onSend={send}
                    modelControl={
                      <PMModelControl
                        project={project}
                        settings={state.settings}
                        agent={projectAgent}
                        profile={pmProfile}
                        onSave={reload}
                      />
                    }
                  />
                </div>
              </section>
            </div>
            {page === 'brief' && <div className="page brief-page">{brief}</div>}
            {(page === 'work' || page === 'task') && (
              <div className={page === 'task' ? 'work-inspection' : 'work-surface'}>
                <WorkList
                  state={state}
                  project={project}
                  query={workQuery}
                  setQuery={setWorkQuery}
                  selectedId={page === 'task' ? route.taskId : undefined}
                />
                {page === 'task' && route.taskId && (
                  <TaskPage
                    state={state}
                    projectId={project.id}
                    taskId={route.taskId}
                    view={route.view}
                    schedule={currentSchedule}
                    busy={busy}
                    act={act}
                    reload={reload}
                    onDraft={(draft) => {
                      go({ page: 'conversation', projectId: project.id });
                      composerRef.current?.setDraft(draft.content, draft.intent);
                    }}
                  />
                )}
              </div>
            )}
            {page === 'team' && (
              <TeamRoom
                state={state}
                projectId={project.id}
                busy={busy}
                onOpenTask={openTask}
                onTeam={onTeam}
              />
            )}
            {page === 'project' && (
              <div className="page project-page">
                <ProjectHeader project={project} onOpenModal={setModal} />
                <PageTabs
                  label={t('tabs.project')}
                  route={{ page: 'project', projectId: project.id }}
                  current={projectView}
                  tabs={[
                    { view: 'overview', label: t('project.tab.overview') },
                    {
                      view: 'docs',
                      label: t('project.tab.docs'),
                      count: state.documents.filter((d) => d.projectId === project.id).length,
                    },
                    { view: 'runs', label: t('project.tab.runs') },
                  ]}
                />
                {projectView === 'overview' && (
                  <>
                    <ProjectContext
                      project={project}
                      state={state}
                      repos={repos}
                      tasks={tasks}
                      active={active}
                      busy={busy}
                      act={act}
                      projectAgent={projectAgent}
                      pmProfile={pmProfile}
                      onOpenModal={setModal}
                      onConfigureRepo={setRepoConfig}
                      claims={
                        <ClaimOrder
                          schedule={currentSchedule}
                          projects={state.projects}
                          locale={locale}
                          refresh={() => setScheduleRefresh((n) => n + 1)}
                          error={
                            scheduleError?.projectId === project.id ? scheduleError.message : ''
                          }
                          refreshing={scheduleLoading}
                        />
                      }
                    />
                    <TeamInstructions
                      key={project.id}
                      state={state}
                      projectId={project.id}
                      refresh={reload}
                    />
                  </>
                )}
                {projectView === 'docs' && <DomainDocuments state={state} project={project} />}
                {projectView === 'runs' && <RunList state={state} runs={runs} tasks={tasks} />}
              </div>
            )}
            {nav('bar')}
          </>
        )}
      </main>
      {modal === 'project' && (
        <Modal title={t('project.create')} onClose={() => setModal(null)}>
          <ProjectForm
            busy={busy}
            submit={async (name) =>
              act(async () => {
                const p = await api<Project>('/projects', name);
                go({ page: 'home', projectId: p.id });
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
          <DeferredSettings
            showProviders={modal === 'settings'}
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
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </React.StrictMode>,
);
