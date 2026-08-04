import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
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
  setP3Collapsed: Dispatch<SetStateAction<boolean>>;
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
  setP3Collapsed,
  groupOfRail,
}: UseWorkbenchLayoutInput) {
  const sessionViewActive = mode === 'sessions' || subtaskActive;
  const workbenchActive = mode === 'sessions' || mode === 'tasks';

  const activeGroup = activeRail ? groupOfRail[activeRail] : null;
  const railGroupHasTabs = activeGroup
    ? tabs.some(tab => tab.group === activeGroup)
    : false;
  const sheetMounted = tabs.length > 0;
  const sheetVisible = workbenchActive
    && chatPanel === null
    && viewState !== 'main'
    && activeRail !== null
    && railGroupHasTabs;
  const inspectorKind: 'files' | 'changes' | 'workspaces' | 'settings' | null =
    activeRail === 'files' ? 'files'
    : activeRail === 'diffs' ? 'changes'
    : activeRail === 'workspaces' ? 'workspaces'
    : activeRail === 'settings' ? 'settings'
    : null;
  const inspectorAvailable = workbenchActive
    && chatPanel === null
    && inspectorKind !== null
    && !(inspectorKind === 'files' && filesInspectorSuppressed)
    && ((inspectorKind === 'files' || inspectorKind === 'changes') ? sessionViewActive : true);
  const inspectorVisible = inspectorAvailable && !p3Collapsed;

  useEffect(() => {
    setP3Collapsed(false);
  }, [activeRail, setP3Collapsed]);

  const openWorkspaceIds = new Set(
    tabs.filter(tab => tab.kind === 'workspace' && tab.wsId).map(tab => tab.wsId as string),
  );
  const selectedWorkspaceId = tabs.find(tab => tab.id === activeTabByGroup.workspaces)?.wsId ?? null;

  return {
    sessionViewActive,
    workbenchActive,
    activeGroup,
    sheetMounted,
    sheetVisible,
    inspectorKind,
    inspectorVisible,
    openWorkspaceIds,
    selectedWorkspaceId,
  };
}
