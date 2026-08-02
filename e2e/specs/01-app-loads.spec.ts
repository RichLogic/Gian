import { expect, test } from '@playwright/test';
import { openSessions, waitForAppReady } from '../fixtures/navigation.js';

test.describe('01 · App shell', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
  });

  test('topbar and dock render after state sync', async ({ page }) => {
    await expect(page.getByTestId('mode-button')).toContainText(/Tasks|任务/);
    await expect(page.getByTestId('runner-chip')).toHaveCount(0);

    await expect(page.getByTestId('dock-files')).toBeVisible();
    await expect(page.getByTestId('dock-diffs')).toBeVisible();
    await expect(page.getByTestId('dock-terminal')).toBeVisible();
    await expect(page.getByTestId('dock-settings')).toBeVisible();
    await expect(page.getByTestId('dock-workspaces')).toBeVisible();
    await expect(page.getByTestId('dock-sidechat')).toBeVisible();
    await expect(page.getByTestId('dock-browser')).toBeVisible();
  });

  test('mode selector switches between primary views', async ({ page }) => {
    await openSessions(page);
    await expect(page.getByTestId('mode-button')).toContainText(/Sessions|会话/);
    await expect(page.getByTestId('sb-new-session')).toBeVisible();

    await page.getByTestId('mode-button').click();
    await page.getByTestId('mode-option-tasks').click();
    await expect(page.getByTestId('mode-button')).toContainText(/Tasks|任务/);
  });

  test('settings dock button opens and closes the workbench tab', async ({ page }) => {
    await page.getByTestId('dock-settings').click();
    await expect(page.getByTestId('workbench-sheet')).toBeVisible();
    await expect(page.getByTestId('settings-body')).toContainText(/Appearance|外观/);

    await page.getByTestId('dock-settings').click();
    await expect(page.getByTestId('workbench-sheet')).not.toBeVisible();
  });
});
