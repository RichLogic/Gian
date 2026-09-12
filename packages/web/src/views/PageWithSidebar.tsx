import { useEffect } from 'react';
import type { Session, Task, Workspace } from '@gian/shared';
import type { Mode } from '../components/Topbar.js';
import { LeftRail, type SidebarListMode } from '../components/SidebarChrome.js';
import { SessionsSidebar } from '../components/SessionsSidebar.js';
import { TasksSidebar } from './TasksView.js';
import { useResizableWidth, RailSplitter } from '../components/RailLayout.js';
import type { RailLayoutController } from '../components/RailLayout.js';

/** Shell of the top-level pages (Agents / Timer / Custom): the last selected
 *  Tasks or Project list stays mounted beside the page. Primary-page changes
 *  never reset that independent list choice; selecting a row returns to the
 *  corresponding conversation surface. */
export function PageWithSidebar({
  mode,
  onSetMode,
  listMode,
  onSetListMode,
  workspaces,
  sessions,
  tasks,
  activeSessionId,
  activeSubtaskId,
  onNewWorkspace,
  onEditWorkspace,
  onNewForWorkspace,
  onPinSession,
  onArchiveSession,
  onSelectSession,
  onSelectUnassignedSession,
  onSelectSubtask,
  onNewSessionForTask,
  railLayout,
  children,
}: {
  mode: Mode;
  onSetMode: (mode: Mode) => void;
  listMode: SidebarListMode;
  onSetListMode: (mode: SidebarListMode) => void;
  workspaces: Workspace[];
  sessions: Session[];
  tasks: Task[];
  activeSessionId: string | null;
  activeSubtaskId: string | null;
  /** Repos section "+": open the New Repo dialog. */
  onNewWorkspace: () => void;
  /** Workspace group ⋯ menu Edit: open the Edit Repo dialog (name-only). */
  onEditWorkspace: (workspace: Workspace) => void;
  onNewForWorkspace: (workspaceId: string) => void;
  onPinSession: (sessionId: string, pinned: boolean) => void;
  onArchiveSession: (sessionId: string) => void;
  onSelectSession: (id: string) => void;
  /** 未分配 (untasked) rows in the Tasks list: open inside the Tasks view
   *  (App's selectStandaloneInTasks), never a jump to Project mode. */
  onSelectUnassignedSession: (id: string) => void;
  onSelectSubtask: (taskId: string, subtaskId: string) => void;
  onNewSessionForTask: (taskId: string) => void;
  /** App-owned four-panel layout. Optional for isolated component renders. */
  railLayout?: RailLayoutController;
  children: React.ReactNode;
}) {
  const fallbackRail = useResizableWidth('rail.w', 272, 200, 480, 'left');
  const rail = railLayout ?? fallbackRail;

  // Same contract as CodingView/TasksView: the brand toggle event collapses
  // the rail only for standalone renders; the App-owned rail is toggled by
  // the Topbar directly.
  useEffect(() => {
    if (railLayout) return;
    const onToggle = () => rail.setCollapsed(!rail.collapsed);
    window.addEventListener('gian.toggle-rail', onToggle);
    return () => window.removeEventListener('gian.toggle-rail', onToggle);
  }, [rail.collapsed, rail.setCollapsed, railLayout]);

  return (
    <div
      className={`view${rail.collapsed ? ' rail-collapsed' : ''}`}
      style={{ '--rail-w': `${rail.width}px` } as React.CSSProperties}
    >
      {rail.collapsed ? (
        <LeftRail
          mode={mode}
          listMode={listMode}
          onSetMode={onSetMode}
          onExpand={() => rail.setCollapsed(false)}
        />
      ) : (
        listMode === 'tasks' ? (
          <TasksSidebar
            mode={mode}
            onSetMode={onSetMode}
            listMode={listMode}
            onSetListMode={onSetListMode}
            tasks={tasks}
            sessions={sessions}
            workspaces={workspaces}
            activeSubtaskId={activeSubtaskId}
            activeSessionId={activeSessionId}
            onSelectSubtask={onSelectSubtask}
            onSelectSession={onSelectUnassignedSession}
            onPinSession={onPinSession}
            onArchiveSession={onArchiveSession}
            onNewSession={onNewSessionForTask}
          />
        ) : (
          <SessionsSidebar
            mode={mode}
            onSetMode={onSetMode}
            listMode={listMode}
            onSetListMode={onSetListMode}
            workspaces={workspaces}
            sessions={sessions}
            activeSessionId={activeSessionId}
            onNewWorkspace={onNewWorkspace}
            onEditWorkspace={onEditWorkspace}
            onNewForWorkspace={onNewForWorkspace}
            onPinSession={onPinSession}
            onArchiveSession={onArchiveSession}
            onSelect={onSelectSession}
          />
        )
      )}
      <RailSplitter onMouseDown={rail.onMouseDown} ariaLabel="Resize sidebar" />
      <div className="primary-page-surface">{children}</div>
    </div>
  );
}
