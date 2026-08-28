import type { Mode } from '../components/Topbar.js';
import type { RailId, SheetGroup, SheetTab } from '../components/sheet-model.js';
import type { ChatPanelTarget } from '../presentation/chat-panel.js';

interface UseWorkbenchLayoutInput {
  mode: Mode;
  subtaskActive: boolean;
  activeRail: RailId | null;
  tabs: SheetTab[];
  activeTabByGroup: Partial<Record<SheetGroup, string | null>>;
  viewState: 'main' | 'workbench' | 'both';
  chatPanel: ChatPanelTarget | null;
  filesInspectorSuppressed: boolean;
  p3Collapsed: boolean;
  groupOfRail: Record<RailId, SheetGroup | null>;
}

export function useWorkbenchLayout({
  mode,
  subtaskActive,
  activeRail,
  tabs,
  activeTabByGroup,
  viewState,
  chatPanel,
  filesInspectorSuppressed,
  p3Collapsed,
  groupOfRail,
}: UseWorkbenchLayoutInput) {
  void activeTabByGroup;
  const sessionViewActive = mode === 'sessions' || subtaskActive;
  const workbenchActive = mode === 'sessions' || mode === 'tasks';

  const activeGroup = activeRail ? groupOfRail[activeRail] : null;
  const railGroupHasTabs = activeGroup
    ? tabs.some(tab => tab.group === activeGroup)
    : false;
  /* The history rail keeps panel 2 mounted even with zero commit tabs — its
   *  renderEmpty slot ("select a commit to review") is the designed resting
   *  state, not an absent panel (git-history design §3.1). Other rails keep
   *  the old hide-when-empty behavior. */
  const historyEmptySlot = activeRail === 'history';
  const sheetMounted = tabs.length > 0 || historyEmptySlot;
  const sheetVisible = workbenchActive
    && chatPanel === null
    && viewState !== 'main'
    && activeRail !== null
    && (railGroupHasTabs || historyEmptySlot);
  const inspectorKind: 'files' | 'changes' | 'history' | null =
    activeRail === 'files' ? 'files'
    : activeRail === 'diffs' ? 'changes'
    : activeRail === 'history' ? 'history'
    : null;
  const inspectorAvailable = workbenchActive
    && chatPanel === null
    && inspectorKind !== null
    && !(inspectorKind === 'files' && filesInspectorSuppressed)
    && ((inspectorKind === 'files' || inspectorKind === 'changes' || inspectorKind === 'history') ? sessionViewActive : true);
  const inspectorVisible = inspectorAvailable && !p3Collapsed;

  return {
    sessionViewActive,
    workbenchActive,
    activeGroup,
    sheetMounted,
    sheetVisible,
    inspectorKind,
    // Exposed separately from `inspectorVisible`: the topbar toggle's
    // availability must NOT depend on the collapsed state, otherwise hiding
    // panel 3 disables the very button that brings it back (2026-08-05).
    inspectorAvailable,
    inspectorVisible,
  };
}
