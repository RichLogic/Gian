import { useCallback, useMemo, useState } from 'react';
import type { Executor, Session, Workspace } from '@gian/shared';
import type { WorkingTree } from '../api.js';
import type {
  BranchMenuActions,
  PathSegment,
  SessionMenuActions,
} from '../components/PathBreadcrumb.js';
import type { Mode } from '../components/Topbar.js';
import { confirm as confirmDialog } from '../feedback.js';
import type { OperationDispatcher } from '../operations/dispatcher.js';

interface TopbarModelInput {
  mode: Mode;
  activeTaskId: string | null;
  activeSubtaskId: string | null;
  activeSession: Session | null;
  activeWorkspace: Workspace | null;
  activeBranch: string | null;
  workingTrees: WorkingTree[];
  refreshWorkingTrees: () => void;
  wtView: { sessionId: string; wtId: string } | null;
  setWtView: (v: { sessionId: string; wtId: string } | null) => void;
  viewedWorkingTreeId(session: Session): string | null;
  /** True while a session.recover run is in flight for the active session —
   *  the Force-recover menu item renders disabled/"recovering". */
  activeSessionRecovering: boolean;
  ops: OperationDispatcher;
  t(key: string): string;
}

export interface TopbarModel {
  pathSegments: PathSegment[];
  sessionMenu: SessionMenuActions | null;
  branchMenu: BranchMenuActions | null;
  onRenameSubmit(value: string): void;
  onRenameCancel(): void;
}

