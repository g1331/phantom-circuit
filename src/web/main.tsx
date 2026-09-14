import { PriorityBadge, PriorityEditor, ClaimConditions, ClaimOrder } from './task-priority.tsx';
import { priorityText } from './priority-resources.ts';
import type { PriorityLocale } from '../shared/priority.ts';
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
import { api, session } from './api.ts';
import { MarkdownContent } from './markdown-content.tsx';
import { ProfileEditor } from './profile-editor.tsx';
import { ProviderSettings } from './providers.tsx';
import './style.css';

const time = (value: string) =>
  new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const profiles: Record<ProfileName, string> = {
  backend: '常规后端',
  frontend: '前端',
  fullstack: '前后端',
  complex: '复杂任务',
  pm: '项目 PM',
  review: '独立 Review',
};
const isRunning = (status: string) => status === 'running' || status === 'waiting';
function App() {
  const [priorityLocale, setPriorityLocale] = useState<PriorityLocale>(
    localStorage.getItem('phantom.priorityLocale') === 'en' ? 'en' : 'zh-CN',
  );
  const [schedule, setSchedule] = useState<SchedulingExplanation>();
  const [scheduleError, setScheduleError] = useState('');
  const [scheduleRefresh, setScheduleRefresh] = useState(0);
  const [state, setState] = useState<Snapshot>();
  const [selected, setSelected] = useState(localStorage.getItem('phantom.project') ?? '');
  const [view, setView] = useState<'chat' | 'tasks' | 'runs'>('chat');
  const [modal, setModal] = useState<'project' | 'repo' | 'settings' | 'project-settings' | null>(
    null,
  );
  const [repoConfig, setRepoConfig] = useState<Repo>();
  const [taskDetail, setTaskDetail] = useState<string>();
  const [error, setError] = useState('');
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
          timer = setTimeout(() => void reload().catch((e) => setError(String(e))), 180);
        });
        source.addEventListener('delta', (event) => {
          const d = JSON.parse((event as MessageEvent).data);
          if (d.role === 'pm') setStream((s) => ({ ...s, [d.runId]: (s[d.runId] ?? '') + d.text }));
        });
      })
      .catch((e) => setError(String(e)));
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
      setError(e instanceof Error ? e.message : String(e));
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
  useEffect(() => {
    let current = true;
    setSchedule(undefined);
    setScheduleError('');
    if (project)
      void api<SchedulingExplanation>(`/projects/${project.id}/scheduling`)
        .then((result) => {
          if (current) setSchedule(result);
        })
        .catch((error) => {
          if (current) setScheduleError(String(error));
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
        let body: unknown = { content, intent };
        if (images.length) {
          const form = new FormData();
          form.append('content', content);
          form.append('intent', intent ?? 'discuss');
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
        <a className="brand" href="/" aria-label="Phantom Circuit 首页">
          <span className="brand-mark">
            <Layers3 size={23} />
          </span>
          <span>
            PHANTOM<span className="brand-sub">CIRCUIT</span>
          </span>
        </a>
        <div className="workspace-label">
          本地工作空间 <span className="local-dot" />
        </div>
        <div className="sidebar-heading">
          <span>项目</span>
          <button className="icon-button" aria-label="新建项目" onClick={() => setModal('project')}>
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
            添加你的第一个项目
            <br />让 PM 接手工程工作。
          </p>
        )}
        <div className="sidebar-bottom">
          <button
            className="sidebar-action"
            aria-label="运行设置"
            onClick={() => setModal('settings')}
          >
            <Settings2 size={17} />
            <span>运行设置</span>
          </button>
          <button
            className="sidebar-action"
            aria-label={theme === 'dark' ? '浅色外观' : '深色外观'}
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            <span>{theme === 'dark' ? '浅色外观' : '深色外观'}</span>
          </button>
          <div className="connection">
            <span className={`status-dot ${connected ? 'live' : ''}`} />
            <span>{connected ? '本地服务已连接' : '正在连接本地服务'}</span>
            <span className="version">v0.1</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            工作空间 <span>/</span>
            <strong>{project?.name ?? '开始使用'}</strong>
          </div>
          <div className="topbar-actions">
            <span className="local-badge">
              <ShieldCheck size={13} /> 本机运行
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
            <span>{error}</span>
            <button className="icon-button" aria-label="关闭错误" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {!state ? (
          <div className="loading">
            <span className="spinner" />
            正在连接工作空间…
          </div>
        ) : !project ? (
          <div className="onboarding">
            <div className="eyebrow">
              <Radio size={16} /> PHANTOM CIRCUIT
            </div>
            <h1>从一个项目开始。</h1>
            <p>
              告诉 PM 你想做什么。
              <br />
              准备好后开启仓库，让开发、评审和交付持续运行。
            </p>
            <button className="primary-button" onClick={() => setModal('project')}>
              <Plus size={17} /> 创建项目
            </button>
            <div className="onboarding-flow">
              <div>
                <span>01</span>
                <strong>讨论需求</strong>
                <small>与项目 PM 对齐目标</small>
              </div>
              <div>
                <span>02</span>
                <strong>打开开工开关</strong>
                <small>按你的节奏并行开发</small>
              </div>
              <div>
                <span>03</span>
                <strong>体验并反馈</strong>
                <small>AI 负责工程交付闭环</small>
              </div>
            </div>
          </div>
        ) : (
          <>
            <section className="project-header">
              <div>
                <div className="eyebrow">PROJECT WORKSPACE</div>
                <h1>{project.name}</h1>
                <p>{project.description || '讨论需求，开启开发，体验结果。'}</p>
              </div>
              <button className="secondary-button" onClick={() => setModal('project-settings')}>
                项目模型设置
              </button>
              <button className="secondary-button" onClick={() => setModal('repo')}>
                <Plus size={16} /> 接入仓库
              </button>
            </section>
            <section className="metrics" aria-label="项目运行概况">
              <Metric
                value={active.filter((r) => r.role === 'dev').length}
                label="正在开发"
                suffix={`/ ${project.devLimit}`}
                live
              />
              <Metric value={active.filter((r) => r.role === 'review').length} label="独立评审" />
              <Metric value={tasks.filter((t) => t.stage === 'ready').length} label="等待认领" />
              <Metric value={tasks.filter((t) => t.stage === 'done').length} label="工程完成" />
            </section>
            <div className="workspace-grid">
              <section className="primary-workspace">
                <div className="tabs" role="tablist" aria-label="项目视图">
                  {(
                    [
                      { key: 'chat', label: '与 PM 讨论', icon: MessageSquare },
                      { key: 'tasks', label: '任务', icon: Layers3 },
                      { key: 'runs', label: '运行记录', icon: Activity },
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
                      {t.key === 'tasks' && <span className="tab-count">{tasks.length}</span>}
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
                          <h2>我们先聊聊你的想法。</h2>
                          <p>
                            描述要解决的问题，或者你希望获得的体验。
                            <br />
                            仓库不开工时，我们可以专心讨论。
                          </p>
                          <div className="suggestions">
                            <button
                              onClick={() => setDraft('我想先和你梳理这个项目的需求和使用场景。')}
                            >
                              梳理项目需求 <ArrowUpRight size={13} />
                            </button>
                            <button
                              onClick={() => setDraft('请先了解已接入的仓库，告诉我现在能做什么。')}
                            >
                              了解现有项目 <ArrowUpRight size={13} />
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
                                '你'
                              ) : (
                                '!'
                              )}
                            </span>
                            <strong>
                              {m.role === 'assistant'
                                ? '项目 PM'
                                : m.role === 'user'
                                  ? '你'
                                  : '运行提示'}
                            </strong>
                            {m.intent && (
                              <span className="message-intent">
                                {
                                  { discuss: '讨论', implement: '实施需求', feedback: '体验反馈' }[
                                    m.intent
                                  ]
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
                              重新发送
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
                              <strong>项目 PM</strong>
                              <span className="thinking">
                                处理中<span>…</span>
                              </span>
                            </div>
                            {stream[r.id] ? (
                              <div className="message-content">
                                <MarkdownContent content={stream[r.id]} />
                              </div>
                            ) : (
                              <div className="message-content">正在阅读上下文并整理回应…</div>
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
                              { discuss: '聊一聊', implement: '交给 PM 做', feedback: '体验反馈' }[
                                i
                              ]
                            }
                          </button>
                        ))}
                      </div>
                      <div className="image-picker">
                        <label>
                          添加图片
                          <input
                            aria-label="选择图片"
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            multiple
                            disabled={busy}
                            onChange={(event) => {
                              const files = Array.from(event.target.files ?? []);
                              event.target.value = '';
                              if (images.length + files.length > 4) {
                                setError('每条消息最多 4 张图片');
                                return;
                              }
                              if (
                                files.some(
                                  (file) =>
                                    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type),
                                )
                              ) {
                                setError('仅支持 PNG、JPEG、WebP 图片');
                                return;
                              }
                              if (files.some((file) => file.size > 10 * 1024 * 1024)) {
                                setError('每张图片不能超过 10 MiB');
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
                        <small>PNG / JPEG / WebP · 最多 4 张 · 每张 10 MiB</small>
                      </div>
                      {!!images.length && (
                        <div className="image-drafts">
                          {images.map((image) => (
                            <div key={image.url} className="image-draft">
                              <img src={image.url} alt={`待发送：${image.file.name}`} />
                              <span>
                                {image.file.name}
                                <small>{Math.max(1, Math.ceil(image.file.size / 1024))} KiB</small>
                              </span>
                              <button
                                aria-label={`移除 ${image.file.name}`}
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
                        aria-label="给 PM 的消息"
                        disabled={busy}
                        placeholder={
                          intent === 'discuss'
                            ? '有什么想法？先聊清楚，再决定开工。'
                            : intent === 'implement'
                              ? '描述你明确希望完成的需求…'
                              : '告诉 PM 你的使用感受，哪里需要改进…'
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
                          {intent === 'discuss'
                            ? '讨论不会自动派发开发任务'
                            : 'PM 会整理任务；仓库开工后自动认领'}
                          <small>Ctrl ↵ 发送</small>
                        </span>
                        <button
                          className="send-button"
                          disabled={(!draft.trim() && !images.length) || busy}
                          onClick={() => void send()}
                          aria-label="发送消息"
                        >
                          <Send size={17} />
                        </button>
                      </div>
                    </div>
                  </div>
                ) : view === 'tasks' ? (
                  <div className="task-workspace">
                    <label className="priority-language">
                      {priorityText[priorityLocale].language}
                      <select
                        value={priorityLocale}
                        onChange={(e) => {
                          const locale = e.target.value as PriorityLocale;
                          setPriorityLocale(locale);
                          localStorage.setItem('phantom.priorityLocale', locale);
                        }}
                      >
                        <option value="zh-CN">中文</option>
                        <option value="en">English</option>
                      </select>
                    </label>
                    <ClaimOrder
                      schedule={schedule}
                      projects={state?.projects ?? []}
                      locale={priorityLocale}
                      refresh={() => setScheduleRefresh((n) => n + 1)}
                      error={scheduleError}
                    />
                    <div className="list-toolbar">
                      <input
                        aria-label="搜索任务"
                        placeholder="搜索任务…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                      <select
                        aria-label="任务状态筛选"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      >
                        <option value="all">全部状态</option>
                        <option value="active">未完成</option>
                        <option value="ready">待认领</option>
                        <option value="done">工程完成</option>
                      </select>
                    </div>
                    {shown.length ? (
                      <div className="task-list">
                        {shown.map((t) => (
                          <button
                            className="task-row"
                            key={t.id}
                            onClick={() => setTaskDetail(t.id)}
                          >
                            <span className={`task-icon ${t.stage}`}>
                              {t.stage === 'done' ? (
                                <Check size={17} />
                              ) : t.blocked ? (
                                <Pause size={17} />
                              ) : (
                                <Circle size={16} />
                              )}
                            </span>
                            <div className="task-row-main">
                              <strong>{t.title}</strong>
                              <PriorityBadge value={t.priority} locale={priorityLocale} />
                              <span>
                                {repos.find((r) => r.id === t.repoId)?.name} <i>·</i>{' '}
                                {profiles[t.profile]} {t.blocked && <em>· {t.blocked}</em>}
                              </span>
                            </div>
                            <span className={`stage ${t.stage}`}>
                              {t.control === 'paused' ? '已暂停' : stageLabels[t.stage]}
                            </span>
                            <ArrowUpRight size={14} />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <Empty
                        icon={<Layers3 size={26} />}
                        title="还没有匹配的任务"
                        text="向 PM 提出明确需求，任务和依赖会在这里出现。"
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
                                  {r.provider?.name ?? 'Codex 官方登录'} (
                                  {r.profileConfig?.providerId ?? 'codex'}) ·{' '}
                                  {r.profileConfig?.model ?? '历史记录未保存模型'} /{' '}
                                  {r.profileConfig?.effort ?? '未知档位'}
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
                        title="运行记录将保留在这里"
                        text="PM、Dev 和 Review 的每次执行都可以追踪。"
                      />
                    )}
                  </div>
                )}
              </section>
              <aside className="context-panel">
                <div className="panel-heading">
                  <h2>仓库控制</h2>
                  <span>{repos.length} 个仓库</span>
                </div>
                {!repos.length ? (
                  <div className="repo-empty">
                    <FolderGit2 size={25} />
                    <p>
                      接入 GitHub 仓库后，
                      <br />
                      就可以控制开发节奏。
                    </p>
                    <button className="text-button" onClick={() => setModal('repo')}>
                      接入第一个仓库 <Plus size={14} />
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
                  <h2>最近动态</h2>
                  <button
                    className="icon-button"
                    title="同步 GitHub"
                    aria-label="同步 GitHub"
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
                    <p className="muted">项目动态会显示在这里。</p>
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
          title="创建项目"
          subtitle="一个项目，一个负责交付的 PM。"
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
          title="接入仓库"
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
      {(modal === 'settings' || modal === 'project-settings') && state && (
        <Modal
          title={modal === 'settings' ? '运行设置' : '项目模型设置'}
          subtitle={
            modal === 'settings'
              ? '全局模型分配仅作为新 Project 默认值，已有 Project 保持独立。'
              : '修改影响后续 Run，进行中与历史 Run 保留固定分配。'
          }
          wide
          onClose={() => setModal(null)}
        >
          {modal === 'settings' && <ProviderSettings />}
          <SettingsForm
            key={`${modal}-${project?.id}`}
            initial={
              modal === 'project-settings' && project
                ? { ...state.settings, profiles: project.profiles }
                : state.settings
            }
            providers={state.providers}
            projectOnly={modal === 'project-settings'}
            busy={busy}
            submit={async (settings) => {
              const result = await api<{ warnings: string[] }>(
                modal === 'project-settings' ? `/projects/${project!.id}/profiles` : '/settings',
                modal === 'project-settings' ? settings.profiles : settings,
                'PATCH',
              );
              await reload();
              if (!result.warnings.length) setModal(null);
              return result;
            }}
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
            <PriorityEditor key={detail.id} task={detail} locale={priorityLocale} reload={reload} />
            <ClaimConditions
              entry={schedule?.tasks.find((t) => t.taskId === detail.id)}
              locale={priorityLocale}
            />
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
  return (
    <div className="metric">
      <div className="metric-value">
        {value}
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
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    const dialog = ref.current;
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
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
          </div>
          <button className="icon-button" aria-label="关闭窗口" onClick={onClose}>
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
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void submit({ name: String(f.get('name')), description: String(f.get('description')) });
      }}
    >
      <label>
        项目名称
        <input name="name" placeholder="例如：我的产品" required maxLength={100} autoFocus />
      </label>
      <label>
        项目目标
        <textarea name="description" placeholder="这个项目希望解决什么问题？" maxLength={3000} />
      </label>
      <button className="primary-button" disabled={busy}>
        创建项目 <ArrowUpRight size={16} />
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
        {busy ? '正在核对仓库…' : '接入仓库'} <ArrowUpRight size={16} />
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
        保存配置
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
}: {
  providers: Snapshot['providers'];
  projectOnly: boolean;
  initial: Settings;
  submit: (s: Settings) => Promise<{ warnings: string[] }>;
  busy: boolean;
}) {
  const [settings, setSettings] = useState(structuredClone(initial));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState<string>();
  const [health, setHealth] = useState<any>();
  const [checking, setChecking] = useState(false);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        setSaveError('');
        setSaved(undefined);
        void submit(settings)
          .then((result) => setSaved('已保存。' + result.warnings.join('；')))
          .catch((error) => setSaveError(String(error)))
          .finally(() => setSaving(false));
      }}
    >
      {!projectOnly && (
        <div className="form-columns">
          <label>
            全局 Dev 上限
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
            Review 会话上限
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
      <h3>{projectOnly ? 'Project model profile' : '新 Project 默认模型分配'}</h3>
      <fieldset className="assignment-form" disabled={saving || busy}>
        <ProfileEditor
          profiles={settings.profiles}
          providers={providers}
          change={(profiles) => setSettings({ ...settings, profiles })}
        />
      </fieldset>
      {saveError && <p role="alert">{saveError}</p>}
      {saved && <p role="status">{saved}</p>}
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
          {checking ? '正在检查…' : '检查 Codex 与 GitHub'}
        </button>
        {health && (
          <div className="health-result">
            {health.error ?? (
              <>
                <p>{health.codex.ok ? '✓ Codex 已连接' : '! ' + health.codex.error}</p>
                <p>
                  {health.github.ok
                    ? `✓ GitHub · ${health.github.login}`
                    : '! ' + health.github.error}
                </p>
                {health.codex.models && (
                  <details>
                    <summary>可用模型</summary>
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
        {saving ? '正在校验…' : '保存设置'}
      </button>
    </form>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
