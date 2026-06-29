import { useEffect, useMemo, useState } from 'react';
import type { Executor, Session, Task, Workspace } from '@gian/shared';
import { toast } from '../feedback.js';
import { useT } from '../i18n/index.js';
import { useResizableWidth, RailSplitter } from '../components/RailLayout.js';
import { Transcript } from '../transcript/Transcript.js';
import { StatusIcon } from './CodingView.js';
import type { TranscriptItem } from '../types.js';
import type { GianWs } from '../ws.js';

/** Params the A1 "create subtask from this" prefilled form collects. */
export interface NewSubtaskDraft {
  workspace_id: string;
  executor: Executor;
  name?: string;
  prompt: string;
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

/** A Subtask is a Session with type==='subtask' and a matching task_id. */
function subtasksFor(sessions: Session[], taskId: string): Session[] {
  return sessions.filter(s => s.task_id === taskId && s.type === 'subtask');
}

/** Compact relative-time label for the task row's trailing `.ri-age`, matching
 *  the prototype's "2 min ago" / "Today 11:04" / "May 18" treatment. */
function relativeAge(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const now = Date.now();
  const diff = now - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min} min ago`;
  const d = new Date(then);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) {
    return `Today ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function TasksView({
  tasks,
  sessions,
  workspaces,
  ws,
  activeTaskId,
  activeSubtaskId,
  managerItems,
  managerPending,
  managerProposal,
  subtaskMain,
  onSelectTask,
  onSelectSubtask,
  onOpenSubtaskSession,
  onManagerMount,
  onManagerSend,
  onCreateSubtask,
}: {
  tasks: Task[];
  sessions: Session[];
  workspaces: Workspace[];
  ws: GianWs;
  activeTaskId: string | null;
  activeSubtaskId: string | null;
  /** Transcript items for the active Task's Manager session (App looks them up
   *  by the manager session id and hands them down). */
  managerItems: TranscriptItem[];
  /** Whether the Manager has a turn in flight. */
  managerPending: boolean;
  /** Latest Manager-proposed subtask parsed from its reply (spec §A2). */
  managerProposal: Partial<NewSubtaskDraft> | null;
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
  /** Send a prose message to the Task's Manager (A1). */
  onManagerSend: (taskId: string, text: string) => void;
  /** A1 — create a Subtask from the prefilled form. */
  onCreateSubtask: (taskId: string, draft: NewSubtaskDraft) => void;
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
        managerItems={managerItems}
        managerPending={managerPending}
        managerProposal={managerProposal}
        onOpenSubtaskSession={onOpenSubtaskSession}
        onManagerMount={onManagerMount}
        onManagerSend={onManagerSend}
        onCreateSubtask={onCreateSubtask}
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
  const open = visible.filter(task => task.status === 'open');
  const done = visible.filter(task => task.status === 'done');

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
      return (
        <div key={task.id} className="tasks-list-task">
          <TaskRow
            task={task}
            active={task.id === activeTaskId && !activeSubtaskId}
            subCount={childSubs.length}
            needsAttention={childSubs.some(subtaskNeedsAttention)}
            onSelect={() => onSelectTask(task.id)}
            onToggleDone={() => {
              if (hasActiveSubtask(task.id)) {
                toast({ kind: 'error', message: t('tasks.done.blocked') });
                return;
              }
              ws.send({ type: 'task:update', task_id: task.id, status: 'done' });
            }}
          />
          {childSubs.map(st => (
            <SubtaskRow
              key={st.id}
              subtask={st}
              active={st.id === activeSubtaskId}
              onSelect={() => onSelectSubtask(task.id, st.id)}
            />
          ))}
          {childSubs.length === 0 && (
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
 * Parent task row. Ported from the prototype's TaskRow — a `.rail-item.task-row`
 * with a Reminders-style done toggle at the start, the task name, and a subtask
 * count subtitle. No caret/triangle: the selected task IS the expanded one.
 */
function TaskRow({
  task,
  active,
  subCount,
  needsAttention,
  onSelect,
  onToggleDone,
}: {
  task: Task;
  active: boolean;
  subCount: number;
  /** Spec §E: any subtask is 待处理 → show a solid accent rollup dot. */
  needsAttention: boolean;
  onSelect: () => void;
  onToggleDone: () => void;
}) {
  const t = useT();
  const age = relativeAge(task.updated_at);
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
        className={`done-toggle${task.status === 'done' ? ' done' : ''}`}
        title={task.status === 'done' ? t('tasks.reopen') : t('tasks.markDone')}
        onClick={e => { e.stopPropagation(); onToggleDone(); }}
      >
        <Icon d={I.check} size={12} stroke={2.4} />
      </button>
      <div className="ri-body">
        <div className="ri-row1">
          <span className="ri-title">{task.name}</span>
          {/* Spec §E: solid accent rollup dot — no gradient, distinct from the
             subtask status glyphs — when any subtask needs the user. */}
          {needsAttention && (
            <span className="task-attn-dot" title={t('tasks.needsAttention')} aria-label={t('tasks.needsAttention')} />
          )}
        </div>
        <div className="ri-row2">
          <span className="ri-sub" style={{ flex: 1 }}>
            {subCount} {subCount === 1 ? t('tasks.subtask.one') : t('tasks.subtask.many')}
          </span>
        </div>
      </div>
      {age && <span className="ri-age" title={task.updated_at}>{age}</span>}
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
          {/* Unread is merged into the StatusIcon (spec §D) — no separate dot. */}
          <StatusIcon status={subtask.status} unread={subtask.unread === 1 && !active} />
        </div>
        <div className="ri-row2">
          <span className={`ri-exec ${subtask.executor}`}>
            {subtask.executor === 'claude' ? 'Claude' : 'Codex'}
          </span>
        </div>
      </div>
    </div>
  );
}

function TaskDetail({
  task,
  subtask,
  subtaskMain,
  workspaces,
  managerItems,
  managerPending,
  managerProposal,
  onOpenSubtaskSession,
  onManagerMount,
  onManagerSend,
  onCreateSubtask,
}: {
  task: Task | null;
  subtask: Session | null;
  subtaskMain: React.ReactNode;
  workspaces: Workspace[];
  managerItems: TranscriptItem[];
  managerPending: boolean;
  managerProposal: Partial<NewSubtaskDraft> | null;
  onOpenSubtaskSession: (subtaskId: string) => void;
  onManagerMount: (taskId: string) => void;
  onManagerSend: (taskId: string, text: string) => void;
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
      workspaces={workspaces}
      items={managerItems}
      pending={managerPending}
      proposal={managerProposal}
      onMount={onManagerMount}
      onSend={onManagerSend}
      onCreateSubtask={onCreateSubtask}
    />
  );
}

/**
 * The per-Task Manager chat panel (PRD-v3 P3), styled like the prototype's
 * ManagerMain: a `.main` island with a head (`Manager` eyebrow · task name ·
 * status), the shared Transcript as the scroll body, and a composer at the
 * bottom. The Manager IS a session (type='manager', read-only Codex), so this
 * reuses the shared Transcript renderer for fidelity. Approvals never appear
 * because the Manager runs approvalPolicy:'never'.
 *
 * A1: a "Create subtask from this" affordance opens a prefilled NewSubtask
 * form. TODO(P3-live): auto-extract workspace/executor/prompt by parsing the
 * Manager's prose `create_subtask` suggestion — for now the user fills the form.
 */
function ManagerPanel({
  task,
  workspaces,
  items,
  pending,
  onMount,
  onSend,
  onCreateSubtask,
  proposal,
  compact = false,
}: {
  task: Task;
  workspaces: Workspace[];
  items: TranscriptItem[];
  pending: boolean;
  onMount: (taskId: string) => void;
  onSend: (taskId: string, text: string) => void;
  onCreateSubtask: (taskId: string, draft: NewSubtaskDraft) => void;
  /** Latest Manager-proposed subtask (spec §A2), parsed from its reply and
   *  prefilled into the confirm card; the card auto-opens on a new proposal. */
  proposal?: Partial<NewSubtaskDraft> | null;
  /** Compact = embedded in the right Inspector rail (zone 4) when a subtask is
   *  selected. Drops the `.main-head` (the wrapping ManagerInspector supplies
   *  its own header) and the create-subtask affordance, matching the design's
   *  head-less compact ManagerMain. */
  compact?: boolean;
}) {
  const t = useT();
  const [draft, setDraft] = useState('');
  const [showNewSubtask, setShowNewSubtask] = useState(false);
  const [dismissedPrompt, setDismissedPrompt] = useState<string | null>(null);

  // Ensure the Manager session + hydrate its transcript when this Task opens.
  useEffect(() => {
    onMount(task.id);
  }, [task.id, onMount]);

  // Auto-open the confirm card when the Manager proposes a (new) subtask
  // (spec §A2). Dismissing/submitting suppresses re-open for that same prompt.
  useEffect(() => {
    if (!compact && proposal?.prompt && proposal.prompt !== dismissedPrompt) {
      setShowNewSubtask(true);
    }
  }, [compact, proposal, dismissedPrompt]);

  function send() {
    const text = draft.trim();
    if (!text || pending) return;
    onSend(task.id, text);
    setDraft('');
  }

  return (
    <main className={`main tasks-main${compact ? ' compact' : ''}`}>
      {!compact && (
        <div className="main-head">
          <div className="main-head-l">
            <span className="manager-eyebrow">{t('tasks.manager.title')}</span>
            <span className="manager-task-name">{task.name}</span>
          </div>
          <div className="main-head-r">
            {/* No task-status pill (spec §F — "Open" removed). */}
            <button
              className="btn sm ghost"
              onClick={() => setShowNewSubtask(s => !s)}
            >
              {t('tasks.manager.createSubtask')}
            </button>
          </div>
        </div>
      )}

      {/* The new-subtask form sits ABOVE the transcript scroll, not inside it:
          the Transcript jams scrollTop to the bottom on every render, so a form
          rendered inside `.main-scroll` opens off-screen and the click reads as
          a no-op. As a banner here it's always visible the moment it opens. */}
      {!compact && showNewSubtask && (
        <NewSubtaskForm
          workspaces={workspaces}
          prefill={proposal ?? undefined}
          onSubmit={d => {
            onCreateSubtask(task.id, d);
            setShowNewSubtask(false);
            setDismissedPrompt(proposal?.prompt ?? null);
          }}
          onCancel={() => {
            setShowNewSubtask(false);
            setDismissedPrompt(proposal?.prompt ?? null);
          }}
        />
      )}

      <div className="main-scroll">
        {items.length === 0 && !pending ? (
          <div className="tasks-manager-placeholder">
            <span className="manager-eyebrow">{t('tasks.manager.eyebrow')}</span>
            <p>{t('tasks.manager.placeholder')}</p>
          </div>
        ) : (
          <Transcript items={items} pending={pending} onApprove={() => { /* read-only: never fires */ }} />
        )}
      </div>

      <div className="composer-wrap">
        <div className="composer tasks-manager-composer">
          <textarea
            className="composer-ta"
            rows={1}
            aria-label={t('tasks.manager.composer.placeholder')}
            placeholder={t('tasks.manager.composer.placeholder')}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            }}
          />
          <div className="composer-bar">
            <span className="spacer" />
            <button
              className="composer-act primary"
              title={pending ? t('tasks.manager.sending') : t('tasks.manager.send')}
              onClick={send}
              disabled={!draft.trim() || pending}
            >
              <Icon d={I.send} stroke={2} />
            </button>
          </div>
        </div>
      </div>
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
 * read-only Codex session as the full Manager view — just no header/island.
 */
export function ManagerInspector({
  task,
  workspaces,
  items,
  pending,
  onMount,
  onSend,
}: {
  task: Task;
  workspaces: Workspace[];
  items: TranscriptItem[];
  pending: boolean;
  onMount: (taskId: string) => void;
  onSend: (taskId: string, text: string) => void;
}) {
  const t = useT();
  return (
    <aside className="inspector manager-inspector">
      <div className="insp-head">
        <span className="label">{t('tasks.manager.title')}</span>
        <button className="iconbtn" title={t('common.refresh')} onClick={() => onMount(task.id)}>
          <Icon d={I.refresh} size={13} stroke={1.6} />
        </button>
      </div>
      <div className="manager-inspector-body">
        <ManagerPanel
          task={task}
          workspaces={workspaces}
          items={items}
          pending={pending}
          onMount={onMount}
          onSend={onSend}
          onCreateSubtask={() => { /* compact: create-subtask lives in the full Manager view */ }}
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
  onCancel: () => void;
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

  function submit() {
    if (!workspaceId) return;
    onSubmit({
      workspace_id: workspaceId,
      executor,
      ...(name.trim() ? { name: name.trim() } : {}),
      prompt: prompt.trim(),
    });
  }

  if (visibleWs.length === 0) {
    return (
      <div className="tasks-subtask-form">
        <p className="tasks-subtask-hint">{t('tasks.newSubtask.noWorkspace')}</p>
        <div className="tasks-subtask-form-actions">
          <button className="btn sm ghost" onClick={onCancel}>{t('tasks.newSubtask.cancel')}</button>
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
        <button className="btn sm ghost" onClick={onCancel}>{t('tasks.newSubtask.cancel')}</button>
        <button className="btn sm primary" onClick={submit} disabled={!workspaceId}>
          {t('tasks.newSubtask.create')}
        </button>
      </div>
    </div>
  );
}
