import { FolderCog, ListTodo, MessageSquare, Newspaper, Users } from 'lucide-react';
import { useLocale } from './locale/provider.tsx';
import { routeHref, type Page, type Route } from './route.ts';

const items = [
  { page: 'home', icon: MessageSquare },
  { page: 'brief', icon: Newspaper },
  { page: 'work', icon: ListTodo },
  { page: 'team', icon: Users },
  { page: 'project', icon: FolderCog },
] as const satisfies readonly { page: Page; icon: typeof MessageSquare }[];

/**
 * The project's pages. The sidebar lists them under the selected project; on a phone the same
 * links sit in a bottom bar. The brief link only shows where the brief is not beside the chat.
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
  const current = route.page === 'task' ? 'work' : route.page;
  return (
    <nav className={`project-pages pages-${variant}`} aria-label={t('nav.label')}>
      {items.map(({ page, icon: Icon }) => {
        const badge = page === 'brief' || page === 'work' ? waiting : page === 'team' ? working : 0;
        const label = t(`nav.${page}`);
        return (
          <a
            key={page}
            className={`page-link page-${page}`}
            href={routeHref({ page, projectId })}
            // The icon rail hides the label text; the link keeps its name there.
            aria-label={badge > 0 ? `${label} ${number(badge)}` : label}
            aria-current={current === page ? 'page' : undefined}
          >
            <Icon size={16} aria-hidden="true" />
            <span className="page-link-label">{label}</span>
            {badge > 0 && (
              <span className={`page-badge ${page === 'team' ? 'live' : 'attention'}`}>
                {number(badge)}
              </span>
            )}
          </a>
        );
      })}
    </nav>
  );
}
