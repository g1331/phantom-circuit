import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Github, MessageSquare, Search, Terminal, X } from 'lucide-react';
import type { Snapshot } from '../shared/types.ts';
import type { WorkflowPage } from '../shared/intake.ts';
import { useLocale } from './locale/provider.tsx';
import { useWhen } from './work-list.tsx';
import { routeHref } from './route.ts';
import { inputTone, workRecords, type RecordKind, type WorkRecord } from './workbench-model.ts';
import { useInputDetail } from './use-input-detail.ts';
import { MarkdownContent } from './markdown-content.tsx';

export function WorkbenchRecords({
  projectId,
  state,
  page,
  query,
  onQuery,
  loading,
  more,
  refresh,
}: {
  projectId: string;
  state: Snapshot;
  page?: WorkflowPage;
  query: string;
  onQuery: (query: string) => void;
  loading: boolean;
  more: () => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const copy = useLocale();
  const { t } = copy;
  const when = useWhen();
  const list = useRef<HTMLElement>(null);
  const [kind, setKind] = useState<Exclude<RecordKind, 'trace'> | 'all'>('all');
  const [selected, setSelected] = useState<WorkRecord>();
  const [count, setCount] = useState(100);
  const rows = workRecords(state, projectId, copy, page);
  const needle = query.trim().toLocaleLowerCase();
  const matches = rows
    .filter(
      (row) =>
        (kind === 'all'
          ? row.kind !== 'trace'
          : kind === 'action'
            ? ['action', 'trace'].includes(row.kind)
            : row.kind === kind) &&
        `${row.title} ${row.result} ${row.source}`.toLocaleLowerCase().includes(needle),
    )
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  const current = selected ? (rows.find((row) => row.id === selected.id) ?? selected) : undefined;
  function closeRecord() {
    const row = list.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    setSelected(undefined);
    requestAnimationFrame(() => row?.focus({ preventScroll: true }));
  }
  return (
    <div className={`record-workspace ${current ? 'record-selected' : ''}`}>
      <section className="record-list" ref={list}>
        <header className="record-header">
          <h1>{t('flow.records')}</h1>
          <div className="flow-filters" role="group" aria-label={t('flow.recordKind')}>
            {(['all', 'input', 'judgment', 'action', 'reply'] as const).map((value) => (
              <button key={value} aria-pressed={kind === value} onClick={() => setKind(value)}>
                {value === 'all'
                  ? t('flow.all')
                  : t(
                      `flow.record${
                        value === 'input'
                          ? 'Input'
                          : value === 'judgment'
                            ? 'Judgment'
                            : value === 'action'
                              ? 'Action'
                              : 'Reply'
                      }`,
                    )}
              </button>
            ))}
          </div>
        </header>
        <label className="record-search console-search">
          <Search size={17} />
          <input
            type="search"
            value={query}
            aria-label={t('flow.recordSearch')}
            placeholder={t('flow.recordSearch')}
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
        <div className="record-table" role="table" aria-label={t('flow.records')}>
          <div className="record-table-head" role="row">
            <span role="columnheader">{t('flow.recordTime')}</span>
            <span role="columnheader">{t('flow.source')}</span>
            <span role="columnheader">{t('flow.recordContent')}</span>
            <span role="columnheader">{t('flow.recordResult')}</span>
          </div>
          {matches.slice(0, count).map((row) => {
            const Icon =
              row.source === 'GitHub'
                ? Github
                : ['action', 'trace'].includes(row.kind)
                  ? Terminal
                  : MessageSquare;
            return (
              <button
                className="record-row"
                key={row.id}
                role="row"
                aria-selected={row.id === selected?.id}
                onClick={() => setSelected(row)}
              >
                <time role="cell" dateTime={row.at} title={row.at}>
                  {when(row.at)}
                </time>
                <span role="cell" className="record-source">
                  <Icon size={16} />
                  {row.source}
                </span>
                <span role="cell" className="record-title">
                  {row.title}
                </span>
                <span
                  role="cell"
                  className={row.result ? `record-result tone-${row.tone}` : undefined}
                >
                  {row.result}
                </span>
              </button>
            );
          })}
          {!matches.length && (
            <div className="flow-empty">
              {t(rows.length ? 'flow.emptyRecordsFilter' : 'flow.noRecords')}
            </div>
          )}
        </div>
        {(matches.length > count || page?.next) && (
          <button
            className="secondary-button"
            disabled={loading}
            onClick={() => {
              if (matches.length > count) setCount((value) => value + 100);
              else void more();
            }}
          >
            {t('flow.more')}
          </button>
        )}
      </section>
      {current && (
        <RecordDetail key={current.id} record={current} refresh={refresh} onClose={closeRecord} />
      )}
    </div>
  );
}

function RecordDetail({
  record,
  onClose,
  refresh,
}: {
  record: WorkRecord;
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  return 'inputId' in record ? (
    <SourceRecordDetail record={record} onClose={onClose} refresh={refresh} />
  ) : (
    <RecordPanel record={record} onClose={onClose}>
      <pre>{record.body}</pre>
    </RecordPanel>
  );
}

function RecordPanel({
  record,
  onClose,
  children,
}: {
  record: WorkRecord;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useLocale();
  const when = useWhen();
  const surface = useRef<HTMLElement>(null);
  useLayoutEffect(() => surface.current?.focus({ preventScroll: true }), []);
  return (
    <aside
      className="record-detail"
      ref={surface}
      tabIndex={-1}
      aria-label={record.title}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <header>
        <h2>{record.title}</h2>
        <button className="icon-button" aria-label={t('common.close')} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      {record.result && <div className={`record-result tone-${record.tone}`}>{record.result}</div>}
      <dl>
        <div>
          <dt>{t('flow.source')}</dt>
          <dd>{record.source}</dd>
        </div>
        <div>
          <dt>{t('flow.recordTime')}</dt>
          <dd>{when(record.at)}</dd>
        </div>
      </dl>
      <section>
        <h3>{t('flow.recordContent')}</h3>
        {children}
      </section>
      <div className="record-detail-links">
        {record.href && (
          <a className="secondary-button" href={record.href}>
            {t('flow.details')}
          </a>
        )}
        {record.original && (
          <a href={record.original} target="_blank" rel="noreferrer">
            {t('flow.sourceOpen')} <ArrowUpRight size={14} />
          </a>
        )}
      </div>
    </aside>
  );
}

function SourceRecordDetail({
  record,
  onClose,
  refresh,
}: {
  record: Extract<WorkRecord, { inputId: string }>;
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  const { t, host } = useLocale();
  const { detail, error } = useInputDetail(record.inputId, refresh);
  let current: WorkRecord = record;
  let content: ReactNode = error ? null : <div role="status">{t('connection.loading')}</div>;
  if (detail?.input.id === record.inputId) {
    if (record.kind === 'input') content = <MarkdownContent content={detail.input.body} />;
    else if (record.kind === 'reply') {
      const reply = detail.replies.find((item) => item.id === record.replyId);
      if (reply) {
        current = {
          ...record,
          result: t(`flow.reply.${reply.state.status}`),
          tone:
            reply.state.status === 'sent'
              ? 'success'
              : reply.state.status === 'queued'
                ? 'neutral'
                : 'warning',
          at: reply.state.status === 'sent' ? reply.state.sentAt : reply.createdAt,
          original: reply.state.status === 'sent' ? reply.state.url : detail.input.url,
        };
        content = (
          <>
            {'reason' in reply.state && (
              <div className="error-inline" role="alert">
                {host(reply.state.reason)}
              </div>
            )}
            <MarkdownContent content={reply.body} />
          </>
        );
      } else
        content = (
          <div className="error-inline" role="alert">
            {t('flow.historyMissing')}
          </div>
        );
    } else {
      const { disposition } = detail.assessment;
      current = {
        ...record,
        at: detail.assessment.updatedAt,
        result: t(`flow.${disposition.status}`),
        tone: inputTone(detail),
      };
      content = (
        <MarkdownContent
          content={
            'reason' in disposition ? host(disposition.reason) : t(`flow.${disposition.status}`)
          }
        />
      );
    }
  }
  return (
    <RecordPanel record={current} onClose={onClose}>
      {error && (
        <div className="error-inline" role="alert">
          {host(error)}
        </div>
      )}
      {content}
    </RecordPanel>
  );
}
