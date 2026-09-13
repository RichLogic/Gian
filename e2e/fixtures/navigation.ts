import { expect, type Page } from '@playwright/test';

export async function waitForAppReady(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-connection', 'ready', {
    timeout: 15_000,
  });
}

export async function openSessions(page: Page): Promise<void> {
  await waitForAppReady(page);
  const listSwitch = page.getByTestId('sb-list-switch');
  if (await listSwitch.count()) {
    await listSwitch.click();
    await page.getByTestId('sb-mode-project').click();
  } else {
    await page.getByTestId('rail-nav-chat').click();
    await page.getByTestId('sb-list-switch').click();
    await page.getByTestId('sb-mode-project').click();
  }
  await expect(page.getByTestId('sb-list-switch')).toContainText(/Repos/);
}

export async function openWorkspaces(page: Page): Promise<void> {
  await waitForAppReady(page);
  await page.getByTestId('dock-settings').click();
  await expect(page.getByTestId('settings-body')).toBeVisible();
  // The Workbench width transition can briefly expose the desktop locator
  // before settling into the compact header. Choose only after that boundary.
  await page.waitForTimeout(250);
  const desktopEntry = page.locator('.settings2-internal-nav')
    .getByRole('button', { name: /Workspaces|工作区/, exact: true });
  const mobileToggle = page.locator('.settings2-nav-toggle');
  await expect.poll(async () => (
    await desktopEntry.isVisible() || await mobileToggle.isVisible()
  )).toBe(true);
  if (await desktopEntry.isVisible()) {
    await desktopEntry.click();
  } else {
    await mobileToggle.click();
    await page.locator('.settings2-mobile-nav')
      .getByRole('button', { name: /Workspaces|工作区/, exact: true }).click();
  }
  await expect(page.getByTestId('settings-workspaces-page')).toBeVisible();
}

export async function openTasks(page: Page): Promise<void> {
  await waitForAppReady(page);
  await page.getByTestId('sb-list-switch').click();
  await page.getByTestId('sb-mode-tasks').click();
  await expect(page.getByTestId('sb-list-switch')).toContainText(/Tasks|任务/);
}

/** Open the New Session page. The rail's top-row "+" was removed (2026-09-07);
 *  the global path is the session.new shortcut (`mod+n`). Ctrl+N is used
 *  because ⌘N is a browser-level shortcut Chromium never delivers to the
 *  page; `mod` matches Ctrl too (see shortcut-prefs comboMatches). The
 *  per-Repo group "+" (`sb-new-session-<wsId>`) remains as the preselected
 *  variant. Focus must not be inside an input — global shortcuts yield to
 *  editing. */
export async function openNewSession(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press('Control+n');
  await expect(page.getByTestId('ns-send')).toBeVisible();
}

/** Open the Tasks rail's inline new-task form: the 进行中 section header's
 *  hover-only "+" (the top-row `sb-new-task` button was removed 2026-09-07). */
export async function openNewTaskForm(page: Page): Promise<void> {
  await page.getByTestId('tasks-section-doing').hover();
  await page.getByTestId('tasks-section-doing-add').click();
}
