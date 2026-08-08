import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, fireEvent, waitFor } from '@testing-library/react';
import { HistoryInspector } from '../src/components/HistoryInspector.js';
import { renderWithOperations } from './operation-test-utils.js';
import {
  GitHistoryRequestError,
  type GitHistoryCommit,
  type GitHistoryPage,
} from '../src/api.js';
import * as api from '../src/api.js';
import {
  getHistoryState,
  reconcileHistoryAfterFetch,
} from '../src/controllers/use-history.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    loadGitHistory: vi.fn(),
    loadGitHistoryCommit: vi.fn(),
    loadGitHistoryFileDiff: vi.fn(),
    fetchGitHistory: vi.fn(),
  };
});

const loadGitHistory = vi.mocked(api.loadGitHistory);
const fetchGitHistory = vi.mocked(api.fetchGitHistory);

let seq = 0;
function commit(partial: Partial<GitHistoryCommit> & { sha: string }): GitHistoryCommit {
  seq += 1;
  return {
    parents: [],
    author: { name: 'Rich', email: 'rich@example.com' },
    authoredAt: new Date(Date.now() - seq * 3600_000).toISOString(),
    committedAt: new Date(Date.now() - seq * 3600_000).toISOString(),
    subject: `commit ${seq}`,
    bodyPreview: '',
    refs: [],
    isMerge: false,
    isRoot: false,
    ...partial,
  };
}

function page(partial: Partial<GitHistoryPage> = {}): GitHistoryPage {
  return {
    items: [],
    nextCursor: null,
    snapshot: 'snap1',
    currentRef: 'refs/heads/main',
    headSha: 'snap1',
    selectedRef: 'refs/heads/main',
    availableRefs: [
      { name: 'refs/heads/main', shortName: 'main', kind: 'local', target: 'x' },
      { name: 'refs/remotes/origin/main', shortName: 'origin/main', kind: 'remote', target: 'x' },
      { name: 'refs/tags/v0.3.0', shortName: 'v0.3.0', kind: 'tag', target: 'y' },
    ],
    availableAuthors: [
      { name: 'Rich', email: 'rich@example.com' },
      { name: 'Codex', email: 'codex@example.com' },
    ],
    ...partial,
  };
}

/** The use-history store is module-level and keyed by tree — a fresh tree id
 *  per test keeps cases isolated. */
let treeSeq = 0;
function nextTree(): string {
  treeSeq += 1;
  return `ws:history-test-${treeSeq}`;
}

function renderInspector(workingTreeId: string, onOpenCommit = vi.fn()) {
  const result = renderWithOperations(
    <HistoryInspector workingTreeId={workingTreeId} selectedSha={null} onOpenCommit={onOpenCommit} />,
  );
  return { onOpenCommit, ...result };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchGitHistory.mockResolvedValue({ ok: true, fetchedAt: new Date().toISOString(), refsChanged: false, coalesced: false });
});

