import { useEffect, useMemo, useRef, useState } from 'react';
import type { Executor, Session, Task, Workspace } from '@gian/shared';
import { Composer } from '../components/Composer.js';
import { QueueList } from '../components/QueueList.js';
import { useT } from '../i18n/index.js';
import { Transcript } from '../transcript/Transcript.js';
import type { QueueEntry, TranscriptItem } from '../types.js';
import type {
  ManagerComposerHandlers,
  ManagerSubtaskCard,
  NewSubtaskDraft,
} from './TasksView.js';

const MANAGER_ICON = {
  check: 'M5 12l5 5L20 7',
  send: 'M5 12l14-7-5 17-3-7z',
  refresh: 'M3 12a9 9 0 0 1 15.5-6.3L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15.5 6.3L3 16 M3 21v-5h5',
};

function ManagerIcon({ d, size = 14, stroke = 1.8 }: { d: string; size?: number; stroke?: number }) {
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

export function ManagerPanel({
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
  /** Resolved "created" subtask cards that stay in the conversation (left by the
   *  manual create form). */
  cards?: ManagerSubtaskCard[];
  /** Compact = embedded in the right Inspector rail (zone 4) when a subtask is
   *  selected. Drops the `.main-head` (the wrapping ManagerInspector supplies
   *  its own header) and the create-subtask affordance, matching the design's
   *  head-less compact ManagerMain. */
  compact?: boolean;
}) {
  const t = useT();
  // The new-subtask FORM is now manual only — opened by the header "Create
  // subtask from this" button or the ⌘J/⌘K shortcut. The Manager no longer
  // proposes into a card/chip; it aligns in natural language and emits a
  // `<<gian:action>>` the host executes directly (surface-agnostic).
  const [showNewSubtask, setShowNewSubtask] = useState(false);
  // Executor preset from the ⌘J/⌘K shortcut (Claude / Codex). Null = form default.
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
              onClick={() => setShowNewSubtask(s => !s)}
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
            {/* Manual create-subtask form — opened by the header button or ⌘J/⌘K.
                Part of the conversation flow (not a top banner). The Transcript
                only auto-scrolls on items/pending changes, not on form
                keystrokes, so editing here is safe. */}
            {showInlineForm && (
              <NewSubtaskForm
                // Remount when the executor preset (⌘J/⌘K) changes so the form
                // re-initialises its executor field.
                key={presetExecutor ?? ''}
                workspaces={workspaces}
                prefill={presetExecutor ? { executor: presetExecutor } : undefined}
                onSubmit={d => {
                  onCreateSubtask(task.id, d);
                  setShowNewSubtask(false);
                  setPresetExecutor(null);
                }}
                onCancel={() => {
                  setShowNewSubtask(false);
                  setPresetExecutor(null);
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
            onSendNow={session.executor === 'codex' ? () => handlers?.onQueueSendNow() : undefined}
          />
          <Composer
            session={session}
            placeholder={t('tasks.manager.composer.placeholder')}
            onSend={(text, opts) => onSend(task.id, text, opts)}
            onSendSkill={(name, path) => handlers?.onSendSkill(name, path)}
            onStop={() => onStop(task.id)}
            onQueueAdd={(text, attachments) => handlers?.onQueueAdd(text, attachments)}
            onSetMode={mode => handlers?.onSetMode(mode)}
            onSetModel={model => handlers?.onSetModel(model)}
            onSetEffort={effort => handlers?.onSetEffort(effort)}
            onSetServiceTier={tier => handlers?.onSetServiceTier(tier)}
            onSetNativeConfig={(configId, value) =>
              handlers?.onSetNativeConfig(configId, value)}
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
                <ManagerIcon d={MANAGER_ICON.send} stroke={2} />
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
          <ManagerIcon d={MANAGER_ICON.refresh} size={13} stroke={1.6} />
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
          compact
        />
      </div>
    </aside>
  );
}

/**
 * A1 prefilled NewSubtask form. Prefills the workspace (first visible),
 * executor, and an empty prompt. The user confirms; submission creates a real
 * Subtask (session with task_id) via the REST path in App. Manager-authored
 * subtasks now use the action envelope path directly; this form is manual.
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
          <option value="kimi">Kimi Code</option>
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

/**
 * A resolved manual subtask-create card — a non-interactive record kept inline
 * in the Manager conversation so the exchange reads as a continuous history.
 */
function SubtaskCard({ card }: { card: ManagerSubtaskCard }) {
  const t = useT();
  return (
    <div className="manager-subtask-card created">
      <span className="msc-icon created" aria-hidden="true">
        <ManagerIcon d={MANAGER_ICON.check} size={12} stroke={2.2} />
      </span>
      <div className="msc-body">
        <div className="msc-head">
          <span className="msc-status">
            {t('tasks.subtaskCard.created')}
          </span>
          {card.name && <span className="msc-name">{card.name}</span>}
        </div>
        <div className="msc-meta">
          <span className={`ri-exec ${card.executor}`}>
            {card.executor === 'claude' ? 'Claude' : card.executor === 'codex' ? 'Codex' : 'Kimi'}
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
