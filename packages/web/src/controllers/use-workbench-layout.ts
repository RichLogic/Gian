import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Mode } from '../components/Topbar.js';
import type { RailId, SheetGroup, SheetTab } from '../components/sheet-model.js';
import type { ChatPanelTarget } from '../presentation/chat-panel.js';

interface UseWorkbenchLayoutInput {
  mode: Mode;
  subtaskActive: boolean;
  hasManagerTask: boolean;
  activeRail: RailId | null;
  setActiveRail: Dispatch<SetStateAction<RailId | null>>;
  tabs: SheetTab[];
  activeTabByGroup: Partial<Record<SheetGroup, string | null>>;
  viewState: 'main' | 'workbench' | 'both';
  chatPanel: ChatPanelTarget | null;
  filesInspectorSuppressed: boolean;
  p3Collapsed: boolean;
  setP3Collapsed: Dispatch<SetStateAction<boolean>>;
  groupOfRail: Record<RailId, SheetGroup | null>;
  activateRail: (rail: RailId) => void;
  revealTab: (group: SheetGroup, tabId: string) => void;
}

export function useWorkbenchLayout({
  mode,
  subtaskActive,
  hasManagerTask,
  activeRail,
  setActiveRail,
  tabs,
  activeTabByGroup,
  viewState,
  chatPanel,
  filesInspectorSuppressed,
  p3Collapsed,
  setP3Collapsed,
  groupOfRail,
  activateRail,
  revealTab,
}: UseWorkbenchLayoutInput) {
  const [navStack, setNavStack] = useState<Array<{ rail: RailId | null; tabId: string | null }>>([
    { rail: null, tabId: null },
  ]);
  const [navIndex, setNavIndex] = useState(0);
  const navSkipRef = useRef(false);
  const sessionViewActive = mode === 'sessions' || subtaskActive;
  const workbenchActive = mode === 'sessions' || mode === 'tasks';

  useEffect(() => {
    if (activeRail === 'manager' && !subtaskActive) setActiveRail(null);
  }, [activeRail, setActiveRail, subtaskActive]);

  const activeGroup = activeRail ? groupOfRail[activeRail] : null;
  const railGroupHasTabs = activeGroup
    ? tabs.some(tab => tab.group === activeGroup)
    : false;
  const managerPanelVisible = activeRail === 'manager' && subtaskActive && hasManagerTask;
  const sheetMounted = tabs.length > 0;
  const sheetVisible = workbenchActive
    && chatPanel === null
    && viewState !== 'main'
    && activeRail !== null
    && (railGroupHasTabs || managerPanelVisible || activeRail === 'sidechat');
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
  const navTabId = activeGroup ? (activeTabByGroup[activeGroup] ?? null) : null;

  useEffect(() => {
    if (navSkipRef.current) {
      navSkipRef.current = false;
      return;
    }
    const current = navStack[navIndex];
    if (current && current.rail === activeRail && current.tabId === navTabId) return;
    const next = [...navStack.slice(0, navIndex + 1), { rail: activeRail, tabId: navTabId }];
    setNavStack(next);
    setNavIndex(next.length - 1);
  }, [activeRail, navIndex, navStack, navTabId]);

  function navigate(delta: -1 | 1): void {
    const entry = navStack[navIndex + delta];
    if (!entry) return;
    navSkipRef.current = true;
    setNavIndex(navIndex + delta);
    if (entry.rail === null) {
      setActiveRail(null);
      return;
    }
    activateRail(entry.rail);
    const group = groupOfRail[entry.rail];
    if (group && entry.tabId && tabs.some(tab => tab.id === entry.tabId)) {
      revealTab(group, entry.tabId);
    }
  }

  return {
    sessionViewActive,
    workbenchActive,
    activeGroup,
    managerPanelVisible,
    sheetMounted,
    sheetVisible,
    inspectorKind,
    inspectorVisible,
    openWorkspaceIds,
    selectedWorkspaceId,
    canGoBack: navIndex > 0,
    canGoForward: navIndex < navStack.length - 1,
    navigate,
  };
}
