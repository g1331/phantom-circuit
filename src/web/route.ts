import { useEffect, useState } from 'react';

/** The addressable pages (ADR 0014). Hash routes keep links and the back button working anywhere. */
export type Page = 'home' | 'brief' | 'work' | 'task' | 'team' | 'project';
export interface Route {
  page: Page;
  projectId?: string;
  taskId?: string;
  /** A section or conversation request within the page; absent means the default view. */
  view?: string;
}

const pages: Page[] = ['brief', 'work', 'team', 'project'];

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
  if (section === 'requests' && a) return { page: 'home', projectId, view: a };
  if (section === 'work' && a) return { page: 'task', projectId, taskId: a, ...(b && { view: b }) };
  const page = pages.includes(section as Page) ? (section as Page) : 'home';
  return { page, projectId, ...(page === 'project' && a && { view: a }) };
}

export function routeHref({ page, projectId, taskId, view }: Route) {
  if (!projectId) return '#/';
  const base = `#/p/${encodeURIComponent(projectId)}`;
  const tail = view ? `/${encodeURIComponent(view)}` : '';
  if (page === 'task' && taskId) return `${base}/work/${encodeURIComponent(taskId)}${tail}`;
  if (page === 'project') return `${base}/project${tail}`;
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
