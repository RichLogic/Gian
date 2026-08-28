// SES-001 navigation lifecycle: New Session is a recoverable draft surface,
// not a modal route lock. Existing sidebar Sessions must take precedence;
// reopening the same Workspace resumes its draft, while a confirmed create
// clears that draft for the next Session.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, Workspace } from '@gian/shared';
import { LocaleProvider } from '../src/i18n/index.js';
import { createOperationStore } from '../src/operations/store.js';
import { OperationStoreProvider } from '../src/operations/use-operations.js';
import type { OperationRun } from '../src/operations/types.js';
import { CodingView, type CodingViewProps } from '../src/views/CodingView.js';
import { typeInlineComposer } from './inline-composer-test-utils.js';

vi.mock('../src/api.js', () => ({
  peekAgents: vi.fn(() => null),
  loadAgents: vi.fn().mockResolvedValue([
    {
      id: 'kimi',
      name: 'Kimi Code',
      ready: true,
      cli: { state: 'ready', path: '/bin/kimi', version: '1.0.0', source: 'path' },
      proxy: { state: 'ready', path: '/proxy/kimi', version: '0.1.0', source: 'github-release' },
      officialInstallUrl: 'https://example.invalid',
    },
  ]),
  loadProxyModels: vi.fn().mockResolvedValue([]),
  loadProxyCapabilities: vi.fn().mockResolvedValue({
    protocolVersion: 'test', models: [], modes: [], slashCommands: [],
  }),
}));

const workspace: Workspace = {
  id: 'ws-1',
  name: 'Alpha',
  path: '/tmp/alpha',
  sort_order: 0,
  hidden: 0,
  pinned: 0,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const existingSession: Session = {
  id: 'session-1',
  name: 'Existing session',
  type: 'coding',
  task_id: null,
  workspace_id: workspace.id,
  executor: 'kimi',
  model: null,
  approval_mode: null,
  executor_config: { schemaVersion: 1, values: {} },
  native_config_options: [],
  thinking_effort: null,
  service_tier: null,
  active_channel: 'web',
  status: 'done',
  archived: 0,
  pinned_at: null,
  unread: 0,
  worktree_path: null,
  branch: null,
  base_branch: null,
  worktree_outcome: null,
  native_session_id: null,
  summary: null,
  completed_at: null,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const pendingRun: OperationRun = {
  id: 'create-1',
  name: 'session.create',
  entityKey: 'session:new',
  phase: 'pending',
  startedAt: 1,
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <LocaleProvider locale="en">
      <OperationStoreProvider store={createOperationStore()}>
        {children}
      </OperationStoreProvider>
    </LocaleProvider>
  );
}

function props(overrides: Partial<CodingViewProps> = {}): CodingViewProps {
  return {
    mode: 'sessions',
    onSetAppMode: vi.fn(),
    onOpenSearch: vi.fn(),
    workspaces: [workspace],
    sessions: [existingSession],
    activeSession: null,
    activeWorkspace: null,
    activeSessionId: null,
    itemsBySession: {},
    pendingBySession: {},
    queueBySession: {},
    planStateBySession: {},
    historyBySession: {},
    onLoadOlder: vi.fn(),
    onRetryHistory: vi.fn(),
    onSelectSession: vi.fn(),
    onNewWorkspace: vi.fn(),
    onCreateSession: vi.fn(() => pendingRun),
    creatingSession: false,
    onClearSessionCreateRun: vi.fn(),
    onVerifySessionCreate: vi.fn().mockResolvedValue(undefined),
    onSend: vi.fn(),
    onSendSkill: vi.fn(),
    onStop: vi.fn(),
    onApprove: vi.fn(),
    onQueueAdd: vi.fn(),
    onQueueRemove: vi.fn(),
    onQueueUpdate: vi.fn(),
    onQueueClear: vi.fn(),
    onQueueSendNow: vi.fn(),
    onSteer: vi.fn(),
    onSetMode: vi.fn(),
    onSetModel: vi.fn(),
    onSetEffort: vi.fn(),
    onSetServiceTier: vi.fn(),
    onSetNativeConfig: vi.fn(),
    onDelete: vi.fn(),
    onReopenSession: vi.fn(),
    onPinSession: vi.fn(),
    onArchiveSession: vi.fn(),
    onShowChanges: vi.fn(),
    onShowLastTurnChanges: vi.fn(),
    activeWorkingTreeId: null,
    activeBranch: null,
    ...overrides,
  };
}

describe('New Session navigation lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('lets an existing Session replace the draft, restores it on return, and clears it on confirm', async () => {
    const initial = props();
    const view = render(<CodingView {...initial} />, { wrapper });

    await userEvent.click(screen.getByTestId('sb-new-session-ws-1'));
    await screen.findByText('Kimi Code');
    await userEvent.type(screen.getByTestId('ns-title-input'), 'Recoverable draft');
    typeInlineComposer(screen.getByTestId('ns-message-input'), 'keep this work');

    await userEvent.click(screen.getByTestId('session-row-session-1'));
    expect(initial.onSelectSession).toHaveBeenCalledWith('session-1');
    expect(screen.queryByTestId('ns-message-input')).toBeNull();

    await userEvent.click(screen.getByTestId('sb-new-session-ws-1'));
    expect(await screen.findByTestId('ns-title-input')).toHaveValue('Recoverable draft');
    expect(screen.getByTestId('ns-message-input')).toHaveTextContent('keep this work');
    await userEvent.click(screen.getByTestId('ns-send'));
    expect(initial.onCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      firstMessage: 'keep this work',
    }));

    const confirmedRun = { ...pendingRun, phase: 'confirmed' as const };
    view.rerender(<CodingView {...initial} sessionCreateRun={confirmedRun} />);
    await waitFor(() => expect(screen.queryByTestId('ns-message-input')).toBeNull());

    await userEvent.click(screen.getByTestId('sb-new-session-ws-1'));
    expect(await screen.findByTestId('ns-title-input')).toHaveValue('');
    expect(screen.getByTestId('ns-message-input')).toHaveTextContent('');
  });
});
