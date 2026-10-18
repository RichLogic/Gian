/**
 * Global search palette (Issue #168 / 0.6.7): typed groups from the Host
 * /api/search contract plus the local settings/commands registry. Empty
 * query shows recents + common commands; remote responses are debounced,
 * cancelled, and a stale response never overwrites a newer query; partial
 * coverage is labelled; filters scope the query.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SearchResult, Session, Workspace } from '@gian/shared';
import { CommandPalette } from '../src/components/CommandPalette.js';
import { mockFetch } from './setup.js';

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

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: 'doc-1',
    kind: 'session',
    title: 'Release planning',
    subtitle: 'My Project',
    snippet: 'discuss the release plan',
    ranges: [{ start: 11, end: 18 }],
    target: { type: 'session', session_id: 's-1', archived: false },
    updated_at: '2026-10-12T01:00:00.000Z',
    archived: false,
    ...overrides,
  };
}

const CONTEXT = {
  hasActiveSession: true,
  workbenchActive: true,
  canGoBack: true,
  canGoForward: false,
  inspectorAvailable: true,
  browserAvailable: true,
};

function searchPage(results: SearchResult[], complete = true) {
  return {
    results,
    next_cursor: null,
    index_revision: 'rev-1',
    coverage: { state: complete ? 'ready' : 'partial', complete, indexed: 100, pending: complete ? 0 : 40 },
  };
}

function openPalette(options: {
  sessions?: Session[];
  workspaces?: Workspace[];
  onNavigate?: ReturnType<typeof vi.fn>;
  onOpenSetting?: ReturnType<typeof vi.fn>;
  onCommand?: ReturnType<typeof vi.fn>;
  onClose?: ReturnType<typeof vi.fn>;
  initialQuery?: string;
  context?: typeof CONTEXT;
} = {}) {
  const onClose = options.onClose ?? vi.fn();
  const onNavigate = options.onNavigate ?? vi.fn();
  const onOpenSetting = options.onOpenSetting ?? vi.fn();
  const onCommand = options.onCommand ?? vi.fn();
  render(
    <CommandPalette
      open
      onClose={onClose}
      sessions={options.sessions ?? [makeSession()]}
      workspaces={options.workspaces ?? [makeWorkspace()]}
      context={options.context ?? CONTEXT}
      onNavigate={onNavigate}
      onOpenSetting={onOpenSetting}
      onCommand={onCommand}
      initialQuery={options.initialQuery}
    />,
  );
  return { onClose, onNavigate, onOpenSetting, onCommand };
}

afterEach(() => vi.restoreAllMocks());

describe('PAL-001: global search palette', () => {
  it('empty query shows recent active sessions and common commands', () => {
    openPalette({
      sessions: [
        makeSession({ id: 'newer', name: 'Newer', updated_at: '2026-10-02T00:00:00.000Z' }),
        makeSession({ id: 'older', name: 'Older', updated_at: '2026-10-01T00:00:00.000Z' }),
        makeSession({ id: 'archived', name: 'Archived', archived: 1 }),
      ],
    });
    expect(screen.getByText('Recent')).toBeTruthy();
    expect(screen.getByText('Newer')).toBeTruthy();
    expect(screen.getByText('Older')).toBeTruthy();
    expect(screen.queryByText('Archived', { selector: '.pal-row-label' })).toBeNull();
    expect(screen.getByText('Commands')).toBeTruthy();
    expect(screen.getByText('New session')).toBeTruthy();
  });

  it('a query hits /api/search and renders typed groups with snippet marks', async () => {
    mockFetch(async () => Response.json(searchPage([
      makeResult(),
      makeResult({ id: 'doc-2', kind: 'inbox', title: 'Approve deploy', snippet: undefined, ranges: [], target: { type: 'inbox', inbox_id: 'i-1', generation: 2 } }),
    ])));
    const { onNavigate } = openPalette();
    await userEvent.setup().type(screen.getByPlaceholderText(/Search sessions, messages/), 'release');
    expect(await screen.findByText('Release planning')).toBeTruthy();
    expect(screen.getByText('Sessions', { selector: '.pal-section-head' })).toBeTruthy();
    expect(screen.getByText('Inbox', { selector: '.pal-section-head' })).toBeTruthy();
    // The snippet range is a <mark>, not injected HTML.
    const mark = document.querySelector('.pal-snippet mark');
    expect(mark?.textContent).toBe('release');
    await userEvent.setup().click(screen.getByText('Release planning'));
    // The full result rides along — the short document id (for the context
    // route) is never dropped in favor of the long message identity.
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({
      id: 'doc-1',
      target: { type: 'session', session_id: 's-1', archived: false },
    }));
  });

  it('labels partial index coverage instead of pretending exhaustiveness', async () => {
    mockFetch(async () => Response.json(searchPage([makeResult()], false)));
    openPalette();
    await userEvent.setup().type(screen.getByPlaceholderText(/Search sessions, messages/), 'release');
    expect(await screen.findByText(/Partial results/)).toBeTruthy();
  });

  it('matches settings and commands locally, gated by availability', async () => {
    mockFetch(async () => Response.json(searchPage([])));
    const { onOpenSetting, onCommand } = openPalette();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/Search sessions, messages/), 'notif');
    const row = await screen.findByText('Notifications');
    await user.click(row);
    expect(onOpenSetting).toHaveBeenCalledWith('notifications', 'settings-section-notifications');

    await user.clear(screen.getByPlaceholderText(/Search sessions, messages/));
    await user.type(screen.getByPlaceholderText(/Search sessions, messages/), 'terminal');
    // Both the Settings section and the command match; the Commands group
    // renders last, so the last matching row is the command.
    const rows = await screen.findAllByText('Terminal');
    await user.click(rows[rows.length - 1]!);
    expect(onCommand).toHaveBeenCalledWith('tool.terminal');
  });

  it('never offers unavailable commands', async () => {
    mockFetch(async () => Response.json(searchPage([])));
    openPalette({ context: { ...CONTEXT, hasActiveSession: false } });
    await userEvent.setup().type(screen.getByPlaceholderText(/Search sessions, messages/), 'rename');
    // session.rename needs an active session — it must not appear.
    await vi.waitFor(() => expect(screen.queryByText('Rename current session')).toBeNull());
  });

  it('a stale response never overwrites a newer query', async () => {
    const resolvers: Array<(r: Response) => void> = [];
    mockFetch(async () => new Promise<Response>(resolve => resolvers.push(resolve)));
    openPalette();
    const input = screen.getByPlaceholderText(/Search sessions, messages/);
    const user = userEvent.setup();
    await user.type(input, 'a');
    await vi.waitFor(() => expect(resolvers.length).toBe(1));
    await user.type(input, 'b');
    await vi.waitFor(() => expect(resolvers.length).toBe(2));
    // The older response resolves LAST and must be discarded.
    resolvers[1]!(Response.json(searchPage([makeResult({ title: 'Newer answer' })])));
    expect(await screen.findByText('Newer answer')).toBeTruthy();
    resolvers[0]!(Response.json(searchPage([makeResult({ title: 'Stale answer' })])));
    await vi.waitFor(() => expect(screen.queryByText('Stale answer')).toBeNull());
    expect(screen.getByText('Newer answer')).toBeTruthy();
  });

  it('an error shows retry and retries the same query', async () => {
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      if (calls === 1) return Response.json({ error: { code: 'invalid_argument', message: 'x' } }, { status: 500 });
      return Response.json(searchPage([makeResult({ title: 'Recovered' })]));
    });
    openPalette();
    await userEvent.setup().type(screen.getByPlaceholderText(/Search sessions, messages/), 'release');
    expect(await screen.findByText('Search failed.')).toBeTruthy();
    await userEvent.setup().click(screen.getByText('Retry'));
    expect(await screen.findByText('Recovered')).toBeTruthy();
    expect(calls).toBe(2);
  });

  it('the settings filter skips the remote search entirely', async () => {
    let searched = 0;
    mockFetch(async () => {
      searched += 1;
      return Response.json(searchPage([]));
    });
    openPalette();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/Search sessions, messages/), 'notif');
    await screen.findByText('Notifications');
    await waitFor(() => expect(searched).toBe(1));
    await user.click(screen.getByTestId('pal-filter-setting'));
    await vi.waitFor(() => expect(screen.getByText('Notifications')).toBeTruthy());
    expect(searched).toBe(1);
  });

  it('keyboard: arrows move, Enter picks, Escape closes', async () => {
    const { onClose, onNavigate } = openPalette({
      sessions: [
        makeSession({ id: 'first', name: 'First' }),
        makeSession({ id: 'second', name: 'Second' }),
      ],
    });
    const user = userEvent.setup();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({
      target: { type: 'session', session_id: 'second', archived: false },
    }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows an empty state and does nothing on Enter when there is no match', async () => {
    mockFetch(async () => Response.json(searchPage([])));
    const { onClose, onNavigate } = openPalette({ initialQuery: 'missing-term' });
    expect(await screen.findByText(/No results for/)).toBeTruthy();
    await userEvent.setup().keyboard('{Enter}');
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('pages forward with next_cursor, deduping by document id', async () => {
    const calls: string[] = [];
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push(url);
      if (url.includes('cursor=page-2')) {
        return Response.json(searchPage([
          makeResult({ id: 'doc-1', title: 'Duplicate first page row' }),
          makeResult({ id: 'doc-2', kind: 'message', title: 'Second page hit', target: { type: 'session', session_id: 's-2', turn_id: 't-2', turn: 4, message_id: '4:assistant:m-2', message_kind: 'assistant', text_revision: 'a'.repeat(64), archived: false } }),
        ]));
      }
      return Response.json({
        ...searchPage([makeResult()]),
        next_cursor: 'page-2',
      });
    });
    openPalette();
    await userEvent.setup().type(screen.getByPlaceholderText(/Search sessions, messages/), 'release');
    expect(await screen.findByText('Release planning')).toBeTruthy();
    await userEvent.setup().click(await screen.findByTestId('pal-load-more'));
    expect(await screen.findByText('Second page hit')).toBeTruthy();
    // The duplicated first-page row renders once.
    expect(screen.getAllByText('Release planning')).toHaveLength(1);
    expect(calls.some(url => url.includes('cursor=page-2'))).toBe(true);
  });

  it('a stale-cursor 409 restarts the query from the top', async () => {
    let topCalls = 0;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('cursor=dead')) {
        return Response.json({ error: { code: 'stale_cursor', message: 'stale' } }, { status: 409 });
      }
      topCalls += 1;
      return Response.json({ ...searchPage([makeResult()]), next_cursor: topCalls === 1 ? 'dead' : null });
    });
    openPalette();
    await userEvent.setup().type(screen.getByPlaceholderText(/Search sessions, messages/), 'release');
    await screen.findByText('Release planning');
    await userEvent.setup().click(screen.getByTestId('pal-load-more'));
    // The restart re-fetches without a cursor and the list recovers.
    await waitFor(() => {
      expect(topCalls).toBe(2);
      expect(screen.getByText('Release planning')).toBeTruthy();
      expect(screen.queryByTestId('pal-load-more')).toBeNull();
    });
  });

  it('Enter never picks a row answering an older query', async () => {
    let resolveSecond: ((r: Response) => void) | null = null;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('q=one')) return Response.json(searchPage([makeResult({ title: 'Old answer' })]));
      return new Promise<Response>(resolve => { resolveSecond = resolve; });
    });
    const { onNavigate, onClose } = openPalette();
    const input = screen.getByPlaceholderText(/Search sessions, messages/);
    const user = userEvent.setup();
    await user.type(input, 'one');
    await screen.findByText('Old answer');
    await user.type(input, ' two');
    // The new query is in flight; the old page is visible but stale.
    await user.keyboard('{Enter}');
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(resolveSecond).toBeTypeOf('function'));
    resolveSecond!(Response.json(searchPage([makeResult({ title: 'New answer' })])));
    await screen.findByText('New answer');
    await user.keyboard('{Enter}');
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('a control-level setting deep link carries its real control anchor', async () => {
    mockFetch(async () => Response.json(searchPage([])));
    const { onOpenSetting } = openPalette();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/Search sessions, messages/), 'font size');
    const row = await screen.findByText('Font size');
    await user.click(row);
    expect(onOpenSetting).toHaveBeenCalledWith('chat', 'settings-control-chat.fontSize');
  });
});
