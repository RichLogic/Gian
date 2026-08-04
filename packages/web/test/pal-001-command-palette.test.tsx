import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session, Workspace } from '@gian/shared';
import { CommandPalette } from '../src/components/CommandPalette.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-default',
    name: 'Default session',
    type: 'coding',
    workspace_id: 'ws-1',
    executor: 'claude',
    model: null,
    approval_mode: 'ask',
    thinking_effort: 'medium',
    active_channel: 'web',
    status: 'idle',
    archived: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    native_session_id: null,
    created_at: '2026-08-04T00:00:00.000Z',
    updated_at: '2026-08-04T00:00:00.000Z',
    ...overrides,
  } as Session;
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'My Project',
    path: '/tmp/my-project',
    sort_order: 0,
    created_at: '2026-08-04T00:00:00.000Z',
    updated_at: '2026-08-04T00:00:00.000Z',
    ...overrides,
  } as Workspace;
}

function openPalette(options: {
  sessions?: Session[];
  workspaces?: Workspace[];
  onJumpToSession?: ReturnType<typeof vi.fn>;
  onClose?: ReturnType<typeof vi.fn>;
  initialQuery?: string;
} = {}) {
  const onClose = options.onClose ?? vi.fn();
  const onJumpToSession = options.onJumpToSession ?? vi.fn();
  render(
    <CommandPalette
      open
      onClose={onClose}
      sessions={options.sessions ?? [makeSession()]}
      workspaces={options.workspaces ?? [makeWorkspace()]}
      onJumpToSession={onJumpToSession}
      initialQuery={options.initialQuery}
    />,
  );
  return { onClose, onJumpToSession };
}

describe('PAL-001: session search and jump', () => {
  it('shows only named, active sessions and their workspace', () => {
    openPalette({
      sessions: [
        makeSession({ id: 'alpha', name: 'Alpha' }),
        makeSession({ id: 'archived', name: 'Archived', archived: 1 }),
        makeSession({ id: 'unnamed', name: '   ' }),
      ],
    });

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('My Project')).toBeInTheDocument();
    expect(screen.queryByText('Archived')).toBeNull();
  });

  it('matches names case-insensitively but does not search session ids', async () => {
    const user = userEvent.setup();
    openPalette({
      sessions: [
        makeSession({ id: 'contains-beta-id', name: 'Alpha planning' }),
        makeSession({ id: 'other', name: 'BETA release' }),
      ],
    });

    await user.type(screen.getByPlaceholderText(/Search sessions/), 'beta');
    expect(screen.queryByText('Alpha planning')).toBeNull();
    expect(screen.getByText('BETA release')).toBeInTheDocument();
  });

  it('jumps to the selected session with Enter and closes', async () => {
    const user = userEvent.setup();
    const onJumpToSession = vi.fn();
    const onClose = vi.fn();
    openPalette({
      sessions: [
        makeSession({ id: 'first', name: 'First' }),
        makeSession({ id: 'second', name: 'Second' }),
      ],
      onJumpToSession,
      onClose,
    });

    await user.keyboard('{ArrowDown}{Enter}');
    expect(onJumpToSession).toHaveBeenCalledWith('second');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape without selecting', async () => {
    const user = userEvent.setup();
    const { onClose, onJumpToSession } = openPalette();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    expect(onJumpToSession).not.toHaveBeenCalled();
  });

  it('shows an empty state and does nothing on Enter when there is no match', async () => {
    const user = userEvent.setup();
    const { onClose, onJumpToSession } = openPalette({ initialQuery: 'missing' });

    expect(screen.getByText(/No results for "missing"/)).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onJumpToSession).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
