import { expect, type Page } from '@playwright/test';

export async function waitForAppReady(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-connection', 'ready', {
    timeout: 15_000,
  });
}

export async function openSessions(page: Page): Promise<void> {
  await waitForAppReady(page);
  const modeButton = page.getByTestId('mode-button');
  if (!/Sessions|会话/.test((await modeButton.textContent()) ?? '')) {
    await modeButton.click();
    await page.getByTestId('mode-option-sessions').click();
  }
  await expect(modeButton).toContainText(/Sessions|会话/);
}

export async function openWorkspaces(page: Page): Promise<void> {
  await waitForAppReady(page);
  await page.getByTestId('dock-workspaces').click();
  await expect(page.getByTestId('workspaces-inspector')).toBeVisible();
}
