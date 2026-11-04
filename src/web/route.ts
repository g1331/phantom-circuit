import { useEffect, useState } from 'react';

/** The addressable pages (ADR 0014). Hash routes keep links and the back button working anywhere. */
export type Page = 'home' | 'brief' | 'work' | 'task' | 'team' | 'project';
export interface Route {
  page: Page;
  projectId?: string;
  taskId?: string;
}

const pages: Page[] = ['brief', 'work', 'team', 'project'];

export function parseRoute(hash: string): Route {
  const [p, projectId, section, taskId] = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (p !== 'p' || !projectId) return { page: 'home' };
  if (section === 'work' && taskId) return { page: 'task', projectId, taskId };
  return { page: pages.includes(section as Page) ? (section as Page) : 'home', projectId };
}

export function routeHref({ page, projectId, taskId }: Route) {
  if (!projectId) return '#/';
  const base = `#/p/${encodeURIComponent(projectId)}`;
  if (page === 'task' && taskId) return `${base}/work/${encodeURIComponent(taskId)}`;
  return page === 'home' ? base : `${base}/${page}`;
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
