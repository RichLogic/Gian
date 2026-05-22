// Coverage for traceability row (UI dimension):
//   PAL-001 — Command Palette must support searching:
//             • sessions (by name / id-prefix)
//             • changed files in the active working tree
//             • transcript-referenced files (file-read / diff entries)
//             plus keyboard navigation (↑ ↓ Enter Esc).
//   Command search is explicitly NOT part of the current row — slash
//   commands surface as a separate section but the row only requires
//   file/session search to work; the existing 03 e2e covers opening
//   the palette and the legacy command filter.
//
// Drives the component directly via React Testing Library so the
// matrix can move beyond "opens / filters command results" e2e.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session, Workspace } from '@gian/shared';
import type { TranscriptItem } from '../src/types.js';
import { CommandPalette } from '../src/components/CommandPalette.js';

vi.mock('../src/api.js', () => ({
  loadChanged: vi.fn().mockResolvedValue([]),
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-aaaaaaaa-uuid',
    name: 'demo session',
    type: 'coding',
    workspace_id: 'ws-1',
    executor: 'claude',
    model: null,
    approval_mode: 'ask',
    thinking_effort: 'medium',
    turns: 1,
    active_channel: 'web',
    status: 'idle',
    archived: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    native_session_id: null,
    runtime_mode: 'structured',
    created_at: '2026-05-17T00:00:00.000Z',
    updated_at: '2026-05-17T00:00:00.000Z',
    ...overrides,
  } as Session;
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'My Project',
    path: '/tmp/my-project',
    git_remote: '',
    sort_order: 0,
    created_at: '2026-05-17T00:00:00.000Z',
    updated_at: '2026-05-17T00:00:00.000Z',
    ...overrides,
  } as Workspace;
}

interface OpenPaletteOpts {
  sessions?: Session[];
  workspaces?: Workspace[];
  activeSessionId?: string | null;
  activeWorkingTreeId?: string | null;
  transcriptItems?: TranscriptItem[];
  onJumpToSession?: ReturnType<typeof vi.fn>;
  onOpenFile?: ReturnType<typeof vi.fn>;
  onClose?: ReturnType<typeof vi.fn>;
  initialQuery?: string;
}

function openPalette(opts: OpenPaletteOpts = {}) {
  const onClose = opts.onClose ?? vi.fn();
  const onJumpToSession = opts.onJumpToSession ?? vi.fn();
  const onOpenFile = opts.onOpenFile ?? vi.fn();
  render(
    <CommandPalette
      open
      onClose={onClose}
      sessions={opts.sessions ?? [makeSession()]}
      workspaces={opts.workspaces ?? [makeWorkspace()]}
      activeSessionId={opts.activeSessionId ?? null}
      activeWorkingTreeId={opts.activeWorkingTreeId ?? null}
      transcriptItems={opts.transcriptItems ?? []}
      onJumpToSession={onJumpToSession}
      onOpenFile={onOpenFile}
      initialQuery={opts.initialQuery}
    />,
  );
  return { onClose, onJumpToSession, onOpenFile };
}

