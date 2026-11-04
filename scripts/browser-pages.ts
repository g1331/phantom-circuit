import type { Page } from 'playwright';
import { pagesEn, pagesZh } from '../src/web/locale/pages.ts';

/** The project's addressable pages (ADR 0014), as named in the page navigation. */
export type ProjectPage = 'home' | 'brief' | 'work' | 'team' | 'project';

async function copy(page: Page) {
  return (await page.locator('html').getAttribute('lang')) === 'en' ? pagesEn : pagesZh;
}
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** On a phone the projects and settings sit in a drawer behind the top bar's menu button. */
export async function openDrawer(page: Page) {
  // The drawer breakpoint (pages.css); the menu button itself appears once the project loads.
  if (page.viewportSize()!.width > 660) return false;
  const menu = page.locator('.mobile-top > button');
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

/** Follows a page link in whichever navigation is on screen: the sidebar or the phone's bottom bar. */
export async function openPage(page: Page, target: ProjectPage) {
  await closeDrawer(page);
  const t = await copy(page);
  await page
    .getByRole('navigation', { name: t['nav.label'], exact: true })
    .getByRole('link', { name: new RegExp(`^${literal(t[`nav.${target}`])}(\\s*\\d+)?$`) })
    .click();
  await page.waitForURL(new RegExp(target === 'home' ? '#/p/[^/]+$' : `#/p/[^/]+/${target}$`));
}

/** Opens a piece of work's page from the work list. */
export async function openTask(page: Page, title: string) {
  if (!/#\/p\/[^/]+\/work$/.test(page.url())) await openPage(page, 'work');
  await page
    .locator('.work-page')
    .getByRole('link')
    .filter({ has: page.locator('strong').getByText(title, { exact: true }) })
    .click();
  await page.getByRole('heading', { level: 1, name: title, exact: true }).waitFor();
}

/** Leaves a work page through its own back link. */
export async function backToWork(page: Page) {
  const t = await copy(page);
  await page.getByRole('link', { name: t['work.back'], exact: true }).click();
  await page.waitForURL(/#\/p\/[^/]+\/work$/);
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
  const link = page
    .getByRole('navigation', {
      name: t[section.startsWith('task.') ? 'tabs.task' : 'tabs.project'],
      exact: true,
    })
    .getByRole('link', { name: new RegExp(`^${literal(t[section])}(\\s*\\d+)?$`) });
  await link.click();
  await link.and(page.locator('[aria-current="page"]')).waitFor();
}
