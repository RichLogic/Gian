import { useEffect, useMemo, useRef, useState } from 'react';
import type { Executor, Session, Task, Workspace } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { useResizableWidth, RailSplitter } from '../components/RailLayout.js';
import { ModeDropdown } from '../components/ModeDropdown.js';
import type { Mode } from '../components/Topbar.js';
import { StatusIcon, statusGlyphShown, relTime } from './session-list-status.js';
import { NewSessionView } from './new-session-view.js';
import type { CreateSessionInput } from './new-session-view.js';
import { confirm as confirmDialog, toast } from '../feedback.js';
import { sessionEntityKey } from '../operations/session.js';
import { taskEntityKey } from '../operations/task.js';
import {
  useOperationDispatch,
  useOperationPending,
  useOperationRun,
  usePendingOperations,
} from '../operations/use-operations.js';
import { sessionNeedsAttention } from '../session-routing.js';

// ── V2 icon paths (verbatim subset from design/gian-design-v2/js/data.jsx) ──
const I = {
  plus: 'M12 5v14 M5 12h14',
  check: 'M5 12l5 5L20 7',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  caretRight: 'M9 6l6 6-6 6',
  caretDown: 'M6 9l6 6 6-6',
  // pushpin — pin / unpin (same glyph as the Sessions rail pin).
  pin: 'M12 17v5 M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4a1 1 0 0 1 1 1z',
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

/** A Subtask is a Session with type==='subtask' and a matching task_id. Open
 *  subtasks come first — pinned ones float to the top (pinned_at DESC), the
 *  rest keep the stable "steps" order (created_at DESC, decided 2026-07-01)
 *  that doesn't jump around on activity. User-completed subtasks
 *  (`completed_at`) sink to the bottom (created_at DESC); they can't be
 *  pinned. ISO-8601 strings compare lexicographically in time order. */
export function subtasksFor(sessions: Session[], taskId: string): Session[] {
  return sessions
    .filter(s => s.task_id === taskId && s.type === 'subtask')
    .sort((a, b) => {
      const ad = a.completed_at != null ? 1 : 0;
      const bd = b.completed_at != null ? 1 : 0;
      if (ad !== bd) return ad - bd;
      if (!ad) {
        const ap = a.pinned_at, bp = b.pinned_at;
        if (ap && bp) return bp.localeCompare(ap);
        if (ap) return -1;
        if (bp) return 1;
      }
      return b.created_at.localeCompare(a.created_at);
    });
}

/** Task ordering (2026-08-03: task pin removed): creation time, newest first
 *  (created_at DESC) — the same order in both the open and done groups. */
function compareTasks(a: Task, b: Task): number {
  return b.created_at.localeCompare(a.created_at);
}


export function TasksView({
  mode,
  onSetMode,
  onOpenSearch,
  tasks,
  sessions,
  workspaces,
  activeTaskId,
  activeSubtaskId,
  subtaskMain,
  onSelectSubtask,
  onWorkspaceCreated,
}: {
  /** Top-level app mode — the sidebar's mode dropdown reads/drives this. */
  mode: Mode;
  onSetMode: (mode: Mode) => void;
  /** Open the global CommandPalette (sidebar search button). */
  onOpenSearch: () => void;
  tasks: Task[];
  sessions: Session[];
  workspaces: Workspace[];
  activeTaskId: string | null;
  activeSubtaskId: string | null;
  /** A Subtask IS a Session: when one is selected, App builds the full
   *  <SessionSurface> element (the same one CodingView renders in Sessions
   *  mode, wired to the same App-level handlers rebound to the subtask's id)
   *  and hands it down here. It already renders its own `.main`, so
   *  TaskDetail drops it in place of the task placeholder. Null when no
   *  subtask is selected. */
  subtaskMain: React.ReactNode;
  onSelectSubtask: (taskId: string, subtaskId: string) => void;
  /** NewSessionView lets the user create a workspace inline; App owns the
   *  workspace list. */
  onWorkspaceCreated: (workspace: Workspace) => void;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const rail = useResizableWidth('rail.w', 272, 200, 480, 'left');

  // Task-context new-session form (sidebar task-row "+" and the ⌘J/⌘K
  // "new subtask" shortcut open it): the shared NewSessionView with the task
  // shown read-only; submit dispatches `task.createSubtask` (REST
  // POST /api/tasks/:id/subtasks) through the operation layer. The pending
  // run drives the form's creating state; the created Session arrives as the
  // run's result and is selected on confirm.
  const [newForTaskId, setNewForTaskId] = useState<string | null>(null);
  const [newForExecutor, setNewForExecutor] = useState<Executor | undefined>(undefined);
  const [subtaskRun, setSubtaskRun] = useState<{ runId: string; taskId: string } | null>(null);
  const subtaskCreateRun = useOperationRun(subtaskRun?.runId);
  const creatingSubtask = subtaskCreateRun?.phase === 'pending';

  useEffect(() => {
    if (!subtaskRun || !subtaskCreateRun) return;
    if (subtaskCreateRun.phase === 'confirmed') {
      const session = subtaskCreateRun.result as Session | undefined;
      const taskId = subtaskRun.taskId;
      setSubtaskRun(null);
      setNewForTaskId(null);
      if (session) onSelectSubtask(taskId, session.id);
    } else if (subtaskCreateRun.phase === 'failed') {
      setSubtaskRun(null);
      toast({ kind: 'error', message: t('tasks.newSubtask.createFailed') });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtaskCreateRun?.phase]);

  // The top-left "Gian" brand button broadcasts `gian.toggle-rail` (Topbar);
  // each view collapses its own rail. Sessions (CodingView) already listens —
  // Tasks was missing this, so the brand button did nothing here.
  useEffect(() => {
    const onToggle = () => rail.setCollapsed(!rail.collapsed);
    window.addEventListener('gian.toggle-rail', onToggle);
    return () => window.removeEventListener('gian.toggle-rail', onToggle);
  }, [rail]);

  // ⌘J / ⌘K (use-app-shortcuts) opens the new-session form for the selected
  // task with the chosen agent preselected — same form the task-row "+" opens.
  useEffect(() => {
    const open = (event: Event) => {
      if (!activeTaskId || activeSubtaskId) return;
      const executor = (event as CustomEvent<{ executor?: Executor }>).detail?.executor;
      setNewForExecutor(executor);
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
    setNewForExecutor(undefined);
    setNewForTaskId(taskId);
  }

  function submitNewSubtask(taskId: string, input: CreateSessionInput) {
    const run = dispatch('task.createSubtask', {
      taskId,
      workspaceId: input.workspaceId,
      executor: input.executor,
      ...(input.name ? { name: input.name } : {}),
    });
    setSubtaskRun({ runId: run.id, taskId });
  }

  return (
    <div
      className={`view${rail.collapsed ? ' rail-collapsed' : ''}`}
      style={{ '--rail-w': `${rail.width}px` } as React.CSSProperties}
    >
      {/* The rail stays mounted while collapsed so its width can transition
          (phase 6); `.view.rail-collapsed` shrinks it to zero. */}
      <TasksList
        mode={mode}
        onSetMode={onSetMode}
        onOpenSearch={onOpenSearch}
        tasks={tasks}
        sessions={sessions}
        activeSubtaskId={activeSubtaskId}
        onSelectSubtask={onSelectSubtask}
        onNewSession={openNewForTask}
      />
      <RailSplitter onMouseDown={rail.onMouseDown} ariaLabel="Resize tasks list" />
      {newForTask ? (
        <NewSessionView
          workspaces={workspaces}
          taskName={newForTask.name}
          initialExecutor={newForExecutor}
          onWorkspaceCreated={onWorkspaceCreated}
          creating={creatingSubtask}
          onCancel={() => setNewForTaskId(null)}
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
 *  Open tasks get Rename/Mark-done; done tasks get Reopen/Delete
 *  (2026-08-03: open tasks can't be deleted, done tasks can't be renamed). */
function TaskMenu({
  task,
  anchorClass,
  onRename,
  onToggleDone,
  onDelete,
}: {
  task: Task;
  /** Trigger button class — `sb-act` on both the group header and done rows. */
  anchorClass: string;
  onRename: () => void;
  onToggleDone: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const done = task.status === 'done';
  return (
    <span className="ws-kebab-anchor" ref={ref}>
      <button
        type="button"
        className={anchorClass}
        data-testid={`task-menu-${task.id}`}
        aria-label={t('tasks.menu.more')}
        title={t('tasks.menu.more')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
      >
        <Icon d={I.kebab} size={13} stroke={2.6} />
      </button>
      {open && (
        <span className="ws-kebab-pop" role="menu" onClick={e => e.stopPropagation()}>
          {!done && (
            <button
              className="ws-kebab-item"
              role="menuitem"
              onClick={() => { setOpen(false); onRename(); }}
            >
              {t('path.menu.rename')}
            </button>
          )}
          <button
            className="ws-kebab-item"
            role="menuitem"
            onClick={() => { setOpen(false); onToggleDone(); }}
          >
            {t(done ? 'tasks.reopen' : 'tasks.markDone')}
          </button>
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
        </span>
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

function TasksList({
  mode,
  onSetMode,
  onOpenSearch,
  tasks,
  sessions,
  activeSubtaskId,
  onSelectSubtask,
  onNewSession,
}: {
  mode: Mode;
  onSetMode: (mode: Mode) => void;
  onOpenSearch: () => void;
  tasks: Task[];
  sessions: Session[];
  activeSubtaskId: string | null;
  onSelectSubtask: (taskId: string, subtaskId: string) => void;
  /** Open the task-context new-session form (task-row "+"). */
  onNewSession: (taskId: string) => void;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const [creating, setCreating] = useState(false);
  // Section collapse (2026-08-03 two-group layout): 完成 collapsed by
  // default, not persisted. The open group has no section header (2026-08-03:
  // the "In Progress" label was dropped — open tasks are the default list).
  const [doneOpen, setDoneOpen] = useState(false);
  // Per-task subtask collapse (Codex-style, 2026-07-01). Default = expanded
  // (empty set); clicking the task's group header toggles it. Persisted so the
  // choice survives reloads.
  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('gian.tasks.collapsed');
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
  // multiple concurrent tasks stay visible at once. Aligned with the Sessions
  // rail (CodingView): each task is a `.sb-group` header — clicking it ONLY
  // toggles collapse, exactly like a project group (2026-08-03: tasks are no
  // longer selectable; only subtasks are). The hover "⋯" menu carries
  // rename/done/delete, "+" opens the task-context new-session form.
  const renderOpen = (group: Task[]) =>
    group.map(task => {
      const childSubs = subtasksFor(sessions, task.id);
      const isCollapsed = collapsedTasks.has(task.id);
      const deleting = deletingTaskIds.has(task.id);
      return (
        <div key={task.id} className="tasks-list-task">
          <div
            className={`sb-group task-group${isCollapsed ? '' : ' open'}`}
            onClick={() => toggleTaskCollapsed(task.id)}
          >
            <span className="sb-group-ico"><Icon d={isCollapsed ? I.listCollapse : I.listTodo} size={14} /></span>
            {renamingTaskId === task.id ? (
              <TaskRenameInput task={task} onDone={() => setRenamingTaskId(null)} />
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
                <Icon d={I.plus} size={13} />
              </button>
            </span>
            )}
          </div>
          {!isCollapsed && childSubs.map(st => (
            <SubtaskRow
              key={st.id}
              subtask={st}
              active={st.id === activeSubtaskId}
              onSelect={() => onSelectSubtask(task.id, st.id)}
            />
          ))}
        </div>
      );
    });

  return (
    <aside className="sidebar">
      <div className="sb-head">
        <div className="sb-toprow">
          <ModeDropdown mode={mode} onSetMode={onSetMode} />
          <span className="sb-toprow-spacer" />
          <button
            type="button"
            className="sb-iconbtn"
            data-testid="sb-open-search"
            aria-label={t('coding.sidebar.search.label')}
            title={t('coding.sidebar.search.label')}
            onClick={onOpenSearch}
          >
            <Icon d={I.search} />
          </button>
          <button
            type="button"
            className={`sb-iconbtn${creating ? ' active' : ''}`}
            data-testid="sb-new-task"
            title={t('tasks.new')}
            aria-label={t('tasks.new')}
            onClick={() => setCreating(c => !c)}
          >
            <Icon d={I.plus} />
          </button>
        </div>
      </div>

      {/* Open tasks render directly (no section header); 完成 keeps its
          collapsible section, collapsed by default. */}
      <div className="sb-scroll">
        {creating && (
          <NewTaskForm onSubmit={createTaskNow} onCancel={() => setCreating(false)} />
        )}
        {visible.length === 0 && !creating && (
          <p className="tasks-list-empty">{t('tasks.empty')}</p>
        )}
        {open.length > 0 && renderOpen(open)}
        {done.length > 0 && (
          <>
            <button
              className="sb-section"
              onClick={() => setDoneOpen(o => !o)}
              aria-expanded={doneOpen}
              data-testid="tasks-section-done"
            >
              <Icon d={doneOpen ? I.caretDown : I.caretRight} size={12} />
              <span className="sb-section-label">{t('tasks.group.done')}</span>
              <span className="count">{done.length}</span>
            </button>
            {doneOpen && done.map(task => (
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
          </>
        )}
      </div>
    </aside>
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
      <span className="sb-group-ico"><Icon d={I.listChecks} size={14} /></span>
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
  onSelect,
}: {
  subtask: Session;
  active: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const done = subtask.completed_at != null;
  const pinned = subtask.pinned_at != null;
  const running = subtask.status === 'running';
  // Pending complete/reopen run (Phase 3a): disables the toggle and blocks
  // duplicate submission while the REST call is in flight.
  const updating = useOperationPending(
    sessionEntityKey(subtask.id),
    done ? 'task.reopenSubtask' : 'task.completeSubtask',
  );
  return (
    <div
      className={`rail-item session-row${done ? ' subtask-done' : ''}${active ? ' active' : ''}${running ? ' is-running' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
      }}
    >
      <div className="ri-body">
        <div className="ri-row1">
          <span className="ri-title">{subtask.name || t('coding.session.untitled')}</span>
          {/* Row-end = status glyph when there is one (unread shows even on the
              active row, for immediate "Mark as unread" feedback), else the
              compact relative time. */}
          {statusGlyphShown(subtask.status, subtask.unread === 1)
            ? <StatusIcon status={subtask.status} unread={subtask.unread === 1} />
            : <span className={`ri-age ${subtask.executor}`}>{relTime(subtask.updated_at)}</span>}
        </div>
        {/* Compact single-line layout: executor is carried by the time tint. */}
      </div>
      {/* Hover actions: pin / complete toggle. They cover the row-end glyph on
          hover (CSS) — EXCEPT while a turn is running: then the complete
          toggle is not rendered at all (a disabled check next to the spinner
          read as "done"), and the pin shifts left to sit BESIDE the running
          ring instead of covering it (`.is-running` rules in tasks-v3.css).
          A completed subtask can't be pinned (it sorts to the bottom of its
          task anyway); neither action stays visible off-hover — an always-on
          glyph would overlap the row-end time (2026-08-03). */}
      <span className="ri-acts">
        {!done && (
          <button
            type="button"
            className={`ri-act${pinned ? ' on' : ''}`}
            data-testid={`subtask-pin-${subtask.id}`}
            aria-label={t(pinned ? 'coding.session.unpin' : 'coding.session.pin')}
            title={t(pinned ? 'coding.session.unpin' : 'coding.session.pin')}
            onClick={e => {
              e.stopPropagation();
              // Pin routes through the operation layer (Phase 2a): the row
              // re-sorts immediately via the pinned_at overlay.
              dispatch('session.pin', { sessionId: subtask.id, pinned: !pinned });
            }}
          >
            <Icon d={I.pin} size={13} filled={pinned} />
          </button>
        )}
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
            <Icon d={done ? I.lockOpen : I.check} size={13} stroke={2.2} />
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
