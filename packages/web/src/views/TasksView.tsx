import { useEffect, useMemo, useState } from 'react';
import type { ApprovalDecision, ApprovalMode, Executor, NativeConfigValue, Session, Task, ThinkingEffort, Workspace } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { useResizableWidth, RailSplitter } from '../components/RailLayout.js';
import { ModeDropdown } from '../components/ModeDropdown.js';
import type { Mode } from '../components/Topbar.js';
import { StatusIcon, statusGlyphShown, relTime } from './session-list-status.js';
import type { QueueEntry, TranscriptItem } from '../types.js';
import type { ApprovalActionContext } from '../types.js';
import type { GianWs } from '../ws.js';
import { sessionNeedsAttention } from '../session-routing.js';
import { ManagerPanel } from './task-manager-panels.js';
export { ManagerInspector } from './task-manager-panels.js';

/** The session-level handlers the full Manager composer needs, pre-bound to the
 *  Manager session id by App (the Manager IS a session, so these are the same
 *  handlers a normal SessionMain uses). */
export interface ManagerComposerHandlers {
  onSetModel: (model: string) => void;
  onSetMode: (mode: ApprovalMode) => void;
  onSetEffort: (effort: ThinkingEffort | null) => void;
  onSetServiceTier: (tier: 'fast' | null) => void;
  onSetNativeConfig: (configId: string, value: NativeConfigValue) => void;
  onSendSkill: (name: string, path: string) => void;
  onQueueAdd: (text: string, attachments?: Array<{ path: string; name: string; mime: string }>) => void;
  onQueueRemove: (queueId: string) => void;
  onQueueReorder: (order: string[]) => void;
  onQueueClear: () => void;
  onQueueSendNow: () => void;
  onApprove: (
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | string[]>,
    context?: ApprovalActionContext,
  ) => void;
}

/** Params the A1 "create subtask from this" prefilled form collects. */
export interface NewSubtaskDraft {
  workspace_id: string;
  executor: Executor;
  name?: string;
  prompt: string;
}

/** A resolved manual subtask-create card that stays in the Manager conversation
 *  after the user creates it from the inline form. Non-interactive once it lands. */
export interface ManagerSubtaskCard {
  /** Subtask session id. */
  id: string;
  status: 'created';
  name?: string;
  /** Display name of the chosen workspace. */
  workspaceLabel?: string;
  executor: Executor;
  prompt: string;
  /** Creation time (ms). Anchors the card to its timeline position so it stays
   *  inline at the point the user acted, not at the bottom of the conversation. */
  ts: number;
  /** Whether this card's context note has already been folded into a Manager
   *  message (so it isn't sent twice). */
  acked: boolean;
}

/** Build the hidden, LLM-facing context note for a resolved card — prepended to
 *  the Manager's next message so it learns which manual subtask was created.
 *  English to match the Manager system prompt. */
export function managerCardContextNote(card: ManagerSubtaskCard): string {
  const bits = [
    card.name ? `name: "${card.name}"` : null,
    card.workspaceLabel ? `workspace: "${card.workspaceLabel}"` : null,
    `executor: ${card.executor}`,
  ].filter(Boolean).join(', ');
  return `[The user created a subtask — ${bits}. Its initial prompt was pre-filled into that subtask's composer for the user to send.]`;
}

// ── V2 icon paths (verbatim subset from design/gian-design-v2/js/data.jsx) ──
const I = {
  plus: 'M12 5v14 M5 12h14',
  check: 'M5 12l5 5L20 7',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  send: 'M5 12l14-7-5 17-3-7z',
  refresh: 'M3 12a9 9 0 0 1 15.5-6.3L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15.5 6.3L3 16 M3 21v-5h5',
  caretRight: 'M9 6l6 6-6 6',
  caretDown: 'M6 9l6 6 6-6',
  x: 'M6 6l12 12 M6 18L18 6',
  // list-checks — the task-group icon (2026-07-31). A checklist reads as "a
  // task with steps" and avoids overloading the pin, which already means
  // "pinned to top" in the task menu. Collapsed = dim, expanded = dark (CSS).
  listChecks: 'M3 17l2 2 4-4 M3 7l2 2 4-4 M13 6h8 M13 12h8 M13 18h8',
};

