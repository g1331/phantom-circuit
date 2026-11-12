import { useMemo, useState, type ReactNode } from 'react';
import { MessageSquare, Settings2 } from 'lucide-react';
import type { Project, Snapshot } from '../shared/types.ts';
import { teamView } from '../shared/team.ts';
import { api } from './api.ts';
import { useLocale } from './locale/provider.tsx';
import { routeHref } from './route.ts';
import { useWorkflow } from './use-workflow.ts';
import { WorkflowBoard, type FlowFilter } from './workbench-board.tsx';
import { InputDetail } from './workbench-detail.tsx';
import { ReceivingSettings } from './workbench-receiving.tsx';
import { WorkbenchSources } from './workbench-sources.tsx';
import { WorkbenchRecords } from './workbench-records.tsx';
import { SourcePage } from './workbench-source-page.tsx';

const filters = ['all', 'active', 'inputs', 'delivered'] as const;

export function Workbench({
  state,
  project,
  inputId,
  view = 'canvas',
  query,
  onQuery,
  detail,
}: {
  state: Snapshot;
  project: Project;
  inputId?: string;
  view?: 'canvas' | 'records' | 'sources';
  query: string;
  onQuery: (query: string) => void;
  detail?: ReactNode;
}) {
  const { t, host } = useLocale();
  const team = useMemo(() => teamView(state, project.id), [state, project.id]);
  const workflow = useWorkflow(project.id, state.events[0]?.id);
  const [filter, setFilter] = useState<FlowFilter>('all');
  const [receiving, setReceiving] = useState<string>();
  const [syncing, setSyncing] = useState<string>();
  const [actionError, setActionError] = useState('');
  const repos = state.repos.filter((repo) => repo.projectId === project.id);
  async function sync(repoId: string) {
    setSyncing(repoId);
    setActionError('');
    try {
      await api(`/repos/${repoId}/intake/refresh`, {});
      await workflow.refresh();
    } catch (cause) {
      setActionError(String(cause));
    } finally {
      setSyncing(undefined);
    }
  }
  async function saved() {
    await workflow.refresh();
    setReceiving(undefined);
  }
  const error = actionError || workflow.error?.message;
  return (
    <div
      className={`page flow-page visual-workspace view-${view} ${detail ? 'has-inspector' : ''}`}
    >
      {error && (
        <div className="error-inline" role="alert">
          {host(error)}
        </div>
      )}
      {view === 'canvas' && (
        <>
          <header className="flow-header">
            <h1 className="sr-only">{t('flow.title')}</h1>
            <div className="flow-filters" role="group" aria-label={t('flow.work')}>
              {filters.map((value) => (
                <button
                  key={value}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {t(`flow.${value}`)}
                </button>
              ))}
            </div>
            <div className="flow-header-actions">
              <a href={routeHref({ page: 'work', projectId: project.id })}>{t('brief.allWork')}</a>
              <a
                className="icon-button"
                aria-label={t('flow.openConversation')}
                href={routeHref({ page: 'conversation', projectId: project.id })}
              >
                <MessageSquare size={17} />
              </a>
              {repos.length > 0 && (
                <button
                  className="icon-button"
                  aria-label={t('flow.settings')}
                  onClick={() => setReceiving(repos[0].id)}
                >
                  <Settings2 size={17} />
                </button>
              )}
            </div>
          </header>
          {workflow.page && (
            <WorkbenchSources
              repos={repos}
              sources={workflow.page.sources}
              projectId={project.id}
              syncing={syncing}
              onConfigure={setReceiving}
              onSync={sync}
            />
          )}
          <WorkflowBoard
            projectId={project.id}
            state={state}
            team={team}
            page={workflow.page}
            filter={filter}
            query={query}
            loading={workflow.loading}
            more={workflow.more}
          />
        </>
      )}
      {view === 'records' && (
        <WorkbenchRecords
          projectId={project.id}
          state={state}
          page={workflow.page}
          query={query}
          onQuery={onQuery}
          loading={workflow.loading}
          more={workflow.more}
          refresh={workflow.refresh}
        />
      )}
      {view === 'sources' && (
        <SourcePage
          projectId={project.id}
          repos={repos}
          sources={workflow.page?.sources ?? []}
          syncing={syncing}
          onSync={sync}
          onSaved={workflow.refresh}
        />
      )}
      {detail && <section className="workbench-inspector">{detail}</section>}
      {receiving && (
        <ReceivingSettings
          repos={repos}
          sources={workflow.page?.sources ?? []}
          initialRepoId={receiving}
          onClose={() => setReceiving(undefined)}
          onSaved={saved}
        />
      )}
      {inputId && (
        <InputDetail
          key={inputId}
          inputId={inputId}
          projectId={project.id}
          backTo={view === 'records' ? 'records' : 'home'}
          onChange={workflow.refresh}
        />
      )}
    </div>
  );
}
