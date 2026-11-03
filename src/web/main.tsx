import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowUpRight,
  ChevronDown,
  Layers3,
  MessageSquare,
  Plus,
  Radio,
  Settings2,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import type { Project, Repo, SchedulingExplanation, Snapshot } from '../shared/types.ts';
import { api, session, LocalRequestError, LocalUiError, HostRequestError } from './api.ts';
import { ErrorText } from './error-text.tsx';
import { PMComposer, type PMComposerHandle, type PMSubmission } from './pm-composer.tsx';
import { PMModelControl } from './pm-model-control.tsx';
import { DeferredSettings, DeferredTaskDetail } from './deferred-panels.tsx';
import { ProjectActions } from './project-actions.tsx';
import { ConversationFlow, TurnNavigator, useReadingAnchor } from './conversation.tsx';
import { LocaleProvider, useLocale } from './locale/provider.tsx';
import { Sidebar, isRunning } from './sidebar.tsx';
import { ChatMessage, PendingReply } from './chat-message.tsx';
import { TaskWorkspace, type TaskFilters } from './task-workspace.tsx';
import { RunList } from './run-list.tsx';
import { ProjectContext } from './project-context.tsx';
import { Modal } from './ui.tsx';
import { CommandsForm, ProjectForm, RepoForm } from './forms.tsx';
import { TeamRoom } from './team-room.tsx';
import './style.css';
import './team-room.css';

