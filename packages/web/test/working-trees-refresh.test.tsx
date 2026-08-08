import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkingTrees, type WorkingTree } from '../src/api.js';
import { useWorkingTrees } from '../src/controllers/use-working-trees.js';

vi.mock('../src/api.js', () => ({ loadWorkingTrees: vi.fn() }));

function tree(id: string): WorkingTree {
  return {
    id,
    kind: 'workspace',
    label: id,
    path: `/repo/${id}`,
    branch: id,
    workspace_id: 'workspace-1',
    workspace_name: 'Workspace',
    session_id: null,
    session_name: null,
  };
}

describe('useWorkingTrees refresh coordination', () => {
  beforeEach(() => {
    vi.mocked(loadWorkingTrees).mockReset();
  });

  it('keeps the newer forced refresh when an older shape request finishes last', async () => {
    let resolveOlder!: (trees: WorkingTree[]) => void;
    let resolveNewer!: (trees: WorkingTree[]) => void;
    vi.mocked(loadWorkingTrees)
      .mockReturnValueOnce(new Promise(resolve => { resolveOlder = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { resolveNewer = resolve; }));
    const { result } = renderHook(() => useWorkingTrees());

    act(() => result.current.reloadWorkingTrees({ force: false }));
    act(() => result.current.reloadWorkingTrees({ force: true }));
    expect(loadWorkingTrees).toHaveBeenNthCalledWith(1, { refresh: false });
    expect(loadWorkingTrees).toHaveBeenNthCalledWith(2, { refresh: true });

    await act(async () => resolveNewer([tree('newer')]));
    await waitFor(() => expect(result.current.workingTrees).toEqual([tree('newer')]));

    await act(async () => resolveOlder([tree('older')]));
    expect(result.current.workingTrees).toEqual([tree('newer')]);
  });

  it('retains the last known-good list when the latest request fails', async () => {
    let rejectLatest!: (error: Error) => void;
    vi.mocked(loadWorkingTrees)
      .mockResolvedValueOnce([tree('known-good')])
      .mockReturnValueOnce(new Promise((_, reject) => { rejectLatest = reject; }));
    const { result } = renderHook(() => useWorkingTrees());

    act(() => result.current.reloadWorkingTrees());
    await waitFor(() => expect(result.current.workingTrees).toEqual([tree('known-good')]));

    act(() => result.current.reloadWorkingTrees({ force: true }));
    await act(async () => rejectLatest(new Error('offline')));
    expect(result.current.workingTrees).toEqual([tree('known-good')]);
  });
});
