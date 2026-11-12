import { useState, type ReactNode } from 'react';
import { BookOpen, Cpu, FolderGit2, History, Users } from 'lucide-react';
import type { Project, Snapshot } from '../shared/types.ts';
import { DeferredSettings } from './deferred-panels.tsx';
import { api } from './api.ts';
import { useLocale } from './locale/provider.tsx';
import { routeHref } from './route.ts';

export function WorkspaceSettings({
  state,
  project,
  section,
  busy,
  reload,
  repositories,
  instructions,
  documents,
  runs,
}: {
  state: Snapshot;
  project: Project;
  section: string;
  busy: boolean;
  reload: () => Promise<void>;
  repositories: ReactNode;
  instructions: ReactNode;
  documents: ReactNode;
  runs: ReactNode;
}) {
  const { t } = useLocale();
  const [scope, setScope] = useState<'project' | 'global'>('project');
  const entries = [
    { view: 'overview', label: 'flow.modelExecution', icon: Cpu },
    { view: 'instructions', label: 'teamInstructions.title', icon: Users },
    { view: 'repos', label: 'flow.deliverySettings', icon: FolderGit2 },
    { view: 'docs', label: 'project.tab.docs', icon: BookOpen },
    { view: 'runs', label: 'project.tab.runs', icon: History },
  ] as const;
  const projectOnly = scope === 'project';
  return (
    <div className="workspace-settings">
      <aside className="workspace-section-nav">
        <h1>{t('flow.settingsTitle')}</h1>
        {entries.map(({ view, label, icon: Icon }) => (
          <a
            key={view}
            href={routeHref({ page: 'project', projectId: project.id, view })}
            aria-current={section === view ? 'page' : undefined}
          >
            <Icon size={18} />
            {t(label)}
          </a>
        ))}
      </aside>
      <section className="workspace-settings-content">
        {section === 'overview' && (
          <>
            <h2>{t('flow.modelExecution')}</h2>
            <div
              className="console-view-switch settings-scope"
              role="group"
              aria-label={t('flow.settingsTitle')}
            >
              {(['project', 'global'] as const).map((value) => (
                <button key={value} aria-pressed={scope === value} onClick={() => setScope(value)}>
                  {t(value === 'project' ? 'flow.currentProject' : 'flow.globalSettings')}
                </button>
              ))}
            </div>
            <DeferredSettings
              key={`${project.id}:${scope}`}
              showProviders={!projectOnly}
              initial={
                projectOnly
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
              project={projectOnly ? project : undefined}
              globalSettings={state.settings}
              projectOnly={projectOnly}
              busy={busy}
              submit={async (settings, runtime) => {
                const result = await api<{ warnings?: string[] }>(
                  projectOnly ? `/projects/${project.id}/runtime` : '/settings',
                  projectOnly
                    ? {
                        ...runtime,
                        ...(JSON.stringify(settings.profiles) !== JSON.stringify(project.profiles)
                          ? { profiles: settings.profiles }
                          : {}),
                        ...(JSON.stringify(settings.ompProfiles) !==
                        JSON.stringify(project.ompProfiles)
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
                return { warnings: result.warnings ?? [] };
              }}
            />
          </>
        )}
        {section === 'instructions' && instructions}
        {section === 'repos' && repositories}
        {section === 'docs' && documents}
        {section === 'runs' && runs}
      </section>
    </div>
  );
}
