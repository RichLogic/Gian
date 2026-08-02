import { expect, test } from '@playwright/test';
import { waitForAppReady } from '../fixtures/navigation.js';

const paletteSelector = '[role="dialog"]';

test.describe('03 · Command palette', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
  });

  test('opens from keyboard and focuses search', async ({ page }) => {
    const palette = page.locator(paletteSelector);
    await expect(palette).not.toBeVisible();

    await page.keyboard.press('Meta+Shift+k');
    await expect(palette).toBeVisible();
    await expect(palette.locator('.pal-input')).toBeFocused();
  });

  test('opens from sidebar search and filters command results', async ({ page }) => {
    const palette = page.locator(paletteSelector);

    await page.getByTestId('sb-open-search').click();
    await expect(palette).toBeVisible();

    await palette.locator('.pal-input').fill('/init');
    await expect(palette.locator('.pal-section-head', { hasText: /Commands|命令/ })).toBeVisible();
    await expect(palette.locator('.pal-row', { hasText: '/init' })).toBeVisible();
  });

  test('Escape and backdrop close the palette', async ({ page }) => {
    const palette = page.locator(paletteSelector);

    await page.keyboard.press('Control+Shift+k');
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).not.toBeVisible();

    await page.getByTestId('sb-open-search').click();
    await expect(palette).toBeVisible();
    await page.locator('.pal-overlay').click({ position: { x: 5, y: 5 } });
    await expect(palette).not.toBeVisible();
  });
});
