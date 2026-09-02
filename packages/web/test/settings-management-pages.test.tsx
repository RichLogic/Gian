import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { NativeSession, Session, Workspace } from '@gian/shared';
import {
  DEFAULT_TERMINAL_PREFERENCES,
} from '@gian/shared';
import type { SystemConfig } from '@gian/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsBody } from '../src/components/SettingsBody.js';
import * as api from '../src/api.js';
import { renderWithOperations } from './operation-test-utils.js';
import { sessionContractFixture } from './fixtures/ws-contract.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    loadArchivedSessions: vi.fn(),
    loadNativeSessions: vi.fn(),
    loadAgents: vi.fn().mockResolvedValue([]),
    updateWorkspace: vi.fn(),
    reorderWorkspaces: vi.fn().mockResolvedValue(undefined),
  };
});

const workspaces: Workspace[] = [
  { id: 'ws-a', name: 'Alpha', path: '/repo/a', sort_order: 0, hidden: 0, pinned: 0, created_at: '2026-01-01', updated_at: '2026-01-01' },
  { id: 'ws-b', name: 'Beta', path: '/repo/b', sort_order: 1, hidden: 0, pinned: 0, created_at: '2026-01-01', updated_at: '2026-01-01' },
  { id: 'ws-hidden', name: 'Hidden', path: '/repo/hidden', sort_order: 2, hidden: 1, pinned: 0, created_at: '2026-01-01', updated_at: '2026-01-01' },
];

function config(): SystemConfig {
  return {
    host: '127.0.0.1', port: 8991, workspace_root: '~/Coding',
    theme: 'light', accent: 'azure', density: 'cozy', locale: 'en',
    font_scale_chrome: 'md', font_scale_chat: 'md', font_scale_code: 'md',
    chat_font_size: 14, chat_font_family: 'system',
    terminal: { ...DEFAULT_TERMINAL_PREFERENCES },
    default_claude_model: '', default_claude_effort: '',
    default_codex_model: '', default_codex_effort: '',
    auth_username: '', external_editors: [], open_apps: {},
  };
}

