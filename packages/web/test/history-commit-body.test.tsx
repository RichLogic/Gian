import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HistoryCommitBody } from '../src/components/HistoryCommitBody.js';
import type { GitHistoryCommitDetail, GitHistoryFileDiff } from '../src/api.js';
import type { SheetTab } from '../src/components/sheet-model.js';
import * as api from '../src/api.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    loadGitHistoryCommit: vi.fn(),
    loadGitHistoryFileDiff: vi.fn(),
  };
});

const loadGitHistoryCommit = vi.mocked(api.loadGitHistoryCommit);
const loadGitHistoryFileDiff = vi.mocked(api.loadGitHistoryFileDiff);

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

const DIFF: GitHistoryFileDiff = {
  sha: 'c0ffee1', base: 'ba5e1', path: 'src/a.ts',
  diff: [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,3 @@',
    ' const a = 1;',
    '+const b = 2;',
    ' const c = 3;',
  ].join('\n'),
  truncated: false,
};

function detail(partial: Partial<GitHistoryCommitDetail> = {}): GitHistoryCommitDetail {
  return {
    sha: 'c0ffee1full',
    parents: ['ba5e1full'],
    author: { name: 'Rich', email: 'rich@example.com' },
    authoredAt: new Date().toISOString(),
    committedAt: new Date().toISOString(),
    subject: 'feat: wire history rail',
    bodyPreview: '',
    body: '',
    refs: [{ name: 'refs/heads/main', shortName: 'main', kind: 'local', target: 'c0ffee1full' }],
    isMerge: false,
    isRoot: false,
    base: 'ba5e1full',
    files: [
      { path: 'src/a.ts', status: 'modified', added: 3, removed: 1, binary: false },
      { path: 'assets/logo.icns', status: 'modified', added: 0, removed: 0, binary: true },
    ],
    ...partial,
  };
}

