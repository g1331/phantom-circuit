import { useEffect, useState, type ReactNode } from 'react';
import type {
  CostEstimate,
  Event,
  PriceSnapshot,
  Role,
  Run,
  RunStatus,
  Snapshot,
  UsageAggregate,
} from '../shared/types.ts';
import { api } from './api.ts';
import { ErrorText } from './error-text.tsx';
import { Fold } from './fold.tsx';
import { MarkdownContent } from './markdown-content.tsx';
import { useLocale } from './locale/provider.tsx';
import { TaskRuntimeBadges } from './project-actions.tsx';
import { isRunning } from './sidebar.tsx';
import { unset } from './ui.tsx';
import { useWhen } from './work-list.tsx';

const tokenFields = {
  inputTokens: 'usage.input',
  cachedInputTokens: 'usage.cached',
  cacheWriteTokens: 'usage.cacheWrite',
  outputTokens: 'usage.output',
  reasoningOutputTokens: 'usage.reasoning',
  totalTokens: 'usage.total',
} as const;
const priceFields = {
  inputPerMillion: 'prices.input',
  outputPerMillion: 'prices.output',
  cachedInputPerMillion: 'prices.cached',
  cacheWritePerMillion: 'prices.cacheWrite',
  reasoningOutputPerMillion: 'prices.reasoning',
  inputPerToken: 'prices.inputToken',
  outputPerToken: 'prices.outputToken',
  cachedInputPerToken: 'prices.cachedToken',
  cacheWritePerToken: 'prices.cacheWriteToken',
  reasoningOutputPerToken: 'prices.reasoningToken',
} as const;
const eventKeys = {
  run: 'event.run',
  command: 'event.command',
  'dev-result': 'event.dev-result',
  'pm-trigger': 'event.pm-trigger',
  task: 'event.task',
  incident: 'event.incident',
  oncall: 'event.oncall',
  blocked: 'event.blocked',
  recovery: 'event.recovery',
} as const;
const roles: Role[] = ['pm', 'dev', 'review', 'oncall'];
const statuses: RunStatus[] = [
  'queued',
  'running',
  'waiting',
  'paused',
  'interrupted',
  'failed',
  'completed',
];
const controlKeys = {
  pause: 'ui.pauseTask',
  resume: 'ui.resumeTask',
  cancel: 'ui.cancelTask',
} as const;
/** A long history opens on its newest entries. */
const page = 40;

function useShown() {
  const { t } = useLocale();
  return (value?: string) =>
    value === undefined ? t('usage.unknown') : unset(value) ? t('runtime.unconfigured') : value;
}

/** Facts as a label/value grid: the one shape every run, price and usage record shares. */
function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function costText(costs: CostEstimate[], t: ReturnType<typeof useLocale>['t']) {
  return costs.length
    ? costs.map((c) => `${c.currency} ${c.amount}`).join(' · ')
    : t('usage.unknown');
}

function PriceFacts({ price }: { price: PriceSnapshot }) {
  const { t, date } = useLocale();
  return (
    <Facts
      items={[
        [t('prices.currency'), price.currency],
        ...Object.entries(priceFields)
          .filter(([key]) => price[key as keyof typeof priceFields] !== undefined)
          .map(
            ([key, label]) =>
              [t(label), String(price[key as keyof typeof priceFields])] as [string, string],
          ),
        [t('usage.priceVersion'), price.version ?? t('usage.unknown')],
        [t('usage.priceSource'), price.source ?? t('usage.unknown')],
        [
          t('usage.captured'),
          price.capturedAt
            ? date(price.capturedAt, { dateStyle: 'short', timeStyle: 'medium' })
            : t('usage.unknown'),
        ],
      ]}
    />
  );
}

/** Everything recorded about one run, read when diagnosing it. */
function RunFacts({ run, cost }: { run: Run; cost?: CostEstimate }) {
  const { t, date, duration, number } = useLocale();
  const shown = useShown();
  const identity = run.modelIdentity ?? run.model;
  const price = run.priceSnapshot ?? run.price;
  const count = (value?: number) => (value === undefined ? t('usage.unknown') : number(value));
  return (
    <>
      <Facts
        items={[
          [t('runtime.agent'), run.agentKind ?? identity?.agentKind ?? t('usage.unknown')],
          [t('ui.model'), shown(identity?.model ?? run.profileConfig?.model)],
          [t('runtime.provider'), shown(identity?.providerId ?? run.provider?.id)],
          [t('ui.reasoningEffort'), shown(identity?.effort ?? run.profileConfig?.effort)],
          [t('usage.version'), run.agentVersion ?? identity?.agentVersion ?? t('usage.unknown')],
          [t('usage.profileVersion'), run.profileVersion ?? t('usage.unknown')],
          [t('usage.contextWindow'), count(run.usage?.contextWindow)],
          [t('process.started'), date(run.startedAt, { dateStyle: 'short', timeStyle: 'medium' })],
          [
            t('process.ended'),
            run.endedAt
              ? date(run.endedAt, { dateStyle: 'short', timeStyle: 'medium' })
              : t('delivery.running'),
          ],
          [
            t('usage.duration'),
            run.durationMs === undefined ? t('usage.unknown') : duration(run.durationMs / 1000),
          ],
          ...Object.entries(tokenFields).map(
            ([field, label]) =>
              [t(label), count(run.usage?.[field as keyof typeof tokenFields])] as [string, string],
          ),
          ...(run.usage?.estimatedUsd !== undefined
            ? [
                [
                  t('usage.actual'),
                  `USD ${number(run.usage.estimatedUsd, { maximumSignificantDigits: 15 })}`,
                ] as [string, string],
              ]
            : []),
          [
            t('usage.estimated'),
            cost
              ? `${cost.currency} ${cost.amount}${cost.partial ? ` (${t('usage.partial')})` : ''}`
              : t('usage.unknown'),
          ],
        ]}
      />
      <Fold className="fold-quiet" title={t('usage.priceSnapshot')}>
        {price ? <PriceFacts price={price} /> : <p className="muted">{t('usage.unknown')}</p>}
      </Fold>
    </>
  );
}

