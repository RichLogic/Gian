import { useCallback, useMemo, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { Executor, Session, Task, Workspace } from '@gian/shared';
import { completeSubtask, reopenSubtask, type WorkingTree } from '../api.js';
import type {
  BranchMenuActions,
  PathSegment,
  SessionMenuActions,
} from '../components/PathBreadcrumb.js';
import type { Mode } from '../components/Topbar.js';
import { confirm as confirmDialog, toast } from '../feedback.js';
import type { GianWs } from '../ws.js';

interface TopbarModelInput {
  mode: Mode;
  activeTaskId: string | null;
  activeSubtaskId: string | null;
  activeSession: Session | null;
  activeWorkspace: Workspace | null;
  activeBranch: string | null;
  tasks: Task[];
  setTasks: Dispatch<SetStateAction<Task[]>>;
  sessions: Session[];
  sessionsRef: MutableRefObject<Session[]>;
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
    tasks,
    setTasks,
    sessions,
    sessionsRef,
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
      const segments: PathSegment[] = [{
        kind: 'workspace',
        label: activeWorkspace?.name ?? activeSession.workspace_id,
        copyHint: `${t('common.copy')} "${activeWorkspace?.name ?? activeSession.workspace_id}"`,
      }];
      if (activeBranch) {
        segments.push({
          kind: 'branch',
          label: activeBranch,
          copyHint: `${t('common.copy')} "${activeBranch}"`,
        });
      }
      segments.push({
        kind: 'session',
        label: activeSession.name || t('coding.session.untitled'),
        copyHint: t('coding.session.actions'),
        editing: renaming,
      });
      return segments;
    }
    if (mode === 'tasks' && activeTaskId) {
      const task = tasks.find(candidate => candidate.id === activeTaskId);
      return task ? [{
        kind: 'session',
        label: task.name || t('coding.session.untitled'),
        copyHint: t('coding.session.actions'),
        editing: renaming,
      }] : [];
    }
    if (mode === 'spaces' && activeWorkspace) {
      return [{
        kind: 'workspace',
        label: activeWorkspace.name,
        copyHint: `${t('common.copy')} "${activeWorkspace.name}"`,
      }];
    }
    return [];
  }, [activeBranch, activeSession, activeSubtaskId, activeTaskId, activeWorkspace, mode, renaming, t, tasks]);

  const sessionMenu = useMemo<SessionMenuActions | null>(() => {
    if (mode === 'tasks' && !activeSubtaskId && activeTaskId) {
      const task = tasks.find(candidate => candidate.id === activeTaskId);
      if (!task) return null;
      return {
        kind: 'task',
        onRename: () => setRenaming(true),
        onCopyName: () => {
          try { void navigator.clipboard?.writeText(task.name || ''); } catch { /* ignore */ }
        },
        onMarkUnread: () => {
          const manager = sessionsRef.current.find(session =>
            session.type === 'manager' && session.task_id === task.id);
          if (manager) ws.send({ type: 'session:set_unread', session_id: manager.id, unread: true });
        },
        pinned: task.pinned_at != null,
        onPin: () => {
          const pinned = task.pinned_at == null;
          setTasks(previous => previous.map(candidate => candidate.id === task.id
            ? { ...candidate, pinned_at: pinned ? new Date().toISOString() : null }
            : candidate));
          ws.send({ type: 'task:update', task_id: task.id, pinned });
        },
        taskDone: task.status === 'done',
        onToggleDone: () => {
          const blocked = sessionsRef.current.some(session =>
            session.task_id === task.id
            && session.type === 'subtask'
            && (session.status === 'running' || session.status === 'pending'));
          if (blocked) {
            toast({ kind: 'error', message: t('tasks.done.blocked') });
            return;
          }
          ws.send({
            type: 'task:update',
            task_id: task.id,
            status: task.status === 'done' ? 'open' : 'done',
          });
        },
        onForceRecover: () => {
          const manager = sessionsRef.current.find(session =>
            session.type === 'manager' && session.task_id === task.id);
          if (manager) ws.send({ type: 'session:recover', session_id: manager.id });
        },
        onDelete: async () => {
          const count = sessions.filter(session => session.task_id === task.id).length;
          const cascade = count > 0
            ? ` ${t('tasks.remove.cascade').replace('{n}', String(count))}`
            : '';
          const confirmed = await confirmDialog({
            message: `${t('tasks.remove.confirmPrefix')} "${task.name || t('tasks.untitled')}"? ${t('tasks.remove.confirmSuffix')}${cascade}`,
            danger: true,
            confirmLabel: t('common.delete'),
          });
          if (confirmed) ws.send({ type: 'task:delete', task_id: task.id });
        },
      };
    }

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
          const worktree = activeSession.worktree_path !== null;
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
            ...(worktree
              ? {
                  mode: 'worktree',
                  ...(activeSession.base_branch
                    ? { base_branch: activeSession.base_branch }
                    : {}),
                }
              : { mode: 'regular' }),
          });
        },
      }),
    };
  }, [activeSession, activeSubtaskId, activeTaskId, mode, sessions, sessionsRef, setCreatingSession, setForkingSession, setTasks, t, tasks, ws]);

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
          label: tree.kind === 'workspace'
            ? t('files.picker.primary')
            : tree.session_name || tree.label,
          detail: tree.branch,
          active: tree.id === viewedId,
        })),
      onPick: id => {
        setWtView({ sessionId: activeSession.id, wtId: id });
        activateDiffsRail();
      },
      onCopy: () => {
        try { void navigator.clipboard?.writeText(activeBranch); } catch { /* ignore */ }
      },
    };
  }, [activateDiffsRail, activeBranch, activeSession, activeSubtaskId, mode, setWtView, t, viewedWorkingTreeId, workingTrees, wtView]);

  const onRenameSubmit = useCallback((value: string) => {
    setRenaming(false);
    const name = value.trim();
    if (!name) return;
    if (mode === 'tasks' && !activeSubtaskId && activeTaskId) {
      const task = tasks.find(candidate => candidate.id === activeTaskId);
      if (task && name !== task.name) {
        ws.send({ type: 'task:update', task_id: activeTaskId, name });
      }
      return;
    }
    if (activeSession && name !== activeSession.name) {
      ws.send({ type: 'session:rename', session_id: activeSession.id, name });
    }
  }, [activeSession, activeSubtaskId, activeTaskId, mode, tasks, ws]);

  return {
    pathSegments,
    sessionMenu,
    branchMenu,
    onRenameSubmit,
    onRenameCancel: useCallback(() => setRenaming(false), []),
  };
}
