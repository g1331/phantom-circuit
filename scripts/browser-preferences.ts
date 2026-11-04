import type { Locator, Page } from 'playwright';
import { closeDrawer, openDrawer } from './browser-pages.ts';

export async function choosePreference(
  page: Page,
  preference: 'language' | 'theme',
  value: string,
  scope?: Locator,
) {
  // On a phone the sidebar is a drawer: open it for the choice and close it again.
  const drawer =
    !scope && !(await page.locator('.drawer-scrim').count()) && (await openDrawer(page));
  const trigger = (scope ?? page.locator('.sidebar')).locator(`.${preference}-control`);
  await trigger.click();
  const id = await trigger.getAttribute('aria-controls');
  await page.locator(`[id="${id}"] [role="menuitemradio"][data-value="${value}"]`).click();
  if (drawer) await closeDrawer(page);
}

/** Settings pages are tabs; on the models page, `agent` picks whose role models are shown. */
export async function settingsPage(
  scope: Locator,
  section: 'team' | 'models' | 'providers',
  agent?: 'omp' | 'codex',
) {
  await scope.locator(`#settings-tab-${section}`).click();
  if (agent) await scope.locator(`[data-agent-view="${agent}"]`).click();
}
