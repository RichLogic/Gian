import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Inspector } from '../src/components/Inspector.js';
import type { WorkingTree, ChangedEntry } from '../src/api.js';
import * as api from '../src/api.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    loadChanged: vi.fn().mockResolvedValue([] as ChangedEntry[]),
    stageFile: vi.fn().mockResolvedValue(true),
    unstageFile: vi.fn().mockResolvedValue(true),
  };
});

const workingTrees: WorkingTree[] = [{
  id: 'ws:demo', kind: 'workspace', label: 'demo', path: '/tmp/demo',
  branch: null, workspace_id: 'demo', workspace_name: 'demo',
  session_id: null, session_name: null,
}];

const unstagedRow: ChangedEntry = { path: 'src/a.ts', kind: 'update', staged: false, added: 2, removed: 1 };
const stagedRow: ChangedEntry = { path: 'src/b.ts', kind: 'update', staged: true, added: 5, removed: 0 };

function renderChanges(opts: {
  canCommit?: boolean;
  onOpenDiff?: ReturnType<typeof vi.fn>;
  onComposePrompt?: ReturnType<typeof vi.fn>;
} = {}) {
  const onOpenDiff = opts.onOpenDiff ?? vi.fn();
  const onComposePrompt = opts.onComposePrompt ?? vi.fn();
  render(
    <Inspector
      tab="changes"
      workingTreeId="ws:demo"
      workingTrees={workingTrees}
      onOpenFile={() => {}}
      onOpenDiff={onOpenDiff}
      canCommit={opts.canCommit ?? true}
      onComposePrompt={onComposePrompt}
    />,
  );
  return { onOpenDiff, onComposePrompt };
}

describe('Inspector CHANGES', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    try { localStorage.removeItem('gian.changes.scope'); } catch { /* noop */ }
    (api.loadChanged as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it('defaults to the "all" scope (no scope arg in the URL path)', async () => {
    renderChanges();
    await waitFor(() => expect(api.loadChanged).toHaveBeenCalledWith('ws:demo', 'all'));
  });

  it('switching the scope dropdown re-fetches with that scope', async () => {
    renderChanges();
    await waitFor(() => expect(api.loadChanged).toHaveBeenCalled());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'staged' } });
    await waitFor(() => expect(api.loadChanged).toHaveBeenCalledWith('ws:demo', 'staged'));
  });

  it('clicking a row opens its diff in the current scope', async () => {
    (api.loadChanged as ReturnType<typeof vi.fn>).mockResolvedValue([unstagedRow]);
    const { onOpenDiff } = renderChanges();
    fireEvent.click(await screen.findByText('a.ts'));
    expect(onOpenDiff).toHaveBeenCalledWith('src/a.ts', false, 'all');
  });

  it('Stage on an unstaged row calls stageFile then reloads', async () => {
    (api.loadChanged as ReturnType<typeof vi.fn>).mockResolvedValue([unstagedRow]);
    renderChanges();
    await screen.findByText('a.ts');
    const calls0 = (api.loadChanged as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(screen.getByTitle('Stage'));
    await waitFor(() => expect(api.stageFile).toHaveBeenCalledWith('ws:demo', 'src/a.ts'));
    // success bumps reloadKey → another loadChanged
    await waitFor(() =>
      expect((api.loadChanged as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(calls0),
    );
    expect(api.unstageFile).not.toHaveBeenCalled();
  });

  it('Unstage on a staged row calls unstageFile', async () => {
    (api.loadChanged as ReturnType<typeof vi.fn>).mockResolvedValue([stagedRow]);
    renderChanges();
    await screen.findByText('b.ts');
    fireEvent.click(screen.getByTitle('Unstage'));
    await waitFor(() => expect(api.unstageFile).toHaveBeenCalledWith('ws:demo', 'src/b.ts'));
    expect(api.stageFile).not.toHaveBeenCalled();
  });

  it('Commit drops a commit-only prompt into the composer (never auto-sent)', async () => {
    const { onComposePrompt } = renderChanges({ canCommit: true });
    fireEvent.click(screen.getByText(/Commit or push/));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Commit' }));
    expect(onComposePrompt).toHaveBeenCalledTimes(1);
    const prompt = onComposePrompt.mock.calls[0][0] as string;
    expect(prompt).toMatch(/commit/i);
    // commit-only path must not instruct an actual push
    expect(prompt).not.toMatch(/then push/i);
  });

  it('Commit and push drops a commit+push prompt into the composer', async () => {
    const { onComposePrompt } = renderChanges({ canCommit: true });
    fireEvent.click(screen.getByText(/Commit or push/));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Commit and push' }));
    expect(onComposePrompt).toHaveBeenCalledTimes(1);
    expect(onComposePrompt.mock.calls[0][0]).toMatch(/push/i);
  });

  it('renders changed files as a folder tree and collapses a folder on click', async () => {
    (api.loadChanged as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: 'packages/web/a.ts', kind: 'update', staged: false, added: 1, removed: 0 },
      { path: 'packages/web/b.ts', kind: 'update', staged: false, added: 1, removed: 0 },
      { path: 'packages/host/c.ts', kind: 'create', staged: false, added: 9, removed: 0 },
    ]);
    renderChanges();
    // Intermediate folders are rendered as tree rows…
    await screen.findByText('packages');
    expect(screen.getByText('host')).toBeTruthy();
    expect(screen.getByText('web')).toBeTruthy();
    // …with `packages` appearing exactly once even though 3 files share it.
    expect(screen.getAllByText('packages')).toHaveLength(1);
    // Leaves show only the basename, grouped under their folder.
    expect(screen.getByText('a.ts')).toBeTruthy();
    expect(screen.getByText('c.ts')).toBeTruthy();
    // Collapsing the `web` folder hides its files but not host's.
    fireEvent.click(screen.getByText('web'));
    expect(screen.queryByText('a.ts')).toBeNull();
    expect(screen.queryByText('b.ts')).toBeNull();
    expect(screen.getByText('c.ts')).toBeTruthy();
  });

  it('git-action buttons are disabled with no active session', async () => {
    renderChanges({ canCommit: false });
    await waitFor(() => expect(api.loadChanged).toHaveBeenCalled());
    const commitBtn = screen.getByText(/Commit or push/).closest('button')!;
    expect(commitBtn).toBeDisabled();
    expect(screen.getByText('Create PR').closest('button')).toBeDisabled();
  });
});
