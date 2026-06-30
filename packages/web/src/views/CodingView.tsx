import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ApprovalDecision, ApprovalMode, RemoteControlState, RuntimeMode, Session, TtySurface, Workspace } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { confirm, toast } from '../feedback.js';
import { createWorkspace, loadBranches, loadRemoteBranches, loadRepoInfo } from '../api.js';
import type { LocalBranch, RemoteBranch } from '../api.js';
import { BranchPicker } from '../components/BranchPicker.js';
import { Composer } from '../components/Composer.js';
import { FilePreviewDrawer } from '../components/FilePreviewDrawer.js';
import { GitBadge } from '../components/GitBadge.js';
import { PlanChip } from '../components/PlanChip.js';
import { QueueList } from '../components/QueueList.js';
import { useResizableWidth, RailSplitter } from '../components/RailLayout.js';
import { Terminal, makeSessionWire } from '../components/Terminal.js';
import { Transcript } from '../transcript/Transcript.js';
import { TranscriptMinimap } from '../transcript/TranscriptMinimap.js';
import type { ApprovalActionContext, ApprovalItem, QueueEntry, TokenUsage, TranscriptItem } from '../types.js';
import type { GianWs } from '../ws.js';
import {
  betaComposerSubmitBehavior,
  isTurnRunning,
  planApprovalResponseDispatch,
  runtimeTabs,
  runtimeChatSurface,
  runtimeForSurface,
  type ChatViewConfig,
  type SessionSurface,
} from '../session-routing.js';

// ─── V2 inline icons (copied verbatim from design/gian-design-v2/js/data.jsx) ─
function SvgIcon({ d, size = 16, stroke = 1.6 }: { d: string; size?: number; stroke?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {d.split(' M').map((seg, i) => (
        <path key={i} d={i === 0 ? seg : `M${seg}`} />
      ))}
    </svg>
  );
}

const ICON = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  filter: 'M4 5h16l-6 8v6l-4-2v-4z',
  plus:   'M12 5v14 M5 12h14',
  x:      'M5 5l14 14 M5 19L19 5',
  kebabV: 'M12 5.01v-.02 M12 12.01v-.02 M12 19.01v-.02',
  branch: 'M5 3v10M11 6v7M5 6h6M11 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4ZM5 15a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  eyeOff: 'M2 2l12 12M6.5 6.5a2 2 0 0 0 2.8 2.8M3.5 4.5a8 8 0 0 0-1.5 3.5C3 11.5 5.5 13 8 13a8 8 0 0 0 4-1.1M9 3a8 8 0 0 1 5 5 8 8 0 0 1-1 2',
};

// 8 hex chars, matches the host's `gian/<8-char-uuid>` default convention.
function shortHexId(): string {
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
}

/** Compact relative age (Codex sidebar style): now / 5m / 3h / 2d / 3w / 2mo /
 *  1y. Shown at a row-end when there is no status glyph. Exported so the Tasks
 *  rows use the exact same format. */
export function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

export interface CreateSessionInput {
  workspaceId: string;
  name: string;
  executor: 'claude' | 'codex';
  approvalMode: ApprovalMode;
  mode?: 'regular' | 'worktree';
  baseBranch?: string;
  /** User-chosen name for the branch the worktree will create. Optional —
   *  when omitted the host falls back to `gian/<short-uuid>`. The web form
   *  pre-fills with that pattern but lets the user override. */
  branch?: string;
  /** Optional first message to send right after the session is created. */
  firstMessage?: string;
}

/**
 * Inputs the form has visible to it. Extracted from the inline submit()
 * closure so SES-001 / WT-001 can be exercised as a pure function.
 */
export interface SessionCreateFormState {
  workspaceId: string;
  sessionName: string;
  executor: 'claude' | 'codex';
  approvalMode: ApprovalMode;
  mode: 'regular' | 'worktree';
  baseBranch: string;
  /** Already-composed full branch name (e.g. `worktree/feature-x`).
   *  Empty string means "let the host auto-generate". */
  composedBranch: string;
  firstMessage: string;
}

/**
 * Map the new-session form state to the payload sent to the host. WT-001
 * + SES-001 contract: regular mode omits `baseBranch` / `branch`;
 * worktree mode includes them only when the user supplied non-empty
 * trimmed values; `firstMessage` is included only when non-empty.
 */
export function buildSessionCreatePayload(form: SessionCreateFormState): CreateSessionInput {
  const trimmedFirst = form.firstMessage.trim();
  return {
    workspaceId: form.workspaceId,
    name: form.sessionName.trim(),
    executor: form.executor,
    approvalMode: form.approvalMode,
    mode: form.mode,
    ...(form.mode === 'worktree' && form.baseBranch.trim() ? { baseBranch: form.baseBranch.trim() } : {}),
    ...(form.mode === 'worktree' && form.composedBranch ? { branch: form.composedBranch } : {}),
    ...(trimmedFirst ? { firstMessage: trimmedFirst } : {}),
  };
}

export interface CodingViewProps {
  workspaces: Workspace[];
  /** Map of workspace_id → current HEAD branch name. Used as a fallback
   *  by SessionRow when session.branch itself is null (non-worktree
   *  sessions ride on the workspace's HEAD). Populated by App. */
  workspaceBranches: Record<string, string | null>;
  sessions: Session[];
  archivedSessions: Session[];
  archivedLoaded: boolean;
  activeSession: Session | null;
  activeWorkspace: Workspace | null;
  activeSessionId: string | null;
  /** Resolved chat-view prefs (which runtime tabs to show). From SystemConfig. */
  chatView: ChatViewConfig;
  itemsBySession: Record<string, TranscriptItem[]>;
  pendingBySession: Record<string, boolean>;
  ttyLockBySession: Record<string, { owner: boolean; reason?: string }>;
  usageBySession: Record<string, TokenUsage>;
  queueBySession: Record<string, QueueEntry[]>;
  /** Codex plan-mode plan markdown per session, populated by plan_update. */
  planBySession: Record<string, string>;
  onLoadArchived: () => void | Promise<void>;
  onSelectSession: (id: string) => void;
  onWorkspaceCreated: (ws: Workspace) => void;
  onCreateSession: (input: CreateSessionInput) => void;
  /** True from `session:create` dispatch until `session:created` lands. Drives
   *  the busy state in NewSessionView's submit button. */
  creatingSession: boolean;
  onSend: (
    sessionId: string,
    text: string,
    opts?: {
      oneShotBypass?: boolean;
      attachments?: Array<{ path: string; name: string; mime: string; previewUrl: string }>;
    },
  ) => void;
  onBetaSend: (
    sessionId: string,
    text: string,
    opts?: {
      attachments?: Array<{ path: string; name: string; mime: string; previewUrl: string }>;
    },
  ) => void;
  onSendSkill: (sessionId: string, name: string, path: string) => void;
  onStop: (sessionId: string) => void;
  onApprove: (
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | string[]>,
    context?: ApprovalActionContext,
  ) => void;
  /** Local-only approval resolution for TTY questions, which paste their
   *  answers into the PTY rather than going through the structured bridge. */
  onLocalApprovalResolve: (
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | string[]>,
  ) => void;
  onQueueAdd: (sessionId: string, text: string) => void;
  onQueueRemove: (sessionId: string, queueId: string) => void;
  onQueueReorder: (sessionId: string, order: string[]) => void;
  onQueueClear: (sessionId: string) => void;
  onQueueSendNow: (sessionId: string) => void;
  onSetMode: (sessionId: string, approvalMode: ApprovalMode, turns?: number) => void;
  onSetModel: (sessionId: string, model: string) => void;
  onSetEffort: (sessionId: string, effort: import('@gian/shared').ThinkingEffort | null) => void;
  onArchive: (sessionId: string, archived: boolean) => void;
  onDelete: (sessionId: string) => void;
  onRecover: (sessionId: string) => void;
  onMerge: (sessionId: string) => void | Promise<void>;
  onDrop: (sessionId: string) => void | Promise<void>;
  onRename: (sessionId: string, name: string) => void;
  /** Open the Files view in Changed mode for this session's working tree. */
  onShowChanges: (session: Session) => void;
  /** Active session's working tree id (`wt:<id>` or `ws:<id>`), null if none. */
  activeWorkingTreeId: string | null;
  /** Branch name for the active session's working tree. */
  activeBranch: string | null;
  /** Inline file preview drawer target — set when user clicks a transcript
   *  FileLink. Null = drawer closed. */
  previewTarget?: import('../components/FilePreviewDrawer.js').PreviewTarget | null;
  onClosePreview?: () => void;
  /** Live WS handle — passed to <Terminal /> for TTY-mode I/O. */
  ws: GianWs;
  /** Flip the active runtime for a session. Caller forwards to
   *  `session:switch-runtime` WS message. */
  onSwitchRuntime: (sessionId: string, target: RuntimeMode, surface?: TtySurface, opts?: { force?: boolean }) => void;
  onClaimTty: (sessionId: string, surface: TtySurface, takeover?: boolean) => void;
  /** Sessions that have been "armed" for a remote-control switch — i.e.
   *  the user clicked Remote while a turn was running. Composer reads
   *  this to lock the input + show a banner. */
  armedRemoteSwitch: Set<string>;
  /** User clicked Remote. App decides whether to fire immediately or
   *  arm for after the current turn. */
  onRequestRemote: (sessionId: string) => void;
  /** User clicked Cancel on the armed banner. */
  onCancelRemote: (sessionId: string) => void;
  /** Live Claude Remote Control state per session (TTY mode). */
  remoteControlBySession: Record<string, RemoteControlState>;
  /** User clicked the antenna while in TTY mode → toggle Remote Control by
   *  sending `/remote-control` into the live PTY. */
  onToggleRemoteControl: (sessionId: string) => void;
  /** Switch app mode to Spaces (workspace management). Triggered from
   *  the sidebar's "N hidden workspaces · manage" footer link. */
  onOpenSpaces: () => void;
}

