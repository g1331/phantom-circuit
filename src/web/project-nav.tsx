import { History, Layers, MessageSquare, Settings2, Workflow } from 'lucide-react';
import { useLocale } from './locale/provider.tsx';
import { routeHref, type Page, type Route } from './route.ts';

const items = [
  { page: 'home', icon: Workflow, label: 'flow.title' },
  { page: 'records', icon: History, label: 'flow.records' },
  { page: 'sources', icon: Layers, label: 'flow.sources' },
  { page: 'project', icon: Settings2, label: 'flow.settingsTitle' },
  { page: 'conversation', icon: MessageSquare, label: 'nav.conversation' },
] as const satisfies readonly { page: Page; icon: typeof MessageSquare; label: string }[];

/**
 * The project's pages. The sidebar lists them under the selected project; on a phone the same
 * links sit in a bottom bar. The brief is an addressable page at every screen width.
 */
export function ProjectNav({
  route,
  projectId,
  waiting,
  working,
  variant,
}: {
  route: Route;
  projectId: string;
  waiting: number;
  working: number;
  variant: 'sidebar' | 'bar';
}) {
  const { t, number } = useLocale();
  // A work page belongs to the work list.
  const current = ['task', 'input'].includes(route.page) ? 'home' : route.page;
  return (
    <nav className={`project-pages pages-${variant}`} aria-label={t('nav.label')}>
      {items.map(({ page, icon: Icon, label: labelKey }) => {
        const badge = page === 'home' ? waiting : 0;
        const label = t(labelKey);
        return (
          <a
            key={page}
            className={`page-link page-${page}`}
            href={routeHref({ page, projectId })}
            // The icon rail hides the label text; the link keeps its name there.
            title={label}
            aria-label={badge > 0 ? `${label} ${number(badge)}` : label}
            aria-current={current === page ? 'page' : undefined}
          >
            <Icon size={16} aria-hidden="true" />
            <span className="page-link-label">
              {variant === 'bar' && page === 'conversation' ? t('nav.conversationShort') : label}
            </span>
            {badge > 0 && <span className="page-badge attention">{number(badge)}</span>}
          </a>
        );
      })}
    </nav>
  );
}
