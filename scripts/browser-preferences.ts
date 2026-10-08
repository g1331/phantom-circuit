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
