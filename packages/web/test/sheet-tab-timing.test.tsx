/**
 * Query-timing tests (proposal §4.5, Phase 3b): file/diff Sheet tabs are
 * created and selected IMMEDIATELY with a loading body — before
 * loadFile/loadDiff resolves — then filled on success or landed in an error
 * state with a working retry on failure. Plus the Files-inspector row-level
 * loader while a folder's loadTree is in flight.
 */
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { Session, Workspace } from '@gian/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/api.js';
import type { WorkingTree } from '../src/api.js';
import { Inspector } from '../src/components/Inspector.js';
import { useWorkbench } from '../src/controllers/use-workbench.js';
import type { DiffItem } from '../src/types.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    loadAllFiles: vi.fn().mockResolvedValue([]),
    loadApps: vi.fn().mockResolvedValue([]),
    loadFile: vi.fn(),
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

function renderWorkbench() {
  return renderHook(() => useWorkbench({
    authStatus: 'authenticated',
    dispatch: vi.fn(),
    sessions: [session],
    activeSessionId: 's1',
    activeSession: session,
    activeWorkspace: workspace,
    workspaces: [workspace],
    workingTrees: [tree],
    mode: 'sessions',
    activeSubtaskId: null,
    t: key => key,
  }));
}

describe('Sheet tab query timing (§4.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('openDiffInSheet creates the diff tab loading BEFORE loadDiff resolves, then fills it', async () => {
    const pending = deferred<string>();
    vi.mocked(api.loadDiff).mockImplementation(() => pending.promise);
    const { result } = renderWorkbench();

    act(() => { void result.current.openDiffInSheet('src/a.ts'); });

    await waitFor(() => {
      const tab = result.current.wbTabs.find(t => t.kind === 'diff');
      expect(tab).toBeDefined();
      expect(tab!.loading).toBe(true);
      expect(tab!.diffText).toBeUndefined();
    });

    await act(async () => pending.resolve('diff --git a/src/a.ts b/src/a.ts'));
    await waitFor(() => {
      const tab = result.current.wbTabs.find(t => t.kind === 'diff');
      expect(tab!.loading).toBeUndefined();
      expect(tab!.diffText).toBe('diff --git a/src/a.ts b/src/a.ts');
    });
  });

  it('openDiffInSheet shows the error state and retries when loadDiff rejects', async () => {
    const first = deferred<string>();
    vi.mocked(api.loadDiff).mockImplementation(() => first.promise);
    const { result } = renderWorkbench();

    act(() => { void result.current.openDiffInSheet('src/a.ts'); });
    await waitFor(() => expect(result.current.wbTabs.find(t => t.kind === 'diff')?.loading).toBe(true));
    await act(async () => first.reject(new Error('Diff load failed (500)')));
    await waitFor(() => {
      const tab = result.current.wbTabs.find(t => t.kind === 'diff');
      expect(tab!.loadError).toBe('sheet.loadFailed');
      expect(tab!.retryLoad).toBeDefined();
    });

    const second = deferred<string>();
    vi.mocked(api.loadDiff).mockImplementation(() => second.promise);
    act(() => result.current.wbTabs.find(t => t.kind === 'diff')!.retryLoad!());
    await act(async () => second.resolve('diff text'));
    await waitFor(() => {
      const tab = result.current.wbTabs.find(t => t.kind === 'diff');
      expect(tab!.diffText).toBe('diff text');
      expect(tab!.loadError).toBeUndefined();
    });
  });

  it('openTranscriptDiffInSheet creates the tab loading, then fills hunk-less files from the tree', async () => {
    const pending = deferred<string>();
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
      const tab = result.current.wbTabs.find(t => t.id === 'tab-diff-event-d1');
      expect(tab).toBeDefined();
      expect(tab!.loading).toBe(true);
    });

    await act(async () => pending.resolve('loaded diff'));
    await waitFor(() => {
      expect(result.current.wbTabs.find(t => t.id === 'tab-diff-event-d1')?.diffText).toBe('loaded diff');
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
