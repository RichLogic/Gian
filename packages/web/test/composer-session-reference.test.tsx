import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@gian/shared';

import {
  Composer,
  injectComposerContextItems,
} from '../src/components/Composer.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { loadSessions, loadWorkspaces } from '../src/api.js';
import { createOperationDispatcher } from '../src/operations/dispatcher.js';
import { createOperationStore } from '../src/operations/store.js';
import { OperationDispatcherProvider, OperationStoreProvider } from '../src/operations/use-operations.js';
import { typeInlineComposer } from './inline-composer-test-utils.js';

vi.mock('../src/desktop-bridge.js', () => ({
  desktopBridge: () => ({}),
}));

vi.mock('../src/api.js', () => ({
  loadProxyModels: vi.fn().mockResolvedValue([]),
  loadSlashCommands: vi.fn().mockResolvedValue([]),
  loadSessionSlashCommands: vi.fn().mockResolvedValue([]),
  loadNativeConfig: vi.fn().mockResolvedValue(null),
  loadSessions: vi.fn(),
  loadWorkspaces: vi.fn(),
  uploadAttachment: vi.fn(),
  // Imported by operations/session.js (pulled in via use-operations.js).
  dropSession: vi.fn(),
  mergeSession: vi.fn(),
}));

function sessionFixture(overrides: Partial<Session>): Session {
  return {
    id: 'session-x',
    name: null,
    type: 'coding',
    workspace_id: 'workspace-1',
    executor: 'claude',
    model: null,
    approval_mode: 'ask',
    thinking_effort: null,
    active_channel: 'web',
    status: 'idle',
    archived: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    native_session_id: null,
    service_tier: null,
    executor_config: { schemaVersion: 1, values: {} },
    native_config_options: [],
    created_at: '2026-09-20T00:00:00.000Z',
    updated_at: '2026-09-20T00:00:00.000Z',
    ...overrides,
  } as Session;
}

const CURRENT = sessionFixture({ id: 'session-current', name: 'Current chat' });
const REFERENCED = sessionFixture({
  id: 'session-ref',
  name: 'Refactor plan',
  workspace_id: 'workspace-2',
  updated_at: '2026-09-21T00:00:00.000Z',
});
const OTHER = sessionFixture({
  id: 'session-other',
  name: 'Release checklist',
  workspace_id: 'workspace-1',
  updated_at: '2026-09-19T00:00:00.000Z',
});

function renderComposer(options: { onSend?: ReturnType<typeof vi.fn> } = {}) {
  const onSend = options.onSend ?? vi.fn();
  const store = createOperationStore();
  const dispatcher = createOperationDispatcher({ store });
  const view = render(
    <LocaleProvider locale="en">
      <OperationStoreProvider store={store}>
        <OperationDispatcherProvider dispatcher={dispatcher}>
          <Composer
            session={CURRENT}
            executor="claude"
            workspaceId="workspace-1"
            disabled={false}
            running={false}
            onSend={onSend}
            onSendSkill={vi.fn()}
            onStop={vi.fn()}
            onQueueAdd={vi.fn()}
            onSetMode={vi.fn()}
            onSetModel={vi.fn()}
            onSetEffort={vi.fn()}
          />
        </OperationDispatcherProvider>
      </OperationStoreProvider>
    </LocaleProvider>,
  );
  return { onSend, unmount: view.unmount };
}

describe('Composer session references', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(loadSessions).mockReset();
    vi.mocked(loadWorkspaces).mockReset();
    vi.mocked(loadSessions).mockResolvedValue([CURRENT, REFERENCED, OTHER]);
    vi.mocked(loadWorkspaces).mockResolvedValue([
      { id: 'workspace-1', name: 'Gian' },
      { id: 'workspace-2', name: 'Infra' },
    ] as Awaited<ReturnType<typeof loadWorkspaces>>);
  });

  it('opens the picker from the add menu and inserts a conversation chip on select', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();

    await user.click(screen.getByRole('button', { name: 'Add context' }));
    await user.click(screen.getByRole('button', { name: 'Reference conversation' }));

    // The picker lists sessions newest-first with workspace labels, excluding
    // the composer's own session.
    const row = await screen.findByTestId('session-reference-row-session-ref');
    expect(row.textContent).toContain('Refactor plan');
    expect(row.textContent).toContain('Infra');
    expect(screen.queryByTestId('session-reference-row-session-current')).toBeNull();
    expect(screen.getByTestId('session-reference-row-session-other').textContent).toContain('Release checklist');

    await user.click(row);
    // The chip lands in the editor with the conversation title.
    expect((await screen.findAllByText('Refactor plan')).length).toBeGreaterThan(0);

    typeInlineComposer(screen.getByRole('textbox'), 'apply this plan');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('apply this plan', expect.objectContaining({
      contextItems: [expect.objectContaining({
        type: 'session',
        sessionId: 'session-ref',
        title: 'Refactor plan',
        workspaceName: 'Infra',
      })],
      composerDocument: expect.objectContaining({
        segments: expect.arrayContaining([
          expect.objectContaining({ referenceType: 'context', label: 'Refactor plan', kind: 'session' }),
        ]),
      }),
    }));
  });

  it('filters the picker by title or workspace and shows an empty state', async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.click(screen.getByRole('button', { name: 'Add context' }));
    await user.click(screen.getByRole('button', { name: 'Reference conversation' }));
    await screen.findByTestId('session-reference-row-session-ref');

    const search = screen.getByPlaceholderText('Search conversations…');
    await user.type(search, 'infra');
    expect(screen.getByTestId('session-reference-row-session-ref')).toBeInTheDocument();
    expect(screen.queryByTestId('session-reference-row-session-other')).toBeNull();

    await user.clear(search);
    await user.type(search, 'zzz-no-match');
    expect(await screen.findByText('No matching conversations')).toBeInTheDocument();
  });

  it('restores an injected session context item from the draft with its label', async () => {
    injectComposerContextItems('session-current', [{
      type: 'session',
      id: 'ctx-ref-1',
      sessionId: 'session-ref',
      title: 'Refactor plan',
      workspaceName: 'Infra',
    }]);
    renderComposer();
    expect((await screen.findAllByText('Refactor plan')).length).toBeGreaterThan(0);
  });
});