function Icon({ d, size = 14, stroke = 1.8 }: { d: string; size?: number; stroke?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

/** A Subtask is a Session with type==='subtask' and a matching task_id. Ordered
 *  by creation time, newest first (created_at DESC) — a stable "steps" order
 *  that doesn't jump around on activity (decided 2026-07-01). */
function subtasksFor(sessions: Session[], taskId: string): Session[] {
  return sessions
    .filter(s => s.task_id === taskId && s.type === 'subtask')
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Task ordering for the open group (decided 2026-07-01): pinned tasks first,
 *  most-recently-pinned on top (pinned_at DESC); the rest by creation time,
 *  newest first (created_at DESC). ISO-8601 strings compare lexicographically
 *  in time order. The done group ignores pins and just uses created_at DESC. */
function compareOpenTasks(a: Task, b: Task): number {
  const ap = a.pinned_at, bp = b.pinned_at;
  if (ap && bp) return bp.localeCompare(ap);
  if (ap) return -1;
  if (bp) return 1;
  return b.created_at.localeCompare(a.created_at);
}


export function TasksView({
  mode,
  onSetMode,
  onOpenSearch,
  tasks,
  sessions,
  workspaces,
  ws,
  defaultTaskExecutor,
  activeTaskId,
  activeSubtaskId,
  managerSession,
  managerItems,
  managerPending,
  managerCards,
  managerHandlers,
  managerQueue,
  showManagerRaw,
  onToggleManagerRaw,
  subtaskMain,
  onSelectTask,
  onSelectSubtask,
  onManagerMount,
  onManagerSend,
  onManagerStop,
  onCreateSubtask,
}: {
  /** Top-level app mode — the sidebar's mode dropdown reads/drives this. */
  mode: Mode;
  onSetMode: (mode: Mode) => void;
  /** Open the global CommandPalette (sidebar search button). */
  onOpenSearch: () => void;
  tasks: Task[];
  sessions: Session[];
  workspaces: Workspace[];
  ws: GianWs;
  /** Which executor a plain click on the sidebar "+" creates the PM on
   *  (`config.default_task_executor`). The "+" hover menu overrides it. */
  defaultTaskExecutor: Executor;
  activeTaskId: string | null;
  activeSubtaskId: string | null;
  /** The active Task's Manager session (type='manager'), or null until it has
   *  been ensured. Drives the shared Composer (draft persistence keyed by this
   *  session id, Send→Stop toggle). */
  managerSession: Session | null;
  /** Transcript items for the active Task's Manager session (App looks them up
   *  by the manager session id and hands them down). */
  managerItems: TranscriptItem[];
  /** Whether the Manager has a turn in flight. */
  managerPending: boolean;
  /** "Created" subtask cards (left by the manual create form) that stay in the
   *  Manager conversation for the active Task. */
  managerCards: ManagerSubtaskCard[];
  /** Session-level handlers (model / mode / effort / slash / queue / approve)
   *  pre-bound to the Manager session id — the full Manager composer reuses
   *  them. Null until the Manager session is ensured. */
  managerHandlers: ManagerComposerHandlers | null;
  /** The Manager session's message queue (for the QueueList). */
  managerQueue: QueueEntry[];
  /** Debug switch: show the Manager transcript's raw plumbing (system prompt /
   *  create_subtask blocks) instead of stripping it. */
  showManagerRaw: boolean;
  /** Toggle `showManagerRaw`. */
  onToggleManagerRaw: () => void;
  /** A Subtask IS a Session: when one is selected, App builds the full
   *  <SessionMain> element (the same one CodingView renders in Sessions mode,
   *  wired to the same App-level handlers rebound to the subtask's id) and
   *  hands it down here. It already renders its own `.main`, so TaskDetail
   *  drops it in place of the parent task's Manager panel. Null when no
   *  subtask is selected. */
  subtaskMain: React.ReactNode;
  onSelectTask: (taskId: string) => void;
  onSelectSubtask: (taskId: string, subtaskId: string) => void;
  /** Called when a Task detail opens — App ensures the Manager session exists
   *  and hydrates its transcript. */
  onManagerMount: (taskId: string) => void;
  /** Send a message to the Task's Manager (A1), optionally with attachments. */
  onManagerSend: (taskId: string, text: string, opts?: { attachments?: Array<{ path: string; name: string; mime: string; previewUrl: string }> }) => void;
  /** Stop the Task's Manager turn (session:stop on the manager session). */
  onManagerStop: (taskId: string) => void;
  /** Create a Subtask from the manual create form. */
  onCreateSubtask: (taskId: string, draft: NewSubtaskDraft) => void;
}) {
  const rail = useResizableWidth('tasks.rail.w', 300, 220, 480, 'left');

  // The top-left "Gian" brand button broadcasts `gian.toggle-rail` (Topbar);
  // each view collapses its own rail. Sessions (CodingView) already listens —
  // Tasks was missing this, so the brand button did nothing here.
  useEffect(() => {
    const onToggle = () => rail.setCollapsed(!rail.collapsed);
    window.addEventListener('gian.toggle-rail', onToggle);
    return () => window.removeEventListener('gian.toggle-rail', onToggle);
  }, [rail]);

  const activeTask = tasks.find(t => t.id === activeTaskId) ?? null;
  const activeSubtask = activeSubtaskId
    ? sessions.find(s => s.id === activeSubtaskId) ?? null
    : null;

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
        ws={ws}
        defaultTaskExecutor={defaultTaskExecutor}
        activeTaskId={activeTaskId}
        activeSubtaskId={activeSubtaskId}
        onSelectTask={onSelectTask}
        onSelectSubtask={onSelectSubtask}
      />
      <RailSplitter onMouseDown={rail.onMouseDown} ariaLabel="Resize tasks list" />
      <TaskDetail
        task={activeTask}
        subtask={activeSubtask}
        subtaskMain={subtaskMain}
        workspaces={workspaces}
        managerSession={managerSession}
        managerItems={managerItems}
        managerPending={managerPending}
        managerCards={managerCards}
        managerHandlers={managerHandlers}
        managerQueue={managerQueue}
        showManagerRaw={showManagerRaw}
        onToggleManagerRaw={onToggleManagerRaw}
        onManagerMount={onManagerMount}
        onManagerSend={onManagerSend}
        onManagerStop={onManagerStop}
        onCreateSubtask={onCreateSubtask}
      />
    </div>
  );
}

/** Inline new-task form — mirrors the search-row's affordance with a small
 *  two-field card under the sidebar head. */
function NewTaskForm({
  executor,
  onSubmit,
  onCancel,
}: {
  /** Which executor the Task's PM will run on (chosen at the "+"). Shown here
   *  so the user sees it before committing; the "+" hover menu changes it. */
  executor: Executor;
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
      <div className="tasks-new-pm">
        <span className={`sb-newtask-dot ${executor}`} />
        {t('tasks.form.pm')} · {executor === 'claude' ? 'Claude' : executor === 'codex' ? 'Codex' : 'Kimi'}
      </div>
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

function TasksList({
  mode,
  onSetMode,
  onOpenSearch,
  tasks,
  sessions,
  ws,
  defaultTaskExecutor,
  activeTaskId,
  activeSubtaskId,
  onSelectTask,
  onSelectSubtask,
}: {
  mode: Mode;
  onSetMode: (mode: Mode) => void;
  onOpenSearch: () => void;
  tasks: Task[];
  sessions: Session[];
  ws: GianWs;
  defaultTaskExecutor: Executor;
  activeTaskId: string | null;
  activeSubtaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onSelectSubtask: (taskId: string, subtaskId: string) => void;
}) {
  const t = useT();
  const [creating, setCreating] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  // Which executor the new Task's PM runs on. Set by the "+" (plain click →
  // the config default; hover menu → an explicit pick), rides into task:create.
  const [createExecutor, setCreateExecutor] = useState<Executor>(defaultTaskExecutor);
  const [doneOpen, setDoneOpen] = useState(false); // Done group collapsed by default (spec §G)
  // Per-task subtask collapse (Codex-style, 2026-07-01). Default = expanded
  // (empty set); clicking the task's group header toggles it. Persisted so the
  // choice survives reloads.
  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('gian.tasks.collapsed');
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch { return new Set(); }
  });
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
  // Sort on render (not by array order) so live pin/unpin re-orders instantly
  // and matches the host snapshot after a refresh — no more "jump on reload".
  const open = useMemo(
    () => visible.filter(task => task.status === 'open').sort(compareOpenTasks),
    [visible],
  );
  const done = useMemo(
    () => visible.filter(task => task.status === 'done')
      .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [visible],
  );

  // Open the create form for a specific PM executor. Plain "+" click passes the
  // config default; the "+" hover menu passes an explicit executor.
  function startCreate(executor: Executor) {
    setCreateExecutor(executor);
    setCreating(true);
    setCreateMenuOpen(false);
  }

  function createTaskNow(input: { name: string }) {
    // Match how other entities are created in the app: fire a WS message and
    // let the host echo back `task:created`. (REST createTask() also exists in
    // api.ts for the initial/fallback path.) Description is optional on the
    // wire and intentionally not collected by the form. `executor` picks which
    // executor the Task's PM runs on (chosen at the "+").
    ws.send({ type: 'task:create', name: input.name, executor: createExecutor });
    setCreating(false);
  }

  // Open tasks (spec §C): EVERY one is expanded with its subtasks nested, so
  // multiple concurrent tasks stay visible at once. Aligned with the Sessions
  // rail (CodingView): each task is a pure `.sb-group` header — clicking it ONLY
  // toggles collapse, no selection. The task's Manager session renders as the
  // group's first child row (`ManagerRow`); selecting it = selecting the task.
  const renderOpen = (group: Task[]) =>
    group.map(task => {
      const childSubs = subtasksFor(sessions, task.id);
      const mgr = sessions.find(s => s.task_id === task.id && s.type === 'manager') ?? null;
      // Group count = children that NEED the user (待处理): the Manager + its
      // subtasks, same rollup as the Sessions rail (2026-07-31). Hidden at zero.
      const attnCount = childSubs.filter(sessionNeedsAttention).length
        + (mgr && sessionNeedsAttention(mgr) ? 1 : 0);
      const isCollapsed = collapsedTasks.has(task.id);
      return (
        <div key={task.id} className="tasks-list-task">
          <div className={`sb-group task-group${isCollapsed ? '' : ' open'}`} onClick={() => toggleTaskCollapsed(task.id)}>
            <span className="sb-group-ico"><Icon d={I.listChecks} size={14} /></span>
            <span className="task-group-name">{task.name}</span>
            {attnCount > 0 && (
              <span className="count" title={t('tasks.needsAttention')}>{attnCount}</span>
            )}
          </div>
          {!isCollapsed && (
            <ManagerRow
              managerSession={mgr}
              active={task.id === activeTaskId && !activeSubtaskId}
              onSelect={() => onSelectTask(task.id)}
            />
          )}
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
          {/* "+" — plain click creates a Task whose PM runs on the config
              default executor; hover/focus reveals the native executor choices
              (gian-task-pm-engineer §4.2 — PM executor is per-Task). */}
          <div
            className={`sb-newtask${createMenuOpen ? ' open' : ''}`}
            onMouseEnter={() => setCreateMenuOpen(true)}
            onMouseLeave={() => setCreateMenuOpen(false)}
            onFocus={() => setCreateMenuOpen(true)}
            onBlur={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setCreateMenuOpen(false);
              }
            }}
            onKeyDown={event => {
              if (event.key === 'Escape') setCreateMenuOpen(false);
            }}
          >
            <button
              className={`sb-iconbtn${creating ? ' active' : ''}`}
              title={t('tasks.new')}
              aria-label={t('tasks.new')}
              aria-haspopup="menu"
              aria-expanded={createMenuOpen}
              onClick={() => {
                if (creating) {
                  setCreating(false);
                  setCreateMenuOpen(false);
                } else {
                  startCreate(defaultTaskExecutor);
                }
              }}
            >
              <Icon d={I.plus} />
            </button>
            <div className="sb-newtask-menu" role="menu" aria-label={t('tasks.new')}>
              <button className="sb-newtask-item" role="menuitem" onClick={() => startCreate('claude')}>
                <span className="sb-newtask-dot claude" />{t('tasks.new.withClaude')}
              </button>
              <button className="sb-newtask-item" role="menuitem" onClick={() => startCreate('codex')}>
                <span className="sb-newtask-dot codex" />{t('tasks.new.withCodex')}
              </button>
              <button className="sb-newtask-item" role="menuitem" onClick={() => startCreate('kimi')}>
                <span className="sb-newtask-dot kimi" />Kimi Code
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* No "Open" header (spec §F) — active tasks list directly. */}
      <div className="sb-scroll">
        {creating && (
          <NewTaskForm executor={createExecutor} onSubmit={createTaskNow} onCancel={() => setCreating(false)} />
        )}
        {renderOpen(open)}
        {visible.length === 0 && !creating && (
          <p className="tasks-list-empty">{t('tasks.empty')}</p>
        )}
      </div>

      {/* Done tasks (spec §G): pinned to the bottom, collapsed by default,
          reopen-only — no opening / messaging / other actions. */}
      {done.length > 0 && (
        <div className="tasks-done-pinned">
          <button
            className="sb-group done-group-head"
            onClick={() => setDoneOpen(o => !o)}
            aria-expanded={doneOpen}
          >
            <Icon d={doneOpen ? I.caretDown : I.caretRight} size={12} />
            <span>{t('tasks.group.done')}</span>
            <span className="count">{done.length}</span>
          </button>
          {doneOpen && (
            <div className="done-group-body">
              {done.map(task => (
                <DoneTaskRow
                  key={task.id}
                  task={task}
                  needsAttention={subtasksFor(sessions, task.id).some(sessionNeedsAttention)}
                  onReopen={() => ws.send({ type: 'task:update', task_id: task.id, status: 'open' })}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

/**
 * A completed Task in the pinned Done group (spec §G). Reopen-only: the round
 * toggle returns it to the active area; the row is NOT selectable (no opening /
 * messaging) and shows no subtasks.
 */
function DoneTaskRow({ task, needsAttention, onReopen }: {
  task: Task;
  /** Spec §G / Codex review: a done Task still surfaces the rollup dot when a
   *  child subtask is 待处理, so active/unread subtasks aren't lost in the
   *  collapsed Done group. */
  needsAttention: boolean;
  onReopen: () => void;
}) {
  const t = useT();
  return (
    <div className="rail-item task-row done-task-row">
      <button
        className="done-toggle done"
        title={t('tasks.reopen')}
        onClick={e => { e.stopPropagation(); onReopen(); }}
      >
        <Icon d={I.check} size={12} stroke={2.4} />
      </button>
      <div className="ri-body">
        <div className="ri-row1">
          <span className="ri-title">{task.name}</span>
          {needsAttention && (
            <span className="task-attn-dot" title={t('tasks.needsAttention')} aria-label={t('tasks.needsAttention')} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The task's Manager session, rendered as the FIRST child row of an expanded
 * task group (Tasks rail ↔ Sessions rail alignment, 2026-07-31). It looks like
 * a subtask row: title + the Manager's own StatusIcon at row end (turn status +
 * unread), falling back to the compact relative time when there's no glyph —
 * this row-end logic moved here verbatim from the retired TaskRow. Selecting it
 * = selecting the task (onSelectTask), which keeps the Manager chat in the main
 * panel. `managerSession` can be null before the Manager session is ensured —
 * the row still renders, just with no row-end glyph.
 */
function ManagerRow({
  managerSession,
  active,
  onSelect,
}: {
  /** The task's Manager session (or null until ensured) — drives the row-end
   *  StatusIcon. */
  managerSession: Session | null;
  active: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const mgr = managerSession;
  return (
    <div
      className={`rail-item session-row manager-row${active ? ' active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
      }}
    >
      <div className="ri-body">
        <div className="ri-row1">
          <span className="ri-title">{t('tasks.manager.title')}</span>
          {mgr && statusGlyphShown(mgr.status, mgr.unread === 1)
            ? <StatusIcon status={mgr.status} unread={mgr.unread === 1} />
            : mgr ? <span className={`ri-age ${mgr.executor}`}>{relTime(mgr.updated_at)}</span> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Subtask row (spec 2026-06-28 §B/§D). Renders as a plain `.session-row` —
 * identical to a Projects session row by construction (no indent, no guide
 * line, same padding/weight/active styling from components.css). Completion
 * (`completed_at`) is a USER flag, separate from turn `status`, set from the
 * breadcrumb session menu; a completed subtask renders struck-through +
 * greyed in place (`.subtask-done`). The shared `StatusIcon` (right) shows
 * turn state with merged unread/"待处理".
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
  const done = subtask.completed_at != null;
  return (
    <div
      className={`rail-item session-row${done ? ' subtask-done' : ''}${active ? ' active' : ''}`}
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
    </div>
  );
}

function TaskDetail({
  task,
  subtask,
  subtaskMain,
  workspaces,
  managerSession,
  managerItems,
  managerPending,
  managerCards,
  managerHandlers,
  managerQueue,
  showManagerRaw,
  onToggleManagerRaw,
  onManagerMount,
  onManagerSend,
  onManagerStop,
  onCreateSubtask,
}: {
  task: Task | null;
  subtask: Session | null;
  subtaskMain: React.ReactNode;
  workspaces: Workspace[];
  managerSession: Session | null;
  managerItems: TranscriptItem[];
  managerPending: boolean;
  managerCards: ManagerSubtaskCard[];
  managerHandlers: ManagerComposerHandlers | null;
  managerQueue: QueueEntry[];
  showManagerRaw: boolean;
  onToggleManagerRaw: () => void;
  onManagerMount: (taskId: string) => void;
  onManagerSend: (taskId: string, text: string, opts?: { attachments?: Array<{ path: string; name: string; mime: string; previewUrl: string }> }) => void;
  onManagerStop: (taskId: string) => void;
  onCreateSubtask: (taskId: string, draft: NewSubtaskDraft) => void;
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
  // full <SessionMain> (chat/transcript/composer + header) that Sessions mode
  // renders. App builds it (`subtaskMain`) wired to the same App-level handlers
  // rebound to the subtask's id; the workbench Sheet + Inspector also resolve
  // to it because App synced `activeSessionId` to the subtask. The element
  // already renders its own `.main`, so we drop it in directly — no extra
  // `.main`/`.view` wrapper (matches how CodingView lays out `.main`).
  if (subtask) {
    // `subtaskMain` is built only once App has caught up (activeSession synced
    // to this subtask); show a lightweight placeholder for the one render where
    // it's still null. The "Open in Sessions" jump stays as a secondary
    // affordance via the topbar, not a primary dead-end here.
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

  // Only a task is selected → the Manager chat is the main panel.
  return (
    <ManagerPanel
      task={task}
      session={managerSession}
      workspaces={workspaces}
      items={managerItems}
      pending={managerPending}
      cards={managerCards}
      handlers={managerHandlers}
      queue={managerQueue}
      showRaw={showManagerRaw}
      onToggleRaw={onToggleManagerRaw}
      onMount={onManagerMount}
      onSend={onManagerSend}
      onStop={onManagerStop}
      onCreateSubtask={onCreateSubtask}
    />
  );
}

/**
 * The per-Task Manager chat panel (PRD-v3 P3), styled like the prototype's
 * ManagerMain: a `.main` island with a head (`Manager` eyebrow · task name ·
 * status), the shared Transcript as the scroll body, and a composer at the
 * bottom. The Manager IS a session (type='manager', fixed-config Codex), so this
 * reuses the shared Transcript renderer for fidelity. Approvals never appear
 * because the Manager runs approvalPolicy:'never'.
 *
 * A1: a "Create subtask from this" affordance opens a prefilled NewSubtask
 * form. TODO(P3-live): auto-extract workspace/executor/prompt by parsing the
 * Manager's prose `create_subtask` suggestion — for now the user fills the form.
 */
