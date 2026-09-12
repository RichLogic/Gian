import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Session, Task, Workspace } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { useResizableWidth, RailSplitter } from '../components/RailLayout.js';
import type { RailLayoutController } from '../components/RailLayout.js';
import {
  GROUP_INITIAL_SHOWN,
  GROUP_SHOW_MORE_STEP,
  LeftRail,
  SidebarListSwitch,
  SidebarNavRows,
  SidebarSection,
  type SidebarListMode,
} from '../components/SidebarChrome.js';
import type { Mode } from '../components/Topbar.js';
import { StatusIcon, statusGlyphShown } from './session-list-status.js';
import { SessionRow, SessionHoverCard, useSessionHoverCard } from '../components/SessionsSidebar.js';
import { clearNewSessionDraft, NewSessionView } from './new-session-view.js';
import type { CreateSessionInput } from './new-session-view.js';
import { confirm as confirmDialog, toast } from '../feedback.js';
import { sessionEntityKey } from '../operations/session.js';
import { taskEntityKey } from '../operations/task.js';
import { sessionNeedsAttention, orderByIds } from '../session-routing.js';
import { moveById, useDragReorder } from '../dnd-reorder.js';
import type { RowDragProps } from '../dnd-reorder.js';
import {
  useOperationDispatch,
  useOperationPending,
  useOperationRun,
  usePendingOperations,
  useSessionOrderOverlay,
  useTaskOrderOverlay,
} from '../operations/use-operations.js';
import type { PendingFirstMessage } from '../pending-first-message.js';

// ── V2 icon paths (verbatim subset from design/gian-design-v2/js/data.jsx) ──
const I = {
  plus: 'M12 5v14 M5 12h14',
  check: 'M5 12l5 5L20 7',
  caretRight: 'M9 6l6 6-6 6',
  caretDown: 'M6 9l6 6 6-6',
  // kebab (horizontal ⋯) — the per-task "more actions" menu trigger.
  kebab: 'M5 12.01v-.02 M12 12.01v-.02 M19 12.01v-.02',
  // list-todo — the expanded task-group icon (2026-08-03, replaces
  // list-checks). The rect+check reads as "an open checklist".
  listTodo: 'M4 5h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M3 17l2 2 4-4 M13 6h8 M13 12h8 M13 18h8',
  // list-collapse — the collapsed task-group icon (2026-08-03).
  listCollapse: 'M10 5h11 M10 12h11 M10 19h11 M3 10l3-3-3-3 M3 20l3-3-3-3',
  // list-checks — the done-task row icon (2026-07-31). A checklist reads as "a
  // task with steps" and avoids overloading the pin, which already means
  // "pinned to top" in the task menu.
  listChecks: 'M3 17l2 2 4-4 M3 7l2 2 4-4 M13 6h8 M13 12h8 M13 18h8',
  // lucide lock-open — the done subtask's hover toggle (2026-08-04): the
  // action is "reopen", so a plain check (which reads as "complete") was
  // misleading.
  lockOpen: 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z M7 11V7a5 5 0 0 1 9.9-1',
};

