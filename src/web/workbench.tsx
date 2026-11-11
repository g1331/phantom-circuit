import { useMemo, useState } from 'react';
import { Pause, Play, Settings2 } from 'lucide-react';
import type { Project, Snapshot } from '../shared/types.ts';
import { teamView } from '../shared/team.ts';
import { api } from './api.ts';
import { useLocale } from './locale/provider.tsx';
import { routeHref } from './route.ts';
import { useWorkflow } from './use-workflow.ts';
import { WorkflowBoard, type FlowFilter } from './workbench-board.tsx';
import { WorkbenchAttention } from './workbench-attention.tsx';
import { InputDetail } from './workbench-detail.tsx';
import { ReceivingSettings } from './workbench-receiving.tsx';
import { WorkbenchSources } from './workbench-sources.tsx';

const filters = ['all', 'active', 'inputs', 'delivered'] as const;

export function Workbench({
  state,
  project,
  inputId,
  busy,
  onTeam,
}: {
  state: Snapshot;
  project: Project;
  inputId?: string;
  busy: boolean;
  onTeam: (action: 'pause' | 'resume') => void;
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
    <div className="page flow-page">
      <header className="flow-header">
        <h1>{t('flow.title')}</h1>
        {workflow.page?.admissionPaused && <span className="flow-paused">{t('flow.paused')}</span>}
        <div className="flow-header-actions">
          <a
            className="primary-button"
            href={routeHref({ page: 'conversation', projectId: project.id })}
          >
            {t('flow.new')}
          </a>
          <button
            className="secondary-button"
            disabled={busy || !workflow.page}
            onClick={() => onTeam(workflow.page?.admissionPaused ? 'resume' : 'pause')}
          >
            {workflow.page?.admissionPaused ? <Play size={15} /> : <Pause size={15} />}
            {t(workflow.page?.admissionPaused ? 'flow.resume' : 'flow.pause')}
          </button>
          {repos.length > 0 && (
            <button
              className="icon-button"
              aria-label={t('flow.settings')}
              onClick={() => setReceiving(repos[0].id)}
            >
              <Settings2 size={18} />
            </button>
          )}
        </div>
      </header>
      {error && (
        <div className="error-inline" role="alert">
          {host(error)}
        </div>
      )}
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
      <WorkbenchAttention state={state} team={team} projectId={project.id} page={workflow.page} />
      <div className="flow-filters" role="group" aria-label={t('flow.work')}>
        {filters.map((value) => (
          <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {t(`flow.${value}`)}
          </button>
        ))}
      </div>
      <WorkflowBoard
        projectId={project.id}
        state={state}
        team={team}
        page={workflow.page}
        filter={filter}
        loading={workflow.loading}
        more={workflow.more}
      />
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
          onChange={workflow.refresh}
        />
      )}
    </div>
  );
}
