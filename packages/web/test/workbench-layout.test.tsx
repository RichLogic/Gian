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
import type { ChatPanelTarget } from '../src/presentation/chat-panel.js';

const GROUP_OF_RAIL: Record<RailId, SheetGroup | null> = {
  files: 'files',
  diffs: 'diffs',
  history: 'history',
  terminal: 'term',
  browser: 'browser',
  workspaces: 'workspaces',
  settings: 'settings',
};

const diffsTab: SheetTab = {
  id: 'changes-1',
  group: 'diffs',
  name: 'Diffs',
  kind: 'changes',
  icoKind: 'diff',
  ico: '',
} as SheetTab;

function useHarness(chatPanel: ChatPanelTarget | null = null) {
  const [p3Collapsed, setP3Collapsed] = useState(false);
  const layout = useWorkbenchLayout({
    mode: 'sessions',
    subtaskActive: false,
    activeRail: 'diffs',
    tabs: [diffsTab],
    activeTabByGroup: { diffs: 'changes-1' },
    viewState: 'both',
    chatPanel,
    filesInspectorSuppressed: false,
    p3Collapsed,
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

  it('gives chat-owned transcript detail exclusive use of panel 2 and restores the rail scene on close', () => {
    const detail: ChatPanelTarget = {
      kind: 'transcript-detail',
      title: 'Tool: Asking user questions',
      text: '{"question":"Which path?"}',
      sourceId: '4:tool:ask',
      sessionId: 'session-1',
    };
    const { result, rerender } = renderHook(
      ({ chatPanel }) => useHarness(chatPanel),
      { initialProps: { chatPanel: detail as ChatPanelTarget | null } },
    );

    expect(result.current.layout.activeGroup).toBe('diffs');
    expect(result.current.layout.sheetMounted).toBe(true);
    expect(result.current.layout.sheetVisible).toBe(false);
    expect(result.current.layout.inspectorAvailable).toBe(false);
    expect(result.current.layout.inspectorVisible).toBe(false);

    rerender({ chatPanel: null });
    expect(result.current.layout.sheetVisible).toBe(true);
    expect(result.current.layout.inspectorAvailable).toBe(true);
    expect(result.current.layout.inspectorVisible).toBe(true);
  });

  it('history rail: first activation shows only the inspector; panel 2 opens once a commit tab exists', () => {
    // With no commit tabs open the history rail shows panel 3 only — panel 2
    // stays hidden like every other empty group. Selecting a commit creates
    // the tab and panel 2 opens naturally.
    function useHistoryHarness(withCommitTab: boolean) {
      const commitTab: SheetTab = {
        id: 'tab-commit-1',
        group: 'history',
        name: 'c0ffee1 · commit',
        kind: 'commit',
        icoKind: 'commit',
        ico: '',
      } as SheetTab;
      return useWorkbenchLayout({
        mode: 'sessions',
        subtaskActive: false,
        activeRail: 'history',
        tabs: withCommitTab ? [commitTab] : [],
        activeTabByGroup: withCommitTab ? { history: 'tab-commit-1' } : {},
        viewState: withCommitTab ? 'both' : 'main',
        chatPanel: null,
        filesInspectorSuppressed: false,
        p3Collapsed: false,
        groupOfRail: GROUP_OF_RAIL,
      });
    }
    const { result, rerender } = renderHook(
      ({ withCommitTab }) => useHistoryHarness(withCommitTab),
      { initialProps: { withCommitTab: false } },
    );
    expect(result.current.inspectorKind).toBe('history');
    expect(result.current.inspectorAvailable).toBe(true);
    expect(result.current.inspectorVisible).toBe(true);
    expect(result.current.activeGroup).toBe('history');
    expect(result.current.sheetMounted).toBe(false);
    expect(result.current.sheetVisible).toBe(false);

    rerender({ withCommitTab: true });
    expect(result.current.sheetMounted).toBe(true);
    expect(result.current.sheetVisible).toBe(true);
  });

  it('Settings owns Panel 2 and never allocates Panel 3', () => {
    const settingsTab: SheetTab = {
      id: 'tab-settings', group: 'settings', name: 'Settings', kind: 'settings',
      icoKind: 'gear', ico: '',
    };
    const { result } = renderHook(() => useWorkbenchLayout({
      mode: 'sessions',
      subtaskActive: false,
      activeRail: 'settings',
      tabs: [settingsTab],
      activeTabByGroup: { settings: settingsTab.id },
      viewState: 'both',
      chatPanel: null,
      filesInspectorSuppressed: false,
      p3Collapsed: false,
      groupOfRail: GROUP_OF_RAIL,
    }));
    expect(result.current.sheetVisible).toBe(true);
    expect(result.current.inspectorKind).toBeNull();
    expect(result.current.inspectorAvailable).toBe(false);
    expect(result.current.inspectorVisible).toBe(false);
  });
});