function App() {
  const { t, number } = useLocale();
  const [schedule, setSchedule] = useState<SchedulingExplanation>();
  const [scheduleError, setScheduleError] = useState<{ projectId: string; message: string }>();
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleRefresh, setScheduleRefresh] = useState(0);
  const [state, setState] = useState<Snapshot>();
  const [selected, setSelected] = useState(localStorage.getItem('phantom.project') ?? '');
  const [view, setView] = useState<'chat' | 'team' | 'tasks' | 'runs'>('chat');
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    localStorage.getItem('phantom.sidebar') === 'collapsed',
  );
  const composerRef = useRef<PMComposerHandle>(null);
  useEffect(() => {
    localStorage.setItem('phantom.sidebar', sidebarCollapsed ? 'collapsed' : 'expanded');
  }, [sidebarCollapsed]);
  const [stream, setStream] = useState<Record<string, string>>({});
  const [taskFilters, setTaskFilters] = useState<TaskFilters>(() => ({
    stage: 'all',
    control: 'all',
    query: '',
    view: localStorage.getItem('phantom.taskView') === 'list' ? 'list' : 'board',
  }));
  const scroll = useRef<HTMLDivElement>(null);
  const conversationContent = useRef<HTMLDivElement>(null);
  const processDisclosures = useRef({ projectId: '', items: new Map<string, boolean>() });
  const followingLatest = useRef(true);
  const [atLatest, setAtLatest] = useState(true);
  const userScrollIntent = useRef(false);
  const userScrollTimer = useRef<number | undefined>(undefined);
  const markUserScroll = useCallback(() => {
    userScrollIntent.current = true;
    if (userScrollTimer.current !== undefined) window.clearTimeout(userScrollTimer.current);
    userScrollTimer.current = window.setTimeout(() => {
      userScrollIntent.current = false;
      userScrollTimer.current = undefined;
    }, 250);
  }, []);
  const scrollToLatest = useCallback(() => {
    const element = scroll.current;
    if (!element) return;
    followingLatest.current = true;
    setAtLatest(true);
    element.scrollTop = element.scrollHeight;
  }, []);
  const trackConversationScroll = useCallback(() => {
    const element = scroll.current;
    if (!element || !userScrollIntent.current) return;
    const atBottom = element.scrollHeight - element.clientHeight - element.scrollTop <= 64;
    followingLatest.current = atBottom;
    setAtLatest(atBottom);
  }, []);
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
    localStorage.setItem('phantom.project', selected);
    setTaskDetail(undefined);
    setContextOpen(false);
  }, [selected]);
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
  if (processDisclosures.current.projectId !== (project?.id ?? '')) {
    processDisclosures.current = { projectId: project?.id ?? '', items: new Map() };
  }
  useReadingAnchor(scroll, conversationContent, followingLatest, `${project?.id}:${view}`);
  useEffect(() => {
    if (view !== 'chat') return;
    const element = scroll.current;
    if (!element) return;
    followingLatest.current = true;
    setAtLatest(true);
    const frame = requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
    const observer = new ResizeObserver(() => {
      if (followingLatest.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    if (conversationContent.current) observer.observe(conversationContent.current);
    return () => {
      if (userScrollTimer.current !== undefined) window.clearTimeout(userScrollTimer.current);
      userScrollTimer.current = undefined;
      userScrollIntent.current = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [project?.id, view]);
  useEffect(() => {
    const element = scroll.current;
    if (followingLatest.current && element) element.scrollTop = element.scrollHeight;
  }, [state?.messages.length, stream]);
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
  const pmBusy = active.some((r) => r.role === 'pm');
  const detail = state?.tasks.find((t) => t.id === taskDetail);
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

  const teamRoom = (layout: 'aside' | 'full') =>
    state && project ? (
      <TeamRoom
        state={state}
        projectId={project.id}
        busy={busy}
        layout={layout}
        onOpenTask={setTaskDetail}
        onTeam={(action) => void act(() => api(`/projects/${project.id}/team/${action}`, {}))}
        {...(layout === 'aside' ? { onExpand: () => setView('team') } : {})}
      />
    ) : null;
  return (
    <div className={`shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar
        state={state}
        selectedId={project?.id}
        collapsed={sidebarCollapsed}
        connected={connected}
        onToggle={() => setSidebarCollapsed((value) => !value)}
        onSelect={setSelected}
        onNewProject={() => setModal('project')}
        onSettings={() => setModal('settings')}
      />
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
              </div>
              <div>
                <span>02</span>
                <strong>{t('onboarding.switch')}</strong>
              </div>
              <div>
                <span>03</span>
                <strong>{t('onboarding.feedback')}</strong>
              </div>
            </div>
          </div>
        ) : (
          <>
            <section className="project-header">
              <div className="project-title">
                <h1>{project.name}</h1>
              </div>
              <div className="tabs" role="tablist" aria-label={t('project.views')}>
                {(
                  [
                    { key: 'chat', label: t('tabs.chat'), icon: MessageSquare },
                    { key: 'team', label: t('tabs.team'), icon: Users },
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
                    {t.key === 'tasks' && <span className="tab-count">{number(tasks.length)}</span>}
                  </button>
                ))}
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
            <div className={`workspace-grid ${view === 'chat' ? 'with-team' : ''}`}>
              <section className="primary-workspace">
                <div
                  className="chat-workspace"
                  style={{ display: view === 'chat' ? undefined : 'none' }}
                >
                  <div className="conversation-shell">
                    <div
                      className="conversation"
                      ref={scroll}
                      role="region"
                      aria-label={t('tabs.chat')}
                      aria-live="polite"
                      tabIndex={0}
                      onScroll={trackConversationScroll}
                      onWheel={markUserScroll}
                      onTouchMove={markUserScroll}
                      onPointerDown={(event) => {
                        if (event.target === event.currentTarget) markUserScroll();
                      }}
                      onPointerMove={(event) => {
                        if (event.buttons && event.target === event.currentTarget) markUserScroll();
                      }}
                      onKeyDown={(event) => {
                        if (
                          ['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp'].includes(
                            event.key,
                          )
                        )
                          markUserScroll();
                      }}
                    >
                      <div className="conversation-content" ref={conversationContent}>
                        <ProjectActions
                          key={`project-actions:${project.id}`}
                          onOpenTask={setTaskDetail}
                          state={state}
                          project={project}
                          reload={reload}
                        />
                        {!messages.length && !activities.length && (
                          <div className="chat-empty">
                            <div className="pm-avatar">
                              <Layers3 size={22} />
                            </div>
                            <h2>{t('chat.emptyTitle')}</h2>
                            <p>{t('chat.emptyDescription')}</p>
                            <div className="suggestions">
                              <button
                                onClick={() =>
                                  composerRef.current?.setDraft(t('chat.requirementsDraft'))
                                }
                              >
                                {t('chat.requirements')} <ArrowUpRight size={13} />
                              </button>
                              <button
                                onClick={() =>
                                  composerRef.current?.setDraft(t('chat.exploreDraft'))
                                }
                              >
                                {t('chat.explore')} <ArrowUpRight size={13} />
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
                        {active
                          .filter(
                            (r) =>
                              r.role === 'pm' &&
                              !messages.some(
                                (message) => message.role === 'assistant' && message.runId === r.id,
                              ),
                          )
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
                        followingLatest.current = false;
                        setAtLatest(false);
                      }}
                    />
                    {!atLatest && (
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
                {view === 'tasks' ? (
                  <TaskWorkspace
                    state={state}
                    tasks={tasks}
                    repos={repos}
                    filters={taskFilters}
                    setFilters={setTaskFilters}
                    schedule={currentSchedule}
                    scheduleError={
                      scheduleError?.projectId === project.id ? scheduleError.message : ''
                    }
                    scheduleLoading={scheduleLoading}
                    onRefreshSchedule={() => setScheduleRefresh((n) => n + 1)}
                    onOpen={setTaskDetail}
                  />
                ) : view === 'runs' ? (
                  <RunList state={state} runs={runs} tasks={tasks} />
                ) : view === 'team' ? (
                  teamRoom('full')
                ) : null}
              </section>
              {view === 'chat' && teamRoom('aside')}
              <dialog
                id="project-context"
                className="context-panel"
                ref={contextRef}
                onClose={() => setContextOpen(false)}
                aria-label={t('project.overview')}
              >
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
                  onClose={() => setContextOpen(false)}
                  onOpenModal={(kind) => {
                    setContextOpen(false);
                    setModal(kind);
                  }}
                  onConfigureRepo={setRepoConfig}
                />
              </dialog>
            </div>
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
      {detail && (
        <Modal
          title={detail.title}
          subtitle={`${t(`stage.${detail.stage}`)} · ${detail.routingReason}`}
          wide
          onClose={() => setTaskDetail(undefined)}
        >
          <DeferredTaskDetail
            key={detail.id}
            task={detail}
            state={state!}
            schedule={currentSchedule}
            busy={busy}
            act={act}
            reload={reload}
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