function Icon({ d, size = 14, stroke = 1.8, filled = false }: { d: string; size?: number; stroke?: number; filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

/** A Subtask is a Session with type==='subtask' and a matching task_id.
 *  Order (2026-09-06 owner call): open subtasks follow the manual drag order
 *  (migration 067 `task_order`; NULL = never dragged — those keep creation
 *  order (created_at ASC) ABOVE the manual range); user-completed subtasks
 *  (`completed_at`) sink to the bottom. There is NO pin concept in the Tasks
 *  rail — a session pinned in Projects keeps its pinned_at data but it does
 *  not reorder this list. ISO-8601 strings compare lexicographically in time
 *  order. */
export function subtasksFor(sessions: Session[], taskId: string): Session[] {
  return sessions
    .filter(s => s.task_id === taskId && s.type === 'subtask')
    .sort((a, b) => {
      const ad = a.completed_at != null ? 1 : 0;
      const bd = b.completed_at != null ? 1 : 0;
      if (ad !== bd) return ad - bd;
      if (!ad) {
        const am = a.task_order != null ? 1 : 0;
        const bm = b.task_order != null ? 1 : 0;
        if (am !== bm) return am - bm;
        if (am && bm) return a.task_order! - b.task_order!;
      }
      return a.created_at.localeCompare(b.created_at);
    });
}

/** The subtask rows the user can drag (2026-08-29): every open row; completed
 *  rows stay sunk at the bottom. The `session.reorder` overlay/endpoint
 *  covers exactly this subset. */
export function reorderableSubtasks(sessions: Session[], taskId: string): Session[] {
  return subtasksFor(sessions, taskId)
    .filter(s => s.completed_at == null);
}

/** Task ordering: manual drag order (migration 067 `sort_order`) wins; tasks
 *  never dragged (NULL) keep the automatic creation-time order (created_at
 *  DESC) ABOVE the manual range, so a fresh task still lands on top. The same
 *  order applies in both the open and done groups (2026-08-03: task pin no
 *  longer affects ordering). Exported for the unit tests. */
export function compareTasks(a: Task, b: Task): number {
  const am = a.sort_order != null ? 1 : 0;
  const bm = b.sort_order != null ? 1 : 0;
  if (am !== bm) return am - bm;
  if (am && bm) return a.sort_order! - b.sort_order!;
  return b.created_at.localeCompare(a.created_at);
}


export function TasksView({
  mode,
  onSetMode,
  tasks,
  sessions,
  workspaces,
  activeTaskId,
  activeSubtaskId,
  activeSessionId,
  onSelectSession,
  onPinSession,
  onArchiveSession,
  subtaskMain,
  onSelectSubtask,
  onNewWorkspace,
  onSetPendingFirstMessage,
  openNewForTaskId,
  onConsumeOpenNewForTaskId,
  railLayout,
}: {
  /** Top-level app mode — the persistent sidebar navigation reads/drives this. */
  mode: Mode;
  onSetMode: (mode: Mode) => void;
  tasks: Task[];
  sessions: Session[];
  workspaces: Workspace[];
  activeTaskId: string | null;
  activeSubtaskId: string | null;
  /** The 未分配 (untasked) Sessions group selects/pins/archives through the
   *  same App handlers the Project rail uses (2026-09-06). */
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onPinSession: (sessionId: string, pinned: boolean) => void;
  onArchiveSession: (sessionId: string) => void;
  /** A Subtask IS a Session: when one is selected, App builds the full
   *  <SessionSurface> element (the same one CodingView renders in Sessions
   *  mode, wired to the same App-level handlers rebound to the subtask's id)
   *  and hands it down here. It already renders its own `.main`, so
   *  TaskDetail drops it in place of the task placeholder. Null when no
   *  subtask is selected. */
  subtaskMain: React.ReactNode;
  onSelectSubtask: (taskId: string, subtaskId: string) => void;
  /** Open the New Repo dialog (the task-context new-session page's workspace
   *  drop "+ New Repo" row). */
  onNewWorkspace: () => void;
  /** App-owned pendingFirstMessage channel: the first composer message is
   *  stashed before create and auto-sent by the session:created socket
   *  handler. Pass null to clear a stashed message after a failed create. */
  onSetPendingFirstMessage: (pending: PendingFirstMessage | null) => void;
  /** App request from a Tasks sidebar shown beside another primary page. */
  openNewForTaskId?: string | null;
  onConsumeOpenNewForTaskId?: () => void;
  /** App-owned four-panel layout. Optional for isolated component renders. */
  railLayout?: RailLayoutController;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const fallbackRail = useResizableWidth('rail.w', 272, 200, 480, 'left');
  const rail = railLayout ?? fallbackRail;

  // Task-context new-session form (sidebar task-row "+" and the ⌘J/⌘K
  // "new subtask" shortcut open it): the shared NewSessionView with the task
  // shown read-only; submit dispatches `task.createSubtask` (REST
  // POST /api/tasks/:id/subtasks) through the operation layer. The pending
  // run drives the form's creating state; the created Session arrives as the
  // run's result and is selected on confirm.
  const [newForTaskId, setNewForTaskId] = useState<string | null>(null);
  const [newForAgentId, setNewForAgentId] = useState<string | undefined>(undefined);
  const [subtaskRun, setSubtaskRun] = useState<{
    runId: string;
    taskId: string;
    preserveDraftUntilUpload: boolean;
  } | null>(null);
  const subtaskCreateRun = useOperationRun(subtaskRun?.runId);
  const creatingSubtask = subtaskCreateRun?.phase === 'pending';

  useEffect(() => {
    if (!subtaskRun || !subtaskCreateRun) return;
    if (subtaskCreateRun.phase === 'confirmed') {
      const session = subtaskCreateRun.result as Session | undefined;
      const taskId = subtaskRun.taskId;
      if (!subtaskRun.preserveDraftUntilUpload) {
        clearNewSessionDraft({ kind: 'task', id: taskId });
      }
      setSubtaskRun(null);
      setNewForTaskId(null);
      if (session) onSelectSubtask(taskId, session.id);
    } else if (subtaskCreateRun.phase === 'failed') {
      setSubtaskRun(null);
      onSetPendingFirstMessage(null);
      toast({ kind: 'error', message: t('tasks.newSubtask.createFailed') });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtaskCreateRun?.phase]);

  // The top-left "Gian" brand button broadcasts `gian.toggle-rail` (Topbar);
  // each view collapses its own rail. Sessions (CodingView) already listens —
  // Tasks was missing this, so the brand button did nothing here.
  useEffect(() => {
    if (railLayout) return;
    const onToggle = () => rail.setCollapsed(!rail.collapsed);
    window.addEventListener('gian.toggle-rail', onToggle);
    return () => window.removeEventListener('gian.toggle-rail', onToggle);
  }, [rail.collapsed, rail.setCollapsed, railLayout]);

  // ⌘J / ⌘K (use-app-shortcuts) opens the new-session form for the selected
  // task with the chosen agent preselected — same form the task-row "+" opens.
  useEffect(() => {
    const open = (event: Event) => {
      if (!activeTaskId || activeSubtaskId) return;
      const agentId = (event as CustomEvent<{ agentId?: string }>).detail?.agentId;
      setNewForAgentId(agentId);
      setNewForTaskId(activeTaskId);
    };
    window.addEventListener('gian:new-subtask', open);
    return () => window.removeEventListener('gian:new-subtask', open);
  }, [activeTaskId, activeSubtaskId]);

  const activeTask = tasks.find(task => task.id === activeTaskId) ?? null;
  const activeSubtask = activeSubtaskId
    ? sessions.find(s => s.id === activeSubtaskId) ?? null
    : null;
  const newForTask = newForTaskId
    ? tasks.find(task => task.id === newForTaskId) ?? null
    : null;

  function openNewForTask(taskId: string) {
    setNewForAgentId(undefined);
    setNewForTaskId(taskId);
  }

  useEffect(() => {
    if (!openNewForTaskId) return;
    openNewForTask(openNewForTaskId);
    onConsumeOpenNewForTaskId?.();
  }, [openNewForTaskId, onConsumeOpenNewForTaskId]);

  function selectSubtask(taskId: string, subtaskId: string) {
    // A draft is background state, never a navigation lock. Hide the form
    // immediately and let the selected Session surface take over; reopening
    // the Task's "+" restores this Task's own persisted draft.
    setNewForTaskId(null);
    setNewForAgentId(undefined);
    onSelectSubtask(taskId, subtaskId);
  }

  function submitNewSubtask(taskId: string, input: CreateSessionInput) {
    if (!input.agentId) return;
    // Stash the first message before dispatching: the session:created socket
    // frame (origin 'task-create') consumes it and auto-sends once the
    // subtask session exists — same channel as the plain session create.
    onSetPendingFirstMessage({
      scope: { kind: 'task', id: taskId },
      text: input.firstMessage,
      attachments: input.firstAttachments ?? [],
      ...(input.contextItems && input.contextItems.length > 0
        ? { contextItems: input.contextItems }
        : {}),
      ...(input.composerDocument ? { composerDocument: input.composerDocument } : {}),
    });
    const run = dispatch('task.createSubtask', {
      taskId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      executor: input.executor,
      ...(input.name ? { name: input.name } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
      ...(input.thinkingEffort ? { thinkingEffort: input.thinkingEffort } : {}),
      ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    });
    setSubtaskRun({
      runId: run.id,
      taskId,
      preserveDraftUntilUpload: (input.firstAttachments?.length ?? 0) > 0,
    });
  }

  return (
    <div
      className={`view${rail.collapsed ? ' rail-collapsed' : ''}`}
      style={{ '--rail-w': `${rail.width}px` } as React.CSSProperties}
    >
      {/* Collapsed (2026-08-31 redesign): the full sidebar swaps for the 38px
          icon rail (Agents / Timer / Custom / 消息). */}
      {rail.collapsed ? (
        <LeftRail
          mode={mode}
          listMode="tasks"
          onSetMode={onSetMode}
          onExpand={() => rail.setCollapsed(false)}
        />
      ) : (
        <TasksSidebar
          mode={mode}
          onSetMode={onSetMode}
          listMode="tasks"
          onSetListMode={onSetMode}
          tasks={tasks}
          sessions={sessions}
          workspaces={workspaces}
          activeSubtaskId={activeSubtaskId}
          activeSessionId={activeSessionId}
          onSelectSubtask={selectSubtask}
          onSelectSession={onSelectSession}
          onPinSession={onPinSession}
          onArchiveSession={onArchiveSession}
          onNewSession={openNewForTask}
        />
      )}
      <RailSplitter onMouseDown={rail.onMouseDown} ariaLabel="Resize tasks list" />
      {newForTask ? (
        <NewSessionView
          key={`task:${newForTask.id}`}
          workspaces={workspaces}
          initialAgentId={newForAgentId}
          draftScope={{ kind: 'task', id: newForTask.id }}
          draftLabel={newForTask.name}
          onNewWorkspace={onNewWorkspace}
          creating={creatingSubtask}
          onCancel={() => {
            setNewForTaskId(null);
            setNewForAgentId(undefined);
          }}
          onCreate={input => { submitNewSubtask(newForTask.id, input); }}
        />
      ) : (
        <TaskDetail
          task={activeTask}
          subtask={activeSubtask}
          subtaskMain={subtaskMain}
        />
      )}
    </div>
  );
}

/** Inline new-task form — a small single-field card under the sidebar head. */
function NewTaskForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (input: { name: string }) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [name, setName] = useState('');

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit({ name: trimmed });
  }

  return (
    <div className="tasks-new-form">
      <input
        className="tasks-new-input"
        aria-label={t('tasks.form.name.label')}
        placeholder={t('tasks.form.name.placeholder')}
        value={name}
        autoFocus
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="tasks-new-form-actions">
        <button className="btn sm ghost" onClick={onCancel}>{t('tasks.form.cancel')}</button>
        <button className="btn sm primary" onClick={submit} disabled={!name.trim()}>
          {t('tasks.form.create')}
        </button>
      </div>
    </div>
  );
}

/** The per-task "⋯" dropdown (reuses the Spaces workspace-kebab styles).
 *  Open tasks get Mark-done / Rename / completed-Session visibility (in that
 *  order, with a divider after the primary action); done tasks get
 *  Reopen/Delete (2026-08-03: open tasks can't be deleted, done tasks can't
 *  be renamed).
 *
 *  The popover is portaled to <body> and viewport-clamped: the sidebar clips
 *  absolutely-positioned overflow, which cut long labels off at the panel's
 *  left edge (2026-08-14). */
function TaskMenu({
  task,
  anchorClass,
  completedSessionsHidden = false,
  onToggleCompletedSessions,
  onRename,
  onToggleDone,
  onDelete,
}: {
  task: Task;
  /** Trigger button class — `sb-act` on both the group header and done rows. */
  anchorClass: string;
  /** Open Tasks can hide/show their user-completed Session rows. */
  completedSessionsHidden?: boolean;
  onToggleCompletedSessions?: () => void;
  onRename: () => void;
  onToggleDone: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);

  // Right-align the popover to the trigger and clamp it into the viewport.
  // The portal mounts hidden on the first pass so we can measure its real
  // (max-content) width before placing it — no clipped frame is ever painted
  // because this runs in useLayoutEffect.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const btn = btnRef.current;
    const pop = popRef.current;
    if (!btn || !pop) return;
    const rect = btn.getBoundingClientRect();
    const width = pop.offsetWidth;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    setPos({ left, top: rect.bottom + 4 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (popRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // The popover is position: fixed, so it cannot track the anchor — close
    // on any scroll (capture, so sidebar scrolling counts) or window resize
    // instead of leaving it detached mid-air.
    const onScrollOrResize = () => setOpen(false);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open]);
  const done = task.status === 'done';
  return (
    <span className="ws-kebab-anchor" ref={ref}>
      <button
        ref={btnRef}
        type="button"
        className={anchorClass}
        data-testid={`task-menu-${task.id}`}
        aria-label={t('tasks.menu.more')}
        title={t('tasks.menu.more')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
      >
        <Icon d={I.kebab} size={14} stroke={2.6} />
      </button>
      {open && createPortal(
        <span
          ref={popRef}
          className="ws-kebab-pop ws-kebab-pop--fixed"
          role="menu"
          onClick={e => e.stopPropagation()}
          style={pos
            ? { left: pos.left, top: pos.top }
            : { visibility: 'hidden', left: 0, top: 0 }}
        >
          <button
            className="ws-kebab-item"
            role="menuitem"
            onClick={() => { setOpen(false); onToggleDone(); }}
          >
            {t(done ? 'tasks.reopen' : 'tasks.markDone')}
          </button>
          {!done && (
            <>
              <span className="ws-kebab-divider" />
              <button
                className="ws-kebab-item"
                role="menuitem"
                onClick={() => { setOpen(false); onRename(); }}
              >
                {t('path.menu.rename')}
              </button>
              {onToggleCompletedSessions && (
                <button
                  className="ws-kebab-item"
                  role="menuitem"
                  data-testid={`task-toggle-completed-${task.id}`}
                  onClick={() => { setOpen(false); onToggleCompletedSessions(); }}
                >
                  {t(completedSessionsHidden
                    ? 'tasks.menu.showCompletedSessions'
                    : 'tasks.menu.hideCompletedSessions')}
                </button>
              )}
            </>
          )}
          {done && (
            <>
              <span className="ws-kebab-divider" />
              <button
                className="ws-kebab-item danger"
                role="menuitem"
                onClick={() => { setOpen(false); onDelete(); }}
              >
                {t('common.delete')}
              </button>
            </>
          )}
        </span>,
        document.body,
      )}
    </span>
  );
}

/** Shared task-menu action builders — the same operations the topbar task
 *  menu performs (rename / done-toggle / delete), driven from the
 *  sidebar row "⋯". All mutations dispatch through the operation layer
 *  (Phase 3a): rename/done are optimistic overlays, delete is pending with
 *  the duplicate destructive guard. */
function useTaskActions(
  sessions: Session[],
  setRenamingTaskId: (taskId: string) => void,
) {
  const t = useT();
  const dispatch = useOperationDispatch();
  return {
    rename: (task: Task) => () => setRenamingTaskId(task.id),
    toggleDone: (task: Task) => () => {
      if (task.status !== 'done') {
        const blocked = sessions.some(session =>
          session.task_id === task.id
          && session.type === 'subtask'
          && (session.status === 'running' || session.status === 'pending'));
        if (blocked) {
          toast({ kind: 'error', message: t('tasks.done.blocked') });
          return;
        }
      }
      dispatch('task.toggleDone', { taskId: task.id, status: task.status === 'done' ? 'open' : 'done' });
    },
    remove: (task: Task) => () => {
      const count = sessions.filter(session => session.task_id === task.id).length;
      const cascade = count > 0
        ? ` ${t('tasks.remove.cascade').replace('{n}', String(count))}`
        : '';
      void confirmDialog({
        message: `${t('tasks.remove.confirmPrefix')} "${task.name || t('tasks.untitled')}"? ${t('tasks.remove.confirmSuffix')}${cascade}`,
        danger: true,
        confirmLabel: t('common.delete'),
      }).then(confirmed => {
        if (confirmed) dispatch('task.delete', { taskId: task.id });
      });
    },
  };
}

/** Inline task-name editor (sidebar ⋯ → Rename). Enter commits via
 *  `task.rename` (optimistic overlay), Escape / blur cancels. */
function TaskRenameInput({
  task,
  onDone,
}: {
  task: Task;
  onDone: () => void;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const [name, setName] = useState(task.name);

  function submit() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== task.name) {
      dispatch('task.rename', { taskId: task.id, name: trimmed });
    }
    onDone();
  }

  return (
    <input
      className="tasks-new-input task-rename-input"
      aria-label={t('tasks.form.name.label')}
      value={name}
      autoFocus
      onClick={e => e.stopPropagation()}
      onChange={e => setName(e.target.value)}
      onKeyDown={e => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') onDone();
      }}
      onBlur={onDone}
    />
  );
}

/** localStorage key for the Tasks rail's collapsed SECTIONS (进行中 /
 *  未分配 / 完成). Distinct from `gian.tasks.collapsed` (per-task subtask
 *  groups). Value: string[] of collapsed section keys; default `['done']`. */
const TASKS_SECTIONS_KEY = 'gian.tasks.sections.collapsed';

export function TasksSidebar({
  mode,
  onSetMode,
  listMode,
  onSetListMode,
  tasks,
  sessions,
  workspaces,
  activeSubtaskId,
  activeSessionId,
  onSelectSubtask,
  onSelectSession,
  onPinSession,
  onArchiveSession,
  onNewSession,
}: {
  mode: Mode;
  onSetMode: (mode: Mode) => void;
  listMode: SidebarListMode;
  onSetListMode: (mode: SidebarListMode) => void;
  tasks: Task[];
  sessions: Session[];
  workspaces: Workspace[];
  activeSubtaskId: string | null;
  activeSessionId: string | null;
  onSelectSubtask: (taskId: string, subtaskId: string) => void;
  /** Untasked sessions (未分配 group, 2026-09-06) select like Project rows —
   *  App hands them to the Project conversation surface. */
  onSelectSession: (id: string) => void;
  onPinSession: (sessionId: string, pinned: boolean) => void;
  onArchiveSession: (sessionId: string) => void;
  /** Open the task-context new-session form (task-row "+"). */
  onNewSession: (taskId: string) => void;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const open = () => setCreating(true);
    window.addEventListener('gian:new-task', open);
    return () => window.removeEventListener('gian:new-task', open);
  }, []);
  // Section collapse (2026-09-07 Codex-style refactor): every section label
  // (进行中 / 未分配 / 完成) collapses its group, persisted in localStorage so
  // switching to the Repos tab and back (which unmounts this rail) keeps the
  // state. Default: 完成 collapsed, the rest expanded.
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(TASKS_SECTIONS_KEY);
      return new Set<string>(raw ? JSON.parse(raw) : ['done']);
    } catch { return new Set(['done']); }
  });
  const toggleSection = (key: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem(TASKS_SECTIONS_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };
  // Display caps (2026-09-08 owner call): every Tasks rail list except the
  // Doing tasks' OPEN subtasks shows 5 rows up front; 显示更多 reveals 10
  // more per click. View-only, ephemeral (same as the Repos rail groups).
  const [unassignedShown, setUnassignedShown] = useState(GROUP_INITIAL_SHOWN);
  const [doneShown, setDoneShown] = useState(GROUP_INITIAL_SHOWN);
  // T2 (2026-09-06): session rows drag between lists for assignment. An
  // unassigned row dropped on an open task's header files it there; a task's
  // subtask dropped on another task's header moves it, and dropped on the
  // 未分配 section header releases it back to standalone. The row's own list
  // reorder controller still owns same-list drops.
  const [assignDrag, setAssignDrag] = useState<{ id: string; taskId: string | null } | null>(null);
  const unassignedDrag = (id: string): { props: RowDragProps; className: string } => ({
    className: assignDrag?.id === id ? ' dnd-dragging' : '',
    props: {
      draggable: true,
      onDragStart: event => {
        if ((event.target as HTMLElement).closest('button, input, textarea, a, [contenteditable]')) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', id);
        setAssignDrag({ id, taskId: null });
      },
      onDragOver: () => undefined,
      onDrop: () => undefined,
      onDragEnd: () => setAssignDrag(null),
    },
  });
  // Per-task subtask collapse (Codex-style, 2026-07-01). Default = expanded
  // (empty set); clicking the task's group header toggles it. Persisted so the
  // choice survives reloads.
  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('gian.tasks.collapsed');
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch { return new Set(); }
  });
  // Per-task visibility preference for user-completed Sessions. Like the
  // collapse state above, this is view-only and survives reloads without
  // changing Task or Session records on the Host.
  const [tasksWithCompletedHidden, setTasksWithCompletedHidden] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('gian.tasks.completed-hidden');
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch { return new Set(); }
  });
  const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null);
  const toggleTaskCollapsed = (taskId: string) => {
    setCollapsedTasks(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
      try { localStorage.setItem('gian.tasks.collapsed', JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };
  const toggleCompletedSessions = (taskId: string) => {
    setTasksWithCompletedHidden(previous => {
      const next = new Set(previous);
      if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
      try {
        localStorage.setItem('gian.tasks.completed-hidden', JSON.stringify([...next]));
      } catch { /* ignore */ }
      return next;
    });
  };

  // Archived tasks are hidden from the list (they're a soft-delete state).
  const visible = useMemo(() => tasks.filter(task => task.status !== 'archived'), [tasks]);
  // Sort on render (not by array order) so the list matches the host snapshot
  // after a refresh — no more "jump on reload".
  const open = useMemo(
    () => visible.filter(task => task.status === 'open').sort(compareTasks),
    [visible],
  );
  const done = useMemo(
    () => visible.filter(task => task.status === 'done').sort(compareTasks),
    [visible],
  );

  // 未分配 (2026-09-06): untasked standalone Sessions — Tasks mode must reach
  // EVERY conversation, not just task-bound subtasks. Hidden-workspace
  // sessions stay reachable here exactly like the Project rail's 无归属.
  // Creation order (oldest first) — the Tasks rail's global rule.
  const wsById = useMemo(() => new Map(workspaces.map(w => [w.id, w])), [workspaces]);
  const unassigned = useMemo(
    () => sessions
      .filter(s => s.task_id === null
        && s.archived === 0
        && s.type !== 'manager'
        && !(s.workspace_id != null && wsById.get(s.workspace_id)?.hidden === 1))
      .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [sessions, wsById],
  );

  // Task drag reorder (2026-08-29): the open group is the draggable range;
  // the 完成 section keeps its automatic order. While the `task.reorder` run
  // is in flight its whole-list overlay (the dragged id order) wins over the
  // canonical sort; on confirm the Host's sort_order column reproduces it.
  const taskOrderOverlay = useTaskOrderOverlay();
  const openOrdered = useMemo(
    () => (taskOrderOverlay ? orderByIds(open, taskOrderOverlay) : open),
    [open, taskOrderOverlay],
  );
  const taskDnd = useDragReorder((dragId, targetId, place) => {
    const current = openOrdered.map(task => task.id);
    const next = moveById(current, dragId, targetId, place);
    if (next !== current) dispatch('task.reorder', { ids: next });
  });

  const taskActions = useTaskActions(sessions, setRenamingTaskId);
  // Destructive-pending row treatment (proposal §5): a task being deleted
  // stays visible with a pending affordance until `task:deleted` lands — a
  // failed delete never requires a surprising reinsert.
  const pendingRuns = usePendingOperations();
  const deletingTaskIds = new Set(
    pendingRuns
      .filter(run => run.name === 'task.delete')
      .map(run => run.entityKey.slice(taskEntityKey('').length)),
  );

  function createTaskNow(input: { name: string }) {
    // Match how other entities are created in the app: dispatch the pending
    // create operation; the host echoes `task:created` before the
    // operation:result, so the canonical row appears first. No executor is
    // picked here — the task is a pure grouping; each session picks its own
    // agent at creation.
    dispatch('task.create', { name: input.name });
    setCreating(false);
  }

  // Open tasks (spec §C): EVERY one is expanded with its subtasks nested, so
  // multiple concurrent tasks stay visible at once. Each task renders as an
  // <OpenTaskGroup> — the header drags for task reorder (taskDnd), the
  // subtask rows drag within the task (the group's own controller).

  return (
    <aside className="sidebar tasks-rail">
      {/* 2026-08-31 redesign: nav rows scroll away with the list. 2026-09-08:
          the sticky [Tasks|Repos] segmented switch became the list-switch
          dropdown nav row under Timer — the ROW still sticks to the scroll
          top (New stays on the section headers' hover "+", 2026-09-07). */}
      <div className="sb-scroll">
        <SidebarNavRows mode={mode} onSetMode={onSetMode} />
        <SidebarListSwitch listMode={listMode} onSetListMode={onSetListMode} />
        {creating && (
          <NewTaskForm onSubmit={createTaskNow} onCancel={() => setCreating(false)} />
        )}
        {visible.length === 0 && !creating && (
          <p className="tasks-list-empty">{t('tasks.empty')}</p>
        )}
        {/* 进行中 always renders — even with zero open tasks — so its hover
            "+" (new task) stays reachable. */}
        <SidebarSection
          label={t('tasks.group.doing')}
          collapsed={collapsedSections.has('doing')}
          onToggle={() => toggleSection('doing')}
          onAdd={() => setCreating(true)}
          addTitle={t('tasks.new')}
          testid="tasks-section-doing"
        />
        {!collapsedSections.has('doing') && openOrdered.map(task => (
          <OpenTaskGroup
            key={task.id}
            task={task}
            sessions={sessions}
            activeSubtaskId={activeSubtaskId}
            isCollapsed={collapsedTasks.has(task.id)}
            completedSessionsHidden={tasksWithCompletedHidden.has(task.id)}
            renaming={renamingTaskId === task.id}
            deleting={deletingTaskIds.has(task.id)}
            dragProps={taskDnd.rowProps(task.id)}
            dragClass={taskDnd.rowClass(task.id)}
            wsById={wsById}
            onToggleCollapsed={() => toggleTaskCollapsed(task.id)}
            onToggleCompletedSessions={() => toggleCompletedSessions(task.id)}
            onRenameDone={() => setRenamingTaskId(null)}
            onSelectSubtask={onSelectSubtask}
            onNewSession={onNewSession}
            taskActions={taskActions}
            assignDragActive={assignDrag !== null && assignDrag.taskId !== task.id}
            onAssignDragStart={(sessionId, taskId) => setAssignDrag({ id: sessionId, taskId })}
            onAssignDragEnd={() => setAssignDrag(null)}
            onAssignDrop={() => {
              if (assignDrag) {
                dispatch('session.assignTask', { sessionId: assignDrag.id, taskId: task.id });
              }
              setAssignDrag(null);
            }}
          />
        ))}
        {unassigned.length > 0 && (
          <>
            <SidebarSection
              label={t('tasks.group.unassigned')}
              collapsed={collapsedSections.has('unassigned')}
              onToggle={() => toggleSection('unassigned')}
              testid="tasks-section-unassigned"
              className={assignDrag?.taskId != null ? ' dnd-assign-target' : ''}
              dropProps={{
                // Drop target for releasing a task-bound row back to standalone.
                onDragOver: assignDrag?.taskId != null
                  ? event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
                  : undefined,
                onDrop: assignDrag?.taskId != null
                  ? event => {
                      event.preventDefault();
                      dispatch('session.assignTask', { sessionId: assignDrag.id, taskId: null });
                      setAssignDrag(null);
                    }
                  : undefined,
              }}
            />
            {!collapsedSections.has('unassigned') && unassigned.slice(0, unassignedShown).map(s => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === activeSessionId}
                hideAge
                hidePin
                workspaceName={s.workspace_id != null ? wsById.get(s.workspace_id)?.name : undefined}
                drag={unassignedDrag(s.id)}
                onSelect={() => onSelectSession(s.id)}
                onPin={pinned => onPinSession(s.id, pinned)}
                onArchive={() => onArchiveSession(s.id)}
              />
            ))}
            {/* Display cap (2026-09-08 owner call): everything except the
                Doing tasks' OPEN subtasks caps at 5 rows + 显示更多. */}
            {!collapsedSections.has('unassigned') && unassigned.length > unassignedShown && (
              <button
                type="button"
                className="sb-showmore"
                data-testid="sb-showmore-unassigned"
                onClick={() => setUnassignedShown(n => n + GROUP_SHOW_MORE_STEP)}
              >
                {t('coding.sidebar.showMore').replace('{n}', String(unassigned.length - unassignedShown))}
              </button>
            )}
          </>
        )}
        {done.length > 0 && (
          <>
            <SidebarSection
              label={t('tasks.group.done')}
              collapsed={collapsedSections.has('done')}
              onToggle={() => toggleSection('done')}
              testid="tasks-section-done"
            />
            {!collapsedSections.has('done') && done.slice(0, doneShown).map(task => (
              <DoneTaskRow
                key={task.id}
                task={task}
                needsAttention={subtasksFor(sessions, task.id).some(sessionNeedsAttention)}
                renaming={renamingTaskId === task.id}
                deleting={deletingTaskIds.has(task.id)}
                onRenameDone={() => setRenamingTaskId(null)}
                menu={(
                  <TaskMenu
                    task={task}
                    anchorClass="sb-act"
                    onRename={taskActions.rename(task)}
                    onToggleDone={taskActions.toggleDone(task)}
                    onDelete={taskActions.remove(task)}
                  />
                )}
              />
            ))}
            {!collapsedSections.has('done') && done.length > doneShown && (
              <button
                type="button"
                className="sb-showmore"
                data-testid="sb-showmore-done"
                onClick={() => setDoneShown(n => n + GROUP_SHOW_MORE_STEP)}
              >
                {t('coding.sidebar.showMore').replace('{n}', String(done.length - doneShown))}
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * One open task in the sidebar (2026-08-29: extracted from TasksList so the
 * subtask list can own hooks): the `.sb-group` header — clicking it ONLY
 * toggles collapse, exactly like a Sessions-rail project group (2026-08-03:
 * tasks are no longer selectable; only subtasks are) — with the hover "⋯"
 * menu (rename/completed-Session visibility/done) and the "+" task-context
 * new-session form opener. The header drags for TASK reorder via TasksList's
 * controller; subtask rows drag WITHIN the task via this group's own
 * controller (open + unpinned rows form the draggable range —
 * `reorderableSubtasks`; pinned rows keep their pinned_at order above it,
 * completed rows stay sunk at the bottom).
 */
function OpenTaskGroup({
  task,
  sessions,
  activeSubtaskId,
  isCollapsed,
  completedSessionsHidden,
  renaming,
  deleting,
  dragProps,
  dragClass,
  wsById,
  onToggleCollapsed,
  onToggleCompletedSessions,
  onRenameDone,
  onSelectSubtask,
  onNewSession,
  taskActions,
  assignDragActive,
  onAssignDragStart,
  onAssignDragEnd,
  onAssignDrop,
}: {
  task: Task;
  sessions: Session[];
  activeSubtaskId: string | null;
  isCollapsed: boolean;
  completedSessionsHidden: boolean;
  renaming: boolean;
  deleting: boolean;
  /** Task-level drag (owned by TasksList's controller) on the group header. */
  dragProps: RowDragProps;
  dragClass: string;
  /** T3 hover-card context (project names) for the subtask rows. */
  wsById: Map<string, Workspace>;
  onToggleCollapsed: () => void;
  onToggleCompletedSessions: () => void;
  onRenameDone: () => void;
  onSelectSubtask: (taskId: string, subtaskId: string) => void;
  onNewSession: (taskId: string) => void;
  taskActions: ReturnType<typeof useTaskActions>;
  /** T2: true while a row from ANOTHER list is being dragged; the header then
   *  accepts the drop as a `session.assignTask` into this task. */
  assignDragActive: boolean;
  /** Subtask rows also start the cross-list assign drag (composed with their
   *  own reorder drag — same-list drops still reorder). */
  onAssignDragStart: (sessionId: string, taskId: string | null) => void;
  onAssignDragEnd: () => void;
  onAssignDrop: () => void;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  // Subtask drag reorder: while the `session.reorder` run is in flight its
  // whole-range overlay (the dragged id order) wins over the canonical
  // `task_order` sort; on confirm the Host column reproduces it.
  const orderOverlay = useSessionOrderOverlay('task', task.id);
  const rows = useMemo(() => {
    const base = subtasksFor(sessions, task.id)
      .filter(session => !completedSessionsHidden || session.completed_at == null);
    if (!orderOverlay) return base;
    const sortable = base.filter(s => s.completed_at == null);
    return [
      ...orderByIds(sortable, orderOverlay),
      ...base.filter(s => s.completed_at != null),
    ];
  }, [sessions, task.id, completedSessionsHidden, orderOverlay]);
  const subDnd = useDragReorder((dragId, targetId, place) => {
    const current = rows
      .filter(s => s.completed_at == null)
      .map(s => s.id);
    const next = moveById(current, dragId, targetId, place);
    if (next !== current) {
      dispatch('session.reorder', { scope: 'task', parentId: task.id, ids: next });
    }
  });
  // Display cap (2026-09-08 owner call): OPEN subtasks always render in
  // full; only the completed tail (shown via the ⋯ menu) caps at 5 rows +
  // 显示更多. View-only — the drag order is unaffected.
  const [completedShown, setCompletedShown] = useState(GROUP_INITIAL_SHOWN);
  const completedCount = rows.length - rows.filter(s => s.completed_at == null).length;
  const visibleRows = rows.filter(s => s.completed_at == null)
    .concat(rows.filter(s => s.completed_at != null).slice(0, completedShown));

  return (
    <div className="tasks-list-task">
      <div
        className={`sb-group task-group${isCollapsed ? '' : ' open'}${dragClass}${assignDragActive ? ' dnd-assign-target' : ''}`}
        onClick={onToggleCollapsed}
        {...dragProps}
        // T2 drop target: while an unassigned-group row is dragged, this
        // header accepts it as a `session.assignTask` (the row's own list
        // drag controller is untouched by the cross-list gesture).
        onDragOver={assignDragActive
          ? event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
          : dragProps.onDragOver}
        onDrop={assignDragActive
          ? event => { event.preventDefault(); onAssignDrop(); }
          : dragProps.onDrop}
      >
        <span className="sb-group-ico"><Icon d={isCollapsed ? I.listCollapse : I.listTodo} size={17} /></span>
        {renaming ? (
          <TaskRenameInput task={task} onDone={onRenameDone} />
        ) : (
          <span className="task-group-name">{task.name}</span>
        )}
        {deleting && (
          <span className="ri-age" data-testid={`task-deleting-${task.id}`}>{t('tasks.deleting')}</span>
        )}
        {/* 2026-08-04: the 待处理 count badge was removed from task
            headers — attention is conveyed per subtask row (StatusIcon),
            not rolled up onto the task title. */}
        {!deleting && (
        <span className="sb-group-acts">
          <TaskMenu
            task={task}
            anchorClass="sb-act"
            completedSessionsHidden={completedSessionsHidden}
            onToggleCompletedSessions={onToggleCompletedSessions}
            onRename={taskActions.rename(task)}
            onToggleDone={taskActions.toggleDone(task)}
            onDelete={taskActions.remove(task)}
          />
          <button
            type="button"
            className="sb-act"
            data-testid={`task-new-session-${task.id}`}
            aria-label={t('tasks.menu.newSession')}
            title={t('tasks.menu.newSession')}
            onClick={e => { e.stopPropagation(); onNewSession(task.id); }}
          >
            <Icon d={I.plus} size={14} />
          </button>
        </span>
        )}
      </div>
      {!isCollapsed && visibleRows.map(st => {
        // Compose the reorder drag with the cross-list assign drag: the row
        // starts both; same-list drops reorder (subDnd), a drop on another
        // task's header or the 未分配 section header assigns.
        const reorderDrag = st.completed_at == null
          ? subDnd.rowProps(st.id)
          : null;
        return (
        <SubtaskRow
          key={st.id}
          subtask={st}
          active={st.id === activeSubtaskId}
          workspaceName={st.workspace_id != null ? wsById.get(st.workspace_id)?.name : undefined}
          onSelect={() => onSelectSubtask(task.id, st.id)}
          drag={reorderDrag
            ? {
                className: subDnd.rowClass(st.id),
                props: {
                  ...reorderDrag,
                  onDragStart: event => {
                    reorderDrag.onDragStart(event);
                    if (!event.defaultPrevented) onAssignDragStart(st.id, task.id);
                  },
                  onDragEnd: event => {
                    reorderDrag.onDragEnd(event);
                    onAssignDragEnd();
                  },
                },
              }
            : undefined}
        />
        );
      })}
      {!isCollapsed && completedCount > completedShown && (
        <button
          type="button"
          className="sb-showmore"
          data-testid={`sb-showmore-completed-${task.id}`}
          onClick={event => {
            event.stopPropagation();
            setCompletedShown(n => n + GROUP_SHOW_MORE_STEP);
          }}
        >
          {t('coding.sidebar.showMore').replace('{n}', String(completedCount - completedShown))}
        </button>
      )}
    </div>
  );
}

/**
 * A completed Task in the 完成 section (2026-08-03 redesign): same visual
 * language as an open task group header — list-checks icon + struck, greyed
 * name — but NOT selectable (no subtasks) and without the "+" action. The
 * hover "⋯" menu carries rename / reopen / delete.
 */
function DoneTaskRow({ task, needsAttention, renaming, deleting, onRenameDone, menu }: {
  task: Task;
  /** A done Task still surfaces the rollup dot when a child subtask is
   *  待处理, so active/unread subtasks aren't lost in the collapsed 完成
   *  section. */
  needsAttention: boolean;
  renaming: boolean;
  /** Delete in flight (pending operation) — the row stays visible with a
   *  pending affordance until `task:deleted` lands (proposal §5). */
  deleting: boolean;
  onRenameDone: () => void;
  menu: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="sb-group task-group done-task-group">
      <span className="sb-group-ico"><Icon d={I.listChecks} size={17} /></span>
      {renaming ? (
        <TaskRenameInput task={task} onDone={onRenameDone} />
      ) : (
        <span className="task-group-name">{task.name}</span>
      )}
      {needsAttention && (
        <span className="task-attn-dot" title={t('tasks.needsAttention')} aria-label={t('tasks.needsAttention')} />
      )}
      {deleting ? (
        <span className="ri-age" data-testid={`task-deleting-${task.id}`}>{t('tasks.deleting')}</span>
      ) : (
        <span className="sb-group-acts">{menu}</span>
      )}
    </div>
  );
}

/**
 * Subtask row (spec 2026-06-28 §B/§D). Renders as a plain `.session-row` —
 * identical to a Sessions session row by construction (no indent, no guide
 * line, same padding/weight/active styling from components.css). Completion
 * (`completed_at`) is a USER flag, separate from turn `status`; a completed
 * subtask renders struck-through + greyed in place (`.subtask-done`) and
 * sinks to the bottom of its task. Hover actions mirror the Sessions rail:
 * pin (open subtasks only — floats the row to the top of its task) and a
 * complete/reopen toggle (REST /complete · /reopen — the same endpoints the
 * breadcrumb session menu uses). The shared `StatusIcon` (right) shows turn
 * state with merged unread/"待处理".
 */
function SubtaskRow({
  subtask,
  active,
  workspaceName,
  onSelect,
  drag,
}: {
  subtask: Session;
  active: boolean;
  /** T3 hover-card context (2026-09-06). */
  workspaceName?: string;
  onSelect: () => void;
  /** Drag-reorder wiring (OpenTaskGroup's controller); absent for completed
   *  rows, which sit outside the draggable range. */
  drag?: { props: RowDragProps; className: string };
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const done = subtask.completed_at != null;
  const running = subtask.status === 'running';
  // Pending complete/reopen run (Phase 3a): disables the toggle and blocks
  // duplicate submission while the REST call is in flight.
  const updating = useOperationPending(
    sessionEntityKey(subtask.id),
    done ? 'task.reopenSubtask' : 'task.completeSubtask',
  );
  const hover = useSessionHoverCard();
  return (
    <div
      className={`rail-item session-row${done ? ' subtask-done' : ''}${active ? ' active' : ''}${running ? ' is-running' : ''}${statusGlyphShown(subtask.status, subtask.unread === 1) ? ' has-status' : ''}${drag?.className ?? ''}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onMouseEnter={hover.onMouseEnter}
      onMouseLeave={hover.onMouseLeave}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
      }}
      {...(drag?.props ?? {})}
    >
      {hover.rect && (
        <SessionHoverCard
          session={subtask}
          rect={hover.rect}
          workspaceName={workspaceName}
          keepOpen={hover.keepOpen}
          scheduleClose={hover.onMouseLeave}
          close={hover.close}
        />
      )}
      <div className="ri-body">
        <div className="ri-row1">
          <span className="ri-title">{subtask.name || t('coding.session.untitled')}</span>
          {/* Row-end: the status glyph only (T4, 2026-09-06 — the Tasks rail
              dropped the relative-time stamp; the 38px reservation is scoped
              away in tasks-v3.css and comes back only on glyph-carrying rows
              via `has-status`, so a long title never runs under the glyph). */}
          {statusGlyphShown(subtask.status, subtask.unread === 1) && (
            <StatusIcon status={subtask.status} unread={subtask.unread === 1} />
          )}
        </div>
      </div>
      {/* Hover action: the complete toggle only (the Tasks rail has no pin
          concept, 2026-09-06). It covers the row-end glyph on hover (CSS) —
          EXCEPT while a turn is running: then it is not rendered at all (a
          disabled check next to the spinner read as "done"). */}
      <span className="ri-acts">
        {!running && (
          <button
            type="button"
            className="ri-act"
            data-testid={`subtask-complete-${subtask.id}`}
            aria-label={t(done ? 'tasks.subtask.reopen' : 'tasks.subtask.complete')}
            title={t(done ? 'tasks.subtask.reopen' : 'tasks.subtask.complete')}
            disabled={updating}
            onClick={e => {
              e.stopPropagation();
              // Complete/reopen routes through the operation layer (Phase
              // 3a): the pending run correlates the REST result; canonical
              // state converges via the session:updated broadcast plus the
              // definition's direct canonical patch (operations/task.ts).
              dispatch(done ? 'task.reopenSubtask' : 'task.completeSubtask', { sessionId: subtask.id });
            }}
          >
            <Icon d={done ? I.lockOpen : I.check} size={14} stroke={2.2} />
          </button>
        )}
      </span>
    </div>
  );
}

function TaskDetail({
  task,
  subtask,
  subtaskMain,
}: {
  task: Task | null;
  subtask: Session | null;
  subtaskMain: React.ReactNode;
}) {
  const t = useT();

  if (!task) {
    // A standalone (未分配) session selected from the Tasks rail opens in
    // place — no jump to Project mode (2026-09-06 owner call). App builds
    // the same <SessionSurface> as for a subtask.
    if (!subtask && subtaskMain) return <>{subtaskMain}</>;
    return (
      <main className="main tasks-detail-empty">
        <p>{t('tasks.detail.empty')}</p>
      </main>
    );
  }

  // A subtask is selected → a Subtask IS a Session, so render the exact same
  // full <SessionSurface> (chat/transcript/composer + header) that Sessions
  // mode renders. App builds it (`subtaskMain`) wired to the same App-level
  // handlers rebound to the subtask's id; the workbench Sheet + Inspector
  // also resolve to it because App synced `activeSessionId` to the subtask.
  // The element already renders its own `.main`, so we drop it in directly —
  // no extra `.main`/`.view` wrapper (matches how CodingView lays out `.main`).
  if (subtask) {
    // `subtaskMain` is built only once App has caught up (activeSession synced
    // to this subtask); show a lightweight placeholder for the one render where
    // it's still null.
    if (!subtaskMain) {
      return (
        <main className="main tasks-main">
          <div className="main-head">
            <div className="main-head-l">
              <span className="manager-task-name">{subtask.name || t('coding.session.untitled')}</span>
            </div>
          </div>
          <div className="main-scroll" />
        </main>
      );
    }
    return <>{subtaskMain}</>;
  }

  // Only a task is selected → a simple placeholder: the task name plus a hint
  // to pick or create a session (same visual language as the empty state).
  return (
    <main className="main tasks-detail-empty">
      <p className="tasks-detail-task-name">{task.name || t('tasks.untitled')}</p>
      <p>{t('tasks.detail.pickSession')}</p>
    </main>
  );
}