function tab(partial: Partial<SheetTab> = {}): SheetTab {
  return {
    id: 'tab-commit-1',
    group: 'history',
    kind: 'commit',
    icoKind: 'commit',
    ico: '',
    name: 'c0ffee1 · feat: wire history rail',
    workingTreeId: 'ws:demo',
    commitSha: 'c0ffee1full',
    ...partial,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeIO.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeIO);
  loadGitHistoryCommit.mockResolvedValue(detail());
  loadGitHistoryFileDiff.mockResolvedValue(DIFF);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HistoryCommitBody', () => {
  it('renders the commit header (subject, author, refs, parents, stats)', async () => {
    render(<HistoryCommitBody tab={tab()} onOpenCommit={() => {}} />);
    await waitFor(() => expect(document.querySelector('.cs-subject')?.textContent).toBe('feat: wire history rail'));
    expect(screen.getByText('Rich')).toBeTruthy();
    expect(screen.getByText('main')).toBeTruthy();
    expect(screen.getByText('ba5e1fu')).toBeTruthy(); // parent chip
    expect(screen.getByText(/2 files/)).toBeTruthy();
    expect(document.querySelector('.cs-stats .add')?.textContent).toBe('+3');
    expect(document.querySelector('.cs-stats .del')?.textContent).toBe('−1');
  });

  it('file patches load lazily — only after the block intersects', async () => {
    render(<HistoryCommitBody tab={tab()} onOpenCommit={() => {}} />);
    await waitFor(() => expect(document.querySelector('.cs-subject')?.textContent).toBe('feat: wire history rail'));
    // skeletons rendered, nothing fetched yet (no intersection)
    expect(document.querySelectorAll('.sk').length).toBe(1); // binary file shows a note, not a skeleton
    expect(loadGitHistoryFileDiff).not.toHaveBeenCalled();
    act(() => {
      FakeIO.instances[0]!.trigger();
      // Repeated observer delivery while the request is pending must not
      // start a duplicate patch request.
      FakeIO.instances[0]!.trigger();
    });
    await waitFor(() => expect(loadGitHistoryFileDiff).toHaveBeenCalledWith('ws:demo', 'c0ffee1full', 'src/a.ts'));
    expect(loadGitHistoryFileDiff).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.querySelectorAll('.sheet-diff-ln.add').length).toBe(1));
  });

  it('binary files never fetch — they render the binary note', async () => {
    render(<HistoryCommitBody tab={tab()} onOpenCommit={() => {}} />);
    await screen.findByText('Binary file — no textual diff.');
    expect(loadGitHistoryFileDiff).not.toHaveBeenCalled();
  });

  it('per-file failure offers retry without touching other files', async () => {
    loadGitHistoryFileDiff.mockRejectedValueOnce(new Error('git died'));
    render(<HistoryCommitBody tab={tab()} onOpenCommit={() => {}} />);
    await waitFor(() => expect(document.querySelector('.cs-subject')?.textContent).toBe('feat: wire history rail'));
    act(() => FakeIO.instances[0]!.trigger());
    await screen.findByText("Couldn't load this file's diff.");
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(document.querySelectorAll('.sheet-diff-ln.add').length).toBe(1));
    expect(loadGitHistoryFileDiff).toHaveBeenCalledTimes(2);
  });

  it('truncated patches render the host-truncation note', async () => {
    loadGitHistoryFileDiff.mockResolvedValue({ ...DIFF, truncated: true });
    render(<HistoryCommitBody tab={tab()} onOpenCommit={() => {}} />);
    await waitFor(() => expect(document.querySelector('.cs-subject')?.textContent).toBe('feat: wire history rail'));
    act(() => FakeIO.instances[0]!.trigger());
    await screen.findByText(/truncated/);
  });

  it('merge commits pin the first-parent base strip; root commits the empty-tree note', async () => {
    loadGitHistoryCommit.mockResolvedValueOnce(detail({ isMerge: true, parents: ['p1first', 'p2second'] }));
    const { unmount } = render(<HistoryCommitBody tab={tab()} onOpenCommit={() => {}} />);
    await screen.findByText(/Diff vs first parent/);
    expect(screen.getByText('p1first')).toBeTruthy();
    expect(screen.getByText('p2secon')).toBeTruthy();
    unmount();

    loadGitHistoryCommit.mockResolvedValueOnce(detail({ isRoot: true, parents: [], isMerge: false }));
    render(<HistoryCommitBody tab={tab({ id: 't3' })} onOpenCommit={() => {}} />);
    await screen.findByText(/empty tree/);
    expect(screen.getByText(/none \(root commit\)/)).toBeTruthy();
  });

  it('clicking a parent chip opens that commit as a preview', async () => {
    const onOpenCommit = vi.fn();
    render(<HistoryCommitBody tab={tab()} onOpenCommit={onOpenCommit} />);
    await waitFor(() => expect(document.querySelector('.cs-subject')?.textContent).toBe('feat: wire history rail'));
    fireEvent.click(screen.getByText('ba5e1fu'));
    expect(onOpenCommit).toHaveBeenCalledWith({ sha: 'ba5e1full' }, false);
  });

  it('orphaned tabs show the snapshot banner', async () => {
    render(<HistoryCommitBody tab={tab({ orphaned: true })} onOpenCommit={() => {}} />);
    await screen.findByText(/no longer reachable/);
  });

  it('file blocks collapse and expand', async () => {
    render(<HistoryCommitBody tab={tab()} onOpenCommit={() => {}} />);
    await waitFor(() => expect(document.querySelector('.cs-subject')?.textContent).toBe('feat: wire history rail'));
    const head = document.querySelector('.cs-file-head')!;
    fireEvent.click(head);
    expect(document.querySelector('.cs-file.collapsed')).toBeTruthy();
    fireEvent.click(head);
    expect(document.querySelector('.cs-file.collapsed')).toBeNull();
  });

  it('replacing a preview commit reloads a same-path patch instead of reusing the old one', async () => {
    loadGitHistoryCommit.mockImplementation(async (_workingTreeId, sha) => detail({
      sha,
      subject: sha === 'first-full' ? 'first preview' : 'second preview',
      files: [{ path: 'src/a.ts', status: 'modified', added: 1, removed: 0, binary: false }],
    }));
    loadGitHistoryFileDiff.mockImplementation(async (_workingTreeId, sha) => ({
      ...DIFF,
      sha,
      diff: [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -0,0 +1 @@',
        sha === 'first-full' ? '+FIRST_PATCH' : '+SECOND_PATCH',
      ].join('\n'),
    }));

    const { rerender } = render(
      <HistoryCommitBody
        tab={tab({ commitSha: 'first-full', name: 'first' })}
        onOpenCommit={() => {}}
      />,
    );
    await waitFor(() => expect(document.querySelector('.cs-subject')?.textContent).toBe('first preview'));
    act(() => FakeIO.instances.at(-1)!.trigger());
    await screen.findByText('FIRST_PATCH');

    rerender(
      <HistoryCommitBody
        tab={tab({ commitSha: 'second-full', name: 'second' })}
        onOpenCommit={() => {}}
      />,
    );
    await waitFor(() => expect(document.querySelector('.cs-subject')?.textContent).toBe('second preview'));
    expect(screen.queryByText('FIRST_PATCH')).toBeNull();
    act(() => FakeIO.instances.at(-1)!.trigger());
    await screen.findByText('SECOND_PATCH');
    expect(loadGitHistoryFileDiff).toHaveBeenLastCalledWith('ws:demo', 'second-full', 'src/a.ts');
  });

  it('a late detail response cannot overwrite a newer preview commit', async () => {
    const first = deferred<GitHistoryCommitDetail>();
    const second = deferred<GitHistoryCommitDetail>();
    loadGitHistoryCommit.mockImplementation((_workingTreeId, sha) =>
      sha === 'first-full' ? first.promise : second.promise);

    const { rerender } = render(
      <HistoryCommitBody
        tab={tab({ commitSha: 'first-full', name: 'first' })}
        onOpenCommit={() => {}}
      />,
    );
    rerender(
      <HistoryCommitBody
        tab={tab({ commitSha: 'second-full', name: 'second' })}
        onOpenCommit={() => {}}
      />,
    );
    await act(async () => second.resolve(detail({ sha: 'second-full', subject: 'second wins' })));
    await waitFor(() => expect(document.querySelector('.cs-subject')?.textContent).toBe('second wins'));
    await act(async () => first.resolve(detail({ sha: 'first-full', subject: 'late first' })));
    expect(screen.queryByText('late first')).toBeNull();
    expect(document.querySelector('.cs-subject')?.textContent).toBe('second wins');
  });
});
