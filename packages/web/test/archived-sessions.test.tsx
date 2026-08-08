import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ClientToServerMessage, ServerToClientMessage, Session, Workspace } from '@gian/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../src/i18n/index.js';
import { createOperationDispatcher, type OperationTransport } from '../src/operations/dispatcher.js';
import '../src/operations/session.js';
import { createOperationStore } from '../src/operations/store.js';
import {
  OperationDispatcherProvider,
  OperationStoreProvider,
} from '../src/operations/use-operations.js';
import { ArchivedSessionsPane } from '../src/views/spaces-archived-sessions.js';
import { loadArchivedSessions } from '../src/api.js';

vi.mock('../src/api.js', () => ({
  loadArchivedSessions: vi.fn(),
  dropSession: vi.fn(),
  mergeSession: vi.fn(),
}));

class Transport implements OperationTransport {
  send(_message: ClientToServerMessage): void {}
  onMessage(_listener: (message: ServerToClientMessage) => void): () => void {
    return () => {};
  }
  onState(listener: (state: 'connecting' | 'open' | 'closed', attempt: number) => void): () => void {
    listener('open', 0);
    return () => {};
  }
}

const workspace: Workspace = {
  id: 'workspace-archived',
  name: 'Archived workspace',
  path: '/tmp/archived-workspace',
  sort_order: 0,
  hidden: 0,
  pinned: 0,
  created_at: '2026-08-08T00:00:00.000Z',
  updated_at: '2026-08-08T00:00:00.000Z',
};

function renderPane(initialWorkspace: Workspace = workspace) {
  const store = createOperationStore();
  const dispatcher = createOperationDispatcher({ store, transport: new Transport() });
  const pane = (currentWorkspace: Workspace) => (
    <LocaleProvider locale="en">
      <OperationStoreProvider store={store}>
        <OperationDispatcherProvider dispatcher={dispatcher}>
          <ArchivedSessionsPane
            key={currentWorkspace.id}
            workspace={currentWorkspace}
            onChange={vi.fn()}
          />
        </OperationDispatcherProvider>
      </OperationStoreProvider>
    </LocaleProvider>
  );
  const rendered = render(pane(initialWorkspace));
  return {
    dispatcher,
    rerenderWorkspace: (next: Workspace) => rendered.rerender(pane(next)),
  };
}

describe('SES-002: archived Session query recovery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('surfaces a load failure and retries without stranding the pane in loading state', async () => {
    vi.mocked(loadArchivedSessions)
      .mockRejectedValueOnce(new Error('archive query failed'))
      .mockResolvedValueOnce([]);
    const { dispatcher } = renderPane();

    expect(await screen.findByRole('alert')).toHaveTextContent('archive query failed');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.getByText('No archived conversations in this workspace.')).toBeVisible();
    });
    expect(loadArchivedSessions).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    dispatcher.dispose();
  });

  it('does not expose the previous workspace rows while the next query is loading', async () => {
    const previousSession = {
      id: 'archived-previous', workspace_id: workspace.id, name: 'previous workspace', archived: 1,
      updated_at: '2026-08-08T00:00:00.000Z', executor: 'codex', branch: null,
    } as Session;
    const nextWorkspace = { ...workspace, id: 'workspace-next', name: 'Next workspace' };
    const nextSession = {
      ...previousSession,
      id: 'archived-next',
      workspace_id: nextWorkspace.id,
      name: 'next workspace',
    };
    let resolveNext!: (sessions: Session[]) => void;
    vi.mocked(loadArchivedSessions)
      .mockResolvedValueOnce([previousSession])
      .mockImplementationOnce(() => new Promise(resolve => { resolveNext = resolve; }));

    const { dispatcher, rerenderWorkspace } = renderPane();
    expect(await screen.findByTestId('archived-session-archived-previous')).toBeVisible();

    rerenderWorkspace(nextWorkspace);
    await waitFor(() => {
      expect(screen.queryByTestId('archived-session-archived-previous')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Loading…')).toBeVisible();

    resolveNext([nextSession]);
    expect(await screen.findByTestId('archived-session-archived-next')).toBeVisible();
    dispatcher.dispose();
  });
});
