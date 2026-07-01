import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalDecision, ApprovalMode, Executor, Session, Task, ThinkingEffort, Workspace } from '@gian/shared';
import { toast } from '../feedback.js';
import { useT } from '../i18n/index.js';
import { useResizableWidth, RailSplitter } from '../components/RailLayout.js';
import { Composer } from '../components/Composer.js';
import { QueueList } from '../components/QueueList.js';
import { Transcript } from '../transcript/Transcript.js';
import { StatusIcon, statusGlyphShown, relTime } from './CodingView.js';
import type { QueueEntry, TranscriptItem } from '../types.js';
import type { GianWs } from '../ws.js';

/** The session-level handlers the full Manager composer needs, pre-bound to the
 *  Manager session id by App (the Manager IS a session, so these are the same
 *  handlers a normal SessionMain uses). */
export interface ManagerComposerHandlers {
  onSetModel: (model: string) => void;
  onSetMode: (mode: ApprovalMode, turns?: number) => void;
  onSetEffort: (effort: ThinkingEffort | null) => void;
  onSendSkill: (name: string, path: string) => void;
  onQueueAdd: (text: string) => void;
  onQueueRemove: (queueId: string) => void;
  onQueueReorder: (order: string[]) => void;
  onQueueClear: () => void;
  onQueueSendNow: () => void;
  onApprove: (approvalId: string, decision: ApprovalDecision, answers?: Record<string, string | string[]>) => void;
}

/** Params the A1 "create subtask from this" prefilled form collects. */
export interface NewSubtaskDraft {
  workspace_id: string;
  executor: Executor;
  name?: string;
  prompt: string;
}

/** A resolved subtask-proposal card that stays in the Manager conversation
 *  after the user acts on it (§A2 follow-up). `created` = a subtask was made;
 *  `dismissed` = the proposal was declined. Non-interactive once it lands. */
export interface ManagerSubtaskCard {
  /** Subtask session id (created) or a generated id (dismissed). */
  id: string;
  status: 'created' | 'dismissed';
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
 *  the Manager's next message so it learns what the user did with its proposal.
 *  English to match the Manager system prompt. */
export function managerCardContextNote(card: ManagerSubtaskCard): string {
  const bits = [
    card.name ? `name: "${card.name}"` : null,
    card.workspaceLabel ? `workspace: "${card.workspaceLabel}"` : null,
    `executor: ${card.executor}`,
  ].filter(Boolean).join(', ');
  if (card.status === 'created') {
    return `[The user created a subtask — ${bits}. Its initial prompt was pre-filled into that subtask's composer for the user to send.]`;
  }
  return `[The user dismissed your subtask proposal (${bits}) without creating it.]`;
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
  pin: 'M12 17v5 M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
};

/** A subtask "needs the user" (待处理, spec §D/§E): waiting on input (pending)
 *  or a finished turn (done/error) the user hasn't read. */
function subtaskNeedsAttention(s: Session): boolean {
  return s.status === 'pending'
    || ((s.status === 'done' || s.status === 'error') && s.unread === 1);
}

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
  tasks,
  sessions,
  workspaces,
  ws,
  activeTaskId,
  activeSubtaskId,
  managerSession,
  managerItems,
  managerPending,
  managerProposal,
  managerCards,
  managerHandlers,
  managerQueue,
  showManagerRaw,
  onToggleManagerRaw,
  subtaskMain,
  onSelectTask,
  onSelectSubtask,
  onOpenSubtaskSession,
  onManagerMount,
  onManagerSend,
  onManagerStop,
  onCreateSubtask,
  onDismissSubtaskProposal,
}: {
  tasks: Task[];
  sessions: Session[];
  workspaces: Workspace[];
  ws: GianWs;
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
  /** Latest Manager-proposed subtask parsed from its reply (spec §A2). */
  managerProposal: Partial<NewSubtaskDraft> | null;
  /** Resolved subtask-action cards (created / dismissed) that stay in the
   *  Manager conversation for the active Task (§A2 follow-up). */
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
  /** Jump into Sessions mode focused on a subtask's underlying session.
   *  Secondary affordance — the default is the inline `subtaskMain` view. */
  onOpenSubtaskSession: (subtaskId: string) => void;
  /** Called when a Task detail opens — App ensures the Manager session exists
   *  and hydrates its transcript. */
  onManagerMount: (taskId: string) => void;
  /** Send a message to the Task's Manager (A1), optionally with attachments. */
  onManagerSend: (taskId: string, text: string, opts?: { attachments?: Array<{ path: string; name: string; mime: string; previewUrl: string }> }) => void;
  /** Stop the Task's Manager turn (session:stop on the manager session). */
  onManagerStop: (taskId: string) => void;
  /** A1 — create a Subtask from the prefilled form. */
  onCreateSubtask: (taskId: string, draft: NewSubtaskDraft) => void;
  /** The user declined a subtask proposal (leaves a `dismissed` card). */
  onDismissSubtaskProposal: (taskId: string, draft: NewSubtaskDraft) => void;
}) {
  const rail = useResizableWidth('tasks.rail.w', 300, 220, 480, 'left');

  const activeTask = tasks.find(t => t.id === activeTaskId) ?? null;
  const activeSubtask = activeSubtaskId
    ? sessions.find(s => s.id === activeSubtaskId) ?? null
    : null;

  return (
    <div
      className="view"
      style={{ '--rail-w': `${rail.width}px` } as React.CSSProperties}
    >
      <TasksList
        tasks={tasks}
        sessions={sessions}
        ws={ws}
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
        managerProposal={managerProposal}
        managerCards={managerCards}
        managerHandlers={managerHandlers}
        managerQueue={managerQueue}
        showManagerRaw={showManagerRaw}
        onToggleManagerRaw={onToggleManagerRaw}
        onOpenSubtaskSession={onOpenSubtaskSession}
        onManagerMount={onManagerMount}
        onManagerSend={onManagerSend}
        onManagerStop={onManagerStop}
        onCreateSubtask={onCreateSubtask}
        onDismissSubtaskProposal={onDismissSubtaskProposal}
      />
    </div>
  );
}

