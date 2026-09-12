import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './render-app.js';
import { sampleCatalog } from '../src/controller/fixture.js';

function openNewChat() {
  return renderApp({
    scenario: { view: { kind: 'new-chat', presetTaskId: 'task-1' } },
    viewport: 'wide',
  });
}

describe('new chat (B4)', () => {
  it('workspace + agent + Doing Task are required', async () => {
    const user = userEvent.setup();
    openNewChat();
    const create = screen.getByRole('button', { name: '创建并开始' });
    // workspace defaults to the first catalog workspace; agent is required
    expect(create).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Codex' }));
    expect(create).toBeEnabled();
  });

  it('cannot create an Unassigned Remote Session', async () => {
    const user = userEvent.setup();
    renderApp({
      scenario: { view: { kind: 'new-chat', presetTaskId: '' } },
      viewport: 'wide',
    });
    await user.click(screen.getByRole('radio', { name: 'Codex' }));
    expect(screen.getByLabelText('Task')).toHaveValue('');
    expect(screen.getByRole('button', { name: '创建并开始' })).toBeDisabled();
  });

  it('defaults come from the agent catalog (no guessed previous config)', async () => {
    const user = userEvent.setup();
    renderApp({ scenario: { view: { kind: 'new-chat', presetTaskId: 'task-1' } }, viewport: 'wide' });
    const taskSelect = screen.getByLabelText('Task');
    expect((taskSelect as HTMLSelectElement).value).toBe('task-1');
    await user.click(screen.getByRole('radio', { name: 'Claude' }));
    expect(screen.getByText(/claude-sonnet-4.6/)).toBeInTheDocument();
  });

  it('an unavailable agent cannot be selected', () => {
    openNewChat();
    expect(screen.getByRole('radio', { name: 'Kimi' })).toBeDisabled();
  });

  it('catalog invalidated blocks create until refreshed', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({
      scenario: { view: { kind: 'new-chat', presetTaskId: 'task-1' } },
      viewport: 'wide',
    });
    await user.click(screen.getByRole('radio', { name: 'Codex' }));
    controller.test.invalidateCatalog();
    expect(screen.getByText(/catalog 已更新/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建并开始' })).toBeDisabled();
    // crafted direct call is refused while invalidated
    controller.actions.createSession({ workspaceId: 'ws-1', agentId: 'agent-codex', taskId: 'task-1' });
    expect(controller.test.pendingCommandIds()).toHaveLength(0);
    controller.test.refreshCatalogResult(sampleCatalog());
    expect(screen.getByRole('button', { name: '创建并开始' })).toBeEnabled();
  });

  it('host offline blocks create', async () => {
    const user = userEvent.setup();
    renderApp({
      scenario: {
        view: { kind: 'new-chat', presetTaskId: 'task-1' },
        connection: { kind: 'host_offline', lastSeenAt: Date.now() },
      },
      viewport: 'wide',
    });
    await user.click(screen.getByRole('radio', { name: 'Codex' }));
    expect(screen.getByText('Host 离线，暂不能创建会话。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建并开始' })).toBeDisabled();
  });

  it('create pending → success enters chat only with the canonical session', async () => {
    const user = userEvent.setup();
    const { controller } = openNewChat();
    await user.click(screen.getByRole('radio', { name: 'Codex' }));
    await user.click(screen.getByRole('button', { name: '创建并开始' }));
    // pending: still on the form, button shows the waiting copy
    expect(screen.getByRole('button', { name: /创建中/ })).toBeDisabled();
    expect(controller.state.view.kind).toBe('new-chat');
    controller.test.resolveAll();
    expect(controller.state.view.kind).toBe('chat');
    const view = controller.state.view as { sessionId: string };
    expect(controller.state.sessions.some((s) => s.id === view.sessionId)).toBe(true);
  });

  it('create error renders the failure and stays on the form', async () => {
    const user = userEvent.setup();
    const { controller } = openNewChat();
    controller.test.scriptCreate('error', 'workspace not available');
    await user.click(screen.getByRole('radio', { name: 'Codex' }));
    await user.click(screen.getByRole('button', { name: '创建并开始' }));
    controller.test.resolveAll();
    expect(controller.state.view.kind).toBe('new-chat');
    expect(screen.getByText(/创建失败：workspace not available/)).toBeInTheDocument();
  });
});
