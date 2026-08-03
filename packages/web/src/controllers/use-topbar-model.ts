import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { Executor, Session, Workspace } from '@gian/shared';
import { completeSubtask, reopenSubtask, type WorkingTree } from '../api.js';
import type {
  BranchMenuActions,
  PathSegment,
  SessionMenuActions,
} from '../components/PathBreadcrumb.js';
import type { Mode } from '../components/Topbar.js';
import { confirm as confirmDialog } from '../feedback.js';
import type { GianWs } from '../ws.js';

interface TopbarModelInput {
  mode: Mode;
  activeTaskId: string | null;
  activeSubtaskId: string | null;
  activeSession: Session | null;
  activeWorkspace: Workspace | null;
  activeBranch: string | null;
  workingTrees: WorkingTree[];
  wtView: { sessionId: string; wtId: string } | null;
  setWtView: Dispatch<SetStateAction<{ sessionId: string; wtId: string } | null>>;
  viewedWorkingTreeId(session: Session): string | null;
  activateDiffsRail(): void;
  setCreatingSession: Dispatch<SetStateAction<boolean>>;
  setForkingSession: Dispatch<SetStateAction<boolean>>;
  ws: GianWs;
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
    wtView,
    setWtView,
    viewedWorkingTreeId,
    activateDiffsRail,
    setCreatingSession,
    setForkingSession,
    ws,
    t,
  } = input;

  const pathSegments = useMemo<PathSegment[]>(() => {
    if (mode === 'sessions' || (mode === 'tasks' && activeSubtaskId)) {
      if (!activeSession) return [];
      // Segment order (2026-08-03): project / session / worktree. The Tasks
      // view no longer prepends the task name — the task is already the
      // selected row in the sidebar, and its menu lives on the rail row.
      const segments: PathSegment[] = [];
      segments.push({
        kind: 'workspace',
        label: activeWorkspace?.name ?? activeSession.workspace_id,
        copyHint: `${t('common.copy')} "${activeWorkspace?.name ?? activeSession.workspace_id}"`,
      });
      segments.push({
        kind: 'session',
        label: activeSession.name || t('coding.session.untitled'),
        copyHint: t('coding.session.actions'),
        editing: renaming,
        menuAnchor: true,
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
    return {
      kind: isSubtask ? 'subtask' : 'session',
      onRename: () => setRenaming(true),
      onCopyName: () => {
        try { void navigator.clipboard?.writeText(activeSession.name || ''); } catch { /* ignore */ }
      },
      onForceRecover: () => ws.send({ type: 'session:recover', session_id: activeSession.id }),
      onMarkUnread: () => ws.send({
        type: 'session:set_unread',
        session_id: activeSession.id,
        unread: true,
      }),
      onDelete: async () => {
        const confirmed = await confirmDialog({
          message: `${t('coding.session.deleteConfirmPrefix')} "${activeSession.name || t('coding.session.untitled')}"? ${t('coding.session.deleteConfirmSuffix')}`,
          danger: true,
          confirmLabel: t('common.delete'),
        });
        if (confirmed) ws.send({ type: 'session:delete', session_id: activeSession.id });
      },
      ...(isSubtask ? {
        completed: activeSession.completed_at != null,
        onToggleComplete: () => {
          void (activeSession.completed_at
            ? reopenSubtask(activeSession.id)
            : completeSubtask(activeSession.id));
        },
      } : {
        onFork: (executor: Executor) => {
          const baseName = activeSession.name || `session ${activeSession.id.slice(0, 6)}`;
          setCreatingSession(true);
          setForkingSession(true);
          ws.send({
            type: 'session:create',
            workspace_id: activeSession.workspace_id,
            executor,
            ...(executor !== 'kimi' && activeSession.approval_mode
              ? { approval_mode: activeSession.approval_mode }
              : {}),
            name: `${baseName} copy`,
          });
        },
      }),
    };
  }, [activeSession, activeSubtaskId, mode, setCreatingSession, setForkingSession, t, ws]);

  const branchMenu = useMemo<BranchMenuActions | null>(() => {
    const visible = (mode === 'sessions' || (mode === 'tasks' && activeSubtaskId))
      && !!activeBranch;
    if (!visible || !activeSession) return null;
    const viewedId = viewedWorkingTreeId(activeSession);
    return {
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
        setWtView({ sessionId: activeSession.id, wtId: id });
        activateDiffsRail();
      },
    };
  }, [activateDiffsRail, activeBranch, activeSession, activeSubtaskId, mode, setWtView, t, viewedWorkingTreeId, workingTrees, wtView]);

  const onRenameSubmit = useCallback((value: string) => {
    setRenaming(false);
    const name = value.trim();
    if (!name) return;
    if (activeSession && name !== activeSession.name) {
      ws.send({ type: 'session:rename', session_id: activeSession.id, name });
    }
  }, [activeSession, ws]);

  return {
    pathSegments,
    sessionMenu,
    branchMenu,
    onRenameSubmit,
    onRenameCancel: useCallback(() => setRenaming(false), []),
  };
}
