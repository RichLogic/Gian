import { expect, test, type APIRequestContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOST_BASE,
  createTestWorkspace,
  deleteTestWorkspace,
  type CreatedWorkspace,
} from '../fixtures/workspace.js';
import { installMockApp, mockSession, mockWorkspace, sentWsMessages } from '../fixtures/mock-app.js';
import { openSessions, openWorkspaces } from '../fixtures/navigation.js';

let apiCtx: APIRequestContext;
let createdWs: CreatedWorkspace | null = null;
let tempDirToRemove: string | null = null;

test.describe('02 · Workspaces and sessions', () => {
  test.beforeEach(async ({ playwright }) => {
    apiCtx = await playwright.request.newContext({ baseURL: HOST_BASE });
  });

  test.afterEach(async () => {
    if (!createdWs && tempDirToRemove) {
      const rows = (await (await apiCtx.get('/api/workspaces')).json().catch(() => [])) as Array<{ id: string; name: string; path: string }>;
      const found = rows.find(r => r.path === tempDirToRemove);
      if (found) {
        createdWs = { ...found, tmpDir: tempDirToRemove };
      }
    }
    if (createdWs) {
      await deleteTestWorkspace(apiCtx, createdWs);
      createdWs = null;
    }
    if (tempDirToRemove) {
      await rm(tempDirToRemove, { recursive: true, force: true }).catch(() => {});
      tempDirToRemove = null;
    }
    await apiCtx.dispose();
  });

  test('workspace created through API appears in Workspaces view', async ({ page }) => {
    createdWs = await createTestWorkspace(apiCtx, 'e2e-spaces');

    await openWorkspaces(page);

    const row = page.getByTestId(`ws-item-${createdWs.id}`);
    await expect(row).toBeVisible({ timeout: 8_000 });
    await expect(row).toContainText(createdWs.name);
    await expect(row).toContainText(createdWs.path);
  });

  test('New workspace form can adopt an existing path', async ({ page, playwright }) => {
    tempDirToRemove = await mkdtemp(join(tmpdir(), 'gian-e2e-adopt-'));

    await openWorkspaces(page);

    await page.getByTestId('workspaces-new').click();
    await expect(page.getByRole('tab', { name: 'Adopt path' })).toBeVisible();
    await page.getByRole('tab', { name: 'Adopt path' }).click();

    const wsName = `e2e-ui-${Date.now()}`;
    await page.getByLabel('Workspace path').fill(tempDirToRemove);
    await page.getByLabel('Workspace name').fill(wsName);
    await page.getByRole('button', { name: /^(Create|创建)$/ }).click();

    const createdRow = page.locator('.ws-item', { hasText: wsName });
    await expect(createdRow).toBeVisible({ timeout: 8_000 });
    await expect(createdRow).toContainText(tempDirToRemove);

    const localApi = await playwright.request.newContext({ baseURL: HOST_BASE });
    const rows = (await (await localApi.get('/api/workspaces')).json()) as Array<{ id: string; name: string; path: string }>;
    const found = rows.find(r => r.name === wsName);
    await localApi.dispose();
    expect(found).toBeTruthy();
    createdWs = found ? { ...found, tmpDir: tempDirToRemove } : null;
  });

  test('New session form exposes only workspace, agent picker, and name', async ({ page }) => {
    createdWs = await createTestWorkspace(apiCtx, 'e2e-session-form');

    await openSessions(page);
    await page.getByTestId('sb-new-session').click();

    await expect(page.getByText(/Start a new session|开启一个新会话/)).toBeVisible();
    await page.locator('select[aria-label="Workspace"]').selectOption({ label: createdWs.name });
    // The agent picker is data-driven from /api/agents — at least one card.
    await expect(page.locator('.exec-card').first()).toBeVisible();
    await expect(page.getByLabel(/Session name|会话名称/)).toBeVisible();

    // Removed controls must be gone.
    await expect(page.getByText(/Approval mode|审批模式/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Worktree', exact: true })).toHaveCount(0);
    await expect(page.getByLabel(/First message|第一条消息/)).toHaveCount(0);
  });

  test('Create session sends the expected WebSocket payload', async ({ page }) => {
    const ws = mockWorkspace({ id: 'ws-dispatch', name: 'dispatch-ws', path: '/tmp/dispatch-ws' });
    await installMockApp(page, { workspaces: [ws], sessions: [] });

    await openSessions(page);
    await page.getByTestId('sb-new-session').click();
    await page.locator('select[aria-label="Workspace"]').selectOption(ws.id);
    await page.getByRole('button', { name: 'Claude Code' }).click();
    await page.getByLabel(/Session name|会话名称/).fill('dispatch check');
    await page.getByRole('button', { name: /Create session|创建会话/ }).click();

    await expect
      .poll(async () => sentWsMessages(page), { timeout: 3_000 })
      .toContainEqual(expect.objectContaining({
        type: 'session:create',
        workspace_id: ws.id,
        executor: 'claude',
        approval_mode: 'ask',
        name: 'dispatch check',
      }));
  });

  test('Workspace row "+" opens the form with that workspace preselected', async ({ page }) => {
    const ws = mockWorkspace({ id: 'ws-pre', name: 'preselect-ws', path: '/tmp/preselect-ws' });
    const session = mockSession({ id: 's-pre', workspace_id: ws.id });
    await installMockApp(page, { workspaces: [ws], sessions: [session] });

    await openSessions(page);
    await page.locator('.sb-group').first().hover();
    await page.getByTestId(`sb-new-session-${ws.id}`).click();

    await expect(page.getByText(/Start a new session|开启一个新会话/)).toBeVisible();
    await expect(page.locator('select[aria-label="Workspace"]')).toHaveValue(ws.id);
  });

  test('Session row hover actions send session:pin and session:archive', async ({ page }) => {
    const ws = mockWorkspace({ id: 'ws-acts', name: 'actions-ws', path: '/tmp/actions-ws' });
    const session = mockSession({ id: 's-acts', workspace_id: ws.id, name: 'pin me' });
    await installMockApp(page, { workspaces: [ws], sessions: [session] });

    await openSessions(page);
    const row = page.getByTestId(`session-row-${session.id}`);
    await row.hover();
    await page.getByTestId(`session-pin-${session.id}`).click();
    await expect
      .poll(async () => sentWsMessages(page), { timeout: 3_000 })
      .toContainEqual({ type: 'session:pin', session_id: session.id, pinned: true });

    await row.hover();
    await page.getByTestId(`session-archive-${session.id}`).click();
    await expect
      .poll(async () => sentWsMessages(page), { timeout: 3_000 })
      .toContainEqual({ type: 'session:archive', session_id: session.id, archived: true });
  });
});
