import type { Locator, Page } from 'playwright';

export async function choosePreference(
  page: Page,
  preference: 'language' | 'theme',
  value: string,
  scope: Locator = page.locator('.sidebar'),
) {
  const trigger = scope.locator(`.${preference}-control`);
  await trigger.click();
  const id = await trigger.getAttribute('aria-controls');
  await page.locator(`[id="${id}"] [role="menuitemradio"][data-value="${value}"]`).click();
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