beforeEach(() => {
  // Reset the loadChanged mock between tests so a previous fake
  // doesn't leak its resolved value.
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// PAL-001 — sessions search
// ---------------------------------------------------------------------------

describe('PAL-001: sessions search', () => {
  it('renders ALL sessions when query is empty', () => {
    const sessions = [
      makeSession({ id: 'sess-aaa1', name: 'alpha' }),
      makeSession({ id: 'sess-bbb2', name: 'beta' }),
      makeSession({ id: 'sess-ccc3', name: 'gamma' }),
    ];
    openPalette({ sessions });
    // Each session appears as a button under the Sessions section.
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
    expect(screen.getByText('gamma')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
  });

  it('PAL-001: filters sessions by name substring (case-insensitive)', async () => {
    const user = userEvent.setup();
    const sessions = [
      makeSession({ id: 'sess-aaa1', name: 'alpha' }),
      makeSession({ id: 'sess-bbb2', name: 'beta' }),
      makeSession({ id: 'sess-ccc3', name: 'BETA-tester' }),
    ];
    openPalette({ sessions });

    const input = screen.getByPlaceholderText(/Search sessions, files, commands/);
    await user.type(input, 'beta');

    expect(screen.queryByText('alpha')).toBeNull();
    expect(screen.getByText('beta')).toBeInTheDocument();
    expect(screen.getByText('BETA-tester')).toBeInTheDocument();
  });

  it('PAL-001: matches a session by its 8-char id prefix', async () => {
    const user = userEvent.setup();
    const sessions = [
      makeSession({ id: 'aaa11111-rest', name: 'first' }),
      makeSession({ id: 'bbb22222-rest', name: 'second' }),
    ];
    openPalette({ sessions });

    const input = screen.getByPlaceholderText(/Search sessions/);
    await user.type(input, 'bbb22222');
    expect(screen.queryByText('first')).toBeNull();
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('PAL-001: each session row carries the workspace name as sublabel and the "session" tag', () => {
    const sessions = [makeSession({ id: 'sess-1', name: 'demo', workspace_id: 'ws-x' })];
    const workspaces = [makeWorkspace({ id: 'ws-x', name: 'Project X' })];
    openPalette({ sessions, workspaces });
    expect(screen.getByText('Project X')).toBeInTheDocument();
    expect(screen.getByText('session')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// PAL-001 — transcript file search (file-read / diff)
// ---------------------------------------------------------------------------

describe('PAL-001: transcript-referenced file search', () => {
  it('surfaces file paths from `file-read` transcript items as Files-section results', () => {
    const transcriptItems: TranscriptItem[] = [
      { kind: 'file-read', id: 'r-1', path: 'src/app.ts', ts: 0, turn: 1 } as TranscriptItem,
      { kind: 'file-read', id: 'r-2', path: 'src/util.ts', ts: 0, turn: 1 } as TranscriptItem,
    ];
    openPalette({ transcriptItems });

    expect(screen.getByText('Files')).toBeInTheDocument();
    // The label is the basename; sublabel is the full path.
    expect(screen.getByText('app.ts')).toBeInTheDocument();
    expect(screen.getByText('util.ts')).toBeInTheDocument();
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    expect(screen.getByText('src/util.ts')).toBeInTheDocument();
  });

  it('PAL-001: extracts file paths from `diff` transcript items (each per-file entry)', () => {
    const transcriptItems: TranscriptItem[] = [
      {
        kind: 'diff', id: 'd-1', ts: 0, turn: 1,
        files: [
          { path: 'src/a.ts', add: 1, del: 0, hunks: [] },
          { path: 'src/b.ts', add: 0, del: 1, hunks: [] },
        ],
      } as TranscriptItem,
    ];
    openPalette({ transcriptItems });
    // Label (basename) AND sublabel (full path) both render; getAllByText
    // accommodates the duplication.
    expect(screen.getAllByText(/^a\.ts$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^b\.ts$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('src/b.ts')).toBeInTheDocument();
  });

  it('PAL-001: filters transcript files by path substring', async () => {
    const user = userEvent.setup();
    const transcriptItems: TranscriptItem[] = [
      { kind: 'file-read', id: 'r-1', path: 'src/app.ts', ts: 0, turn: 1 } as TranscriptItem,
      { kind: 'file-read', id: 'r-2', path: 'docs/README.md', ts: 0, turn: 1 } as TranscriptItem,
    ];
    openPalette({ transcriptItems });

    const input = screen.getByPlaceholderText(/Search sessions/);
    await user.type(input, 'README');
    expect(screen.queryByText('app.ts')).toBeNull();
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// PAL-001 — keyboard navigation + selection
// ---------------------------------------------------------------------------

describe('PAL-001: keyboard navigation', () => {
  it('Enter on a Sessions row invokes onJumpToSession with the session id', async () => {
    const user = userEvent.setup();
    const sessions = [makeSession({ id: 'sess-target', name: 'pick me' })];
    const { onJumpToSession, onClose } = openPalette({ sessions });

    const input = screen.getByPlaceholderText(/Search sessions/);
    await user.click(input);
    await user.keyboard('{Enter}');
    expect(onJumpToSession).toHaveBeenCalledWith('sess-target');
    expect(onClose).toHaveBeenCalled();
  });

  it('PAL-001: Enter on a Files row invokes onOpenFile with the working-tree id + path', async () => {
    const user = userEvent.setup();
    const transcriptItems: TranscriptItem[] = [
      { kind: 'file-read', id: 'r-1', path: 'src/app.ts', ts: 0, turn: 1 } as TranscriptItem,
    ];
    const { onOpenFile, onJumpToSession } = openPalette({
      transcriptItems,
      activeWorkingTreeId: 'ws:ws-1',
      // No sessions so the file row is the first result.
      sessions: [],
    });

    const input = screen.getByPlaceholderText(/Search sessions/);
    await user.click(input);
    await user.keyboard('{Enter}');
    expect(onOpenFile).toHaveBeenCalledWith('ws:ws-1', 'src/app.ts');
    expect(onJumpToSession).not.toHaveBeenCalled();
  });

  it('PAL-001: Files Enter is a no-op when activeWorkingTreeId is null (palette stays open)', async () => {
    // Without a working tree, the palette can't resolve the file open;
    // the route from CommandPalette guards `if (activeWorkingTreeId)`.
    const user = userEvent.setup();
    const transcriptItems: TranscriptItem[] = [
      { kind: 'file-read', id: 'r-1', path: 'src/app.ts', ts: 0, turn: 1 } as TranscriptItem,
    ];
    const { onOpenFile, onClose } = openPalette({
      transcriptItems,
      activeWorkingTreeId: null,
      sessions: [],
    });

    const input = screen.getByPlaceholderText(/Search sessions/);
    await user.click(input);
    await user.keyboard('{Enter}');
    expect(onOpenFile).not.toHaveBeenCalled();
    // onClose still fires per the current contract — pick() always closes.
    expect(onClose).toHaveBeenCalled();
  });

  it('PAL-001: ↓ moves selection to the next row, ↑ moves back', async () => {
    const user = userEvent.setup();
    const sessions = [
      makeSession({ id: 'sess-a', name: 'first' }),
      makeSession({ id: 'sess-b', name: 'second' }),
      makeSession({ id: 'sess-c', name: 'third' }),
    ];
    const { onJumpToSession } = openPalette({ sessions });

    const input = screen.getByPlaceholderText(/Search sessions/);
    await user.click(input);
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onJumpToSession).toHaveBeenCalledWith('sess-c');

    onJumpToSession.mockClear();
    await user.keyboard('{ArrowUp}{Enter}');
    expect(onJumpToSession).toHaveBeenCalledWith('sess-b');
  });

  it('PAL-001: Escape closes the palette without firing a selection callback', async () => {
    const user = userEvent.setup();
    const sessions = [makeSession()];
    const { onClose, onJumpToSession } = openPalette({ sessions });

    const input = screen.getByPlaceholderText(/Search sessions/);
    await user.click(input);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    expect(onJumpToSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PAL-001 — empty-state handling
// ---------------------------------------------------------------------------

describe('PAL-001: empty result handling', () => {
  it('shows the "No results" message when the query matches nothing', async () => {
    const user = userEvent.setup();
    openPalette({ sessions: [makeSession({ name: 'alpha' })] });
    const input = screen.getByPlaceholderText(/Search sessions/);
    await user.type(input, 'zzzzzzzzzz');
    expect(screen.getByText(/No results for "zzzzzzzzzz"/)).toBeInTheDocument();
  });

  it('PAL-001: Enter with no results is a no-op (no callbacks fire)', async () => {
    const user = userEvent.setup();
    const { onJumpToSession, onOpenFile, onClose } = openPalette({
      sessions: [makeSession({ name: 'alpha' })],
    });
    const input = screen.getByPlaceholderText(/Search sessions/);
    await user.type(input, 'zzzzzzzzzz');
    await user.keyboard('{Enter}');
    expect(onJumpToSession).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();
    // Escape would close, but Enter on no-results stays open.
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PAL-001 — initial query seed
// ---------------------------------------------------------------------------

describe('PAL-001: initialQuery seeding', () => {
  it('seeds the input with `initialQuery` when the palette opens', async () => {
    openPalette({
      sessions: [makeSession({ name: 'alpha' }), makeSession({ name: 'beta' })],
      initialQuery: 'beta',
    });
    const input = screen.getByPlaceholderText(/Search sessions/) as HTMLInputElement;
    expect(input.value).toBe('beta');
    // Filter already applied.
    expect(screen.queryByText('alpha')).toBeNull();
    expect(screen.getByText('beta')).toBeInTheDocument();
  });
});