describe('Settings Archive management', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts with None filters and does not expand archived results implicitly', async () => {
    vi.mocked(api.loadArchivedSessions).mockResolvedValue([
      sessionContractFixture({ id: 'hidden-until-filtered', name: 'Hidden initially', workspace_id: 'ws-a', archived: 1 }) as Session,
    ]);
    renderWithOperations(<SettingsBody config={config()} activeSection="archive" workspaces={workspaces} />);
    await waitFor(() => expect(api.loadArchivedSessions).toHaveBeenCalled());
    expect(screen.getByLabelText('Filter archived chats by Agent')).toHaveValue('none');
    expect(screen.getByLabelText('Filter archived chats by workspace')).toHaveValue('none');
    expect(screen.queryByText('Hidden initially')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete all' })).toBeNull();
  });

  it('groups archived chats across workspaces and restores through session.archive', async () => {
    const archived = sessionContractFixture({
      id: 'archived-a', name: 'Old conversation', workspace_id: 'ws-a', archived: 1,
    }) as Session;
    vi.mocked(api.loadArchivedSessions).mockResolvedValue([archived]);
    const view = renderWithOperations(
      <SettingsBody config={config()} activeSection="archive" workspaces={workspaces} />,
    );
    fireEvent.change(screen.getByLabelText('Filter archived chats by Agent'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Filter archived chats by workspace'), { target: { value: 'all' } });
    expect(await screen.findByText('Old conversation')).toBeTruthy();
    expect(screen.getAllByText('Alpha')).toHaveLength(2);
    const row = screen.getByText('Old conversation').closest('.management-row')!;
    expect(row.querySelector('.management-row-actions')).not.toBeNull();
    expect(row.querySelector('.management-trash')?.parentElement)
      .toBe(row.querySelector('.management-primary-action')?.parentElement);
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    await waitFor(() => expect(view.transport.sent.at(-1)).toMatchObject({
      type: 'session:archive', session_id: 'archived-a', archived: false,
    }));
    act(() => view.transport.resolveLast());
    await waitFor(() => expect(screen.queryByText('Old conversation')).toBeNull());
  });

  it('searches archived chats without losing workspace grouping', async () => {
    vi.mocked(api.loadArchivedSessions).mockResolvedValue([
      sessionContractFixture({ id: 'one', name: 'Design review', workspace_id: 'ws-a', archived: 1 }) as Session,
      sessionContractFixture({ id: 'two', name: 'Release notes', workspace_id: 'ws-b', archived: 1 }) as Session,
    ]);
    renderWithOperations(<SettingsBody config={config()} activeSection="archive" workspaces={workspaces} />);
    fireEvent.change(screen.getByLabelText('Filter archived chats by Agent'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Filter archived chats by workspace'), { target: { value: 'all' } });
    await screen.findByText('Design review');
    fireEvent.change(screen.getByPlaceholderText('Search archived chats'), { target: { value: 'release' } });
    expect(screen.queryByText('Design review')).toBeNull();
    expect(screen.getByText('Release notes')).toBeTruthy();
    expect(screen.getAllByText('Beta')).toHaveLength(2);
  });
});

describe('Settings Adopt management', () => {
  it('starts the scope selectors at None and has no status selector', async () => {
    vi.mocked(api.loadNativeSessions).mockResolvedValue([]);
    renderWithOperations(<SettingsBody config={config()} activeSection="adopt" workspaces={workspaces} />);
    await waitFor(() => expect(api.loadNativeSessions).toHaveBeenCalled());
    expect(screen.getByLabelText('Filter native sessions by provider')).toHaveValue('none');
    expect(screen.getByLabelText('Filter native sessions by workspace')).toHaveValue('none');
    expect(screen.queryByLabelText('Filter native sessions by status')).toBeNull();
  });

  it('aggregates native sessions across workspaces and opens the adopt dialog', async () => {
    const native: NativeSession = {
      id: 'native-a', executor: 'codex', filePath: '/tmp/native.jsonl', cwd: '/repo/a',
      updatedAt: '2026-08-26T10:00:00.000Z', fileSize: 100, turnCount: 3,
      firstUserMessage: 'Continue the settings redesign', gitBranch: 'feat/settings',
    };
    const adopted: NativeSession = {
      ...native,
      id: 'native-adopted',
      firstUserMessage: 'Already adopted session',
      adoptedBy: { gianSessionId: 'gian-session', gianSessionName: 'Gian session' },
    };
    vi.mocked(api.loadNativeSessions).mockImplementation(async workspaceId =>
      workspaceId === 'ws-a' ? [native, adopted] : []);
    renderWithOperations(<SettingsBody config={config()} activeSection="adopt" workspaces={workspaces} />);
    fireEvent.change(screen.getByLabelText('Filter native sessions by provider'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Filter native sessions by workspace'), { target: { value: 'all' } });
    expect(await screen.findByText('Continue the settings redesign')).toBeTruthy();
    expect(screen.queryByText('Already adopted session')).toBeNull();
    const row = screen.getByText('Continue the settings redesign').closest('.management-row')!;
    expect(row.querySelector('.management-trash')?.parentElement)
      .toBe(row.querySelector('.management-primary-action')?.parentElement);
    fireEvent.click(screen.getAllByRole('button', { name: 'Adopt' }).at(-1)!);
    expect(await screen.findByText('Adopt as Gian session')).toBeTruthy();
  });
});

describe('Settings Workspaces reduction', () => {
  it('keeps only drag ordering and Hide/Show actions', async () => {
    vi.mocked(api.updateWorkspace).mockImplementation(async (id, patch) => ({
      ...workspaces.find(workspace => workspace.id === id)!,
      hidden: patch.hidden ? 1 : 0,
    }));
    renderWithOperations(<SettingsBody config={config()} activeSection="workspaces" workspaces={workspaces} />);
    expect(screen.queryByRole('button', { name: /new workspace/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    // 2026-08-29: ordering is drag-based (no more Move up/down arrows). jsdom
    // has no DataTransfer — fireEvent attaches the init object onto the event.
    // Rows measure 0×0 in jsdom, so clientY 0 lands the drop 'after' Beta:
    // Alpha moves below it.
    expect(screen.queryByRole('button', { name: 'Move down' })).toBeNull();
    const rowA = screen.getByText('Alpha').closest('.management-row')!;
    const rowB = screen.getByText('Beta').closest('.management-row')!;
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: () => {} };
    fireEvent.dragStart(rowA, { dataTransfer });
    fireEvent.dragOver(rowB, { dataTransfer, clientY: 0 });
    fireEvent.drop(rowB, { dataTransfer });
    await waitFor(() => expect(api.reorderWorkspaces).toHaveBeenCalledWith(['ws-b', 'ws-a', 'ws-hidden']));
    fireEvent.click(screen.getAllByRole('button', { name: 'Hide' })[0]!);
    await waitFor(() => expect(api.updateWorkspace).toHaveBeenCalledWith('ws-a', { hidden: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(api.updateWorkspace).toHaveBeenCalledWith('ws-hidden', { hidden: false }));
  });

  it('opens the selected workspace in the Workbench without restoring removed row actions', () => {
    const onWorkspaceOpened = vi.fn();
    renderWithOperations(
      <SettingsBody
        config={config()}
        activeSection="workspaces"
        workspaces={workspaces}
        onWorkspaceOpened={onWorkspaceOpened}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Alpha.*\/repo\/a/ }));
    expect(onWorkspaceOpened).toHaveBeenCalledWith('ws-a');
    expect(screen.queryByRole('button', { name: /new workspace/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });
});