export function CodingView(p: CodingViewProps) {
  const [showNew, setShowNew] = useState(false);
  const rail = useResizableWidth('coding.rail.w', 272, 200, 480, 'left');

  // Once the session lands (creatingSession flips back to false), close the
  // new-session form. Kept here — not on submit — so the form stays visible
  // with a "Creating…" indicator instead of flashing to an empty pane.
  const wasCreatingRef = useRef(false);
  useEffect(() => {
    if (wasCreatingRef.current && !p.creatingSession) {
      setShowNew(false);
    }
    wasCreatingRef.current = p.creatingSession;
  }, [p.creatingSession]);

  // Topbar's brand burger emits this event — primary discoverable affordance
  // for hiding/showing the rail. The in-sidebar collapse button is the
  // secondary path. Listening at the window level keeps Topbar decoupled.
  useEffect(() => {
    const onToggle = () => rail.setCollapsed(!rail.collapsed);
    window.addEventListener('gian.toggle-rail', onToggle);
    return () => window.removeEventListener('gian.toggle-rail', onToggle);
  }, [rail]);

  return (
    <div
      className={`view${rail.collapsed ? ' rail-collapsed' : ''}`}
      style={{ '--rail-w': `${rail.width}px` } as React.CSSProperties}
    >
      {!rail.collapsed && (
        <>
          <Sidebar
            workspaces={p.workspaces}
            workspaceBranches={p.workspaceBranches}
            sessions={p.sessions}
            archivedSessions={p.archivedSessions}
            archivedLoaded={p.archivedLoaded}
            activeSessionId={p.activeSessionId}
            showNew={showNew}
            onToggleNew={() => setShowNew(v => !v)}
            onSelect={id => { setShowNew(false); p.onSelectSession(id); }}
            onLoadArchived={p.onLoadArchived}
            onOpenSpaces={p.onOpenSpaces}
          />
          <RailSplitter onMouseDown={rail.onMouseDown} ariaLabel="Resize sidebar" />
        </>
      )}
      {showNew ? (
        <NewSessionView
          workspaces={p.workspaces}
          onCancel={() => setShowNew(false)}
          onWorkspaceCreated={p.onWorkspaceCreated}
          creating={p.creatingSession}
          onCreate={input => {
            p.onCreateSession(input);
          }}
        />
      ) : p.activeSession ? (
        <SessionMain
          session={p.activeSession}
          chatView={p.chatView}
          workspace={p.activeWorkspace}
          items={p.itemsBySession[p.activeSession.id] ?? []}
          pending={p.pendingBySession[p.activeSession.id] ?? false}
          ttyLock={p.ttyLockBySession[p.activeSession.id]}
          usage={p.usageBySession[p.activeSession.id] ?? null}
          queue={p.queueBySession[p.activeSession.id] ?? []}
          codexPlanText={p.planBySession[p.activeSession.id]}
          onSend={(text, opts) => p.onSend(p.activeSession!.id, text, opts)}
          onBetaSend={(text, opts) => p.onBetaSend(p.activeSession!.id, text, opts)}
          onSendSkill={(name, path) => p.onSendSkill(p.activeSession!.id, name, path)}
          onStop={() => p.onStop(p.activeSession!.id)}
          onApprove={(approvalId, decision, answers, context) => p.onApprove(p.activeSession!.id, approvalId, decision, answers, context)}
          onLocalApprovalResolve={(approvalId, decision, answers) => p.onLocalApprovalResolve(p.activeSession!.id, approvalId, decision, answers)}
          onQueueAdd={text => p.onQueueAdd(p.activeSession!.id, text)}
          onQueueRemove={queueId => p.onQueueRemove(p.activeSession!.id, queueId)}
          onQueueReorder={order => p.onQueueReorder(p.activeSession!.id, order)}
          onQueueClear={() => p.onQueueClear(p.activeSession!.id)}
          onQueueSendNow={() => p.onQueueSendNow(p.activeSession!.id)}
          onSetMode={(mode, turns) => p.onSetMode(p.activeSession!.id, mode, turns)}
          onSetModel={model => p.onSetModel(p.activeSession!.id, model)}
          onSetEffort={effort => p.onSetEffort(p.activeSession!.id, effort)}
          onMerge={() => p.onMerge(p.activeSession!.id)}
          onDrop={() => p.onDrop(p.activeSession!.id)}
          onArchive={archived => p.onArchive(p.activeSession!.id, archived)}
          onDelete={() => p.onDelete(p.activeSession!.id)}
          onRecover={() => p.onRecover(p.activeSession!.id)}
          onRename={name => p.onRename(p.activeSession!.id, name)}
          onShowChanges={() => p.onShowChanges(p.activeSession!)}
          workingTreeId={p.activeWorkingTreeId}
          branch={p.activeBranch}
          ws={p.ws}
          onSwitchRuntime={(target, surface, opts) => p.onSwitchRuntime(p.activeSession!.id, target, surface, opts)}
          onClaimTty={(surface, takeover) => p.onClaimTty(p.activeSession!.id, surface, takeover)}
          armedRemote={p.armedRemoteSwitch.has(p.activeSession.id)}
          onRequestRemote={() => p.onRequestRemote(p.activeSession!.id)}
          onCancelRemote={() => p.onCancelRemote(p.activeSession!.id)}
          remoteControl={p.remoteControlBySession[p.activeSession.id]}
          onToggleRemoteControl={() => p.onToggleRemoteControl(p.activeSession!.id)}
        />
      ) : (
        <CodingViewEmpty />
      )}
      {/* 4th-level Inspector — sibling of `.main` per the design's
       *  rail | main | preview three-column layout. Hidden via CSS until
       *  either a transcript FileLink (file mode) or a DiffCard click
       *  (diff mode) populates `previewTarget`. */}
      <FilePreviewDrawer target={p.previewTarget ?? null} onClose={p.onClosePreview ?? (() => {})} />
    </div>
  );
}

function CodingViewEmpty() {
  const t = useT();
  return (
    <main className="main">
      <div className="files-preview-empty">
        <svg className="fpe-icon" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <path d="M10 14a4 4 0 014-4h28a4 4 0 014 4v22a4 4 0 01-4 4H22l-12 10V14z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M20 22h16M20 28h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.6" />
        </svg>
        <p className="fpe-title">{t('coding.session.empty')}</p>
        <p className="fpe-hint">
          <kbd>⌘K</kbd> {t('coding.empty.hint')}
        </p>
      </div>
    </main>
  );
}

