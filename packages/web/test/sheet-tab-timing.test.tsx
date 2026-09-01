/**
 * Query-timing tests (proposal §4.5, Phase 3b): file/diff Sheet tabs are
 * created and selected IMMEDIATELY with a loading body — before
 * loadFile/loadDiff resolves — then filled on success or landed in an error
 * state with a working retry on failure. Plus the Files-inspector row-level
 * loader while a folder's loadTree is in flight.
 */
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { GianBrowserApi, Session, Workspace } from '@gian/shared';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/api.js';
import type { WorkingTree } from '../src/api.js';
import { Inspector } from '../src/components/Inspector.js';
import type { Mode } from '../src/components/Topbar.js';
import { useWorkbench } from '../src/controllers/use-workbench.js';
import type { DiffItem } from '../src/types.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    loadAllFiles: vi.fn().mockResolvedValue([]),
    loadApps: vi.fn().mockResolvedValue([]),
    loadFile: vi.fn(),
    loadAbsoluteFile: vi.fn(),
    loadDiff: vi.fn(),
    loadTree: vi.fn(),
  };
});

const workspace: Workspace = {
  id: 'workspace-1',
  name: 'demo',
  path: '/tmp/w1',
  sort_order: 0,
  hidden: 0,
  pinned: 0,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const tree: WorkingTree = {
  id: 'ws:workspace-1',
  kind: 'workspace',
  label: 'demo',
  path: '/tmp/w1',
  branch: 'main',
  workspace_id: 'workspace-1',
  workspace_name: 'demo',
  session_id: null,
  session_name: null,
};

const viewedTree: WorkingTree = {
  ...tree,
  id: 'ext:workspace-1:d3Q',
  kind: 'worktree',
  label: 'w1-message-system-design',
  path: '/tmp/worktrees/w1-message-system-design',
  branch: 'codex/message-system-design',
};

const session: Session = {
  id: 's1',
  name: 'demo',
  type: 'coding',
  task_id: null,
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
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
} as unknown as Session;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function renderWorkbench(strict = false, workingTrees: WorkingTree[] = [tree]) {
  return renderHook(() => useWorkbench({
    authStatus: 'authenticated',
    dispatch: vi.fn(),
    sessions: [session],
    activeSessionId: 's1',
    activeSession: session,
    activeWorkspace: workspace,
    workspaces: [workspace],
    workingTrees,
    mode: 'sessions',
    activeSubtaskId: null,
    t: key => key,
  }), strict ? { wrapper: StrictMode } : undefined);
}

const session2: Session = { ...session, id: 's2', name: 'demo two' };
const session3: Session = { ...session, id: 's3', name: 'demo three' };
const session4: Session = { ...session, id: 's4', name: 'demo four' };
const sessionSet = [session, session2, session3, session4];

function renderSwitchableWorkbench(initialSessionId = 's1') {
  return renderHook(({ sessionId, mode = 'sessions' }: { sessionId: string; mode?: Mode }) => {
    const active = sessionSet.find(candidate => candidate.id === sessionId) ?? null;
    return useWorkbench({
      authStatus: 'authenticated',
      dispatch: vi.fn(),
      sessions: sessionSet,
      activeSessionId: active?.id ?? null,
      activeSession: active,
      activeWorkspace: workspace,
      workspaces: [workspace],
      workingTrees: [tree],
      mode,
      activeSubtaskId: null,
      t: key => key,
    });
  }, {
    initialProps: { sessionId: initialSessionId },
  });
}

describe('Sheet tab query timing (§4.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    delete window.gianDesktop;
    vi.mocked(api.loadAllFiles).mockResolvedValue([]);
    vi.mocked(api.loadApps).mockResolvedValue([]);
  });

  it('openFileInSheet creates the tab with a loading body BEFORE loadFile resolves, then fills it', async () => {
    const pending = deferred<{ content: string; size: number } | null>();
    vi.mocked(api.loadFile).mockImplementation(() => pending.promise);
    const { result } = renderWorkbench();

    act(() => { void result.current.openFileInSheet('/tmp/w1/src/a.ts'); });

    // The destination surface exists while the content is still loading.
    await waitFor(() => {
      const tab = result.current.wbTabs.find(t => t.kind === 'file');
      expect(tab).toBeDefined();
      expect(tab!.loading).toBe(true);
      expect(tab!.fullPath).toBe('/tmp/w1/src/a.ts');
      expect(tab!.lines).toBeUndefined();
    });

    await act(async () => pending.resolve({ content: 'one\ntwo', size: 7 }));
    await waitFor(() => {
      const tab = result.current.wbTabs.find(t => t.kind === 'file');
      expect(tab!.loading).toBeUndefined();
      expect(tab!.lines).toEqual([['1', 'one'], ['2', 'two']]);
      expect(tab!.loadError).toBeUndefined();
    });
  });

  it('openFileInSheet lands the tab in an error state with a working retry on load failure', async () => {
    const first = deferred<{ content: string; size: number } | null>();
    vi.mocked(api.loadFile).mockImplementation(() => first.promise);
    const { result } = renderWorkbench();

    act(() => { void result.current.openFileInSheet('/tmp/w1/src/a.ts'); });
    await waitFor(() => expect(result.current.wbTabs.find(t => t.kind === 'file')?.loading).toBe(true));

    await act(async () => first.resolve(null));
    await waitFor(() => {
      const tab = result.current.wbTabs.find(t => t.kind === 'file');
      expect(tab!.loading).toBeUndefined();
      expect(tab!.loadError).toBe('sheet.loadFailed');
      expect(tab!.retryLoad).toBeDefined();
    });

    // Retry: back to loading, then the second attempt fills the tab.
    const second = deferred<{ content: string; size: number } | null>();
    vi.mocked(api.loadFile).mockImplementation(() => second.promise);
    act(() => result.current.wbTabs.find(t => t.kind === 'file')!.retryLoad!());
    await waitFor(() => expect(result.current.wbTabs.find(t => t.kind === 'file')?.loading).toBe(true));
    await act(async () => second.resolve({ content: 'recovered', size: 9 }));
    await waitFor(() => {
      const tab = result.current.wbTabs.find(t => t.kind === 'file');
      expect(tab!.loadError).toBeUndefined();
      expect(tab!.lines).toEqual([['1', 'recovered']]);
    });
  });

  it('opens a workspace-root link from the viewed worktree and shows its canonical path', async () => {
    localStorage.setItem('gian.wt.view.s1', viewedTree.id);
    vi.mocked(api.loadAllFiles).mockImplementation(async workingTreeId =>
      workingTreeId === viewedTree.id ? ['docs/message-system-design.md'] : []);
    vi.mocked(api.loadFile).mockResolvedValue({ content: '# Message system', size: 16 });
    const { result } = renderWorkbench(false, [tree, viewedTree]);

    await act(async () => {
      await result.current.openFileInSheet('/tmp/w1/docs/message-system-design.md');
    });

    await waitFor(() => expect(api.loadFile).toHaveBeenCalledWith(
      viewedTree.id,
      'docs/message-system-design.md',
    ));
    const tab = result.current.wbTabs.find(t => t.kind === 'file');
    expect(tab?.workingTreeId).toBe(viewedTree.id);
    expect(tab?.fullPath).toBe('/tmp/worktrees/w1-message-system-design/docs/message-system-design.md');
    expect(tab?.loadError).toBeUndefined();
  });

  it('previews an unregistered absolute markdown path without opening Files inspector', async () => {
    const pending = deferred<{ content: string; size: number } | null>();
    vi.mocked(api.loadAbsoluteFile).mockImplementation(() => pending.promise);
    const { result } = renderWorkbench();
    const abs = '/Users/me/.gian/attachments/sess-1/plan.md';

    act(() => { void result.current.openFileInSheet(abs); });

    await waitFor(() => {
      const tab = result.current.wbTabs.find(t => t.kind === 'file');
      expect(tab).toBeDefined();
      expect(tab!.loading).toBe(true);
      expect(tab!.fullPath).toBe(abs);
      expect(tab!.workingTreeId).toBeUndefined();
    });
    expect(api.loadFile).not.toHaveBeenCalled();
    expect(api.loadAbsoluteFile).toHaveBeenCalledWith(abs);
    expect(result.current.filesInspectorSuppressed).toBe(true);
    expect(result.current.fileReveal).toBeNull();

    await act(async () => pending.resolve({ content: '# Plan\n\nDone.', size: 14 }));
    await waitFor(() => {
      const tab = result.current.wbTabs.find(t => t.kind === 'file');
      expect(tab!.loading).toBeUndefined();
      expect(tab!.viewMode).toBe('preview');
      expect(tab!.lines).toEqual([['1', '# Plan'], ['2', ''], ['3', 'Done.']]);
      expect(tab!.loadError).toBeUndefined();
    });
  });

  it('previews an unregistered image through the absolute raw endpoint', async () => {
    const { result } = renderWorkbench();
    const abs = '/Users/me/.gian/attachments/sess-1/shot.png';

    act(() => { void result.current.openFileInSheet(abs); });

    await waitFor(() => {
      const tab = result.current.wbTabs.find(t => t.kind === 'file');
      expect(tab?.rawSrc).toBe(`/api/files/raw?path=${encodeURIComponent(abs)}`);
      expect(tab?.icoKind).toBe('img');
      expect(tab?.loadError).toBeUndefined();
    });
    expect(api.loadFile).not.toHaveBeenCalled();
    expect(api.loadAbsoluteFile).not.toHaveBeenCalled();
  });

  it('the diffs rail auto-ensures exactly one singleton Changes tab', async () => {
    const { result } = renderWorkbench();

    act(() => result.current.activateRail('diffs'));
    await waitFor(() => {
      expect(result.current.wbTabs.filter(t => t.kind === 'changes')).toHaveLength(1);
    });
    const tab = result.current.wbTabs.find(t => t.kind === 'changes')!;
    expect(tab.group).toBe('diffs');
    expect(result.current.activeTabByGroup.diffs).toBe(tab.id);

    // Re-activating the rail never duplicates the singleton.
    act(() => result.current.activateRail('diffs'));
    await waitFor(() => {
      expect(result.current.wbTabs.filter(t => t.kind === 'changes')).toHaveLength(1);
    });
  });

  it('the Changes tab is re-ensured (without stealing a text tab) after it was closed', async () => {
    const { result } = renderWorkbench();
    act(() => result.current.activateRail('diffs'));
    await waitFor(() => expect(result.current.wbTabs.some(t => t.kind === 'changes')).toBe(true));

    // A transcript text detail opens alongside and takes the foreground.
    const item: DiffItem = {
      kind: 'diff',
      id: 'd1',
      files: [{ path: 'src/a.ts', add: 1, del: 0, hunks: [] }],
      ts: 1,
      turn: 1,
    };
    const pending = deferred<api.FileDiffResult>();
    vi.mocked(api.loadDiff).mockImplementation(() => pending.promise);
    act(() => { void result.current.openTranscriptDiffInSheet(item); });
    await waitFor(() => {
      expect(result.current.activeTabByGroup.diffs).toBe('tab-diff-event-s1-1:diff:d1');
    });
    await act(async () => pending.resolve({ diff: 'x', truncated: false }));

    // Closing the Changes tab while the rail is active re-creates it, and the
    // text detail keeps the foreground.
    const changesId = result.current.wbTabs.find(t => t.kind === 'changes')!.id;
    act(() => result.current.sheetActions.closeTab(changesId));
    await waitFor(() => {
      expect(result.current.wbTabs.filter(t => t.kind === 'changes')).toHaveLength(1);
    });
    expect(result.current.activeTabByGroup.diffs).toBe('tab-diff-event-s1-1:diff:d1');

    // showChangesDiff (GitBadge / transcript show-changes entries) DOES steal.
    act(() => result.current.showChangesDiff());
    await waitFor(() => {
      expect(result.current.activeTabByGroup.diffs)
        .toBe(result.current.wbTabs.find(t => t.kind === 'changes')!.id);
    });
  });

  it('openTranscriptDiffInSheet creates the tab loading, then fills hunk-less files from the tree', async () => {
    const pending = deferred<api.FileDiffResult>();
    vi.mocked(api.loadDiff).mockImplementation(() => pending.promise);
    const { result } = renderWorkbench();
    const item: DiffItem = {
      kind: 'diff',
      id: 'd1',
      files: [{ path: 'src/a.ts', add: 1, del: 0, hunks: [] }],
      ts: 1,
      turn: 1,
    };

    act(() => { void result.current.openTranscriptDiffInSheet(item); });
    await waitFor(() => {
      const tab = result.current.wbTabs.find(t => t.id === 'tab-diff-event-s1-1:diff:d1');
      expect(tab).toBeDefined();
      expect(tab!.kind).toBe('text');
      expect(tab!.loading).toBe(true);
    });

    await act(async () => pending.resolve({ diff: 'loaded diff', truncated: false }));
    await waitFor(() => {
      expect(result.current.wbTabs.find(t => t.id === 'tab-diff-event-s1-1:diff:d1')?.text).toBe('loaded diff');
    });
  });

  it('scopes transcript diff tabs by session and turn when provider ids repeat', async () => {
    const { result } = renderWorkbench();
    const hunk = {
      header: '@@ -1 +1 @@',
      lines: [{ kind: 'add' as const, text: 'next' }],
    };
    const first: DiffItem = {
      kind: 'diff', id: 'reused', turn: 1, ts: 1,
      files: [{ path: 'src/a.ts', add: 1, del: 0, hunks: [hunk] }],
    };
    const second: DiffItem = { ...first, turn: 2, ts: 2 };

    act(() => { void result.current.openTranscriptDiffInSheet(first); });
    await waitFor(() => expect(result.current.wbTabs.filter(t => t.textDiff)).toHaveLength(1));
    const firstId = result.current.wbTabs.find(t => t.textDiff)!.id;
    act(() => result.current.sheetActions.pinTab(firstId));
    act(() => { void result.current.openTranscriptDiffInSheet(first); });
    await waitFor(() => expect(result.current.wbTabs.filter(t => t.id === firstId)).toHaveLength(1));

    act(() => { void result.current.openTranscriptDiffInSheet(second); });
    await waitFor(() => {
      const ids = result.current.wbTabs.filter(t => t.textDiff).map(t => t.id);
      expect(ids).toEqual([
        'tab-diff-event-s1-1:diff:reused',
        'tab-diff-event-s1-2:diff:reused',
      ]);
    });
  });

  it('a late file load never clobbers the preview tab a newer click replaced it with', async () => {
    const first = deferred<{ content: string; size: number } | null>();
    vi.mocked(api.loadFile).mockImplementation(() => first.promise);
    const { result } = renderWorkbench();

    // Click file A (preview), then file B before A's load resolves — B
    // replaces the preview tab in place. A's late fill must not overwrite B.
    act(() => { void result.current.openFileInSheet('/tmp/w1/a.ts'); });
    await waitFor(() => expect(result.current.wbTabs.find(t => t.kind === 'file')?.loading).toBe(true));
    const second = deferred<{ content: string; size: number } | null>();
    vi.mocked(api.loadFile).mockImplementation(() => second.promise);
    act(() => { void result.current.openFileInSheet('/tmp/w1/b.ts'); });
    await waitFor(() => {
      const tab = result.current.wbTabs.find(t => t.kind === 'file');
      expect(tab!.fullPath).toBe('/tmp/w1/b.ts');
      expect(tab!.loading).toBe(true);
    });

    await act(async () => first.resolve({ content: 'A contents', size: 10 }));
    await act(async () => second.resolve({ content: 'B contents', size: 10 }));
    await waitFor(() => {
      const fileTabs = result.current.wbTabs.filter(t => t.kind === 'file');
      expect(fileTabs).toHaveLength(1);
      expect(fileTabs[0]!.fullPath).toBe('/tmp/w1/b.ts');
      expect(fileTabs[0]!.lines).toEqual([['1', 'B contents']]);
    });
  });

  it('opens each project HTML in a new Browser tab and keeps existing tabs', async () => {
    const openProject = vi.fn().mockResolvedValue({
      url: 'gian-browser://site/index.html',
      title: '',
      loading: true,
      canGoBack: false,
      canGoForward: false,
      canOpenExternal: true,
      inspecting: false,
    });
    const closeTab = vi.fn().mockResolvedValue(true);
    window.gianDesktop = {
      browser: { openProject, closeTab } as unknown as GianBrowserApi,
    };
    const { result } = renderWorkbench(true);

    act(() => result.current.openProjectInBrowser('ws:workspace-1', 'site/index.html'));
    await waitFor(() => {
      expect(result.current.activeRail).toBe('browser');
      expect(result.current.wbTabs.filter(tab => tab.kind === 'browser')).toHaveLength(1);
      const browserTab = result.current.wbTabs.find(tab => tab.kind === 'browser');
      expect(openProject).toHaveBeenCalledWith(browserTab?.id, {
        workingTreeId: 'ws:workspace-1',
        path: 'site/index.html',
      });
    });

    act(() => result.current.openProjectInBrowser('ws:workspace-1', 'design/01.html'));
    await waitFor(() => {
      const browserTabs = result.current.wbTabs.filter(tab => tab.kind === 'browser');
      expect(browserTabs).toHaveLength(2);
      expect(openProject).toHaveBeenCalledTimes(2);
      expect(openProject).toHaveBeenLastCalledWith(browserTabs[1]?.id, {
        workingTreeId: 'ws:workspace-1',
        path: 'design/01.html',
      });
      expect(result.current.activeTabByGroup.browser).toBe(browserTabs[1]?.id);
    });

    act(() => result.current.addBrowserTab());
    await waitFor(() => {
      const browserTabs = result.current.wbTabs.filter(tab => tab.kind === 'browser');
      expect(browserTabs).toHaveLength(3);
      expect(new Set(browserTabs.map(tab => tab.id)).size).toBe(3);
      expect(browserTabs[2]?.name).toBe('Browser #3');
      expect(result.current.activeTabByGroup.browser).toBe(browserTabs[2]?.id);
    });

    const lastTab = result.current.wbTabs.filter(tab => tab.kind === 'browser')[2]!;
    act(() => result.current.sheetActions.closeTab(lastTab.id));
    await waitFor(() => {
      expect(closeTab).toHaveBeenCalledWith(lastTab.id);
      expect(result.current.wbTabs.filter(tab => tab.kind === 'browser')).toHaveLength(2);
    });
  });

  it('History commit tab is a singleton: opening another commit replaces it in place and preserves Diffs state', async () => {
    const { result } = renderWorkbench();

    act(() => result.current.activateRail('diffs'));
    await waitFor(() => expect(result.current.wbTabs.some(t => t.kind === 'changes')).toBe(true));
    const changesTab = result.current.wbTabs.find(t => t.kind === 'changes')!;

    act(() => result.current.openCommitInSheet({
      workingTreeId: tree.id,
      sha: 'a'.repeat(40),
      subject: 'first',
    }));
    await waitFor(() => expect(result.current.wbTabs.find(t => t.kind === 'commit')).toBeDefined());
    const tabId = result.current.wbTabs.find(t => t.kind === 'commit')!.id;

    act(() => result.current.openCommitInSheet({
      workingTreeId: tree.id,
      sha: 'b'.repeat(40),
      subject: 'second',
    }));
    await waitFor(() => {
      const commits = result.current.wbTabs.filter(t => t.kind === 'commit');
      expect(commits).toHaveLength(1);
      expect(commits[0]).toMatchObject({ id: tabId, commitSha: 'b'.repeat(40), preview: false });
    });

    // Re-opening the same commit is a no-op reveal.
    act(() => result.current.openCommitInSheet({
      workingTreeId: tree.id,
      sha: 'b'.repeat(40),
      subject: 'second',
    }));
    await waitFor(() => {
      const commits = result.current.wbTabs.filter(t => t.kind === 'commit');
      expect(commits).toHaveLength(1);
      expect(commits[0]).toMatchObject({ id: tabId, commitSha: 'b'.repeat(40) });
    });

    act(() => result.current.openCommitInSheet({
      workingTreeId: tree.id,
      sha: 'c'.repeat(40),
      subject: 'third',
    }));
    await waitFor(() => {
      const commits = result.current.wbTabs.filter(t => t.kind === 'commit');
      expect(commits).toHaveLength(1);
      expect(commits[0]).toMatchObject({ id: tabId, commitSha: 'c'.repeat(40) });
    });

    expect(result.current.wbTabs.find(t => t.id === changesTab.id)).toEqual(changesTab);
    expect(result.current.activeTabByGroup.diffs).toBe(changesTab.id);
    expect(result.current.activeRail).toBe('history');
  });

  it('History orphan revalidation preserves a prior marker when a probe is inconclusive', async () => {
    const { result } = renderWorkbench();
    const sha = 'd'.repeat(40);
    act(() => result.current.openCommitInSheet({ workingTreeId: tree.id, sha }));
    await waitFor(() => expect(result.current.wbTabs.find(t => t.kind === 'commit')).toBeDefined());

    act(() => result.current.revalidateHistoryTabs(tree.id, candidate => candidate === sha));
    expect(result.current.wbTabs.find(t => t.commitSha === sha)?.orphaned).toBe(true);

    act(() => result.current.revalidateHistoryTabs(tree.id, () => undefined));
    expect(result.current.wbTabs.find(t => t.commitSha === sha)?.orphaned).toBe(true);

    act(() => result.current.revalidateHistoryTabs(tree.id, () => false));
    expect(result.current.wbTabs.find(t => t.commitSha === sha)?.orphaned).toBe(false);
  });
});

