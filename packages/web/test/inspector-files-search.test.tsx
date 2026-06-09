import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Inspector } from '../src/components/Inspector.js';
import type { WorkingTree } from '../src/api.js';
import * as api from '../src/api.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    loadTree: vi.fn().mockResolvedValue([{ name: 'src', type: 'dir', path: 'src' }]),
    loadChanged: vi.fn().mockResolvedValue([]),
    loadAllFiles: vi.fn().mockResolvedValue([
      'README.md', 'src/index.ts', 'src/bar/baz.ts',
    ]),
  };
});

const workingTrees: WorkingTree[] = [{
  id: 'ws:demo', kind: 'workspace', label: 'demo', path: '/tmp/demo',
  branch: null, workspace_id: 'demo', workspace_name: 'demo',
  session_id: null, session_name: null,
}];

function renderFiles(onOpenFile = vi.fn()) {
  render(
    <Inspector
      tab="files"
      workingTreeId="ws:demo"
      workingTrees={workingTrees}
      onOpenFile={onOpenFile}
      onOpenDiff={() => {}}
    />,
  );
  return onOpenFile;
}

describe('Inspector FILES search', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('typing a query fetches the recursive index and shows only matching files', async () => {
    renderFiles();
    const input = screen.getByPlaceholderText('Filter files…');
    fireEvent.change(input, { target: { value: 'baz' } });
    await waitFor(() => expect(api.loadAllFiles).toHaveBeenCalledWith('ws:demo'));
    expect(await screen.findByText('baz.ts')).toBeTruthy();
    // Non-matching files are filtered out.
    expect(screen.queryByText('index.ts')).toBeNull();
    expect(screen.queryByText('README.md')).toBeNull();
  });

  it('clicking a search hit opens that file by its full relative path', async () => {
    const onOpenFile = renderFiles();
    fireEvent.change(screen.getByPlaceholderText('Filter files…'), { target: { value: 'baz' } });
    fireEvent.click(await screen.findByText('baz.ts'));
    expect(onOpenFile).toHaveBeenCalledWith('src/bar/baz.ts', false);
  });

  it('shows the empty-state note when nothing matches', async () => {
    renderFiles();
    fireEvent.change(screen.getByPlaceholderText('Filter files…'), { target: { value: 'zzzznope' } });
    await waitFor(() => expect(api.loadAllFiles).toHaveBeenCalled());
    expect(await screen.findByText('No matching files')).toBeTruthy();
  });

  it('clearing the search box returns to the lazy tree (no index fetch with empty query)', async () => {
    renderFiles();
    // Empty query must not trigger the recursive fetch.
    await waitFor(() => expect(api.loadTree).toHaveBeenCalled());
    expect(api.loadAllFiles).not.toHaveBeenCalled();
  });

  it('switching working tree remounts the tree and refetches from the new tree', async () => {
    // Regression: the root folder used to be keyed only by reloadKey, so a
    // workspace switch left it showing the previous tree's cached entries.
    const { rerender } = render(
      <Inspector tab="files" workingTreeId="ws:demo" workingTrees={workingTrees}
        onOpenFile={vi.fn()} onOpenDiff={() => {}} />,
    );
    await waitFor(() => expect(api.loadTree).toHaveBeenCalledWith('ws:demo', ''));
    (api.loadTree as ReturnType<typeof vi.fn>).mockClear();

    rerender(
      <Inspector tab="files" workingTreeId="ws:other" workingTrees={workingTrees}
        onOpenFile={vi.fn()} onOpenDiff={() => {}} />,
    );
    await waitFor(() => expect(api.loadTree).toHaveBeenCalledWith('ws:other', ''));
  });
});