function Sidebar({
  workspaces,
  workspaceBranches,
  sessions,
  archivedSessions,
  archivedLoaded,
  activeSessionId,
  onToggleNew,
  onSelect,
  onLoadArchived,
  onOpenSpaces,
}: {
  workspaces: Workspace[];
  workspaceBranches: Record<string, string | null>;
  sessions: Session[];
  archivedSessions: Session[];
  archivedLoaded: boolean;
  activeSessionId: string | null;
  showNew: boolean;
  onToggleNew: () => void;
  onSelect: (id: string) => void;
  onLoadArchived: () => void | Promise<void>;
  onOpenSpaces: () => void;
}) {
  const t = useT();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [wsFilter, setWsFilter] = useState('all');
  // V2 sidebar state — search box + popover.
  const [search, setSearch] = useState('');
  const [filterExec, setFilterExec] = useState<null | 'claude' | 'codex'>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const headRef = useRef<HTMLDivElement>(null);

  const collapsedKey = 'gian.sidebar.collapsed.workspace';
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(collapsedKey);
      return new Set<string>(raw ? JSON.parse(raw) : []);
    } catch { return new Set(); }
  });

  useEffect(() => {
    try { localStorage.setItem(collapsedKey, JSON.stringify(Array.from(collapsed))); }
    catch { /* localStorage full / disabled — non-essential */ }
  }, [collapsed, collapsedKey]);

  function toggleGroup(key: string) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  // Close filter popover on outside click / Escape.
  useEffect(() => {
    if (!filterOpen) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Element | null;
      if (target?.closest('.sb-search-row')) return;
      setFilterOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setFilterOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [filterOpen]);

  function toggleArchived() {
    void onLoadArchived();
    setArchivedOpen(o => !o);
  }

  function makeRowHandlers(s: Session) {
    return {
      active: s.id === activeSessionId,
      onSelect: () => onSelect(s.id),
    };
  }

  const wsById = new Map(workspaces.map(w => [w.id, w]));

  const active = sessions.filter(s => s.archived === 0);

  function matchesSearch(s: Session, wsName: string): boolean {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (s.name ?? '').toLowerCase().includes(q) ||
      (s.branch ?? '').toLowerCase().includes(q) ||
      wsName.toLowerCase().includes(q)
    );
  }

  const filtered = active.filter(s => {
    // The per-Task Manager (type='manager') lives in Tasks mode only — it is
    // never a row in the Sessions list. Subtasks (type='subtask') DO appear
    // here: a subtask is a 1:1 session.
    if (s.type === 'manager') return false;
    if (wsFilter !== 'all' && s.workspace_id !== wsFilter) return false;
    if (filterExec && s.executor !== filterExec) return false;
    const ws = wsById.get(s.workspace_id);
    // Sessions whose workspace is hidden disappear from the list — UNLESS
    // they're the currently active session, in which case we keep the row
    // visible with a "wsHidden" badge so the user has a route back.
    if (ws?.hidden && s.id !== activeSessionId) return false;
    return matchesSearch(s, ws?.name ?? '');
  });

  // Every session groups by workspace — no "needs you" section pinned to the
  // top (it overrode workspace grouping). Attention is conveyed per-row via the
  // StatusIcon (pending/error/unread), not by reordering.
  const rest = filtered;

  function renderRow(s: Session, isArchived = false) {
    return (
      <SessionRow
        key={s.id}
        session={s}
        archived={isArchived}
        wsHidden={wsById.get(s.workspace_id)?.hidden === 1}
        branchFallback={workspaceBranches[s.workspace_id] ?? null}
        {...makeRowHandlers(s)}
      />
    );
  }

  function renderGroups() {
    if (rest.length === 0) return null;
    const byWs = new Map<string, Session[]>();
    for (const s of rest) {
      const list = byWs.get(s.workspace_id) ?? [];
      list.push(s);
      byWs.set(s.workspace_id, list);
    }
    // Iterate workspaces in the order they arrive from the host (sort_order).
    // Append any orphan workspace_ids (e.g. sessions whose ws isn't in the
    // workspaces prop yet) at the end so they stay visible.
    const orderedIds: string[] = [];
    const seen = new Set<string>();
    for (const w of workspaces) {
      if (byWs.has(w.id)) { orderedIds.push(w.id); seen.add(w.id); }
    }
    for (const wsId of byWs.keys()) {
      if (!seen.has(wsId)) orderedIds.push(wsId);
    }
    return orderedIds.map(wsId => {
      const list = byWs.get(wsId)!;
      const ws = wsById.get(wsId);
      const name = ws?.name ?? wsId;
      const sorted = list.slice().sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
      const isCollapsed = collapsed.has(wsId);
      return (
        <div key={wsId}>
          <div className="sb-group" onClick={() => toggleGroup(wsId)}>
            <span className="caret">{isCollapsed ? '▸' : '▾'}</span>
            <span>{name}</span>
            <span className="count">{list.length}</span>
          </div>
          {!isCollapsed && sorted.map(s => renderRow(s))}
        </div>
      );
    });
  }

  const hasFilter = wsFilter !== 'all' || filterExec !== null;

  return (
    <aside className="sidebar">
      <div className="sb-head" ref={headRef}>
        <div className="sb-search-row">
          <div className="sb-search">
            <SvgIcon d={ICON.search} />
            <input
              aria-label={t('coding.sidebar.search.label')}
              placeholder={t('coding.sidebar.search.placeholder')}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <button
            type="button"
            className={`sb-iconbtn${hasFilter ? ' has-active' : ''}`}
            aria-label={t('coding.sidebar.filter.label')}
            title={t('coding.sidebar.filter.title')}
            onClick={() => setFilterOpen(o => !o)}
          >
            <SvgIcon d={ICON.filter} />
          </button>
          <span className="sb-sep" />
          <button
            type="button"
            className="sb-iconbtn"
            aria-label={t('coding.sidebar.new')}
            title={t('coding.sidebar.new')}
            onClick={onToggleNew}
          >
            <SvgIcon d={ICON.plus} />
          </button>

          {filterOpen && (
            <div className="filter-pop">
              <div>
                <div className="lbl">{t('coding.sidebar.filter.workspace')}</div>
                <select
                  className="select"
                  style={{ width: '100%' }}
                  value={wsFilter === 'all' ? '' : wsFilter}
                  onChange={e => setWsFilter(e.target.value || 'all')}
                >
                  <option value="">{t('coding.sidebar.filter.allWorkspaces')}</option>
                  {workspaces.map(w => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <div className="lbl">{t('coding.sidebar.filter.executor')}</div>
                <div className="segm" style={{ width: '100%' }}>
                  {([['', t('coding.sidebar.filter.all')], ['claude', 'Claude'], ['codex', 'Codex']] as const).map(([v, lbl]) => (
                    <button
                      key={v || 'all'}
                      type="button"
                      className={`segm-item${(filterExec ?? '') === v ? ' active' : ''}`}
                      style={{ flex: 1 }}
                      onClick={() => setFilterExec(v === '' ? null : (v as 'claude' | 'codex'))}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                className="btn ghost sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => { setWsFilter('all'); setFilterExec(null); }}
              >
                {t('common.reset')}
              </button>
            </div>
          )}
        </div>

        {hasFilter && (
          <div className="sb-chips">
            {wsFilter !== 'all' && (
              <span className="sb-chip">
                <span className="dot" />{wsById.get(wsFilter)?.name ?? wsFilter}
                <button
                  type="button"
                  className="x"
                  onClick={() => setWsFilter('all')}
                >
                  <SvgIcon d={ICON.x} size={9} stroke={2.4} />
                </button>
              </span>
            )}
            {filterExec && (
              <span className={`sb-chip ${filterExec}`}>
                <span className="dot" />{filterExec === 'claude' ? 'Claude' : 'Codex'}
                <button
                  type="button"
                  className="x"
                  onClick={() => setFilterExec(null)}
                >
                  <SvgIcon d={ICON.x} size={9} stroke={2.4} />
                </button>
              </span>
            )}
            <button
              type="button"
              className="sb-chip clear"
              onClick={() => { setWsFilter('all'); setFilterExec(null); }}
            >
              {t('coding.sidebar.clear')}
            </button>
          </div>
        )}
      </div>

      <div className="sb-scroll">
        {renderGroups()}

        {(() => {
          const visible = archivedSessions
            .filter(s => wsFilter === 'all' || s.workspace_id === wsFilter)
            .filter(s => !filterExec || s.executor === filterExec)
            .filter(s => {
              const ws = wsById.get(s.workspace_id);
              return !ws?.hidden || s.id === activeSessionId;
            })
            .filter(s => matchesSearch(s, wsById.get(s.workspace_id)?.name ?? ''))
            .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
          return (
            <>
              <button className="sb-archived" onClick={toggleArchived}>
                <span className="caret">{archivedOpen ? '▾' : '▸'}</span> {t('coding.sidebar.archived')}
                {archivedLoaded && <span className="count">{visible.length}</span>}
              </button>
              {archivedOpen && (
                <>
                  {visible.map(s => renderRow(s, true))}
                  {archivedLoaded && visible.length === 0 && (
                    <span style={{ padding: '4px 10px', color: 'var(--text-3)', fontSize: 11 }}>
                      {t('coding.sidebar.noArchived')}
                    </span>
                  )}
                </>
              )}
            </>
          );
        })()}

        {(() => {
          const hiddenCount = workspaces.filter(w => w.hidden === 1).length;
          if (hiddenCount === 0) return null;
          return (
            <button
              type="button"
              className="sb-hidden-link"
              onClick={onOpenSpaces}
            >
              ↳ {hiddenCount} {t(hiddenCount === 1 ? 'coding.sidebar.hiddenOne' : 'coding.sidebar.hiddenMany')} · {t('coding.sidebar.manage')}
            </button>
          );
        })()}
      </div>
    </aside>
  );
}

function SessionRow({
  session, active, archived, wsHidden, onSelect,
}: {
  session: Session;
  active: boolean;
  archived?: boolean;
  wsHidden?: boolean;
  /** Accepted for compatibility (renderRow still passes it); the single-line
   *  Codex-style row no longer renders the branch. */
  branchFallback?: string | null;
  onSelect: () => void;
}) {
  const t = useT();
  return (
    <div
      className={`rail-item session-row${active ? ' active' : ''}${archived ? ' archived' : ''}`}
      data-testid={`session-row-${session.id}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
      }}
    >
      <div className="ri-body">
        <div className="ri-row1">
          {/* Single-line (Codex-style) row: title only; executor/branch dropped. */}
          <span className="ri-title">{session.name || `session ${session.id.slice(0, 6)}`}</span>
        </div>
      </div>
      {/* Row-end = status glyph when there is one (running/pending/error/unread),
          else the relative time. Mutually exclusive so the row stays compact. */}
      {statusGlyphShown(session.status, session.unread === 1 && !active)
        ? <StatusIcon status={session.status} unread={session.unread === 1 && !active} />
        : <span className="ri-age" title={t('coding.session.lastActivity')}>{relTime(session.updated_at)}</span>}
      {wsHidden && (
        <span
          className="ri-hidden-badge"
          title={t('coding.session.workspaceHidden')}
          aria-label={t('coding.session.workspaceHidden.aria')}
        >
          <SvgIcon d={ICON.eyeOff} size={11} />
        </span>
      )}
    </div>
  );
}

// Status icon — gradient disc + knockout glyph (spec 2026-06-28 §H). The glyph
// is a CSS-mask knockout of a gradient/accent disc (✅-emoji style). Built as
// data-URI masks set via React style props (avoids the inline-attribute quote
// pitfall). `mask-composite: subtract` carves the glyph out of the disc.
const GICO_DISC = "<circle cx='8' cy='8' r='7.4' fill='#fff'/>";
function gicoGlyph(kind: 'done' | 'err' | 'pend'): string {
  if (kind === 'done') return "<path d='M5 8l2 2 4-4' fill='none' stroke='#fff' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/>";
  if (kind === 'err') return "<path d='M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8' fill='none' stroke='#fff' stroke-width='2.2' stroke-linecap='round'/>";
  return "<rect x='7.05' y='3.8' width='1.9' height='5.3' rx='.95' fill='#fff'/><circle cx='8' cy='11.4' r='1.05' fill='#fff'/>";
}
function gicoMaskUrl(inner: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>${inner}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
function gicoMaskStyle(kind: 'done' | 'err' | 'pend'): CSSProperties {
  const layers = `${gicoMaskUrl(GICO_DISC)}, ${gicoMaskUrl(gicoGlyph(kind))}`;
  return { maskImage: layers, WebkitMaskImage: layers };
}

/** §#7 status indicator (spec 2026-06-28 §H). Nothing for 'new'; a spinning
 *  gradient ring for running; ❗ for pending (always "待处理"); ✓ for done and
 *  ✕ for error rendered as a flowing gradient while `unread` ("待处理") and a
 *  solid-accent knockout once read. Exported so Tasks-mode subtask rows reuse
 *  the exact same indicator + unread semantics as session rows. */
/** Whether StatusIcon renders a glyph at all for this state. Mirrors StatusIcon's
 *  null-returns: nothing for 'new' or a completed-and-read turn. Callers use this
 *  to decide whether to show the time instead (single-line rows). */
export function statusGlyphShown(status: import('@gian/shared').SessionStatus, unread: boolean): boolean {
  if (status === 'running' || status === 'pending' || status === 'error') return true;
  if (status === 'done') return unread;
  return false;
}

export function StatusIcon({ status, unread = false }: {
  status: import('@gian/shared').SessionStatus;
  /** Merged unread/"待处理" signal — drives the gradient-vs-solid look on
   *  terminal (done/error) states. Pending is always treated as 待处理. */
  unread?: boolean;
}) {
  const t = useT();
  if (status === 'new') return null;
  if (status === 'running') {
    return (
      <span className="ri-status running" title={t('coding.status.running')} aria-label="running">
        <span className="gico ring"><span className="gring" /></span>
      </span>
    );
  }
  const kind: 'done' | 'err' | 'pend' =
    status === 'pending' ? 'pend' : status === 'error' ? 'err' : 'done';
  const attention = status === 'pending' || unread;
  // Spec change (2026-06-30): a normally-completed-and-read turn shows NO icon.
  // Only "needs you" (pending / error / unread) and running surface a glyph.
  if (kind === 'done' && !attention) return null;
  const wrapClass = kind === 'err' ? 'err' : kind === 'pend' ? 'pending' : 'done';
  const label = status === 'pending'
    ? t('coding.status.awaitingApproval')
    : status === 'error'
    ? t('coding.status.error')
    : t('coding.status.done');
  return (
    <span className={`ri-status ${wrapClass}`} title={label} aria-label={status}>
      <span className={`gico ${attention ? 'unread' : 'read'} ${kind}`}>
        <span className="gfill" style={gicoMaskStyle(kind)} />
      </span>
    </span>
  );
}

function SessionRowKebab({
  archived,
  onResetContext,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  archived: boolean;
  onResetContext: () => void;
  onArchive: () => void;
  onUnarchive?: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function confirmDelete() {
    const ok = await confirm({
      message: t('coding.session.deleteConfirm'),
      danger: true,
      confirmLabel: t('common.delete'),
    });
    if (ok) onDelete();
  }

  return (
    <div className="ws-kebab-anchor session-row-kebab" ref={ref}>
      <button
        type="button"
        className="ws-kebab-btn"
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        title="Session menu"
        aria-label="Session menu"
      >
        ⋯
      </button>
      {open && (
        <div className="ws-kebab-pop" onClick={e => e.stopPropagation()}>
          {archived ? (
            <>
              <button
                className="ws-kebab-item"
                onClick={() => { setOpen(false); onUnarchive?.(); }}
              >
                Unarchive
              </button>
              <div className="ws-kebab-divider" />
              <button
                className="ws-kebab-item danger"
                onClick={() => { setOpen(false); confirmDelete(); }}
              >
                Delete session
              </button>
            </>
          ) : (
            <>
              <button
                className="ws-kebab-item"
                onClick={() => { setOpen(false); onResetContext(); }}
              >
                Reset context
              </button>
              <div className="ws-kebab-divider" />
              <button
                className="ws-kebab-item danger"
                onClick={() => { setOpen(false); onArchive(); }}
              >
                Archive session
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function NewSessionView({
  workspaces,
  onWorkspaceCreated,
  onCreate,
  onCancel,
  creating,
}: {
  workspaces: Workspace[];
  onWorkspaceCreated: (ws: Workspace) => void;
  onCreate: (input: CreateSessionInput) => void;
  onCancel: () => void;
  creating: boolean;
}) {
  const t = useT();
  const [selectedWs, setSelectedWs] = useState(
    workspaces.find(w => w.hidden !== 1)?.id ?? workspaces[0]?.id ?? ''
  );
  const [sessionName, setSessionName] = useState('');
  const [executor, setExecutor] = useState<'claude' | 'codex'>('codex');
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('ask');
  const [mode, setMode] = useState<'regular' | 'worktree'>('regular');
  const [baseBranch, setBaseBranch] = useState('');
  // Suffix-only — the `worktree/` prefix is fixed and rendered as a
  // non-editable decoration. An auto-generated hex id is the default;
  // user can clear and type their own.
  const [branchSuffix, setBranchSuffix] = useState<string>(() => shortHexId());
  const [firstMessage, setFirstMessage] = useState('');
  // Branch picker data — loaded lazily once worktree mode is selected. The
  // dropdown options mirror NewWorktreeDialog in SpacesView: occupied
  // branches are filtered out (a branch can only live in one worktree at a
  // time) and remote refs without a local tracking branch are surfaced as
  // standalone options.
  const [branches, setBranches] = useState<LocalBranch[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<RemoteBranch[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  // Resolved workspace default branch (e.g. `main`) — surfaced in the
  // BranchPicker so it floats to the top with a `default` tag.
  const [defaultBranchHint, setDefaultBranchHint] = useState<string | null>(null);

  // Inline workspace create (used when there are no workspaces, or the user
  // picks "+ create new workspace" from the select).
  const [wsName, setWsName] = useState('');
  const [wsRemote, setWsRemote] = useState('');
  const [wsBusy, setWsBusy] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);

  async function createWs() {
    if (!wsName) return;
    setWsBusy(true);
    setWsError(null);
    const result = await createWorkspace(wsName, { gitRemote: wsRemote.trim() || undefined });
    setWsBusy(false);
    if (!result.workspace) {
      setWsError(result.error ?? 'workspace create failed');
      return;
    }
    onWorkspaceCreated(result.workspace);
    setSelectedWs(result.workspace.id);
    setWsName('');
    setWsRemote('');
  }

  const showInlineCreate = workspaces.length === 0 || selectedWs === '__new__';
  const canCreate = !!selectedWs && selectedWs !== '__new__';

  // Fetch branch lists once worktree mode is selected for a real workspace.
  // Inline-create selections (__new__) have no repo on disk yet. Re-run if
  // the user switches workspaces while still in worktree mode.
  useEffect(() => {
    if (mode !== 'worktree' || !canCreate) {
      setBranches([]);
      setRemoteBranches([]);
      setBranchesLoaded(false);
      return;
    }
    let cancelled = false;
    setBranchesLoaded(false);
    void Promise.all([
      loadBranches(selectedWs),
      loadRemoteBranches(selectedWs),
      loadRepoInfo(selectedWs),
    ]).then(([b, rb, info]) => {
      if (cancelled) return;
      setBranches(b);
      setRemoteBranches(rb);
      setBranchesLoaded(true);
      const def = info?.git.defaultBranch ?? null;
      setDefaultBranchHint(def);
      // Pre-pick the workspace's default branch if it shows up in the list
      // and the user hasn't already chosen anything else.
      if (def && !baseBranch && b.some(x => x.name === def && !x.worktreePath)) {
        setBaseBranch(def);
      }
    });
    return () => { cancelled = true; };
    // baseBranch intentionally omitted: we only want to seed it once per
    // workspace selection, not re-run when the user picks a different option.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selectedWs, canCreate]);

  // Suffix → full branch name. An empty suffix falls back to the host's
  // own auto-id behavior (omit `branch` from the payload), but we always
  // prefer the form's pre-filled suggestion so the user can see what name
  // is being committed before they hit Create.
  const trimmedSuffix = branchSuffix.trim();
  const composedBranch = trimmedSuffix ? `worktree/${trimmedSuffix}` : '';

  // Collisions are checked against the composed `worktree/<suffix>` name.
  // The host runs `git check-ref-format` on POST for syntactic issues, so
  // we only handle the common-case "name already exists" here.
  const existingLocalNames = new Set(branches.map(b => b.name));
  const branchNameError: string | null =
    mode !== 'worktree' || !branchesLoaded || !composedBranch
      ? null
      : existingLocalNames.has(composedBranch)
        ? `${composedBranch} ${t('coding.form.branchExists')}`
        : null;

  const canSubmit = canCreate
    && !creating
    && (mode === 'regular' || (!!composedBranch && !branchNameError));

  function submit() {
    if (!canSubmit) return;
    onCreate(buildSessionCreatePayload({
      workspaceId: selectedWs,
      sessionName,
      executor,
      approvalMode,
      mode,
      baseBranch,
      composedBranch,
      firstMessage,
    }));
  }

  return (
    <main className="main">
      <div className="main-head">
        <div className="main-head-l">
          <span className="main-title">{t('coding.new.title')}</span>
        </div>
        <div className="main-head-r">
          <button className="btn ghost sm" onClick={onCancel}>{t('coding.new.cancel')}</button>
        </div>
      </div>
      <div className="ns-wrap">
        <div className="ns-card">
          <div className="ns-head">
            <div className="ns-title">{t('coding.new.heading')}</div>
            <div className="ns-sub">{t('coding.new.sub')}</div>
          </div>
          <div className="ns-body">
            <div className="field">
              <div className="field-lbl">
                <span>{t('coding.new.workspace')}</span>
                <span className="field-hint">{t('coding.new.workspace.hint')}</span>
              </div>
              {workspaces.length > 0 && (
                <select
                  className="select"
                  aria-label="Workspace"
                  value={selectedWs}
                  onChange={e => setSelectedWs(e.target.value)}
                >
                  {workspaces.map(w => (
                    <option key={w.id} value={w.id} disabled={w.hidden === 1}>
                      {w.name}{w.hidden === 1 ? ` (${t('coding.session.workspaceHidden.aria')})` : ''}
                    </option>
                  ))}
                  <option value="__new__">{t('coding.form.ws.createnew')}</option>
                </select>
              )}
              {showInlineCreate && (
                <div className="ns-inline-ws">
                  <input
                    className="input"
                    aria-label={t('coding.form.ws.name.placeholder')}
                    placeholder={t('coding.form.ws.name.placeholder')}
                    value={wsName}
                    onChange={e => setWsName(e.target.value)}
                  />
                  <input
                    className="input"
                    aria-label={t('coding.form.ws.gitremote.label')}
                    placeholder={t('coding.form.ws.gitremote.placeholder')}
                    value={wsRemote}
                    onChange={e => setWsRemote(e.target.value)}
                  />
                  {wsError && <p className="spaces-error">{wsError}</p>}
                  <button
                    className="btn primary sm"
                    onClick={() => void createWs()}
                    disabled={wsBusy || !wsName}
                  >
                    {wsBusy ? (
                      <span className="ns-busy"><span className="ns-spinner" aria-hidden="true" />{t('common.creating')}</span>
                    ) : t('coding.form.ws.create')}
                  </button>
                </div>
              )}
            </div>

            <div className="field">
              <div className="field-lbl">
                <span>{t('coding.new.executor')}</span>
                <span className="field-hint">{t('coding.new.executor.hint')}</span>
              </div>
              <div className="exec-picker">
                <button
                  type="button"
                  className={`exec-card codex${executor === 'codex' ? ' active' : ''}`}
                  onClick={() => setExecutor('codex')}
                >
                  <div className="exec-card-dot" />
                  <div className="exec-card-body">
                    <div className="exec-card-name">Codex</div>
                    <div className="exec-card-desc">OpenAI · gpt-5-codex</div>
                  </div>
                </button>
                <button
                  type="button"
                  className={`exec-card claude${executor === 'claude' ? ' active' : ''}`}
                  onClick={() => setExecutor('claude')}
                >
                  <div className="exec-card-dot" />
                  <div className="exec-card-body">
                    <div className="exec-card-name">Claude Code</div>
                    <div className="exec-card-desc">CLI plan</div>
                  </div>
                </button>
              </div>
            </div>

            <div className="field">
              <div className="field-lbl">
                <span>{t('coding.new.approval')}</span>
                <span className="field-hint">{t('coding.new.approval.hint')}</span>
              </div>
              <div className="segm" style={{ width: 'fit-content' }}>
                <button
                  type="button"
                  className={`segm-item${approvalMode === 'plan' ? ' active' : ''}`}
                  onClick={() => setApprovalMode('plan')}
                >
                  {t('mode.plan')}
                </button>
                <button
                  type="button"
                  className={`segm-item${approvalMode === 'ask' ? ' active' : ''}`}
                  onClick={() => setApprovalMode('ask')}
                >
                  {t('mode.ask')}
                </button>
                <button
                  type="button"
                  className={`segm-item${approvalMode === 'auto' ? ' active' : ''}`}
                  onClick={() => setApprovalMode('auto')}
                >
                  {t('mode.auto')}
                </button>
              </div>
              <div className="field-hint">{t('coding.new.approval.help')}</div>
            </div>

            <div className="field">
              <div className="field-lbl">
                <span>{t('coding.new.mode')}</span>
                <span className="field-hint">{t('coding.new.mode.hint')}</span>
              </div>
              <div className="segm" style={{ width: 'fit-content' }}>
                <button
                  type="button"
                  className={`segm-item${mode === 'regular' ? ' active' : ''}`}
                  onClick={() => setMode('regular')}
                >
                  {t('coding.form.mode.regular')}
                </button>
                <button
                  type="button"
                  className={`segm-item${mode === 'worktree' ? ' active' : ''}`}
                  onClick={() => setMode('worktree')}
                >
                  {t('coding.form.mode.worktree')}
                </button>
              </div>
              {mode === 'worktree' && (
                <div className="ns-worktree-fields">
                  {/* Base branch — popover picker with search + grouped
                     local/remote sections. Workspace default branch (when
                     known) auto-seeds the value in the useEffect above. */}
                  <label className="ns-sublabel">{t('coding.form.baseBranch')}</label>
                  <BranchPicker
                    branches={branches}
                    remoteBranches={remoteBranches}
                    value={baseBranch}
                    defaultBranch={defaultBranchHint}
                    disabled={!branchesLoaded}
                    placeholder={branchesLoaded ? t('coding.form.baseBranch.pick') : t('coding.form.baseBranch.loading')}
                    onChange={setBaseBranch}
                    ariaLabel={t('coding.form.baseBranch')}
                  />

                  {/* New branch name — fixed `worktree/` prefix + suffix
                     input. Suffix is pre-filled with an 8-char hex id so a
                     one-click create still works; user can replace it with
                     a meaningful slug. Collisions with existing local refs
                     block submit. */}
                  <label className="ns-sublabel">{t('coding.form.newBranch')}</label>
                  <div className="branch-name-field">
                    <span className="prefix">worktree/</span>
                    <input
                      aria-label={t('coding.form.newBranchSuffix')}
                      placeholder="short-id"
                      value={branchSuffix}
                      onChange={e => setBranchSuffix(e.target.value)}
                      spellCheck={false}
                    />
                  </div>
                  {branchNameError && (
                    <p className="spaces-error" style={{ marginTop: 4 }}>{branchNameError}</p>
                  )}
                </div>
              )}
            </div>

            <div className="field">
              <div className="field-lbl">
                <span>{t('coding.new.name')}</span>
                <span className="field-hint">{t('coding.new.name.hint')}</span>
              </div>
              <input
                className="input"
                aria-label={t('coding.form.session.name.label')}
                placeholder={t('coding.new.name.placeholder')}
                value={sessionName}
                onChange={e => setSessionName(e.target.value)}
              />
            </div>

            <div className="field">
              <div className="field-lbl">
                <span>{t('coding.new.first')}</span>
              </div>
              <textarea
                className="input"
                aria-label={t('coding.form.first.label')}
                rows={4}
                placeholder={t('coding.new.first.placeholder')}
                value={firstMessage}
                onChange={e => setFirstMessage(e.target.value)}
              />
            </div>
          </div>
          <div className="ns-foot">
            <button className="btn ghost sm" onClick={onCancel} disabled={creating}>
              {t('coding.new.cancel')}
            </button>
            <button className="btn primary sm" disabled={!canSubmit} onClick={submit}>
              {creating ? (
                <span className="ns-busy"><span className="ns-spinner" aria-hidden="true" />{t('common.creating')}</span>
              ) : t('coding.new.create')}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

export function SessionMain({
  session,
  chatView,
  workspace,
  items,
  pending,
  ttyLock,
  usage,
  queue,
  codexPlanText,
  onSend,
  onBetaSend,
  onSendSkill,
  onStop,
  onApprove,
  onLocalApprovalResolve,
  onQueueAdd,
  onQueueRemove,
  onQueueReorder,
  onQueueClear,
  onQueueSendNow,
  onSetMode,
  onSetModel,
  onSetEffort,
  onMerge,
  onDrop,
  onArchive,
  onDelete,
  onRecover,
  onReopen,
  onRename,
  onShowChanges,
  workingTreeId,
  branch,
  ws,
  onSwitchRuntime,
  onClaimTty,
  armedRemote,
  onRequestRemote,
  onCancelRemote,
  remoteControl,
  onToggleRemoteControl,
}: {
  session: Session;
  chatView: ChatViewConfig;
  workspace: Workspace | null;
  items: TranscriptItem[];
  pending: boolean;
  ttyLock?: { owner: boolean; reason?: string; alive?: boolean };
  usage: TokenUsage | null;
  queue: QueueEntry[];
  codexPlanText?: string;
  ws: GianWs;
  onSwitchRuntime: (target: RuntimeMode, surface?: TtySurface, opts?: { force?: boolean }) => void;
  onClaimTty: (surface: TtySurface, takeover?: boolean) => void;
  armedRemote: boolean;
  onRequestRemote: () => void;
  onCancelRemote: () => void;
  remoteControl?: RemoteControlState;
  onToggleRemoteControl: () => void;
  onSend: (
    text: string,
    opts?: {
      oneShotBypass?: boolean;
      attachments?: Array<{ path: string; name: string; mime: string; previewUrl: string }>;
    },
  ) => void;
  onBetaSend: (
    text: string,
    opts?: {
      attachments?: Array<{ path: string; name: string; mime: string; previewUrl: string }>;
    },
  ) => void;
  onSendSkill: (name: string, path: string) => void;
  onStop: () => void;
  onApprove: (
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | string[]>,
    context?: ApprovalActionContext,
  ) => void;
  onLocalApprovalResolve: (
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | string[]>,
  ) => void;
  onQueueAdd: (text: string) => void;
  onQueueRemove: (queueId: string) => void;
  onQueueReorder: (order: string[]) => void;
  onQueueClear: () => void;
  onQueueSendNow: () => void;
  onSetMode: (mode: ApprovalMode, turns?: number) => void;
  onSetModel: (model: string) => void;
  onSetEffort: (effort: import('@gian/shared').ThinkingEffort | null) => void;
  onMerge: () => void | Promise<void>;
  onDrop: () => void | Promise<void>;
  onArchive: (archived: boolean) => void;
  onDelete: () => void;
  onRecover: () => void;
  /** Reopen a completed subtask (clears `completed_at`). Subtask-only — the
   *  completed banner's affordance; absent for regular sessions. */
  onReopen?: () => void;
  onRename: (name: string) => void;
  onShowChanges: () => void;
  workingTreeId: string | null;
  branch: string | null;
}) {
  const t = useT();
  const isWorktree = session.branch !== null;
  const terminal = session.worktree_outcome !== null;
  // A user-completed subtask is read-only in the chat: sending is blocked in the
  // UI until it's reopened (the turn machinery still works, but a "done" subtask
  // shouldn't accept new messages). Regular sessions never hit this.
  const subtaskCompleted = session.type === 'subtask' && session.completed_at != null;
  const visibleTabs = runtimeTabs(session.executor, chatView);
  const tabKey = visibleTabs.map(tb => tb.surface).join(',');

  // The surface a session opens on. Claude follows the configured chat surface
  // (structured→'chat', tty→'beta'); Codex always opens on 'chat' (it has no
  // CLI tab anymore).
  const defaultSurfaceFor = (): SessionSurface => {
    if (session.executor === 'claude') return runtimeChatSurface('claude', chatView);
    return 'chat';
  };
  const [surface, setSurface] = useState<SessionSurface>(defaultSurfaceFor);
  const surfaceSessionRef = useRef(session.id);
  const lastClaimRef = useRef('');
  const alignedSessionRef = useRef('');

  // Keep `surface` within the currently-visible tabs: reset to the primary
  // chat surface on session change, or when the active surface is no longer
  // offered (config changed via reload, or runtime flipped underneath us).
  useEffect(() => {
    if (surfaceSessionRef.current !== session.id) {
      surfaceSessionRef.current = session.id;
      setSurface(defaultSurfaceFor());
      return;
    }
    if (!tabKey.split(',').includes(surface)) {
      setSurface(defaultSurfaceFor());
    }
    // defaultSurfaceFor reads the latest session / chatView via closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.executor, session.runtime_mode, surface, tabKey]);

  // Honor the global Claude chat-surface setting for already-existing sessions:
  // once per open, when idle, align the stored runtime to the configured chat
  // surface via the same switch-runtime path a tab click uses. Claude only —
  // Codex's CLI toggle never forces a runtime change. Shared session id means
  // the switch keeps history (`--resume`). After this one-shot, tab clicks own
  // runtime switching, so a later force-recover isn't fought.
  useEffect(() => {
    if (session.executor !== 'claude') return;
    if (alignedSessionRef.current === session.id) return;
    if (pending || terminal) return;
    alignedSessionRef.current = session.id;
    const want = runtimeChatSurface('claude', chatView);
    const wantRuntime = runtimeForSurface(want);
    if (session.runtime_mode !== wantRuntime) {
      onSwitchRuntime(wantRuntime, want === 'beta' ? 'beta' : undefined);
    }
  }, [session.id, session.executor, session.runtime_mode, pending, terminal, chatView.claude_chat_surface, onSwitchRuntime]);

  useEffect(() => {
    if (
      session.executor === 'claude'
      && session.runtime_mode === 'tty'
      && (surface === 'beta' || surface === 'cli')
    ) {
      const key = `${session.id}:${surface}:${session.runtime_mode}`;
      if (lastClaimRef.current === key) return;
      lastClaimRef.current = key;
      onClaimTty(surface);
    }
  }, [session.id, session.executor, session.runtime_mode, surface, onClaimTty]);

  const isTty = surface === 'cli' && session.runtime_mode === 'tty';
  const isBeta = surface === 'beta' && session.executor === 'claude';
  let pendingQuestion: ApprovalItem | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (
      item.kind === 'approval'
      && item.status === 'pending'
      && item.category === 'question'
      && (item.questions?.length ?? 0) > 0
    ) {
      pendingQuestion = item;
      break;
    }
  }
  const ttyLockedOut = session.executor === 'claude'
    && session.runtime_mode === 'tty'
    && (surface === 'beta' || surface === 'cli')
    && ttyLock?.owner === false;
  // Claude TTY chat opened but the underlying PTY isn't running — after a host
  // restart the session stays runtime_mode='tty' yet no PTY was respawned. We
  // own the lock (not locked out) but the host reported alive===false.
  const ttyDead = session.executor === 'claude'
    && session.runtime_mode === 'tty'
    && (surface === 'beta' || surface === 'cli')
    && ttyLock?.owner !== false
    && ttyLock?.alive === false;
  const ttySupported = session.executor === 'claude' || session.executor === 'codex';
  const canSwitchClaudeTtySurface = session.executor === 'claude' && session.runtime_mode === 'tty';
  const runtimeSwitchDisabled = pending || terminal;
  const betaDisabled = terminal || (pending && !canSwitchClaudeTtySurface);
  const cliDisabled = terminal || !ttySupported || (pending && !canSwitchClaudeTtySurface);
  const handleSelectSurface = (next: SessionSurface) => {
    setSurface(next);
    if (next === 'chat') {
      if (session.runtime_mode !== 'structured') onSwitchRuntime('structured');
    } else if (next === 'beta') {
      if (session.runtime_mode !== 'tty') onSwitchRuntime('tty', 'beta');
      else onClaimTty('beta');
    } else {
      if (!ttySupported) return;
      if (session.runtime_mode !== 'tty') onSwitchRuntime('tty', 'cli');
      else if (session.executor === 'claude') onClaimTty('cli');
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl/Cmd+1 → chat view, Ctrl/Cmd+2 → CLI. Capture phase so xterm never
      // sees the digit. claude TTY only. (Replaces the old Ctrl+` toggle, which
      // was awkward to reach on many keyboard layouts.)
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey || e.shiftKey) return;
      const wantChat = e.key === '1' || e.code === 'Digit1';
      const wantCli = e.key === '2' || e.code === 'Digit2';
      if (!wantChat && !wantCli) return;
      if (session.executor !== 'claude' || session.runtime_mode !== 'tty') return;
      if (surface !== 'beta' && surface !== 'cli') return;
      e.preventDefault();
      e.stopPropagation();
      handleSelectSurface(wantChat ? 'beta' : 'cli');
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [session.executor, session.runtime_mode, surface, handleSelectSurface]);

  // Beta: a Claude question's interactive selector lives ONLY in the PTY — the
  // beta surface can't answer it. So when one appears, nudge with a toast and
  // jump straight to the CLI where the selector is blocking. Once per question;
  // if the user manually returns to beta the dock still shows the reminder.
  const autoJumpedQRef = useRef<string | null>(null);
  useEffect(() => {
    if (isBeta && pendingQuestion) {
      if (autoJumpedQRef.current !== pendingQuestion.approvalId) {
        autoJumpedQRef.current = pendingQuestion.approvalId;
        toast({ kind: 'info', message: t('coding.beta.questionToast'), duration: 6000 });
        handleSelectSurface('cli');
      }
    } else if (!pendingQuestion) {
      autoJumpedQRef.current = null;
    }
    // handleSelectSurface is recreated each render; the ref guards re-firing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBeta, pendingQuestion]);

  const handleTranscriptApprove = (
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | string[]>,
    context?: ApprovalActionContext,
  ) => {
    const plan = planApprovalResponseDispatch({
      executor: session.executor,
      runtimeMode: session.runtime_mode,
      surface,
      decision,
      answers,
      context,
    });
    if (plan.channel === 'cli') {
      // TTY questions can't be answered by pasting into the blocking selector
      // (it cancels). Jump to the CLI where Claude's own selector is waiting;
      // the JSONL watcher resolves the card once the user picks there. No
      // paste, no local resolve — the card stays pending until the real pick.
      handleSelectSurface('cli');
      return;
    }
    onApprove(approvalId, decision, answers, context);
  };

  // Bump on pending → idle transition so GitBadge refetches at turn end.
  const [gitRefreshKey, setGitRefreshKey] = useState(0);
  const prevPendingRef = useRef(pending);
  useEffect(() => {
    if (prevPendingRef.current && !pending) setGitRefreshKey(k => k + 1);
    prevPendingRef.current = pending;
  }, [pending]);

  // Map our session.status → V2 status label + dot variant.
  const statusLabel =
    session.status === 'running' ? t('coding.status.running').toUpperCase()
    : session.status === 'pending' ? t('coding.status.awaitingApproval').toUpperCase()
    : session.status === 'error' ? t('coding.status.error').toUpperCase()
    : t('coding.status.done').toUpperCase();
  const statusDotCls = session.status === 'running' ? 'status-dot run' : 'status-dot';

  return (
    <main className="main">
      <div className="main-head">
        <div className="main-head-l">
          {/* A Subtask IS a session; this same SessionMain renders both. Tag the
              subtask variant with a "Subtask" eyebrow (mirrors the Manager
              panel's "Manager" eyebrow) so its top-left identifies it. */}
          {session.type === 'subtask' && (
            <span className="manager-eyebrow">{t('tasks.subtask.title')}</span>
          )}
          {/* Runtime tabs are configurable (Settings → 聊天视图). Claude shows a
              single chat surface — `claude -p` or tty — never both; CLI is an
              optional extra. The whole bar hides when only one tab is offered. */}
          {visibleTabs.length > 1 && (
            <div className="chat-toggle" role="tablist" aria-label={t('coding.runtime.label')}>
              {visibleTabs.map(tab => {
                const active = surface === tab.surface;
                const isChat = tab.label === 'chat';
                const disabled = isChat
                  ? (tab.surface === 'beta' ? betaDisabled : runtimeSwitchDisabled)
                  : cliDisabled;
                const title = isChat
                  ? (tab.surface === 'beta'
                      ? t('coding.runtime.betaTitle')
                      : (session.executor === 'claude'
                          ? t('coding.runtime.chatClaudeTitle')
                          : t('coding.runtime.chatTitle')))
                  : (session.executor === 'claude'
                      ? t('coding.runtime.claudeCliTitle')
                      : t('coding.runtime.cliTitle'));
                return (
                  <button
                    key={tab.surface}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={active ? 'active' : ''}
                    onClick={() => handleSelectSurface(tab.surface)}
                    disabled={disabled}
                    title={title}
                  >
                    {isChat ? t('coding.runtime.chat') : 'CLI'}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="main-head-r">
          {/* §B2 — only +N/−M (no branch, hidden when clean). Status indicator
              now lives in the sidebar row (§#7), not the main header. */}
          <GitBadge
            workingTreeId={workingTreeId}
            branch={branch}
            isWorktree={isWorktree}
            refreshKey={gitRefreshKey}
            onClick={onShowChanges}
          />
        </div>
      </div>
      {terminal && (
        <div className={`session-banner ${session.worktree_outcome}`}>
          <span>
            {session.worktree_outcome === 'merged'
              ? `${t('coding.banner.merged')} ${session.base_branch}. ${t('coding.banner.readonly')}`
              : t('coding.banner.discarded')}
          </span>
          <span className="session-banner-spacer" />
          <button className="btn xs ghost" onClick={() => onArchive(session.archived !== 1)}>
            {session.archived === 1 ? t('common.unarchive') : t('common.archive')}
          </button>
          <button className="btn xs danger-ghost" onClick={onDelete}>{t('common.delete')}</button>
        </div>
      )}
      {ttyLockedOut && (
        <div className="session-banner warning">
          <span>{ttyLock?.reason ?? 'Claude CLI is open in another window.'}</span>
          <span className="session-banner-spacer" />
          <button
            type="button"
            className="btn xs secondary"
            onClick={() => onClaimTty(surface === 'beta' ? 'beta' : 'cli', true)}
          >
            {t('coding.banner.takeOver')}
          </button>
        </div>
      )}
      {ttyDead && (
        <div className="session-banner warning">
          <span>{t('coding.banner.ttyNotRunning')}</span>
          <span className="session-banner-spacer" />
          <button
            type="button"
            className="btn xs secondary"
            onClick={() => { setSurface('cli'); onSwitchRuntime('tty', 'cli', { force: true }); }}
          >
            {t('coding.banner.openTty')}
          </button>
        </div>
      )}
      {subtaskCompleted && (
        <div className="session-banner">
          <span>{t('coding.banner.subtaskCompleted')}</span>
          <span className="session-banner-spacer" />
          {onReopen && (
            <button className="btn xs secondary" onClick={onReopen}>
              {t('tasks.subtask.reopen')}
            </button>
          )}
        </div>
      )}
      {isTty && !ttyLockedOut ? (
        <div className="main-scroll tty-pane">
          <Terminal
            instanceKey={`session:${session.id}`}
            wire={makeSessionWire(ws, session.id)}
            shiftEnterNewline={session.executor === 'claude'}
          />
        </div>
      ) : (
        <>
          <div className="main-scroll">
            <Transcript
              items={items}
              pending={pending || session.status === 'running' || session.status === 'pending'}
              onApprove={handleTranscriptApprove}
              hiddenApprovalId={isBeta && pendingQuestion ? pendingQuestion.approvalId : undefined}
            />
          </div>
          {/* Overlay rail — sibling of `.main-scroll` so it stays fixed while
              the conversation scrolls underneath it. */}
          <TranscriptMinimap items={items} />
          <QueueList queue={queue} onRemove={onQueueRemove} onReorder={onQueueReorder} onClear={onQueueClear} onSendNow={onQueueSendNow} />
          <PlanChip items={items} codexPlanText={codexPlanText} sessionId={session.id} />
          {isBeta && pendingQuestion && (
            <div className="beta-question-dock">
              <div className="beta-question-dock-label">{t('coding.beta.waiting')}</div>
              <button
                className="btn primary sm beta-question-cli"
                onClick={() => handleSelectSurface('cli')}
              >
                {t('transcript.question.answerInCli')}
              </button>
            </div>
          )}
          <Composer
            session={session}
            onSend={isBeta ? onBetaSend : onSend}
            onSendSkill={onSendSkill}
            onStop={onStop}
            onQueueAdd={onQueueAdd}
            onSetMode={onSetMode}
            onSetModel={onSetModel}
            onSetEffort={onSetEffort}
            onJumpToCli={() => handleSelectSurface('cli')}
            disabled={pending || terminal || subtaskCompleted || ttyLockedOut || ttyDead || (isBeta && !!pendingQuestion)}
            running={isTurnRunning(session.status, pending)}
            disabledSubmitBehavior={subtaskCompleted ? 'block' : betaComposerSubmitBehavior(isBeta, !!pendingQuestion)}
            executor={session.executor}
            workspaceId={workspace?.id}
            armedRemote={armedRemote}
            onRequestRemote={onRequestRemote}
            onCancelRemote={onCancelRemote}
            remoteControl={remoteControl}
            onToggleRemoteControl={onToggleRemoteControl}
          />
        </>
      )}
    </main>
  );
}

/**
 * Context strip + session kebab below the composer (PR5/A2 design).
 * Replaces the old `main-head-r` UsageChip + kebab combo.
 */
function TokStrip({
  usage,
  isWorktree,
  terminal,
  archived,
  onResetContext,
  onArchive,
  onDelete,
  onRecover,
  onMergeToBase,
  onDropWorktree,
}: {
  usage: TokenUsage | null;
  isWorktree: boolean;
  terminal: boolean;
  archived: boolean;
  onResetContext: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onRecover: () => void;
  onMergeToBase: () => void;
  onDropWorktree: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const contextWindow = usage?.contextWindow ?? 200_000;
  // contextUsed = last-turn prompt size (drops after /compact); using `total`
  // would peg codex at 100% forever since `total` is session-cumulative.
  const used = usage?.contextUsed ?? 0;
  const ratio = usage ? Math.min(1, used / contextWindow) : 0;
  const pct = ratio * 100;
  const fillCls = pct >= 95 ? 'danger' : pct >= 85 ? 'warn' : '';
  const compactHint = usage ? (pct >= 85 ? 'compact soon' : 'compact 90%') : '';

  function fmtK(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
    return String(n);
  }

  return (
    <div className="tok-strip">
      <span className="tok-strip-lbl">Context</span>
      <span className="tok-strip-val">
        {usage ? <><b>{fmtK(used)}</b> / {fmtK(contextWindow)}</> : <b>—</b>}
      </span>
      <div className="tok-bar" title={usage ? `${used.toLocaleString()} / ${contextWindow.toLocaleString()} tokens` : 'no usage data yet'}>
        <div className={`tok-bar-fill ${fillCls}`} style={{ width: `${pct}%` }} />
        <div className="tok-bar-mark" style={{ left: '90%' }} title="auto-compact threshold" />
      </div>
      {usage && <span className="tok-compact-hint">{compactHint}</span>}
      <span className="spacer" />
      <div className="ws-kebab-anchor ts-kebab" ref={ref}>
        <button
          type="button"
          className="ws-kebab-btn"
          onClick={() => setOpen(o => !o)}
          title="Session menu"
          aria-label="Session menu"
        >
          ⋯
        </button>
        {open && (
          <div className="ws-kebab-pop">
            {isWorktree && !terminal && (
              <>
                <button className="ws-kebab-item" onClick={() => { setOpen(false); onMergeToBase(); }}>
                  Merge to base
                </button>
                <button className="ws-kebab-item danger" onClick={() => { setOpen(false); onDropWorktree(); }}>
                  Drop worktree
                </button>
                <div className="ws-kebab-divider" />
              </>
            )}
            <button className="ws-kebab-item" onClick={() => { setOpen(false); onArchive(); }}>
              {archived ? 'Unarchive session' : 'Archive session'}
            </button>
            <div className="ws-kebab-divider" />
            <button
              className="ws-kebab-item"
              title="Kill the spawned proxy/agent process and reset this session to idle. Use when Stop didn't work."
              onClick={async () => {
                setOpen(false);
                const ok = await confirm({
                  message: 'Force recover this session? Any in-flight turn will be killed.',
                  danger: true,
                  confirmLabel: 'Force recover',
                });
                if (ok) onRecover();
              }}
            >
              Force recover
            </button>
            <button className="ws-kebab-item danger" onClick={() => { setOpen(false); onDelete(); }}>
              Delete session
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
