import { useEffect, useState } from 'react';

/** Hash routes preserve work, input, and conversation links across navigation (ADRs 0014/0019). */
export type Page =
  | 'home'
  | 'conversation'
  | 'input'
  | 'brief'
  | 'work'
  | 'task'
  | 'team'
  | 'project'
  | 'records'
  | 'sources';
export interface Route {
  page: Page;
  projectId?: string;
  taskId?: string;
  inputId?: string;
  /** A section or conversation request within the page; absent means the default view. */
  view?: string;
}

const pages: Page[] = ['conversation', 'brief', 'work', 'team', 'project', 'records', 'sources'];

export function parseRoute(hash: string): Route {
  let parts: string[];
  try {
    parts = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  } catch (error) {
    if (error instanceof URIError) return { page: 'home' };
    throw error;
  }
  const [p, projectId, section, a, b] = parts;
  if (p !== 'p' || !projectId) return { page: 'home' };
  if (section === 'requests' && a) return { page: 'conversation', projectId, view: a };
  if (section === 'inputs' && a)
    return { page: 'input', projectId, inputId: a, ...(b === 'records' && { view: b }) };
  if (section === 'work' && a) return { page: 'task', projectId, taskId: a, ...(b && { view: b }) };
  const page = pages.includes(section as Page) ? (section as Page) : 'home';
  return { page, projectId, ...(page === 'project' && a && { view: a }) };
}

export function routeHref({ page, projectId, taskId, inputId, view }: Route) {
  if (!projectId) return '#/';
  const base = `#/p/${encodeURIComponent(projectId)}`;
  const tail = view ? `/${encodeURIComponent(view)}` : '';
  if (page === 'task' && taskId) return `${base}/work/${encodeURIComponent(taskId)}${tail}`;
  if (page === 'input' && inputId) return `${base}/inputs/${encodeURIComponent(inputId)}${tail}`;
  if (page === 'project') return `${base}/project${tail}`;
  if (page === 'conversation' && view) return `${base}/requests${tail}`;
  return page === 'home' ? (view ? `${base}/requests${tail}` : base) : `${base}/${page}`;
}

export function useRoute(): [Route, (next: Route, replace?: boolean) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const sync = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);
  const go = (next: Route, replace = false) => {
    const href = routeHref(next);
    if (replace) history.replaceState(null, '', href);
    else if (location.hash !== href) history.pushState(null, '', href);
    setRoute(parseRoute(href));
  };
  return [route, go];
}
