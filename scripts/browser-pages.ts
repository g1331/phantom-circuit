import type { Page } from 'playwright';
import { pagesEn, pagesZh } from '../src/web/locale/pages.ts';
import { workbenchEn, workbenchZh } from '../src/web/locale/workbench.ts';
import { parseRoute, routeHref } from '../src/web/route.ts';

/** The project's addressable pages (ADR 0014), as named in the page navigation. */
export type ProjectPage = 'home' | 'conversation' | 'brief' | 'work' | 'team' | 'project';

async function copy(page: Page) {
  return (await page.locator('html').getAttribute('lang')) === 'en' ? pagesEn : pagesZh;
}
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function assertProject(id: string | undefined): asserts id is string {
  if (!id) throw new Error('Expected an addressable project page');
}

/** On a phone the projects and settings sit in a drawer behind the top bar's menu button. */
export async function openDrawer(page: Page) {
  // The drawer breakpoint (pages.css); the menu button itself appears once the project loads.
  if (page.viewportSize()!.width > 660) return false;
  const menu = page.locator('.workspace-header .workspace-menu');
  if (!(await page.locator('.drawer-scrim').count())) await menu.click();
  const sidebar = page.locator('.sidebar');
  await sidebar.waitFor({ state: 'visible' });
  // Let the slide-in finish so positions are final.
  await sidebar.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  return true;
}

/** Dismisses the phone drawer by tapping the page beside it, if it is open. */
export async function closeDrawer(page: Page) {
  const scrim = page.locator('.drawer-scrim');
  if (!(await scrim.count())) return;
  await scrim.click({ position: { x: page.viewportSize()!.width - 8, y: 8 } });
  await scrim.waitFor({ state: 'detached' });
}

/** Clicks a sidebar button, opening the drawer first on a phone. The drawer stays open. */
export async function clickInSidebar(page: Page, name: string) {
  await openDrawer(page);
  await page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
}

/** Follows a page link in the sidebar or the phone's bottom bar. */
export async function openPage(page: Page, target: ProjectPage) {
  await closeDrawer(page);
  const inspector = page.locator('.workbench-inspector');
  if (target === 'work' && (await inspector.count())) {
    await inspector.locator('.page-back').click();
    await inspector.waitFor({ state: 'detached' });
  }
  await page.waitForURL((url) => Boolean(parseRoute(url.hash).projectId));
  const { projectId } = parseRoute(new URL(page.url()).hash);
  assertProject(projectId);
  const href = routeHref({
    page: target,
    projectId,
    ...(target === 'project' && { view: 'repos' }),
  });
  const link = page.locator(`a[href="${href}"]:visible`).first();
  if (await link.count()) await link.click();
  else
    await page.evaluate((hash) => {
      location.hash = hash;
    }, href);
  await page.waitForURL((url) => url.hash === href);
}

/** Opens a piece of work's page from the work list. */
export async function openTask(page: Page, title: string) {
  if (!/#\/p\/[^/]+\/work$/.test(page.url())) await openPage(page, 'work');
  await page
    .locator('.work-page')
    .getByRole('link')
    .filter({ has: page.locator('strong').getByText(title, { exact: true }) })
    .click();
  await page
    .locator('.task-page')
    .getByRole('heading', { level: 1, name: title, exact: true })
    .waitFor();
}

/** Leaves a work page through its own back link. */
export async function backToWork(page: Page) {
  const language =
    (await page.locator('html').getAttribute('lang')) === 'en' ? workbenchEn : workbenchZh;
  await page
    .locator('.task-page')
    .getByRole('link', {
      name: language['flow.close'],
      exact: true,
    })
    .click();
  await openPage(page, 'work');
}

/** A section within the task or project page, as named in that page's section navigation. */
export type PageSection =
  | 'task.tab.overview'
  | 'task.tab.spec'
  | 'task.tab.process'
  | 'project.tab.overview'
  | 'project.tab.docs'
  | 'project.tab.runs';

/** Switches the open task or project page to one of its sections. */
export async function openSection(page: Page, section: PageSection) {
  const t = await copy(page);
  if (section.startsWith('project.')) {
    const view =
      section === 'project.tab.overview'
        ? 'repos'
        : section === 'project.tab.docs'
          ? 'docs'
          : 'runs';
    const { projectId } = parseRoute(new URL(page.url()).hash);
    const link = page
      .locator('.workspace-section-nav')
      .locator(`a[href="${routeHref({ page: 'project', projectId, view })}"]`);
    await link.click();
    await link.and(page.locator('[aria-current="page"]')).waitFor();
    return;
  }
  const link = page
    .getByRole('navigation', {
      name: t[section.startsWith('task.') ? 'tabs.task' : 'tabs.project'],
      exact: true,
    })
    .getByRole('link', { name: new RegExp(`^${literal(t[section])}(\\s*\\d+)?$`) });
  await link.click();
  await link.and(page.locator('[aria-current="page"]')).waitFor();
}