export function useTopbarModel(input: TopbarModelInput): TopbarModel {
  const [renaming, setRenaming] = useState(false);
  const {
    mode,
    activeTaskId,
    activeSubtaskId,
    activeSession,
    activeWorkspace,
    activeBranch,
    workingTrees,
    refreshWorkingTrees,
    wtView,
    setWtView,
    viewedWorkingTreeId,
    activeSessionRecovering,
    ops,
    t,
  } = input;

  const pathSegments = useMemo<PathSegment[]>(() => {
    if (mode === 'sessions' || (mode === 'tasks' && activeSubtaskId)) {
      if (!activeSession) return [];
      // A completed conversation (completed_at set) is read-only in the
      // breadcrumb: no session menu anchor (no caret, click copies the name)
      // and no worktree dropdown (2026-08-05).
      const completed = activeSession.completed_at != null;
      // Segment order (2026-08-03): project / session / worktree. The Tasks
      // view no longer prepends the task name — the task is already the
      // selected row in the sidebar, and its menu lives on the rail row.
      const segments: PathSegment[] = [];
      segments.push({
        kind: 'workspace',
        label: activeWorkspace?.name ?? activeSession.workspace_id ?? t('coding.sidebar.section.unfiled'),
        copyHint: `${t('common.copy')} "${activeWorkspace?.name ?? activeSession.workspace_id ?? t('coding.sidebar.section.unfiled')}"`,
      });
      segments.push({
        kind: 'session',
        label: activeSession.name || t('coding.session.untitled'),
        copyHint: completed
          ? `${t('common.copy')} "${activeSession.name || t('coding.session.untitled')}"`
          : t('coding.session.actions'),
        editing: renaming,
        menuAnchor: !completed,
      });
      if (activeBranch) {
        segments.push({
          kind: 'branch',
          label: activeBranch,
          copyHint: `${t('common.copy')} "${activeBranch}"`,
        });
      }
      return segments;
    }
    if (mode === 'tasks' && activeTaskId) {
      // Task selected without a subtask: the header shows no breadcrumb —
      // the task name is redundant with the selected sidebar row. The task
      // menu (rename/done/delete) stays available on the rail row's ⋯.
      return [];
    }
    if (mode === 'spaces' && activeWorkspace) {
      return [{
        kind: 'workspace',
        label: activeWorkspace.name,
        copyHint: `${t('common.copy')} "${activeWorkspace.name}"`,
      }];
    }
    return [];
  }, [activeBranch, activeSession, activeSubtaskId, activeTaskId, activeWorkspace, mode, renaming, t]);

  const sessionMenu = useMemo<SessionMenuActions | null>(() => {
    const isSubtask = mode === 'tasks' && !!activeSubtaskId;
    if ((mode !== 'sessions' && !isSubtask) || !activeSession) return null;
    // Completed conversation: no session dropdown (2026-08-05).
    if (activeSession.completed_at != null) return null;
    // Fork needs a workspace — an Unfiled (workspace-deleted) session cannot
    // be forked, so the menu omits Fork there.
    const forkWorkspaceId = activeSession.workspace_id;
    // Session mutations route through the operation layer (Phase 2a): rename
    // and mark-unread are optimistic overlays; delete/recover/fork are
    // pending runs with duplicate submission blocked by the dispatcher.
    return {
      kind: isSubtask ? 'subtask' : 'session',
      onRename: () => setRenaming(true),
      onCopyName: () => {
        try { void navigator.clipboard?.writeText(activeSession.name || ''); } catch { /* ignore */ }
      },
      onForceRecover: () => ops.dispatch('session.recover', { sessionId: activeSession.id }),
      recovering: activeSessionRecovering,
      onMarkUnread: () => ops.dispatch('session.setUnread', { sessionId: activeSession.id, unread: true }),
      onDelete: async () => {
        const confirmed = await confirmDialog({
          message: `${t('coding.session.deleteConfirmPrefix')} "${activeSession.name || t('coding.session.untitled')}"? ${t('coding.session.deleteConfirmSuffix')}`,
          danger: true,
          confirmLabel: t('common.delete'),
        });
        if (confirmed) ops.dispatch('session.delete', { sessionId: activeSession.id });
      },
      ...(isSubtask || forkWorkspaceId == null ? {} : {
        onFork: (executor: Executor) => {
          const baseName = activeSession.name || `session ${activeSession.id.slice(0, 6)}`;
          ops.dispatch('session.fork', {
            workspaceId: forkWorkspaceId,
            executor,
            approvalMode: activeSession.approval_mode,
            name: `${baseName} copy`,
          });
        },
      }),
    };
  }, [activeSession, activeSessionRecovering, activeSubtaskId, mode, ops, t]);

  const branchMenu = useMemo<BranchMenuActions | null>(() => {
    const visible = (mode === 'sessions' || (mode === 'tasks' && activeSubtaskId))
      && !!activeBranch;
    if (!visible || !activeSession) return null;
    // Completed conversation: no worktree dropdown either (2026-08-05).
    if (activeSession.completed_at != null) return null;
    const viewedId = viewedWorkingTreeId(activeSession);
    return {
      onOpen: refreshWorkingTrees,
      items: workingTrees
        .filter(tree => tree.workspace_id === activeSession.workspace_id)
        .map(tree => ({
          id: tree.id,
          // Label = the branch/worktree you switch to, same column for every
          // row (2026-08-03: the workspace's own checkout no longer gets
          // "Primary" as its label — that moved to the detail slot). For
          // agent worktrees the detail is the owning session's name, but only
          // when it adds information — a worktree whose session is named
          // after the branch would otherwise show the same text twice.
          label: tree.branch ?? tree.session_name ?? tree.label,
          detail: tree.kind === 'workspace'
            ? t('files.picker.primary')
            : (tree.session_name && tree.session_name !== tree.branch
                ? tree.session_name
                : null),
          active: tree.id === viewedId,
        }))
        // The currently-viewed tree always leads the list (2026-08-03); the
        // sort is stable, so the rest keep host order.
        .sort((a, b) => Number(b.active ?? false) - Number(a.active ?? false)),
      onPick: id => {
        // View switch only — picking a worktree must NOT pop the Diffs rail
        // open (2026-08-06 user request). The pick persists per session via
        // setWtView (localStorage), so it survives reloads.
        setWtView({ sessionId: activeSession.id, wtId: id });
      },
    };
  }, [activeBranch, activeSession, activeSubtaskId, mode, refreshWorkingTrees, setWtView, t, viewedWorkingTreeId, workingTrees, wtView]);

  const onRenameSubmit = useCallback((value: string) => {
    setRenaming(false);
    const name = value.trim();
    if (!name) return;
    if (activeSession && name !== activeSession.name) {
      ops.dispatch('session.rename', { sessionId: activeSession.id, name });
    }
  }, [activeSession, ops]);

  return {
    pathSegments,
    sessionMenu,
    branchMenu,
    onRenameSubmit,
    onRenameCancel: useCallback(() => setRenaming(false), []),
  };
}