describe('Issue #46 Session-owned workbench state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    delete window.gianDesktop;
    vi.mocked(api.loadAllFiles).mockResolvedValue([]);
    vi.mocked(api.loadApps).mockResolvedValue([]);
  });

  it('restores independent Files, Diffs, History, and explicitly closed states per Session', async () => {
    const { result, rerender } = renderSwitchableWorkbench();

    act(() => result.current.activateRail('files'));
    expect(result.current.activeRail).toBe('files');

    rerender({ sessionId: 's2' });
    expect(result.current.activeRail).toBeNull();
    act(() => result.current.activateRail('diffs'));
    await waitFor(() => expect(result.current.activeRail).toBe('diffs'));

    rerender({ sessionId: 's3' });
    expect(result.current.activeRail).toBeNull();
    act(() => result.current.activateRail('history'));
    expect(result.current.activeRail).toBe('history');

    rerender({ sessionId: 's4' });
    expect(result.current.activeRail).toBeNull();
    rerender({ sessionId: 's1' });
    expect(result.current.activeRail).toBe('files');
    rerender({ sessionId: 's2' });
    expect(result.current.activeRail).toBe('diffs');
    rerender({ sessionId: 's3' });
    expect(result.current.activeRail).toBe('history');

    rerender({ sessionId: 's2' });
    act(() => result.current.toggleRail('diffs'));
    expect(result.current.activeRail).toBeNull();
    rerender({ sessionId: 's1' });
    expect(result.current.activeRail).toBe('files');
    rerender({ sessionId: 's2' });
    expect(result.current.activeRail).toBeNull();
  });

  it('restores Side Chat only for its owning Session after page and Session navigation', () => {
    const { result, rerender } = renderSwitchableWorkbench();

    act(() => result.current.openChatPanel('s1', { kind: 'sidechat' }));
    expect(result.current.chatPanel).toEqual({ kind: 'sidechat', sessionId: 's1' });

    act(() => rerender({ sessionId: 's1', mode: 'spaces' }));
    expect(result.current.chatPanel).toBeNull();
    act(() => rerender({ sessionId: 's1', mode: 'sessions' }));
    expect(result.current.chatPanel).toEqual({ kind: 'sidechat', sessionId: 's1' });

    act(() => rerender({ sessionId: 's2', mode: 'sessions' }));
    expect(result.current.chatPanel).toBeNull();
    act(() => rerender({ sessionId: 's1', mode: 'sessions' }));
    expect(result.current.chatPanel).toEqual({ kind: 'sidechat', sessionId: 's1' });

    act(() => result.current.activateRail('files'));
    expect(result.current.chatPanel).toBeNull();
    act(() => result.current.restoreChatPanelForSession('s1'));
    expect(result.current.chatPanel).toEqual({ kind: 'sidechat', sessionId: 's1' });

    act(() => result.current.setChatPanel(null));
    act(() => rerender({ sessionId: 's1', mode: 'spaces' }));
    act(() => rerender({ sessionId: 's1', mode: 'sessions' }));
    expect(result.current.chatPanel).toBeNull();
  });

  it('isolates Session-owned tabs and active content even when Sessions share one working tree', async () => {
    vi.mocked(api.loadAllFiles).mockResolvedValue(['src/a.ts', 'src/b.ts']);
    vi.mocked(api.loadFile).mockImplementation(async (_workingTreeId, path) => ({
      content: `content:${path}`,
      size: path.length,
    }));
    const { result, rerender } = renderSwitchableWorkbench();

    await act(async () => result.current.openFileInSheet('/tmp/w1/src/a.ts', true));
    await waitFor(() => expect(result.current.wbTabs.find(tab => tab.kind === 'file')?.fullPath)
      .toBe('/tmp/w1/src/a.ts'));
    const firstTabId = result.current.activeTabByGroup.files;

    rerender({ sessionId: 's2' });
    expect(result.current.wbTabs.some(tab => tab.kind === 'file')).toBe(false);
    await act(async () => result.current.openFileInSheet('/tmp/w1/src/b.ts', true));
    await waitFor(() => expect(result.current.wbTabs.find(tab => tab.kind === 'file')?.fullPath)
      .toBe('/tmp/w1/src/b.ts'));
    const secondTabId = result.current.activeTabByGroup.files;
    expect(secondTabId).not.toBe(firstTabId);

    rerender({ sessionId: 's1' });
    expect(result.current.wbTabs.filter(tab => tab.kind === 'file')).toHaveLength(1);
    expect(result.current.wbTabs.find(tab => tab.kind === 'file')?.fullPath)
      .toBe('/tmp/w1/src/a.ts');
    expect(result.current.activeTabByGroup.files).toBe(firstTabId);

    rerender({ sessionId: 's2' });
    expect(result.current.wbTabs.filter(tab => tab.kind === 'file')).toHaveLength(1);
    expect(result.current.wbTabs.find(tab => tab.kind === 'file')?.fullPath)
      .toBe('/tmp/w1/src/b.ts');
    expect(result.current.activeTabByGroup.files).toBe(secondTabId);
  });

  it('does not let a late Files index response displace a newer global rail', async () => {
    const pendingIndex = deferred<string[]>();
    vi.mocked(api.loadAllFiles).mockImplementation(() => pendingIndex.promise);
    vi.mocked(api.loadFile).mockResolvedValue({ content: 'late file', size: 9 });
    const { result } = renderSwitchableWorkbench();

    act(() => { void result.current.openFileInSheet('/tmp/w1/src/late.ts'); });
    expect(result.current.activeRail).toBe('files');
    act(() => result.current.activateRail('terminal'));
    expect(result.current.activeRail).toBe('terminal');

    await act(async () => pendingIndex.resolve(['src/late.ts']));
    await waitFor(() => expect(result.current.wbTabs.some(tab =>
      tab.kind === 'file' && tab.fullPath === '/tmp/w1/src/late.ts')).toBe(true));
    expect(result.current.activeRail).toBe('terminal');
  });

  it('opens the Files inspector without clearing another rail panel-3 memory', async () => {
    vi.mocked(api.loadAllFiles).mockResolvedValue(['src/a.ts']);
    vi.mocked(api.loadFile).mockResolvedValue({ content: 'a', size: 1 });
    const { result } = renderSwitchableWorkbench();

    act(() => result.current.activateRail('diffs'));
    await waitFor(() => expect(result.current.activeRail).toBe('diffs'));
    act(() => result.current.setP3Collapsed(true));
    expect(result.current.p3Collapsed).toBe(true);

    await act(async () => result.current.openFileInSheet('/tmp/w1/src/a.ts'));
    expect(result.current.activeRail).toBe('files');
    expect(result.current.p3Collapsed).toBe(false);
    act(() => result.current.toggleRail('diffs'));
    expect(result.current.activeRail).toBe('diffs');
    expect(result.current.p3Collapsed).toBe(true);
  });

  it('keeps History commit singletons and close fallback inside their owning Session', async () => {
    const { result, rerender } = renderSwitchableWorkbench();
    const firstSha = 'a'.repeat(40);
    const secondSha = 'b'.repeat(40);

    act(() => result.current.openCommitInSheet({
      workingTreeId: tree.id,
      sha: firstSha,
      subject: 'first Session commit',
    }));
    const firstTabId = result.current.activeTabByGroup.history;
    expect(result.current.wbTabs.find(tab => tab.id === firstTabId)?.commitSha).toBe(firstSha);

    await act(async () => rerender({ sessionId: 's2' }));
    act(() => result.current.openCommitInSheet({
      workingTreeId: tree.id,
      sha: secondSha,
      subject: 'second Session commit',
    }));
    const secondTabId = result.current.activeTabByGroup.history;
    expect(secondTabId).not.toBe(firstTabId);
    expect(result.current.wbTabs.find(tab => tab.id === secondTabId)?.commitSha).toBe(secondSha);

    act(() => result.current.sheetActions.closeTab(secondTabId!));
    expect(result.current.activeTabByGroup.history).toBeNull();
    expect(result.current.wbTabs.some(tab => tab.kind === 'commit')).toBe(false);

    await act(async () => rerender({ sessionId: 's1' }));
    expect(result.current.activeTabByGroup.history).toBe(firstTabId);
    expect(result.current.wbTabs.find(tab => tab.id === firstTabId)?.commitSha).toBe(firstSha);
  });

  it.each(['terminal', 'browser', 'workspaces', 'settings'] as const)(
    'keeps the global %s foreground and tabs unchanged while Sessions switch',
    async (globalRail) => {
      const { result, rerender } = renderSwitchableWorkbench();
      act(() => result.current.activateRail('files'));
      rerender({ sessionId: 's2' });
      act(() => result.current.activateRail('history'));
      rerender({ sessionId: 's1' });
      expect(result.current.activeRail).toBe('files');

      act(() => {
        if (globalRail === 'workspaces') result.current.openWorkspaceInSheet(workspace.id);
        else result.current.activateRail(globalRail);
      });
      await waitFor(() => expect(result.current.activeRail).toBe(globalRail));
      const globalTabIds = result.current.wbTabs
        .filter(tab => ['term', 'browser', 'workspaces', 'settings'].includes(tab.group))
        .map(tab => tab.id);

      rerender({ sessionId: 's2' });
      expect(result.current.activeRail).toBe(globalRail);
      expect(result.current.wbTabs
        .filter(tab => ['term', 'browser', 'workspaces', 'settings'].includes(tab.group))
        .map(tab => tab.id)).toEqual(globalTabIds);

      act(() => result.current.toggleRail(globalRail));
      expect(result.current.activeRail).toBeNull();
      act(() => result.current.toggleRail('history'));
      expect(result.current.activeRail).toBe('history');
      rerender({ sessionId: 's1' });
      expect(result.current.activeRail).toBe('files');
    },
  );

  it.each([
    ['terminal', 'term'],
    ['browser', 'browser'],
  ] as const)(
    'closing the final %s tab clears its global foreground and restores the Session scene',
    async (globalRail, group) => {
      const { result } = renderSwitchableWorkbench();
      act(() => result.current.activateRail('files'));
      expect(result.current.activeRail).toBe('files');

      act(() => result.current.activateRail(globalRail));
      const globalTab = result.current.wbTabs.find(tab => tab.group === group);
      expect(globalTab).toBeDefined();
      expect(result.current.activeRail).toBe(globalRail);

      act(() => result.current.sheetActions.closeTab(globalTab!.id));
      await waitFor(() => {
        expect(result.current.wbTabs.some(tab => tab.group === group)).toBe(false);
        expect(result.current.activeRail).toBeNull();
      });

      act(() => result.current.toggleRail('files'));
      expect(result.current.activeRail).toBe('files');

      // A single Dock click must also be enough to create the global tab
      // again; there is no invisible active rail left to dismiss first.
      act(() => result.current.toggleRail(globalRail));
      await waitFor(() => {
        expect(result.current.activeRail).toBe(globalRail);
        expect(result.current.wbTabs.filter(tab => tab.group === group)).toHaveLength(1);
      });
    },
  );

  it('keeps the global Workspaces rail open when its new-workspace detail closes', async () => {
    const { result, rerender } = renderSwitchableWorkbench();
    act(() => result.current.openNewWorkspaceInSheet());
    const formTab = result.current.wbTabs.find(tab => tab.kind === 'new-workspace');
    expect(formTab).toBeDefined();
    expect(result.current.activeRail).toBe('workspaces');

    act(() => result.current.sheetActions.closeTab(formTab!.id));
    await waitFor(() => {
      expect(result.current.wbTabs.some(tab => tab.group === 'workspaces')).toBe(false);
      expect(result.current.activeRail).toBe('workspaces');
    });

    await act(async () => rerender({ sessionId: 's2' }));
    expect(result.current.activeRail).toBe('workspaces');
  });

  it('keeps the panel-3 collapsed state with its Session rail scene', async () => {
    const { result, rerender } = renderSwitchableWorkbench();
    act(() => result.current.activateRail('files'));
    act(() => result.current.setP3Collapsed(true));
    expect(result.current.p3Collapsed).toBe(true);

    await act(async () => rerender({ sessionId: 's2' }));
    expect(result.current.p3Collapsed).toBe(false);
    act(() => result.current.activateRail('files'));
    expect(result.current.p3Collapsed).toBe(false);

    await act(async () => rerender({ sessionId: 's1' }));
    expect(result.current.activeRail).toBe('files');
    expect(result.current.p3Collapsed).toBe(true);
  });
});

describe('Files inspector folder loader (§4.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a row-level loader while the folder\'s loadTree is in flight', async () => {
    const root = deferred<api.TreeEntry[]>();
    vi.mocked(api.loadTree).mockImplementation(() => root.promise);
    render(
      <Inspector
        tab="files"
        workingTreeId="ws:demo"
        workingTrees={[{ ...tree, id: 'ws:demo' }]}
        onOpenFile={() => {}}
      />,
    );

    // Root folder is open by default and its listing is still loading.
    expect(await screen.findByText('Loading…')).toBeInTheDocument();

    root.resolve([{ name: 'src', type: 'dir', path: 'src' }]);
    expect(await screen.findByText('src')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();

    // Expanding a nested folder shows the loader again for its own load.
    const nested = deferred<api.TreeEntry[]>();
    vi.mocked(api.loadTree).mockImplementation(() => nested.promise);
    fireEvent.click(screen.getByText('src'));
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    nested.resolve([{ name: 'a.ts', type: 'file', path: 'src/a.ts' }]);
    expect(await screen.findByText('a.ts')).toBeInTheDocument();
  });
});
