import { expect, test } from '@playwright/test';
import { openSessions, waitForAppReady } from '../fixtures/navigation.js';

test.describe('01 · App shell', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
  });

  test('topbar and dock render after state sync', async ({ page }) => {
    await expect(page.getByTestId('sb-list-switch')).toContainText(/Tasks|任务/);
    await expect(page.getByTestId('sb-nav-agents')).toBeVisible();
    await expect(page.getByTestId('runner-chip')).toHaveCount(0);

    await expect(page.getByTestId('dock-files')).toBeVisible();
    await expect(page.getByTestId('dock-diffs')).toBeVisible();
    await expect(page.getByTestId('dock-terminal')).toBeVisible();
    await expect(page.getByTestId('dock-settings')).toBeVisible();
    await expect(page.getByTestId('dock-workspaces')).toHaveCount(0);
  });

  test('list-switch dropdown changes between Project and Tasks', async ({ page }) => {
    await openSessions(page);
    await expect(page.getByTestId('sb-list-switch')).toContainText(/Repos/);
    // The top-row New button is gone (2026-09-07); the Repos section header
    // always renders and carries the hover-only New Repo "+".
    await expect(page.getByTestId('sb-section-projects')).toBeVisible();
    await expect(page.getByTestId('sb-section-projects-add')).toBeAttached();

    await page.getByTestId('sb-list-switch').click();
    // The check sits on the active list; picking Tasks switches the rail.
    await expect(page.getByTestId('sb-mode-project')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('sb-mode-tasks').click();
    await expect(page.getByTestId('sb-list-switch')).toContainText(/Tasks|任务/);
  });

  test('first-level pages preserve the selected Tasks list', async ({ page }) => {
    await expect(page.getByTestId('sb-list-switch')).toContainText(/Tasks|任务/);
    for (const target of ['agents', 'timer', 'custom']) {
      await page.getByTestId(`sb-nav-${target}`).click();
      await expect(page.getByTestId('sb-list-switch')).toContainText(/Tasks|任务/);
      await expect(page.getByTestId('tasks-section-doing')).toBeVisible();
    }
  });

  test('settings dock button opens and closes the workbench tab', async ({ page }) => {
    await page.getByTestId('dock-settings').click();
    await expect(page.getByTestId('workbench-sheet')).toBeVisible();
    await expect(page.getByTestId('settings-body')).toContainText(/Appearance|外观/);
    const management = page.locator('.s2-group').last().locator('.s2-navitem');
    await expect(management).toHaveText([/Archive|归档/, /Adopt|接入/]);

    await page.getByTestId('dock-settings').click();
    await expect(page.getByTestId('workbench-sheet')).not.toBeVisible();
  });

  test('Remote settings use the isolated Host enrollment instead of a fixture', async ({ page }) => {
    await page.getByTestId('dock-settings').click();
    await expect(page.getByTestId('settings-body')).toBeVisible();
    await page.waitForTimeout(250);
    const desktopRemote = page.locator('.settings2-internal-nav')
      .getByRole('button', { name: /^(Remote|远程)$/, exact: true });
    const mobileToggle = page.getByRole('button', {
      name: /Open settings navigation|打开设置目录/,
    });
    await expect.poll(async () => (
      await desktopRemote.isVisible() || await mobileToggle.isVisible()
    )).toBe(true);
    if (await desktopRemote.isVisible()) {
      await desktopRemote.click();
    } else {
      await mobileToggle.click();
      await page.locator('.settings2-mobile-nav')
        .getByRole('button', { name: /^(Remote|远程)$/, exact: true }).click();
    }
    const enrollment = page.getByTestId('settings-remote-enrollment');
    await expect(enrollment.getByRole('textbox', { name: 'Remote Server URL' })).toHaveValue('');
    await expect(enrollment.getByLabel('Enrollment token', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Generate QR \+ code|生成二维码 \+ 短码/ })).toBeDisabled();
    await expect(page.getByTestId('pairing-short-code')).toHaveCount(0);
  });
});
