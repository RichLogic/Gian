// useWorkbenchLayout panel-3 (inspector) toggle gating:
//   - The topbar toggle's availability (p3Available) is driven by
//     `inspectorAvailable`, which must NOT depend on the collapsed state.
//     Before 2026-08-05 App gated it on `inspectorVisible`, so hiding panel 3
//     disabled the very button that brings it back.

import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { useWorkbenchLayout } from '../src/controllers/use-workbench-layout.js';
import type { RailId, SheetGroup, SheetTab } from '../src/components/sheet-model.js';

const GROUP_OF_RAIL: Record<RailId, SheetGroup | null> = {
  files: 'files',
  diffs: 'diffs',
  terminal: 'term',
  workspaces: 'workspaces',
  settings: 'settings',
};

const diffsTab: SheetTab = {
  id: 'diff-1',
  group: 'diffs',
  name: 'manager.ts',
  kind: 'diff',
  icoKind: 'diff',
  ico: '',
} as SheetTab;

function useHarness() {
  const [p3Collapsed, setP3Collapsed] = useState(false);
  const layout = useWorkbenchLayout({
    mode: 'sessions',
    subtaskActive: false,
    activeRail: 'diffs',
    tabs: [diffsTab],
    activeTabByGroup: { diffs: 'diff-1' },
    viewState: 'both',
    chatPanel: null,
    filesInspectorSuppressed: false,
    p3Collapsed,
    setP3Collapsed,
    groupOfRail: GROUP_OF_RAIL,
  });
  return { p3Collapsed, setP3Collapsed, layout };
}

describe('useWorkbenchLayout panel-3 gating', () => {
  it('inspector is available and visible with the diffs rail active', () => {
    const { result } = renderHook(() => useHarness());
    expect(result.current.layout.sheetVisible).toBe(true);
    expect(result.current.layout.inspectorAvailable).toBe(true);
    expect(result.current.layout.inspectorVisible).toBe(true);
  });

  it('collapsing panel 3 hides it but KEEPS it available (toggle stays enabled)', () => {
    const { result } = renderHook(() => useHarness());
    act(() => result.current.setP3Collapsed(true));
    expect(result.current.layout.inspectorVisible).toBe(false);
    expect(result.current.layout.inspectorAvailable).toBe(true);
    expect(result.current.layout.sheetVisible).toBe(true);
  });
});
