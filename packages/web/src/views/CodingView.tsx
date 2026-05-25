import { useEffect, useRef, useState } from 'react';
import type { ApprovalDecision, ApprovalMode, RuntimeMode, Session, Workspace } from '@gian/shared';
import { useT } from '../i18n/index.js';
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
import type { QueueEntry, TokenUsage, TranscriptItem } from '../types.js';
import type { GianWs } from '../ws.js';

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

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
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
  itemsBySession: Record<string, TranscriptItem[]>;
  pendingBySession: Record<string, boolean>;
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
  onSendSkill: (sessionId: string, name: string, path: string) => void;
  onStop: (sessionId: string) => void;
  onApprove: (
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
  onSwitchRuntime: (sessionId: string, target: RuntimeMode) => void;
  /** Sessions that have been "armed" for a remote-control switch — i.e.
   *  the user clicked Remote while a turn was running. Composer reads
   *  this to lock the input + show a banner. */
  armedRemoteSwitch: Set<string>;
  /** User clicked Remote. App decides whether to fire immediately or
   *  arm for after the current turn. */
  onRequestRemote: (sessionId: string) => void;
  /** User clicked Cancel on the armed banner. */
  onCancelRemote: (sessionId: string) => void;
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
          workspace={p.activeWorkspace}
          items={p.itemsBySession[p.activeSession.id] ?? []}
          pending={p.pendingBySession[p.activeSession.id] ?? false}
          usage={p.usageBySession[p.activeSession.id] ?? null}
          queue={p.queueBySession[p.activeSession.id] ?? []}
          codexPlanText={p.planBySession[p.activeSession.id]}
          onSend={(text, opts) => p.onSend(p.activeSession!.id, text, opts)}
          onSendSkill={(name, path) => p.onSendSkill(p.activeSession!.id, name, path)}
          onStop={() => p.onStop(p.activeSession!.id)}
          onApprove={(approvalId, decision, answers) => p.onApprove(p.activeSession!.id, approvalId, decision, answers)}
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
          onSwitchRuntime={target => p.onSwitchRuntime(p.activeSession!.id, target)}
          armedRemote={p.armedRemoteSwitch.has(p.activeSession.id)}
          onRequestRemote={() => p.onRequestRemote(p.activeSession!.id)}
          onCancelRemote={() => p.onCancelRemote(p.activeSession!.id)}
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
          <kbd>⌘K</kbd> jump to session, file, or command
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
    if (wsFilter !== 'all' && s.workspace_id !== wsFilter) return false;
    if (filterExec && s.executor !== filterExec) return false;
    const ws = wsById.get(s.workspace_id);
    // Sessions whose workspace is hidden disappear from the list — UNLESS
    // they're the currently active session, in which case we keep the row
    // visible with a "wsHidden" badge so the user has a route back.
    if (ws?.hidden && s.id !== activeSessionId) return false;
    return matchesSearch(s, ws?.name ?? '');
  });

  const needsYou = filtered.filter(s => s.status === 'pending' || s.status === 'error');
  const needsYouIds = new Set(needsYou.map(s => s.id));
  const rest = filtered.filter(s => !needsYouIds.has(s.id));

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
              aria-label="Search sessions"
              placeholder="Search"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <button
            type="button"
            className={`sb-iconbtn${hasFilter ? ' has-active' : ''}`}
            aria-label="Filter sessions"
            title="Filter"
            onClick={() => setFilterOpen(o => !o)}
          >
            <SvgIcon d={ICON.filter} />
          </button>
          <span className="sb-sep" />
          <button
            type="button"
            className="sb-iconbtn"
            aria-label="New session"
            title="New session"
            onClick={onToggleNew}
          >
            <SvgIcon d={ICON.plus} />
          </button>

          {filterOpen && (
            <div className="filter-pop">
              <div>
                <div className="lbl">Workspace</div>
                <select
                  className="select"
                  style={{ width: '100%' }}
                  value={wsFilter === 'all' ? '' : wsFilter}
                  onChange={e => setWsFilter(e.target.value || 'all')}
                >
                  <option value="">All workspaces</option>
                  {workspaces.map(w => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <div className="lbl">Executor</div>
                <div className="segm" style={{ width: '100%' }}>
                  {([['', 'All'], ['claude', 'Claude'], ['codex', 'Codex']] as const).map(([v, lbl]) => (
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
                Reset
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
              clear
            </button>
          </div>
        )}
      </div>

      <div className="sb-scroll">
        {needsYou.length > 0 && (
          <>
            <div className="sb-group needs-you">
              <span className="dot" />
              <span>Needs you</span>
              <span className="count">{needsYou.length}</span>
            </div>
            {needsYou
              .slice()
              .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
              .map(s => renderRow(s))}
          </>
        )}

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
                <span className="caret">{archivedOpen ? '▾' : '▸'}</span> Archived
                {archivedLoaded && <span className="count">{visible.length}</span>}
              </button>
              {archivedOpen && (
                <>
                  {visible.map(s => renderRow(s, true))}
                  {archivedLoaded && visible.length === 0 && (
                    <span style={{ padding: '4px 10px', color: 'var(--text-3)', fontSize: 11 }}>
                      no archived sessions
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
              ↳ {hiddenCount} hidden workspace{hiddenCount === 1 ? '' : 's'} · manage
            </button>
          );
        })()}
      </div>
    </aside>
  );
}

function SessionRow({
  session, active, archived, wsHidden, branchFallback, onSelect,
}: {
  session: Session;
  active: boolean;
  archived?: boolean;
  wsHidden?: boolean;
  /** Workspace HEAD branch — shown when the session itself doesn't own a
   *  worktree branch (regular sessions ride the workspace's checkout). */
  branchFallback?: string | null;
  onSelect: () => void;
}) {
  const branch = session.branch ?? branchFallback ?? null;
  return (
    <div
      className={`rail-item${active ? ' active' : ''}${archived ? ' archived' : ''}`}
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
          <span className="ri-title">{session.name || `session ${session.id.slice(0, 6)}`}</span>
        </div>
        <div className="ri-row2">
          <span className={`ri-exec ${session.executor}`}>
            {session.executor === 'claude' ? 'Claude' : 'Codex'}
          </span>
          {branch && (
            <>
              <span className="ri-dot-sep">·</span>
              <span className="ri-branch">
                <SvgIcon d={ICON.branch} size={9} />
                <span className="ri-branch-name">{branch}</span>
              </span>
            </>
          )}
        </div>
      </div>
      <span className="ri-age" title="Last activity">{relTime(session.updated_at)}</span>
      <StatusIcon status={session.status} />
      {wsHidden && (
        <span
          className="ri-hidden-badge"
          title="Workspace 已隐藏 — 在 Settings 里管理"
          aria-label="workspace hidden"
        >
          <SvgIcon d={ICON.eyeOff} size={11} />
        </span>
      )}
    </div>
  );
}

/** §#7 status indicator: replaces the per-row kebab + the main-head status
 *  pill. Renders nothing for 'new', a spinner for running/pending, a red ⚠
 *  for errors, and a green ✓ for done. */
function StatusIcon({ status }: { status: import('@gian/shared').SessionStatus }) {
  if (status === 'new') return null;
  if (status === 'running' || status === 'pending') {
    return (
      <span className="ri-status running" title={status === 'running' ? 'Running' : 'Awaiting approval'} aria-label={status}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
          <circle cx="8" cy="8" r="6" stroke="var(--accent-soft)" strokeWidth="2" />
          <path d="M14 8a6 6 0 0 0-6-6" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="ri-status err" title="Error" aria-label="error">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
          <circle cx="8" cy="8" r="7" fill="var(--danger-soft)" stroke="var(--danger)" strokeWidth="1" />
          <path d="M8 4.5v4 M8 10.6v.4" stroke="var(--danger)" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  // done
  return (
    <span className="ri-status done" title="Done" aria-label="done">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
        <circle cx="8" cy="8" r="7" fill="var(--ok-soft)" stroke="var(--ok)" strokeWidth="1" />
        <path d="M5 8l2 2 4-4" stroke="var(--ok)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
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

  function confirmDelete() {
    if (typeof window !== 'undefined' && !window.confirm('Delete this session? This cannot be undone.')) return;
    onDelete();
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
        ? `Branch "${composedBranch}" already exists locally`
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
                      {w.name}{w.hidden === 1 ? ' (隐藏)' : ''}
                    </option>
                  ))}
                  <option value="__new__">{t('coding.form.ws.createnew')}</option>
                </select>
              )}
              {showInlineCreate && (
                <div className="ns-inline-ws">
                  <input
                    className="input"
                    aria-label="New workspace name"
                    placeholder={t('coding.form.ws.name.placeholder')}
                    value={wsName}
                    onChange={e => setWsName(e.target.value)}
                  />
                  <input
                    className="input"
                    aria-label="New workspace git remote"
                    placeholder="Git remote (optional)"
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
                      <span className="ns-busy"><span className="ns-spinner" aria-hidden="true" />Creating…</span>
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
                    <div className="exec-card-desc">Anthropic · sonnet-4.6</div>
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
                  Regular
                </button>
                <button
                  type="button"
                  className={`segm-item${mode === 'worktree' ? ' active' : ''}`}
                  onClick={() => setMode('worktree')}
                >
                  Worktree
                </button>
              </div>
              {mode === 'worktree' && (
                <div className="ns-worktree-fields">
                  {/* Base branch — popover picker with search + grouped
                     local/remote sections. Workspace default branch (when
                     known) auto-seeds the value in the useEffect above. */}
                  <label className="ns-sublabel">Base branch</label>
                  <BranchPicker
                    branches={branches}
                    remoteBranches={remoteBranches}
                    value={baseBranch}
                    defaultBranch={defaultBranchHint}
                    disabled={!branchesLoaded}
                    placeholder={branchesLoaded ? 'Pick a base branch…' : 'Loading branches…'}
                    onChange={setBaseBranch}
                    ariaLabel="Base branch"
                  />

                  {/* New branch name — fixed `worktree/` prefix + suffix
                     input. Suffix is pre-filled with an 8-char hex id so a
                     one-click create still works; user can replace it with
                     a meaningful slug. Collisions with existing local refs
                     block submit. */}
                  <label className="ns-sublabel">New branch name</label>
                  <div className="branch-name-field">
                    <span className="prefix">worktree/</span>
                    <input
                      aria-label="New branch suffix"
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
                aria-label="Session name"
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
                aria-label="First message"
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
                <span className="ns-busy"><span className="ns-spinner" aria-hidden="true" />Creating…</span>
              ) : t('coding.new.create')}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

function SessionMain({
  session,
  workspace,
  items,
  pending,
  usage,
  queue,
  codexPlanText,
  onSend,
  onSendSkill,
  onStop,
  onApprove,
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
  onRename,
  onShowChanges,
  workingTreeId,
  branch,
  ws,
  onSwitchRuntime,
  armedRemote,
  onRequestRemote,
  onCancelRemote,
}: {
  session: Session;
  workspace: Workspace | null;
  items: TranscriptItem[];
  pending: boolean;
  usage: TokenUsage | null;
  queue: QueueEntry[];
  codexPlanText?: string;
  ws: GianWs;
  onSwitchRuntime: (target: RuntimeMode) => void;
  armedRemote: boolean;
  onRequestRemote: () => void;
  onCancelRemote: () => void;
  onSend: (
    text: string,
    opts?: {
      oneShotBypass?: boolean;
      attachments?: Array<{ path: string; name: string; mime: string; previewUrl: string }>;
    },
  ) => void;
  onSendSkill: (name: string, path: string) => void;
  onStop: () => void;
  onApprove: (
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
  onRename: (name: string) => void;
  onShowChanges: () => void;
  workingTreeId: string | null;
  branch: string | null;
}) {
  const isWorktree = session.branch !== null;
  const terminal = session.worktree_outcome !== null;
  // V2 chat/cli toggle — now wired to the runtime-mode switch.
  // `chat` = structured (today's transcript + composer)
  // `cli`  = pure TTY (xterm panel, no composer)
  // We read from session.runtime_mode so the active state survives
  // refreshes (and updates when the server confirms a switch).
  const chatMode: 'chat' | 'cli' = session.runtime_mode === 'tty' ? 'cli' : 'chat';
  const isTty = chatMode === 'cli';
  const ttySupported = session.executor === 'claude' || session.executor === 'codex';

  // Bump on pending → idle transition so GitBadge refetches at turn end.
  const [gitRefreshKey, setGitRefreshKey] = useState(0);
  const prevPendingRef = useRef(pending);
  useEffect(() => {
    if (prevPendingRef.current && !pending) setGitRefreshKey(k => k + 1);
    prevPendingRef.current = pending;
  }, [pending]);

  // Map our session.status → V2 status label + dot variant.
  const statusLabel =
    session.status === 'running' ? 'RUNNING'
    : session.status === 'pending' ? 'WAITING'
    : session.status === 'error' ? 'ERROR'
    : 'DONE';
  const statusDotCls = session.status === 'running' ? 'status-dot run' : 'status-dot';

  return (
    <main className="main">
      <div className="main-head">
        <div className="main-head-l">
          <div className="chat-toggle" role="tablist" aria-label="Runtime mode">
            <button
              type="button"
              role="tab"
              aria-selected={chatMode === 'chat'}
              className={chatMode === 'chat' ? 'active' : ''}
              onClick={() => {
                if (chatMode !== 'chat') onSwitchRuntime('structured');
              }}
              disabled={pending || terminal}
              title="Structured mode — transcript cards + composer"
            >
              Chat
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={chatMode === 'cli'}
              className={chatMode === 'cli' ? 'active' : ''}
              onClick={() => {
                if (!ttySupported) return;
                if (chatMode !== 'cli') onSwitchRuntime('tty');
              }}
              disabled={pending || terminal || !ttySupported}
              title={ttySupported
                ? 'Pure TTY mode — interactive CLI inside xterm'
                : 'TTY mode is currently only available for claude sessions'}
            >
              CLI
            </button>
          </div>
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
              ? `Worktree merged into ${session.base_branch}. This session is read-only.`
              : `Worktree discarded. This session is read-only.`}
          </span>
          <span className="session-banner-spacer" />
          <button className="btn xs ghost" onClick={() => onArchive(session.archived !== 1)}>
            {session.archived === 1 ? 'Unarchive' : 'Archive'}
          </button>
          <button className="btn xs danger-ghost" onClick={onDelete}>Delete</button>
        </div>
      )}
      {isTty ? (
        <div className="main-scroll tty-pane">
          <Terminal
            instanceKey={`session:${session.id}`}
            wire={makeSessionWire(ws, session.id)}
          />
        </div>
      ) : (
        <>
          <div className="main-scroll">
            <Transcript
              items={items}
              pending={pending || session.status === 'running' || session.status === 'pending'}
              onApprove={onApprove}
            />
          </div>
          <QueueList queue={queue} onRemove={onQueueRemove} onReorder={onQueueReorder} onClear={onQueueClear} onSendNow={onQueueSendNow} />
          <PlanChip items={items} codexPlanText={codexPlanText} sessionId={session.id} />
          <Composer
            session={session}
            onSend={onSend}
            onSendSkill={onSendSkill}
            onStop={onStop}
            onQueueAdd={onQueueAdd}
            onSetMode={onSetMode}
            onSetModel={onSetModel}
            onSetEffort={onSetEffort}
            disabled={pending || terminal}
            executor={session.executor}
            workspaceId={workspace?.id}
            armedRemote={armedRemote}
            onRequestRemote={onRequestRemote}
            onCancelRemote={onCancelRemote}
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
              onClick={() => {
                setOpen(false);
                if (typeof window !== 'undefined' && !window.confirm(
                  'Force recover this session? Any in-flight turn will be killed.',
                )) return;
                onRecover();
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
