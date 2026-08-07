// Coverage for SES-001 (form dimension) — NewSessionView collects only
// workspace / agent / optional name, drives the agent picker from
// /api/agents (ready state), and honors the sidebar's initialWorkspaceId.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInstallStatus, ClientToServerMessage, Executor, Workspace } from '@gian/shared';
import { loadAgents } from '../src/api.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { createOperationDispatcher } from '../src/operations/dispatcher.js';
// Side effect: registers the product Workspace definitions (the inline
// workspace create dispatches workspace.create since Phase 3a).
import '../src/operations/workspace.js';
import { createOperationStore } from '../src/operations/store.js';
import { OperationDispatcherProvider, OperationStoreProvider } from '../src/operations/use-operations.js';
import { NewSessionView } from '../src/views/new-session-view.js';

vi.mock('../src/api.js', () => ({
  createWorkspace: vi.fn(),
  loadAgents: vi.fn(),
  peekAgents: vi.fn(() => null),
}));

function agent(id: Executor, name: string, ready = true): AgentInstallStatus {
  return {
    id,
    name,
    ready,
    cli: ready
      ? { state: 'ready', path: `/bin/${id}`, version: '1.0.0', source: 'path' }
      : { state: 'missing', path: null, version: null, source: null },
    proxy: ready
      ? {
          state: 'ready', path: `/proxy/${id}`, version: '0.1.0', source: 'github-release',
          defaults: { model: '', thinking: '', mode: '' },
        }
      : {
          state: 'missing', path: `/proxy/${id}`, version: null, source: 'github-release',
          defaults: { model: '', thinking: '', mode: '' },
        },
    officialInstallUrl: 'https://example.invalid',
  };
}

function workspace(id: string, name: string): Workspace {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    sort_order: 0,
    hidden: 0,
    pinned: 0,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  };
}

const agents = [
  agent('codex', 'Codex'),
  agent('claude', 'Claude Code'),
  agent('kimi', 'Kimi Code', false),
];

/** Operation-layer harness: the inline workspace create dispatches
 *  workspace.create through a real dispatcher (Phase 3a). */
function operationWrapper() {
  const store = createOperationStore();
  const dispatcher = createOperationDispatcher({
    store,
    transport: {
      send: () => {},
      onMessage: () => () => {},
      onState: listener => { listener('open', 0); return () => {}; },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <OperationStoreProvider store={store}>
      <OperationDispatcherProvider dispatcher={dispatcher}>{children}</OperationDispatcherProvider>
    </OperationStoreProvider>
  );
}

function renderView(props: Partial<Parameters<typeof NewSessionView>[0]> = {}) {
  const onCreate = vi.fn();
  const Ops = operationWrapper();
  render(
    <LocaleProvider locale="en">
      <Ops>
        <NewSessionView
          workspaces={[workspace('ws-1', 'Alpha'), workspace('ws-2', 'Beta')]}
          onWorkspaceCreated={vi.fn()}
          onCreate={onCreate}
          onCancel={vi.fn()}
          creating={false}
          {...props}
        />
      </Ops>
    </LocaleProvider>,
  );
  return { onCreate };
}

describe('NewSessionView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadAgents).mockResolvedValue(agents);
  });

  it('renders one card per agent from /api/agents and disables unready agents', async () => {
    renderView();
    const codex = await screen.findByRole('button', { name: /Codex/ });
    const claude = screen.getByRole('button', { name: /Claude Code/ });
    const kimi = screen.getByRole('button', { name: /Kimi Code/ });
    expect(codex).toBeEnabled();
    expect(claude).toBeEnabled();
    expect(kimi).toBeDisabled();
  });

  it('defaults to the first ready agent and submits the minimal payload', async () => {
    const { onCreate } = renderView();
    const create = await screen.findByRole('button', { name: 'Create session' });
    await waitFor(() => expect(create).toBeEnabled());
    await userEvent.click(create);
    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      name: '',
      executor: 'codex',
    });
  });

  it('submits the selected agent and trimmed optional name', async () => {
    const { onCreate } = renderView();
    await screen.findByRole('button', { name: /Claude Code/ });
    await userEvent.click(screen.getByRole('button', { name: /Claude Code/ }));
    await userEvent.type(screen.getByLabelText('Session name'), '  my session  ');
    await userEvent.click(screen.getByRole('button', { name: 'Create session' }));
    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      name: 'my session',
      executor: 'claude',
    });
  });

  it('preselects initialWorkspaceId (sidebar workspace-row "+" entry)', async () => {
    const { onCreate } = renderView({ initialWorkspaceId: 'ws-2' });
    await screen.findByRole('button', { name: /Codex/ });
    const select = screen.getByLabelText('Workspace') as HTMLSelectElement;
    expect(select.value).toBe('ws-2');
    await userEvent.click(screen.getByRole('button', { name: 'Create session' }));
    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-2',
      name: '',
      executor: 'codex',
    });
  });

  it('no longer renders approval / mode / first-message fields', async () => {
    renderView();
    await screen.findByRole('button', { name: /Codex/ });
    expect(screen.queryByText('Approval mode')).toBeNull();
    expect(screen.queryByText('Mode')).toBeNull();
    expect(screen.queryByText('First message')).toBeNull();
  });

  it('shows the task context read-only when opened from a task-row "+"', async () => {
    renderView({ taskName: 'My task' });
    await screen.findByRole('button', { name: /Codex/ });
    expect(screen.getByTestId('ns-task-name')).toHaveTextContent('My task');
    // The workspace picker is still editable — only the task is fixed.
    expect(screen.getByLabelText('Workspace')).toBeEnabled();
  });

  it('preselects initialExecutor (⌘J/⌘K shortcut carries the agent choice)', async () => {
    const { onCreate } = renderView({ initialExecutor: 'claude' });
    await screen.findByRole('button', { name: /Claude Code/ });
    await userEvent.click(screen.getByRole('button', { name: 'Create session' }));
    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      name: '',
      executor: 'claude',
    });
  });
});
