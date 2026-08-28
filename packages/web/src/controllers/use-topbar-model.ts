import { useCallback, useMemo, useState } from 'react';
import type { Executor, Session, SideChatInfo, Workspace } from '@gian/shared';
import type { WorkingTree } from '../api.js';
import type { ActionControlState } from '../components/action-gating.js';
import type {
  BranchMenuActions,
  PathSegment,
  SessionMenuActions,
} from '../components/PathBreadcrumb.js';
import type { Mode } from '../components/Topbar.js';
import { confirm as confirmDialog } from '../feedback.js';
import type { OperationDispatcher } from '../operations/dispatcher.js';
import { sideChatParentCascadeSuffix } from '../presentation/sidechat.js';
import { worktreeDisplayName } from '../presentation/wt-view.js';

interface TopbarModelInput {
  mode: Mode;
  activeTaskId: string | null;
  activeSubtaskId: string | null;
  activeSession: Session | null;
  activeWorkspace: Workspace | null;
  activeWorktreeName: string | null;
  workingTrees: WorkingTree[];
  refreshWorkingTrees: () => void;
  wtView: { sessionId: string; wtId: string } | null;
  setWtView: (v: { sessionId: string; wtId: string } | null) => void;
  viewedWorkingTreeId(session: Session): string | null;
  /** True while a session.recover run is in flight for the active session —
   *  the Force-recover menu item renders disabled/"recovering". */
  activeSessionRecovering: boolean;
  /** Side Chats bound to the active session (gian.proxy/2.0 §10.5.4): the
   *  delete confirm must list the still-open ones — deleting the parent
   *  permanently closes them too. */
  activeSessionSideChats?: SideChatInfo[];
  /** Protocol head-Fork entry for the session dropdown menu (§10.6/§15):
   *  the gating state (`session.fork`, §9.4/§10.3), whether a fork run is in
   *  flight, and the dispatch callback. The App root wires all three with
   *  the store-explicit hooks (this hook runs above the providers). */
  forkHead?: {
    control: ActionControlState | null;
    forking: boolean;
    onFork: () => void;
  };
  /** Open the active-Task picker for a standalone Session. */
  onAssignSessionTask: (session: Session) => void;
  ops: OperationDispatcher;
  t(key: string): string;
}

export interface TopbarModel {
  pathSegments: PathSegment[];
  sessionMenu: SessionMenuActions | null;
  branchMenu: BranchMenuActions | null;
  onRenameSubmit(value: string): void;
  onRenameCancel(): void;
  onRenameStart(): void;
}

export function useTopbarModel(input: TopbarModelInput): TopbarModel {
  const [renaming, setRenaming] = useState(false);
  const {
    mode,
    activeTaskId,
    activeSubtaskId,
    activeSession,
    activeWorkspace,
    activeWorktreeName,
    workingTrees,
    refreshWorkingTrees,
    wtView,
    setWtView,
    viewedWorkingTreeId,
    activeSessionRecovering,
    activeSessionSideChats,
    forkHead,
    onAssignSessionTask,
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
      if (activeWorktreeName) {
        segments.push({
          kind: 'branch',
          label: activeWorktreeName,
          copyHint: `${t('common.copy')} "${activeWorktreeName}"`,
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
  }, [activeSession, activeSubtaskId, activeTaskId, activeWorkspace, activeWorktreeName, mode, renaming, t]);

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
      ...(mode === 'sessions'
        && activeSession.type === 'coding'
        && activeSession.task_id === null
        ? { onAssignTask: () => onAssignSessionTask(activeSession) }
        : {}),
      onForceRecover: () => ops.dispatch('session.recover', { sessionId: activeSession.id }),
      recovering: activeSessionRecovering,
      onMarkUnread: () => ops.dispatch('session.setUnread', { sessionId: activeSession.id, unread: true }),
      // Protocol head Fork (§10.6/§15): always on the menu, greyed with the
      // gating reason when either layer disallows it or a fork is in flight.
      // Dispatch/run tracking lives in the App root (store-explicit hooks).
      ...(forkHead ? {
        forkHead: {
          disabled: forkHead.control?.enabled !== true || forkHead.forking,
          title: forkHead.control?.enabled
            ? (forkHead.forking ? t('fork.forking') : t('fork.headTitle'))
            : (forkHead.control?.reason ?? t('fork.unavailable')),
          onFork: forkHead.onFork,
        },
      } : {}),
      onDelete: async () => {
        // §10.5.4: explicitly deleting the parent session permanently closes
        // its still-open Side Chats — the confirm must list them by the same
        // labels the dock's chips show.
        const openSideChats = activeSessionSideChats ?? [];
        const cascade = sideChatParentCascadeSuffix(t, openSideChats);
        const confirmed = await confirmDialog({
          message: `${t('coding.session.deleteConfirmPrefix')} "${activeSession.name || t('coding.session.untitled')}"? ${t('coding.session.deleteConfirmSuffix')}${cascade}`,
          danger: true,
          confirmLabel: t('common.delete'),
        });
        if (confirmed) {
          // Host contract (sidechat-coordinator.assertParentCloseConfirmed):
          // deleting a parent with still-open Side Chats REQUIRES the ids of
          // the Side Chats whose close the user just confirmed — the confirm
          // above covers exactly this set, so pass every id through.
          ops.dispatch('session.delete', {
            sessionId: activeSession.id,
            ...(openSideChats.length > 0
              ? { confirmedSidechatIds: openSideChats.map(entry => entry.id) }
              : {}),
          });
        }
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
  }, [activeSession, activeSessionRecovering, activeSessionSideChats, activeSubtaskId, forkHead, mode, onAssignSessionTask, ops, t]);

  const branchMenu = useMemo<BranchMenuActions | null>(() => {
    const visible = (mode === 'sessions' || (mode === 'tasks' && activeSubtaskId))
      && !!activeWorktreeName;
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
          // The worktree directory is the identity being switched. Branch is
          // secondary context only; using it as the label made this look like
          // a local-branch picker even though the rows were real worktrees.
          label: worktreeDisplayName(tree),
          detail: tree.kind === 'workspace'
            ? [tree.branch, t('files.picker.primary')].filter(Boolean).join(' · ')
            : tree.branch,
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
  }, [activeSession, activeSubtaskId, activeWorktreeName, mode, refreshWorkingTrees, setWtView, t, viewedWorkingTreeId, workingTrees, wtView]);

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
    onRenameStart: useCallback(() => {
      if (activeSession?.completed_at == null) setRenaming(true);
    }, [activeSession?.completed_at]),
  };
}