/** One model run as one line: when, who, which model, how it ended, how long and how much. */
export function RunRow({ state, run, cost }: { state: Snapshot; run: Run; cost?: CostEstimate }) {
  const { t, host, duration, number } = useLocale();
  const when = useWhen();
  const model = run.modelIdentity?.model ?? run.model?.model ?? run.profileConfig?.model;
  const effort = run.modelIdentity?.effort ?? run.profileConfig?.effort;
  // The official Codex login is the common case; another provider is worth naming on the line.
  const provider =
    run.agentKind === 'omp'
      ? (run.modelIdentity?.providerId ?? run.profileConfig?.providerId)
      : run.provider?.kind === 'custom'
        ? run.provider.name
        : undefined;
  const elapsed = run.endedAt
    ? (Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000
    : undefined;
  const tokens = run.usage?.totalTokens;
  return (
    <li className="run-row">
      <Fold
        className={`run-record status-${run.status}`}
        title={
          <>
            <time dateTime={run.startedAt}>{when(run.startedAt)}</time>
            <strong>{t(`team.role.${run.role}`)}</strong>
            <span className="run-model">
              {model && unset(model)
                ? t('runtime.unconfigured')
                : [provider, model ?? t('ui.modelNotRecorded'), effort].filter(Boolean).join(' · ')}
            </span>
            {/* A finished run is the normal case; only the others carry a mark. */}
            <span className={`run-outcome ${run.status}`}>
              {run.status !== 'completed' && (
                <>
                  {isRunning(run.status) && <span className="status-dot live" />}
                  {t(`ui.${run.status}`)}
                </>
              )}
            </span>
            <span className="run-num">{elapsed === undefined ? '' : duration(elapsed)}</span>
            <span className="run-num">
              {tokens === undefined
                ? ''
                : number(tokens, { notation: 'compact', maximumFractionDigits: 1 })}
            </span>
            {run.error && <em className="run-error">{host(run.error, run.errorDescriptor)}</em>}
            <span className="run-badges">
              <TaskRuntimeBadges state={state} taskId={run.taskId} runId={run.id} />
            </span>
          </>
        }
      >
        {/* The line shows the error's start; the whole text is here. */}
        {run.error && <pre className="log-block">{host(run.error, run.errorDescriptor)}</pre>}
        <RunFacts run={run} cost={cost} />
      </Fold>
    </li>
  );
}

/** Newest first; older entries wait behind one button so a long history stays one screen. */
function Paged<T>({ items, render }: { items: T[]; render: (item: T) => ReactNode }) {
  const { t } = useLocale();
  const [count, setCount] = useState(page);
  return (
    <>
      <ol className="record-list">{items.slice(0, count).map(render)}</ol>
      {items.length > count && (
        <button className="record-more" onClick={() => setCount((c) => c + page * 2)}>
          {t('process.earlier', { count: items.length - count })}
        </button>
      )}
    </>
  );
}

export function RunRows({
  state,
  runs,
  costs,
}: {
  state: Snapshot;
  runs: Run[];
  costs?: Record<string, CostEstimate | undefined>;
}) {
  const { t } = useLocale();
  if (!runs.length) return <p className="muted">{t('process.noRuns')}</p>;
  return (
    <Paged
      items={runs}
      render={(run) => <RunRow key={run.id} state={state} run={run} cost={costs?.[run.id]} />}
    />
  );
}

function firstLine(text: string) {
  const line = text.trim().split('\n')[0];
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

/** What the host recorded while the work went on; commands hide behind their own switch. */
export function EventLog({ events }: { events: Event[] }) {
  const { t, host } = useLocale();
  const when = useWhen();
  const [commands, setCommands] = useState(false);
  const commandCount = events.filter((e) => e.type === 'command').length;
  const shown = commands ? events : events.filter((e) => e.type !== 'command');
  const label = (type: string) =>
    type in eventKeys ? t(eventKeys[type as keyof typeof eventKeys]) : type;
  // Run and control events are recorded as terse codes ("dev completed", "任务 pause").
  const text = (e: Event) => {
    if (e.type === 'task' && e.control) return t(controlKeys[e.control.action]);
    const [role, status] = e.message.split(' ');
    if (e.type === 'run' && roles.includes(role as Role) && statuses.includes(status as RunStatus))
      return `${t(`team.role.${role as Role}`)} · ${t(`ui.${status as RunStatus}`)}`;
    return host(e.message, e.descriptor);
  };
  return (
    <section className="process-section" aria-label={t('process.events')}>
      <header className="section-head">
        <h2>{t('process.events')}</h2>
        {commandCount > 0 && (
          <label className="toggle-chip">
            <input
              type="checkbox"
              checked={commands}
              onChange={(e) => setCommands(e.target.checked)}
            />
            {t('process.commands', { count: commandCount })}
          </label>
        )}
      </header>
      {!shown.length ? (
        <p className="muted">{t('process.noEvents')}</p>
      ) : (
        <Paged
          items={shown}
          render={(e) => {
            const message = text(e);
            const head = (
              <>
                <time dateTime={e.at}>{when(e.at)}</time>
                <span className={`event-type type-${e.type}`}>{label(e.type)}</span>
                <span className="event-line">{firstLine(message)}</span>
              </>
            );
            const long = message.length > 160 || message.trim().includes('\n');
            return (
              <li key={e.id}>
                {long ? (
                  <Fold className="event-record" title={head}>
                    {e.type === 'dev-result' ? (
                      <MarkdownContent content={message} label={label(e.type)} copyable={false} />
                    ) : (
                      <pre className="log-block">{message}</pre>
                    )}
                  </Fold>
                ) : (
                  <div className="event-record plain">
                    <span className="fold-title">{head}</span>
                  </div>
                )}
              </li>
            );
          }}
        />
      )}
    </section>
  );
}

type TaskUsageResult = {
  usage?: UsageAggregate;
  cost?: CostEstimate;
  costs?: CostEstimate[];
  runCosts?: Record<string, CostEstimate | undefined>;
  runs?: Run[];
  coverage?: { available: number; total: number };
  durationMs?: number;
  elapsedMs?: number | null;
};

/** The task's process: what it cost, every model run, then the host's event record. */
export function TaskProcess({
  taskId,
  revision,
  state,
}: {
  taskId: string;
  revision: string;
  state: Snapshot;
}) {
  const { t, duration, number } = useLocale();
  const [result, setResult] = useState<TaskUsageResult>();
  const [error, setError] = useState<string | Error>('');
  useEffect(() => {
    let current = true;
    setError('');
    void api<TaskUsageResult>(`/tasks/${taskId}/usage`)
      .then((result) => {
        if (current) setResult(result);
      })
      .catch((error) => {
        if (current) setError(error instanceof Error ? error : String(error));
      });
    return () => {
      current = false;
    };
  }, [taskId, revision]);
  const usage = result?.usage;
  const costs = result?.costs ?? (result?.cost ? [result.cost] : []);
  const count = (value?: number) => (value === undefined ? t('usage.unknown') : number(value));
  const runs = (result?.runs ?? []).slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return (
    <div className="task-process">
      <section className="usage-panel" aria-label={t('usage.title')}>
        <h2 className="visually-hidden">{t('usage.title')}</h2>
        {error && (
          <p role="alert">
            <ErrorText error={error} />
          </p>
        )}
        <dl className="stat-strip">
          <div>
            <dt>{t('usage.duration')}</dt>
            <dd>
              {result?.durationMs === undefined
                ? t('usage.unknown')
                : duration(result.durationMs / 1000)}
            </dd>
          </div>
          <div>
            <dt>{t('usage.elapsed')}</dt>
            <dd>
              {result?.elapsedMs == null ? t('usage.unknown') : duration(result.elapsedMs / 1000)}
            </dd>
          </div>
          <div>
            <dt>{t('usage.total')}</dt>
            <dd>{count(usage?.totalTokens)}</dd>
          </div>
          <div>
            <dt>{t('usage.estimated')}</dt>
            <dd>{costText(costs, t)}</dd>
          </div>
        </dl>
        <p className="stat-note">
          {t('process.tokenDetail', {
            input: count(usage?.inputTokens),
            cached: count(usage?.cachedInputTokens),
            output: count(usage?.outputTokens),
            reasoning: count(usage?.reasoningOutputTokens),
          })}
          {usage?.estimatedUsd !== undefined && (
            <>
              {' · '}
              {t('usage.actual')} USD {number(usage.estimatedUsd, { maximumSignificantDigits: 15 })}
            </>
          )}
          {result?.coverage && <> · {t('usage.coverageCount', result.coverage)}</>}
          {costs.some((c) => c.partial) && <> · {t('usage.partial')}</>}
        </p>
      </section>
      <section className="process-section" aria-label={t('process.runs')}>
        <header className="section-head">
          <h2>{t('process.runs')}</h2>
          <span className="section-count">{number(runs.length)}</span>
        </header>
        {result && <RunRows state={state} runs={runs} costs={result.runCosts} />}
      </section>
      <EventLog events={state.events.filter((e) => e.taskId === taskId)} />
    </div>
  );
}
