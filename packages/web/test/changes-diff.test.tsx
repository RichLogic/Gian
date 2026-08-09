/**
 * Diffs rail multi-diff view (ChangesDiffBody + use-changes-diff store):
 * lazy per-file patches, collapse-all, anchor jumps, silent refetch on
 * git invalidation, per-block error retry, binary/truncation notes.
 * Modeled on history-commit-body.test.tsx (same FakeIO pattern).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChangesDiffBody } from '../src/components/ChangesDiffBody.js';
import type { ChangedEntry, WorkingTree } from '../src/api.js';
import * as api from '../src/api.js';
import {
  __resetChangesDiffForTests,
  getChangesDiffState,
  invalidateAllChangesDiffs,
  requestChangesDiffAnchor,
  setChangesDiffScope,
  toggleChangesDiffCollapsed,
} from '../src/controllers/use-changes-diff.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    loadChanged: vi.fn(),
    loadDiff: vi.fn(),
  };
});

const loadChanged = vi.mocked(api.loadChanged);
const loadDiff = vi.mocked(api.loadDiff);

/* Controllable IntersectionObserver — jsdom has none. */
class FakeIO {
  static instances: FakeIO[] = [];
  cb: IntersectionObserverCallback;
  el: Element | null = null;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    FakeIO.instances.push(this);
  }
  observe(el: Element) { this.el = el; }
  unobserve() {}
  disconnect() {}
  trigger() { this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
}

const tree: WorkingTree = {
  id: 'ws:demo', kind: 'workspace', label: 'demo', path: '/tmp/demo',
  branch: 'main', workspace_id: 'demo', workspace_name: 'demo',
  session_id: null, session_name: null,
};

const FILES: ChangedEntry[] = [
  { path: 'src/a.ts', kind: 'update', staged: false, added: 3, removed: 1 },
  { path: 'src/b.ts', kind: 'create', staged: false, added: 5, removed: 0 },
];

const DIFF_A = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' const a = 1;',
  '+const b = 2;',
  ' const c = 3;',
].join('\n');