/** Inline new-task form — mirrors the search-row's affordance with a small
 *  two-field card under the sidebar head. */
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

function TasksList({
  tasks,
  sessions,
  ws,
  activeTaskId,
  activeSubtaskId,
  onSelectTask,
  onSelectSubtask,
}: {
  tasks: Task[];
  sessions: Session[];
  ws: GianWs;
  activeTaskId: string | null;
  activeSubtaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onSelectSubtask: (taskId: string, subtaskId: string) => void;
}) {
  const t = useT();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [doneOpen, setDoneOpen] = useState(false); // Done group collapsed by default (spec §G)
  // Per-task subtask collapse (Codex-style, 2026-07-01). Default = expanded
  // (empty set); a hover caret on the TaskRow toggles it. Persisted so the
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
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks.filter(task => {
      if (task.status === 'archived') return false;
      if (!q) return true;
      return (
        task.name.toLowerCase().includes(q) ||
        (task.description ?? '').toLowerCase().includes(q)
      );
    });
  }, [tasks, search]);
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

  function createTaskNow(input: { name: string }) {
    // Match how other entities are created in the app: fire a WS message and
    // let the host echo back `task:created`. (REST createTask() also exists in
    // api.ts for the initial/fallback path.) Description is optional on the
    // wire and intentionally not collected by the form.
    ws.send({ type: 'task:create', name: input.name });
    setCreating(false);
  }

  // A Task has an active subtask turn when any of its subtasks is running/
  // pending — the host blocks marking the Task done in that case (spec §G); we
  // pre-check here only to surface a toast (the real guard is host-side).
  const hasActiveSubtask = (taskId: string) =>
    sessions.some(s => s.task_id === taskId && s.type === 'subtask'
      && (s.status === 'running' || s.status === 'pending'));

  // Open tasks (spec §C): EVERY one is expanded with its subtasks nested, so
  // multiple concurrent tasks stay visible at once.
  const renderOpen = (group: Task[]) =>
    group.map(task => {
      const childSubs = subtasksFor(sessions, task.id);
      const attnCount = childSubs.filter(subtaskNeedsAttention).length;
      const mgr = sessions.find(s => s.task_id === task.id && s.type === 'manager') ?? null;
      const isCollapsed = collapsedTasks.has(task.id);
      return (
        <div key={task.id} className="tasks-list-task">
          <TaskRow
            task={task}
            active={task.id === activeTaskId && !activeSubtaskId}
            attnCount={attnCount}
            managerSession={mgr}
            onSelect={() => onSelectTask(task.id)}
            onToggleDone={() => {
              if (hasActiveSubtask(task.id)) {
                toast({ kind: 'error', message: t('tasks.done.blocked') });
                return;
              }
              ws.send({ type: 'task:update', task_id: task.id, status: 'done' });
            }}
            hasSubtasks={childSubs.length > 0}
            collapsed={isCollapsed}
            onToggleCollapse={() => toggleTaskCollapsed(task.id)}
          />
          {!isCollapsed && childSubs.map(st => (
            <SubtaskRow
              key={st.id}
              subtask={st}
              active={st.id === activeSubtaskId}
              onSelect={() => onSelectSubtask(task.id, st.id)}
            />
          ))}
          {!isCollapsed && childSubs.length === 0 && (
            <div className="tasks-empty-subs">{t('tasks.subtasks.empty')}</div>
          )}
        </div>
      );
    });

  return (
    <aside className="sidebar">
      <div className="sb-head">
        <div className="sb-search-row">
          <div className="sb-search">
            <Icon d={I.search} />
            <input
              placeholder={t('tasks.search')}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <span className="sb-sep" />
          <button
            className={`sb-iconbtn${creating ? ' active' : ''}`}
            title={t('tasks.new')}
            aria-label={t('tasks.new')}
            onClick={() => setCreating(c => !c)}
          >
            <Icon d={I.plus} />
          </button>
        </div>
      </div>

      {/* No "Open" header (spec §F) — active tasks list directly. */}
      <div className="sb-scroll">
        {creating && (
          <NewTaskForm onSubmit={createTaskNow} onCancel={() => setCreating(false)} />
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
                  needsAttention={subtasksFor(sessions, task.id).some(subtaskNeedsAttention)}
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
 * Parent task row (state model 2026-06-29). Two orthogonal axes, decoupled
 * left/right:
 *   - LEFT circle (done-toggle) = the TASK axis: ✓ when the task is done; else a
 *     count of subtasks that need you (待处理); else the hollow circle.
 *   - RIGHT glyph = the SESSION axis: the Manager's own StatusIcon (turn status
 *     + unread), exactly like a subtask row shows its own. The Manager IS the
 *     task's session, so its state lives here — same logic, same place.
 * Subtitle row carries the timestamp (the subtask count was dropped as noise).
 */
function TaskRow({
  task,
  active,
  attnCount,
  managerSession,
  onSelect,
  onToggleDone,
  hasSubtasks,
  collapsed,
  onToggleCollapse,
}: {
  task: Task;
  active: boolean;
  /** Number of subtasks that need the user (待处理): shown in the left circle. */
  attnCount: number;
  /** The task's Manager session (or null until ensured) — drives the row-end
   *  StatusIcon. */
  managerSession: Session | null;
  onSelect: () => void;
  onToggleDone: () => void;
  /** Whether the task has any subtasks — the collapse caret only shows if so. */
  hasSubtasks: boolean;
  /** Subtasks currently collapsed (hidden). Drives the caret direction. */
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const t = useT();
  const done = task.status === 'done';
  const showCount = !done && attnCount > 0;
  return (
    <div
      className={`rail-item task-row status-${task.status}${active ? ' active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
      }}
    >
      <button
        className={`done-toggle${done ? ' done' : ''}${showCount ? ' has-count' : ''}`}
        title={done ? t('tasks.reopen') : showCount ? t('tasks.needsAttention') : t('tasks.markDone')}
        onClick={e => { e.stopPropagation(); onToggleDone(); }}
      >
        {/* Always render the check (invisible until hover/done); the count
            overlays it and fades on hover so the check shows through — so a
            numbered task still reveals the "mark done" affordance on hover. */}
        <Icon d={I.check} size={12} stroke={2.4} />
        {showCount && <span className="dt-count">{attnCount}</span>}
      </button>
      <div className="ri-body">
        <div className="ri-row1">
          {task.pinned_at != null && (
            <span className="task-pin-badge" title={t('tasks.pinned')} aria-label={t('tasks.pinned')}>
              <Icon d={I.pin} size={11} stroke={1.8} />
            </span>
          )}
          <span className="ri-title">{task.name}</span>
          {hasSubtasks && (
            <button
              className="task-collapse-toggle"
              title={collapsed ? t('tasks.expand') : t('tasks.collapse')}
              aria-label={collapsed ? t('tasks.expand') : t('tasks.collapse')}
              aria-expanded={!collapsed}
              onClick={e => { e.stopPropagation(); onToggleCollapse(); }}
            >
              <Icon d={collapsed ? I.caretRight : I.caretDown} size={13} stroke={2} />
            </button>
          )}
        </div>
      </div>
      {/* Single-line (Codex-style): row-end = the Manager-as-session StatusIcon
          when it has one, else the task's compact relative time. */}
      {managerSession && statusGlyphShown(managerSession.status, managerSession.unread === 1)
        ? <StatusIcon status={managerSession.status} unread={managerSession.unread === 1} />
        : <span className={`ri-age ${managerSession?.executor ?? 'claude'}`}>{relTime(task.updated_at)}</span>}
    </div>
  );
}

/**
 * Nested subtask row (spec 2026-06-28 §B/§D). `.rail-item.subtask-row` indented
 * under its parent. No square toggle anymore — completion (`completed_at`) is a
 * USER flag, separate from turn `status`, set from the breadcrumb session menu;
 * a completed subtask renders struck-through + greyed in place. The shared
 * `StatusIcon` (right) shows turn state with merged unread/"待处理".
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
      className={`rail-item subtask-row status-${subtask.status}${done ? ' subtask-done' : ''}${active ? ' active' : ''}`}
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
        {/* Single-line (Codex-style): the Claude/Codex executor label was dropped. */}
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
  managerProposal,
  managerCards,
  managerHandlers,
  managerQueue,
  showManagerRaw,
  onToggleManagerRaw,
  onOpenSubtaskSession,
  onManagerMount,
  onManagerSend,
  onManagerStop,
  onCreateSubtask,
  onDismissSubtaskProposal,
}: {
  task: Task | null;
  subtask: Session | null;
  subtaskMain: React.ReactNode;
  workspaces: Workspace[];
  managerSession: Session | null;
  managerItems: TranscriptItem[];
  managerPending: boolean;
  managerProposal: Partial<NewSubtaskDraft> | null;
  managerCards: ManagerSubtaskCard[];
  managerHandlers: ManagerComposerHandlers | null;
  managerQueue: QueueEntry[];
  showManagerRaw: boolean;
  onToggleManagerRaw: () => void;
  onOpenSubtaskSession: (subtaskId: string) => void;
  onManagerMount: (taskId: string) => void;
  onManagerSend: (taskId: string, text: string, opts?: { attachments?: Array<{ path: string; name: string; mime: string; previewUrl: string }> }) => void;
  onManagerStop: (taskId: string) => void;
  onCreateSubtask: (taskId: string, draft: NewSubtaskDraft) => void;
  onDismissSubtaskProposal: (taskId: string, draft: NewSubtaskDraft) => void;
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
    // affordance via the topbar/inbox paths, not a primary dead-end here.
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
      proposal={managerProposal}
      cards={managerCards}
      handlers={managerHandlers}
      queue={managerQueue}
      showRaw={showManagerRaw}
      onToggleRaw={onToggleManagerRaw}
      onMount={onManagerMount}
      onSend={onManagerSend}
      onStop={onManagerStop}
      onCreateSubtask={onCreateSubtask}
      onDismissProposal={onDismissSubtaskProposal}
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
function ManagerPanel({
  task,
  session,
  workspaces,
  items,
  pending,
  handlers,
  queue = [],
  showRaw = false,
  onToggleRaw,
  onMount,
  onSend,
  onStop,
  onCreateSubtask,
  onDismissProposal,
  proposal,
  cards = [],
  compact = false,
}: {
  task: Task;
  /** The Manager session backing this Task (type='manager'), or null until it
   *  has been ensured. The shared Composer needs it for draft persistence and
   *  the Send→Stop toggle. */
  session: Session | null;
  workspaces: Workspace[];
  items: TranscriptItem[];
  pending: boolean;
  /** Session-level handlers (model / mode / effort / slash / queue / approve)
   *  bound to the Manager session id — the full composer + approval cards use
   *  them. Null until the Manager session is ensured. */
  handlers: ManagerComposerHandlers | null;
  /** The Manager's queued messages (QueueList). */
  queue?: QueueEntry[];
  /** Debug: show the transcript's raw plumbing instead of stripping it. */
  showRaw?: boolean;
  /** Toggle `showRaw` (only rendered in the full, non-compact head). */
  onToggleRaw?: () => void;
  onMount: (taskId: string) => void;
  onSend: (taskId: string, text: string, opts?: { attachments?: Array<{ path: string; name: string; mime: string; previewUrl: string }> }) => void;
  onStop: (taskId: string) => void;
  onCreateSubtask: (taskId: string, draft: NewSubtaskDraft) => void;
  onDismissProposal: (taskId: string, draft: NewSubtaskDraft) => void;
  /** Latest Manager-proposed subtask (spec §A2), parsed from its reply and
   *  prefilled into the confirm card; the card auto-opens on a new proposal. */
  proposal?: Partial<NewSubtaskDraft> | null;
  /** Resolved (created / dismissed) subtask cards that stay in the conversation
   *  (§A2 follow-up). */
  cards?: ManagerSubtaskCard[];
  /** Compact = embedded in the right Inspector rail (zone 4) when a subtask is
   *  selected. Drops the `.main-head` (the wrapping ManagerInspector supplies
   *  its own header) and the create-subtask affordance, matching the design's
   *  head-less compact ManagerMain. */
  compact?: boolean;
}) {
  const t = useT();
  const [showNewSubtask, setShowNewSubtask] = useState(false);
  // Whether the open form came from a Manager `create_subtask` proposal (vs the
  // header "Create subtask from this" button). Cancelling only leaves a
  // "dismissed" card when there was a real proposal to dismiss.
  const [formFromProposal, setFormFromProposal] = useState(false);
  const [dismissedPrompt, setDismissedPrompt] = useState<string | null>(null);
  // Executor preset from the ⌘J/⌘K shortcut (Claude / Codex). Null = use the
  // proposal's executor (or the form default).
  const [presetExecutor, setPresetExecutor] = useState<Executor | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Ensure the Manager session + hydrate its transcript when this Task opens.
  useEffect(() => {
    onMount(task.id);
  }, [task.id, onMount]);

  // ⌘J / ⌘K (global shortcut) open the create-subtask form, preset to the chosen
  // executor. Full panel only — the compact inspector has no inline form.
  useEffect(() => {
    if (compact) return;
    const open = (e: Event) => {
      const ex = (e as CustomEvent<{ executor?: Executor }>).detail?.executor ?? null;
      setPresetExecutor(ex);
      setShowNewSubtask(true);
      setFormFromProposal(false);
    };
    window.addEventListener('gian:new-subtask', open);
    return () => window.removeEventListener('gian:new-subtask', open);
  }, [compact]);

  // The inline form lives at the bottom of the conversation. The Transcript only
  // auto-scrolls on items/pending changes, so when the form opens via the header
  // button (no transcript change) scroll it into view ourselves.
  useEffect(() => {
    if (showNewSubtask && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [showNewSubtask]);

  // Auto-open the confirm card when the Manager proposes a (new) subtask
  // (spec §A2). Dismissing/submitting suppresses re-open for that same prompt.
  useEffect(() => {
    if (!compact && proposal?.prompt && proposal.prompt !== dismissedPrompt) {
      setShowNewSubtask(true);
      setFormFromProposal(true);
    }
  }, [compact, proposal, dismissedPrompt]);

  // The Manager is a fixed-config Codex session: a turn is "in flight" while it's
  // running or (defensively) pending. That drives the Composer's Send→Stop
  // toggle, exactly like a normal session.
  const managerRunning = pending
    || session?.status === 'running'
    || session?.status === 'pending';

  // The inline new-subtask form + the resolved cards live in the conversation
  // flow (issue #2). Empty placeholder only when there's truly nothing to show.
  const showInlineForm = !compact && showNewSubtask;
  const hasConversation = items.length > 0 || pending || cards.length > 0 || showInlineForm;

  return (
    <main className={`main tasks-main${compact ? ' compact' : ''}`}>
      {!compact && (
        <div className="main-head">
          <div className="main-head-l">
            {/* Keep the "Manager" eyebrow; the task name was dropped (the rail
                already shows which task is selected). */}
            <span className="manager-eyebrow">{t('tasks.manager.title')}</span>
            {/* Running status pill in the panel head. */}
            {managerRunning && (
              <span className="manager-status running" title={t('coding.status.running')}>
                <span className="manager-status-dot" />{t('coding.status.running')}
              </span>
            )}
          </div>
          <div className="main-head-r">
            {/* Debug switch: surface the Manager's raw plumbing in the transcript
                (system prompt / create_subtask blocks). One-click off once the UX
                is trusted. */}
            {onToggleRaw && (
              <button
                className={`btn sm ghost${showRaw ? ' active' : ''}`}
                title={t('tasks.manager.showRaw')}
                onClick={onToggleRaw}
              >
                {t('tasks.manager.showRaw')}
              </button>
            )}
            <button
              className="btn sm ghost"
              onClick={() => { setShowNewSubtask(s => !s); setFormFromProposal(false); }}
            >
              {t('tasks.manager.createSubtask')}
            </button>
          </div>
        </div>
      )}

      <div className="main-scroll" ref={scrollRef}>
        {!hasConversation ? (
          <div className="tasks-manager-placeholder">
            <span className="manager-eyebrow">{t('tasks.manager.eyebrow')}</span>
            <p>{t('tasks.manager.placeholder')}</p>
          </div>
        ) : (
          <>
            {/* §A2 follow-up: resolved subtask cards interleave into the
                transcript by timestamp, so each stays at the point in the
                conversation where the user acted — not all at the bottom. */}
            {(items.length > 0 || pending || cards.length > 0) && (
              <Transcript
                items={items}
                pending={pending}
                onApprove={handlers ? handlers.onApprove : () => { /* not ensured yet */ }}
                extras={cards.map(card => ({
                  id: card.id,
                  afterTs: card.ts,
                  node: <SubtaskCard card={card} />,
                }))}
              />
            )}
            {/* The open form is part of the conversation flow (not a top banner).
                The Transcript only auto-scrolls on items/pending changes, not on
                form keystrokes, so editing here is safe. */}
            {showInlineForm && (
              <NewSubtaskForm
                // Remount when the executor preset (⌘J/⌘K) or proposal changes so
                // the form re-initialises its executor field.
                key={`${proposal?.prompt ?? ''}:${presetExecutor ?? ''}`}
                workspaces={workspaces}
                prefill={proposal ?? (presetExecutor ? { executor: presetExecutor } : undefined)}
                onSubmit={d => {
                  onCreateSubtask(task.id, d);
                  setShowNewSubtask(false);
                  setPresetExecutor(null);
                  setDismissedPrompt(proposal?.prompt ?? null);
                }}
                onCancel={d => {
                  // Cancelling a real proposal leaves a static "dismissed" card
                  // (and feeds the Manager that context next turn). Cancelling a
                  // manually-opened form just closes it — there's no proposal to
                  // dismiss, so a "Proposal dismissed" record would be misleading.
                  if (formFromProposal && d) onDismissProposal(task.id, d);
                  setShowNewSubtask(false);
                  setPresetExecutor(null);
                  setDismissedPrompt(proposal?.prompt ?? null);
                }}
              />
            )}
          </>
        )}
      </div>

      {/* The Manager IS a session (type='manager'), so its composer is now the
          FULL shared <Composer> — model / approval-mode / effort / slash /
          attachments / queue all live, bound (via `handlers`) to the manager
          session id exactly like a normal session. Approval cards work because
          the Manager honors its approval_mode (host no longer forces a policy).
          While the session is still being ensured we show a disabled placeholder
          shell with identical chrome so the panel never reflows. */}
      {session ? (
        <>
          <QueueList
            queue={queue}
            onRemove={id => handlers?.onQueueRemove(id)}
            onReorder={order => handlers?.onQueueReorder(order)}
            onClear={() => handlers?.onQueueClear()}
            onSendNow={() => handlers?.onQueueSendNow()}
          />
          <Composer
            session={session}
            placeholder={t('tasks.manager.composer.placeholder')}
            onSend={(text, opts) => onSend(task.id, text, opts)}
            onSendSkill={(name, path) => handlers?.onSendSkill(name, path)}
            onStop={() => onStop(task.id)}
            onQueueAdd={text => handlers?.onQueueAdd(text)}
            onSetMode={(mode, turns) => handlers?.onSetMode(mode, turns)}
            onSetModel={model => handlers?.onSetModel(model)}
            onSetEffort={effort => handlers?.onSetEffort(effort)}
            disabled={managerRunning}
            running={managerRunning}
            executor={session.executor}
            workspaceId={session.workspace_id}
          />
        </>
      ) : (
        <div className="composer-wrap">
          <div className="composer">
            <div className="composer-input-wrap">
              <textarea
                className="composer-ta"
                rows={1}
                aria-label={t('tasks.manager.composer.placeholder')}
                placeholder={t('tasks.manager.composer.placeholder')}
                disabled
              />
            </div>
            <div className="composer-bar">
              <span className="spacer" />
              <button className="composer-act primary" disabled title={t('tasks.manager.send')}>
                <Icon d={I.send} stroke={2} />
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/**
 * Compact Manager panel for the right Inspector rail (zone 4) — shown when a
 * subtask is selected in Tasks mode (toggled by the dock's "Manager" button).
 * Mirrors design/gian-design-v2 → ManagerInspector: an
 * `.inspector.manager-inspector` aside with its own `.insp-head` wrapping a
 * head-less (compact) ManagerPanel, so you can talk to the parent Task's
 * Manager while reading one of its subtasks. Same transcript + composer + live
 * fixed-config Codex session as the full Manager view — just no header/island.
 */
export function ManagerInspector({
  task,
  session,
  workspaces,
  items,
  pending,
  handlers,
  queue = [],
  onMount,
  onSend,
  onStop,
}: {
  task: Task;
  session: Session | null;
  workspaces: Workspace[];
  items: TranscriptItem[];
  pending: boolean;
  handlers: ManagerComposerHandlers | null;
  queue?: QueueEntry[];
  onMount: (taskId: string) => void;
  onSend: (taskId: string, text: string, opts?: { attachments?: Array<{ path: string; name: string; mime: string; previewUrl: string }> }) => void;
  onStop: (taskId: string) => void;
}) {
  const t = useT();
  const managerRunning = pending || session?.status === 'running' || session?.status === 'pending';
  return (
    <aside className="inspector manager-inspector">
      <div className="insp-head">
        <span className="label">{t('tasks.manager.title')}</span>
        {/* Issue #1: running indicator mirrors the full panel head. */}
        {managerRunning && (
          <span className="manager-status running compact" title={t('coding.status.running')}>
            <span className="manager-status-dot" />
          </span>
        )}
        <button className="iconbtn" title={t('common.refresh')} onClick={() => onMount(task.id)}>
          <Icon d={I.refresh} size={13} stroke={1.6} />
        </button>
      </div>
      <div className="manager-inspector-body">
        <ManagerPanel
          task={task}
          session={session}
          workspaces={workspaces}
          items={items}
          pending={pending}
          handlers={handlers}
          queue={queue}
          onMount={onMount}
          onSend={onSend}
          onStop={onStop}
          onCreateSubtask={() => { /* compact: create-subtask lives in the full Manager view */ }}
          onDismissProposal={() => { /* compact: no inline form */ }}
          compact
        />
      </div>
    </aside>
  );
}

/**
 * A1 prefilled NewSubtask form. Prefills the workspace (first visible),
 * executor, and an empty prompt. The user confirms; submission creates a real
 * Subtask (session with task_id) via the REST path in App. TODO(P3-live): seed
 * these fields from the Manager's parsed `create_subtask` prose instead of
 * leaving them at defaults.
 */
function NewSubtaskForm({
  workspaces,
  onSubmit,
  onCancel,
  prefill,
}: {
  workspaces: Workspace[];
  onSubmit: (draft: NewSubtaskDraft) => void;
  /** Cancel carries the current draft so the caller can leave a "dismissed"
   *  card (§A2 follow-up). Undefined when there's no workspace to act on. */
  onCancel: (draft?: NewSubtaskDraft) => void;
  /** Optional context-derived defaults (A1 auto-extract target). */
  prefill?: Partial<NewSubtaskDraft>;
}) {
  const t = useT();
  const visibleWs = useMemo(() => workspaces.filter(w => w.hidden !== 1), [workspaces]);
  const [workspaceId, setWorkspaceId] = useState(
    prefill?.workspace_id ?? visibleWs[0]?.id ?? '',
  );
  const [executor, setExecutor] = useState<Executor>(prefill?.executor ?? 'codex');
  const [name, setName] = useState(prefill?.name ?? '');
  const [prompt, setPrompt] = useState(prefill?.prompt ?? '');

  function currentDraft(): NewSubtaskDraft {
    return {
      workspace_id: workspaceId,
      executor,
      ...(name.trim() ? { name: name.trim() } : {}),
      prompt: prompt.trim(),
    };
  }

  function submit() {
    if (!workspaceId) return;
    onSubmit(currentDraft());
  }

  if (visibleWs.length === 0) {
    return (
      <div className="tasks-subtask-form">
        <p className="tasks-subtask-hint">{t('tasks.newSubtask.noWorkspace')}</p>
        <div className="tasks-subtask-form-actions">
          <button className="btn sm ghost" onClick={() => onCancel()}>{t('tasks.newSubtask.cancel')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="tasks-subtask-form">
      <div className="tasks-subtask-form-title">{t('tasks.newSubtask.title')}</div>
      <label className="tasks-field">
        <span className="tasks-field-label">{t('tasks.newSubtask.workspace')}</span>
        <select className="tasks-field-input" value={workspaceId} onChange={e => setWorkspaceId(e.target.value)}>
          {visibleWs.map(w => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
      </label>
      <label className="tasks-field">
        <span className="tasks-field-label">{t('tasks.newSubtask.executor')}</span>
        <select
          className="tasks-field-input"
          value={executor}
          onChange={e => setExecutor(e.target.value as Executor)}
        >
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
        </select>
      </label>
      <label className="tasks-field">
        <span className="tasks-field-label">{t('tasks.form.name.label')}</span>
        <input
          className="tasks-field-input"
          value={name}
          placeholder={t('tasks.form.name.placeholder')}
          onChange={e => setName(e.target.value)}
        />
      </label>
      <label className="tasks-field">
        <span className="tasks-field-label">{t('tasks.newSubtask.prompt')}</span>
        <textarea
          className="tasks-field-input"
          rows={3}
          value={prompt}
          placeholder={t('tasks.newSubtask.promptPlaceholder')}
          onChange={e => setPrompt(e.target.value)}
        />
      </label>
      <div className="tasks-subtask-form-actions">
        <button className="btn sm ghost" onClick={() => onCancel(currentDraft())}>{t('tasks.newSubtask.cancel')}</button>
        <button className="btn sm primary" onClick={submit} disabled={!workspaceId}>
          {t('tasks.newSubtask.create')}
        </button>
      </div>
    </div>
  );
}

/**
 * A resolved subtask-proposal card (§A2 follow-up) — a non-interactive record
 * that the user created or dismissed a subtask, kept inline in the Manager
 * conversation so the exchange reads as a continuous history.
 */
function SubtaskCard({ card }: { card: ManagerSubtaskCard }) {
  const t = useT();
  const created = card.status === 'created';
  return (
    <div className={`manager-subtask-card ${card.status}`}>
      <span className={`msc-icon ${card.status}`} aria-hidden="true">
        <Icon d={created ? I.check : I.x} size={12} stroke={2.2} />
      </span>
      <div className="msc-body">
        <div className="msc-head">
          <span className="msc-status">
            {created ? t('tasks.subtaskCard.created') : t('tasks.subtaskCard.dismissed')}
          </span>
          {card.name && <span className="msc-name">{card.name}</span>}
        </div>
        <div className="msc-meta">
          <span className={`ri-exec ${card.executor}`}>
            {card.executor === 'claude' ? 'Claude' : 'Codex'}
          </span>
          {card.workspaceLabel && (
            <>
              <span className="ri-dot-sep">·</span>
              <span className="msc-ws">{card.workspaceLabel}</span>
            </>
          )}
        </div>
        {card.prompt && <p className="msc-prompt">{card.prompt}</p>}
      </div>
    </div>
  );
}