describe('HistoryInspector', () => {
  it('renders the timeline with graph, refs chips, and type tags', async () => {
    const wt = nextTree();
    loadGitHistory.mockResolvedValue(page({
      headSha: 'aaa111',
      items: [
        commit({ sha: 'aaa111', subject: 'tip commit', refs: [{ name: 'refs/heads/main', shortName: 'main', kind: 'local', target: 'aaa111' }], parents: ['bbb222'] }),
        commit({ sha: 'bbb222', subject: 'merge commit', isMerge: true, parents: ['ccc333', 'ddd444'] }),
        commit({ sha: 'ccc333', subject: 'older', isRoot: true }),
      ],
    }));
    renderInspector(wt);
    await screen.findByText('tip commit');
    expect(document.querySelectorAll('.h-row').length).toBe(3);
    expect(document.querySelector('.h-row .g svg')).toBeTruthy();
    expect(document.querySelector('.h-ref.local')?.textContent).toContain('main');
    expect(document.querySelector('.h-ref.head')?.textContent).toContain('HEAD');
    expect(screen.getByText('MERGE')).toBeTruthy();
    expect(screen.getByText('ROOT')).toBeTruthy();
    // day band present (all fixtures land today/yesterday)
    expect(document.querySelector('.h-day')).toBeTruthy();
  });

  it('single click opens a preview, double click pins', async () => {
    const wt = nextTree();
    const c1 = commit({ sha: 'aaa111', subject: 'clickable' });
    loadGitHistory.mockResolvedValue(page({ items: [c1] }));
    const { onOpenCommit } = renderInspector(wt);
    const row = await screen.findByText('clickable');
    fireEvent.click(row.closest('.h-row')!);
    expect(onOpenCommit).toHaveBeenCalledWith({ sha: 'aaa111', subject: 'clickable' }, false);
    fireEvent.doubleClick(row.closest('.h-row')!);
    expect(onOpenCommit).toHaveBeenCalledWith({ sha: 'aaa111', subject: 'clickable' }, true);
  });

  it('branch and author filters refetch with the full ref / email', async () => {
    const wt = nextTree();
    loadGitHistory.mockResolvedValue(page({ items: [commit({ sha: 'aaa111', subject: 'seed commit' })] }));
    renderInspector(wt);
    await screen.findByText('seed commit');
    // branch filter
    fireEvent.click(document.querySelector('.h-filters .h-chip')!);
    const menu = document.querySelector('.h-menu')!;
    const tagItem = Array.from(menu.querySelectorAll('button')).find(b => b.textContent?.includes('v0.3.0'))!;
    fireEvent.click(tagItem);
    await waitFor(() => expect(loadGitHistory).toHaveBeenLastCalledWith(wt, expect.objectContaining({ ref: 'refs/tags/v0.3.0' })));
    // author filter
    const chips = document.querySelectorAll('.h-filters .h-chip');
    fireEvent.click(chips[1]!);
    const authorMenu = document.querySelector('.h-menu')!;
    const codex = Array.from(authorMenu.querySelectorAll('button')).find(b => b.textContent?.includes('Codex'))!;
    fireEvent.click(codex);
    await waitFor(() => expect(loadGitHistory).toHaveBeenLastCalledWith(wt, expect.objectContaining({ author: 'codex@example.com' })));
  });

  it('search debounces into a q query', async () => {
    const wt = nextTree();
    loadGitHistory.mockResolvedValue(page({ items: [commit({ sha: 'aaa111', subject: 'seed commit' })] }));
    renderInspector(wt);
    await screen.findByText('seed commit');
    fireEvent.change(document.querySelector('.insp-search input')!, { target: { value: 'oauth' } });
    await waitFor(() => expect(loadGitHistory).toHaveBeenLastCalledWith(wt, expect.objectContaining({ q: 'oauth' })), { timeout: 1500 });
  });

  it('load more appends the next cursor page; failure offers retry', async () => {
    const wt = nextTree();
    loadGitHistory
      .mockResolvedValueOnce(page({ items: [commit({ sha: 'aaa111', subject: 'page one' })], nextCursor: 'cur1' }))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(page({ items: [commit({ sha: 'bbb222', subject: 'page two' })], nextCursor: null }));
    renderInspector(wt);
    await screen.findByText('page one');
    fireEvent.click(screen.getByTestId('history-load-more'));
    await screen.findByText("Couldn't load older commits.");
    fireEvent.click(screen.getByText('Retry'));
    await screen.findByText('page two');
    expect(screen.queryByTestId('history-load-more')).toBeNull();
  });

  it('keeps the previous page visible and reports a refresh failure', async () => {
    const wt = nextTree();
    loadGitHistory
      .mockResolvedValueOnce(page({ items: [commit({ sha: 'aaa111', subject: 'cached commit' })] }))
      .mockRejectedValueOnce(new Error('refresh unavailable'))
      .mockResolvedValueOnce(page({ items: [commit({ sha: 'bbb222', subject: 'fresh commit' })] }));
    renderInspector(wt);
    await screen.findByText('cached commit');

    fireEvent.click(screen.getByLabelText('Refresh — re-read local history (no network)'));
    await screen.findByText("Couldn't load history.");
    expect(screen.getByText('cached commit')).toBeTruthy();

    fireEvent.click(screen.getByText('Retry'));
    await screen.findByText('fresh commit');
    expect(screen.queryByText("Couldn't load history.")).toBeNull();
  });

  it('a stale cursor reloads page 1 and raises the moved strip', async () => {
    const wt = nextTree();
    loadGitHistory
      .mockResolvedValueOnce(page({ items: [commit({ sha: 'aaa111', subject: 'stale page' })], nextCursor: 'cur1' }))
      .mockRejectedValueOnce(new GitHistoryRequestError({ code: 'history_cursor_stale', message: 'stale', status: 409 }))
      .mockResolvedValueOnce(page({ items: [commit({ sha: 'ccc333', subject: 'fresh page' })] }));
    renderInspector(wt);
    await screen.findByText('stale page');
    fireEvent.click(screen.getByTestId('history-load-more'));
    await screen.findByText('fresh page');
    expect(document.querySelector('.h-moved')).toBeTruthy();
    // dismiss
    fireEvent.click(document.querySelector('.h-moved .lnk')!);
    expect(document.querySelector('.h-moved')).toBeNull();
  });

  it('fetch success with refsChanged reloads the timeline', async () => {
    const wt = nextTree();
    loadGitHistory.mockResolvedValue(page({ items: [commit({ sha: 'aaa111', subject: 'before fetch' })] }));
    fetchGitHistory.mockResolvedValue({ ok: true, fetchedAt: new Date().toISOString(), refsChanged: true, coalesced: false });
    renderInspector(wt);
    await screen.findByText('before fetch');
    const callsBefore = loadGitHistory.mock.calls.length;
    fireEvent.click(screen.getByTestId('history-fetch'));
    await waitFor(() => expect(loadGitHistory.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(document.querySelector('.h-moved')).toBeTruthy();
  });

  it('fetch success without ref changes still discards cursor state and reloads page 1', async () => {
    const wt = nextTree();
    loadGitHistory.mockResolvedValue(page({ items: [commit({ sha: 'aaa111', subject: 'unchanged fetch' })] }));
    fetchGitHistory.mockResolvedValue({ ok: true, fetchedAt: new Date().toISOString(), refsChanged: false, coalesced: false });
    renderInspector(wt);
    await screen.findByText('unchanged fetch');
    const callsBefore = loadGitHistory.mock.calls.length;
    fireEvent.click(screen.getByTestId('history-fetch'));
    await waitFor(() => expect(loadGitHistory.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(document.querySelector('.h-moved')).toBeNull();
  });

  it('fetch auth failure renders the dedicated bar with retry', async () => {
    const wt = nextTree();
    loadGitHistory.mockResolvedValue(page({ items: [commit({ sha: 'aaa111' })] }));
    fetchGitHistory.mockRejectedValue(new GitHistoryRequestError({
      code: 'git_authentication_failed', message: "could not read Username", retryable: true, status: 500,
    }));
    loadGitHistory.mockResolvedValue(page({ items: [commit({ sha: 'aaa111', subject: 'seed commit' })] }));
    renderInspector(wt);
    await screen.findByText('seed commit');
    fireEvent.click(screen.getByTestId('history-fetch'));
    await screen.findByText('Authentication failed');
    expect(document.querySelector('.h-fetchbar.err .btn')?.textContent).toBe('Retry');
  });

  it('fetch unknown outcome renders the pending-confirmation bar (never "rolled back")', async () => {
    const wt = nextTree();
    loadGitHistory.mockResolvedValue(page({ items: [commit({ sha: 'aaa111' })] }));
    fetchGitHistory.mockRejectedValue(new GitHistoryRequestError({
      code: 'git_command_failed', message: 'died mid-fetch', unknownOutcome: true, refsChanged: true, status: 500,
    }));
    loadGitHistory.mockResolvedValue(page({ items: [commit({ sha: 'aaa111', subject: 'seed commit' })] }));
    renderInspector(wt);
    await screen.findByText('seed commit');
    fireEvent.click(screen.getByTestId('history-fetch'));
    await screen.findByText(/outcome unknown/);
    expect(document.querySelector('.h-fetchbar.warn')).toBeTruthy();
  });

  it('a later generic Fetch failure does not inherit an earlier auth classification', async () => {
    const wt = nextTree();
    loadGitHistory.mockResolvedValue(page({ items: [commit({ sha: 'aaa111', subject: 'seed commit' })] }));
    fetchGitHistory.mockRejectedValueOnce(new GitHistoryRequestError({
      code: 'git_authentication_failed', message: 'auth denied', status: 502,
    })).mockRejectedValueOnce(new Error('network offline'));
    renderInspector(wt);
    await screen.findByText('seed commit');
    fireEvent.click(screen.getByTestId('history-fetch'));
    await screen.findByText('Authentication failed');
    fireEvent.click(screen.getByText('Retry'));
    await screen.findByText('Fetch failed.');
    expect(screen.queryByText('Authentication failed')).toBeNull();
    expect(screen.getByText('network offline')).toBeTruthy();
  });

  it('search drafts and Fetch outcomes do not leak when the viewed worktree changes', async () => {
    const treeA = nextTree();
    const treeB = nextTree();
    loadGitHistory.mockImplementation(async workingTreeId => page({
      items: [commit({
        sha: workingTreeId === treeA ? 'aaa111' : 'bbb222',
        subject: workingTreeId === treeA ? 'tree A commit' : 'tree B commit',
      })],
    }));
    const pendingFetch = deferred<never>();
    fetchGitHistory.mockReturnValueOnce(pendingFetch.promise);
    const rendered = renderInspector(treeA);
    await screen.findByText('tree A commit');
    fireEvent.change(document.querySelector('.insp-search input')!, { target: { value: 'only-tree-a' } });
    fireEvent.click(screen.getByTestId('history-fetch'));

    rendered.rerender(
      <HistoryInspector workingTreeId={treeB} selectedSha={null} onOpenCommit={rendered.onOpenCommit} />,
    );
    await screen.findByText('tree B commit');
    expect((document.querySelector('.insp-search input') as HTMLInputElement).value).toBe('');
    await act(async () => pendingFetch.reject(new GitHistoryRequestError({
      code: 'git_authentication_failed', message: 'tree A auth', status: 502,
    })));
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(screen.queryByText('Authentication failed')).toBeNull();
    expect(loadGitHistory.mock.calls.some(([id, options]) =>
      id === treeB && options?.q === 'only-tree-a')).toBe(false);
  });

  it('each ref rewrite advances the orphan-revalidation revision even before dismiss', async () => {
    const wt = nextTree();
    loadGitHistory.mockResolvedValue(page({ items: [commit({ sha: 'aaa111' })] }));
    const before = getHistoryState(wt).movementRevision;
    act(() => reconcileHistoryAfterFetch(wt, true));
    const first = getHistoryState(wt).movementRevision;
    act(() => reconcileHistoryAfterFetch(wt, true));
    const second = getHistoryState(wt).movementRevision;
    expect(first).toBe(before + 1);
    expect(second).toBe(first + 1);
    expect(getHistoryState(wt).moved).toBe(true);
  });

  it('empty repo and detached HEAD have their own states', async () => {
    const wtEmpty = nextTree();
    loadGitHistory.mockResolvedValueOnce(page({ snapshot: null, currentRef: 'refs/heads/empty', headSha: null, items: [] }));
    const { unmount } = renderInspector(wtEmpty);
    await screen.findByText('No commits yet');
    unmount();

    const wtDetached = nextTree();
    loadGitHistory.mockResolvedValueOnce(page({ currentRef: null, headSha: 'de7ached0abc', snapshot: 'other-ref-tip', items: [commit({ sha: 'de7ached0abc', subject: 'detached tip' })] }));
    renderInspector(wtDetached);
    await screen.findByText('detached tip');
    expect(document.querySelector('.h-detached')?.textContent).toContain('de7ache');
  });

  it('no search results shows the empty state with a clear affordance', async () => {
    const wt = nextTree();
    loadGitHistory.mockResolvedValue(page({ items: [] }));
    renderInspector(wt);
    fireEvent.change(document.querySelector('.insp-search input')!, { target: { value: 'zzz' } });
    await screen.findByText(/No commits match/);
    await screen.findByText('Clear search & filters');
  });
});