function renderBody(workingTreeId: string | null = 'ws:demo') {
  return render(<ChangesDiffBody workingTreeId={workingTreeId} tree={workingTreeId ? tree : null} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetChangesDiffForTests();
  localStorage.clear();
  FakeIO.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeIO);
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  loadChanged.mockResolvedValue(FILES);
  loadDiff.mockResolvedValue({ diff: DIFF_A, truncated: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChangesDiffBody', () => {
  it('renders the scope header (title, tree meta, totals) once the list loads', async () => {
    renderBody();
    await waitFor(() => expect(document.querySelector('.cs-subject')?.textContent).toBe('Branch'));
    // Default scope, tree label + branch, and the auto-base hint.
    expect(document.querySelector('.cs-meta')?.textContent).toContain('demo · main');
    expect(document.querySelector('.cs-meta')?.textContent).toContain('main →');
    expect(screen.getByText(/2 files/)).toBeTruthy();
    expect(document.querySelector('.cs-stats .add')?.textContent).toBe('+8');
    expect(document.querySelector('.cs-stats .del')?.textContent).toBe('−1');
    expect(loadChanged).toHaveBeenCalledWith('ws:demo', 'branch', null, null, null, undefined);
  });

  it('shows the no-working-tree empty state', () => {
    renderBody(null);
    expect(screen.getByText('Open a session or workspace to review its changes.')).toBeTruthy();
    expect(loadChanged).not.toHaveBeenCalled();
  });

  it('shows the scope empty state when nothing changed', async () => {
    loadChanged.mockResolvedValue([]);
    renderBody();
    await screen.findByText('No changes in this scope.');
  });

  it('file patches load lazily — only after the block intersects', async () => {
    renderBody();
    await waitFor(() => expect(document.querySelectorAll('.cs-file').length).toBe(2));
    // Skeletons rendered, nothing fetched yet (no intersection).
    expect(document.querySelectorAll('.sk').length).toBe(2);
    expect(loadDiff).not.toHaveBeenCalled();
    act(() => {
      FakeIO.instances[0]!.trigger();
      // Repeated delivery while pending must not start a duplicate request.
      FakeIO.instances[0]!.trigger();
    });
    await waitFor(() => expect(loadDiff).toHaveBeenCalledWith('ws:demo', 'src/a.ts', 'branch', null, null));
    expect(loadDiff).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.querySelectorAll('.sheet-diff-ln.add').length).toBe(1));
  });

  it('per-file failure offers retry without touching other files', async () => {
    loadDiff.mockRejectedValueOnce(new Error('git died'));
    renderBody();
    await waitFor(() => expect(document.querySelectorAll('.cs-file').length).toBe(2));
    act(() => FakeIO.instances[0]!.trigger());
    await screen.findByText("Couldn't load this file's diff.");
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(document.querySelectorAll('.sheet-diff-ln.add').length).toBe(1));
    expect(loadDiff).toHaveBeenCalledTimes(2);
  });

  it('truncated patches render the host-truncation note', async () => {
    loadDiff.mockResolvedValue({ diff: DIFF_A, truncated: true });
    renderBody();
    await waitFor(() => expect(document.querySelectorAll('.cs-file').length).toBe(2));
    act(() => FakeIO.instances[0]!.trigger());
    await screen.findByText(/truncated/);
  });

  it('binary patches render the binary note instead of the diff body', async () => {
    loadDiff.mockResolvedValue({ diff: 'Binary files a/logo.icns and b/logo.icns differ', truncated: false });
    renderBody();
    await waitFor(() => expect(document.querySelectorAll('.cs-file').length).toBe(2));
    act(() => FakeIO.instances[0]!.trigger());
    await screen.findByText('Binary file — no textual diff.');
  });

  it('the toolbar collapse-all toggle folds and restores every file block', async () => {
    renderBody();
    await waitFor(() => expect(document.querySelectorAll('.cs-file').length).toBe(2));
    fireEvent.click(screen.getByLabelText('Collapse all files'));
    expect(document.querySelectorAll('.cs-file.collapsed').length).toBe(2);
    fireEvent.click(screen.getByLabelText('Expand all files'));
    expect(document.querySelectorAll('.cs-file.collapsed').length).toBe(0);
  });

  it('the split toggle persists to the shared localStorage key', async () => {
    renderBody();
    await waitFor(() => expect(document.querySelectorAll('.cs-file').length).toBe(2));
    act(() => FakeIO.instances[0]!.trigger());
    await waitFor(() => expect(document.querySelectorAll('.sheet-diff-ln.add').length).toBe(1));
    expect(document.querySelector('.sheet-diff')).not.toHaveClass('split');
    fireEvent.click(screen.getByLabelText('Side-by-side view'));
    expect(document.querySelector('.sheet-diff')).toHaveClass('split');
    expect(localStorage.getItem('gian.sheet.diffsplit')).toBe('on');
  });

  it('collapse state survives a scope switch while patches are dropped', async () => {
    renderBody();
    await waitFor(() => expect(document.querySelectorAll('.cs-file').length).toBe(2));
    act(() => FakeIO.instances[0]!.trigger());
    await waitFor(() => expect(getChangesDiffState('ws:demo').patches['src/a.ts']?.status).toBe('loaded'));

    // Collapse one block, then switch scope: the fold stays, the patch cache
    // is dropped (same path under another comparison is a different diff).
    fireEvent.click(document.querySelector('.cs-file[data-path="src/a.ts"] .cs-file-head')!);
    expect(document.querySelectorAll('.cs-file.collapsed').length).toBe(1);
    act(() => setChangesDiffScope('ws:demo', 'all'));
    await waitFor(() => expect(loadChanged).toHaveBeenCalledWith('ws:demo', 'all', null, null, null, undefined));
    expect(document.querySelectorAll('.cs-file.collapsed').length).toBe(1);
    expect(getChangesDiffState('ws:demo').patches['src/a.ts']).toBeUndefined();
    expect(localStorage.getItem('gian.changes.scope')).toBe('all');
    expect(document.querySelector('.cs-subject')?.textContent).toBe('All changes');
  });

  it('an anchor request expands the block and scrolls it into view', async () => {
    renderBody();
    await waitFor(() => expect(document.querySelectorAll('.cs-file').length).toBe(2));
    act(() => toggleChangesDiffCollapsed('ws:demo', 'src/b.ts'));
    expect(document.querySelector('.cs-file[data-path="src/b.ts"]')).toHaveClass('collapsed');

    act(() => requestChangesDiffAnchor('ws:demo', 'src/b.ts'));
    await waitFor(() => {
      expect(document.querySelector('.cs-file[data-path="src/b.ts"]')).not.toHaveClass('collapsed');
    });
    await waitFor(() => expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled());
    expect(vi.mocked(window.HTMLElement.prototype.scrollIntoView).mock.calls[0]![0])
      .toEqual({ block: 'start' });
    // The store slot is one-shot — consumed by the mounted body.
    expect(getChangesDiffState('ws:demo').anchor).toBeNull();
  });

  it('git invalidation refetches the list and silently re-loads stale patches', async () => {
    renderBody();
    await waitFor(() => expect(document.querySelectorAll('.cs-file').length).toBe(2));
    act(() => FakeIO.instances[0]!.trigger());
    await waitFor(() => expect(getChangesDiffState('ws:demo').patches['src/a.ts']?.status).toBe('loaded'));
    const listCalls = loadChanged.mock.calls.length;

    act(() => invalidateAllChangesDiffs());
    await waitFor(() => expect(loadChanged.mock.calls.length).toBeGreaterThan(listCalls));
    // Loaded patch went back to idle (stale) — collapse state untouched, no
    // error surface.
    await waitFor(() => expect(getChangesDiffState('ws:demo').patches['src/a.ts']?.status).toBe('idle'));
    // The visible block's observer re-fires and lazily refetches the patch.
    const io = FakeIO.instances.at(-1)!;
    act(() => io.trigger());
    await waitFor(() => expect(getChangesDiffState('ws:demo').patches['src/a.ts']?.status).toBe('loaded'));
    expect(loadDiff).toHaveBeenCalledTimes(2);
  });

  it('a list load failure shows the error state with a working retry', async () => {
    loadChanged.mockRejectedValueOnce(new Error('host down'));
    renderBody();
    await screen.findByText('host down');
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(document.querySelectorAll('.cs-file').length).toBe(2));
    expect(loadChanged).toHaveBeenCalledTimes(2);
  });
});
