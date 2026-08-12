import { useEffect, useState } from 'react';
import type { ApprovalDecision, ApprovalMode, Executor, NativeConfigValue, Session, Workspace } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { ModeDropdown } from '../components/ModeDropdown.js';
import type { Mode } from '../components/Topbar.js';
import { useResizableWidth, RailSplitter } from '../components/RailLayout.js';
import type { RailLayoutController } from '../components/RailLayout.js';
import { useSessionOperationPending } from '../operations/use-operations.js';
import type { OperationRun } from '../operations/types.js';
import type { PlanLifecycleState } from '../transcript/apply.js';
import type { TranscriptHistoryState } from '../controllers/use-transcript-hydration.js';
import type { ApprovalActionContext, QueueEntry, TranscriptItem } from '../types.js';
import { sessionNeedsAttention, buildRailSections } from '../session-routing.js';
import { SessionMain } from './SessionMain.js';
import { relTime, statusGlyphShown, StatusIcon } from './session-list-status.js';
import { NewSessionView } from './new-session-view.js';
import type { CreateSessionInput } from './new-session-view.js';
export { buildSessionCreatePayload } from './new-session-view.js';
export type { CreateSessionInput, SessionCreateFormState } from './new-session-view.js';

// ─── V2 inline icons (24-grid, 1.5px stroke, round caps — phase 6 grid) ────
function SvgIcon({ d, size = 16, stroke = 1.5, filled = false }: { d: string; size?: number; stroke?: number; filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill={filled ? 'currentColor' : 'none'} stroke="currentColor"
         strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {d.split(' M').map((seg, i) => (
        <path key={i} d={i === 0 ? seg : `M${seg}`} />
      ))}
    </svg>
  );
}

const ICON = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  plus:   'M12 5v14 M5 12h14',
  kebabV: 'M12 5.01v-.02 M12 12.01v-.02 M12 19.01v-.02',
  branch: 'M5 3v10M11 6v7M5 6h6M11 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4ZM5 15a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  eyeOff: 'M2 2l12 12M6.5 6.5a2 2 0 0 0 2.8 2.8M3.5 4.5a8 8 0 0 0-1.5 3.5C3 11.5 5.5 13 8 13a8 8 0 0 0 4-1.1M9 3a8 8 0 0 1 5 5 8 8 0 0 1-1 2',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  folderOpen: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2.5 M3 7v10a2 2 0 0 0 2 2h12.5a2 2 0 0 0 1.9-1.4L21.8 11H7.5a2 2 0 0 0-1.9 1.4L4 17.5',
  // pushpin — pin / unpin rows (same glyph as the task pin in PathBreadcrumb)
  pin: 'M12 17v5 M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
  archive: 'M3 4h18v4H3z M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8 M10 12h4',
  caretRight: 'M9 6l6 6-6 6',
  caretDown: 'M6 9l6 6 6-6',
};

/** Reserved collapse-set key for the 无归属 (Unfiled) group — '$' can never
 *  collide with a workspace UUID. */
const UNFILED_GROUP_KEY = '$unfiled';


export interface CodingViewProps {
  /** Top-level app mode — the sidebar's mode dropdown reads/drives this. */
  mode: Mode;
  onSetAppMode: (mode: Mode) => void;
  /** Open the global CommandPalette (sidebar search button). */
  onOpenSearch: () => void;
  workspaces: Workspace[];
  sessions: Session[];
  activeSession: Session | null;
  activeWorkspace: Workspace | null;
  activeSessionId: string | null;
  itemsBySession: Record<string, TranscriptItem[]>;
  pendingBySession: Record<string, boolean>;
  queueBySession: Record<string, QueueEntry[]>;
  /** Streamed plan text and whether a successful turn finalized it. */
  planStateBySession: Record<string, PlanLifecycleState>;
  historyBySession: Record<string, TranscriptHistoryState>;
  onLoadOlder: (sessionId: string, executor: Executor) => void;
  onRetryHistory: (sessionId: string, executor: Executor) => void;
  onSelectSession: (id: string) => void;
  /** Open the Workspaces "New workspace" sheet tab (new-session page's
   *  workspace drop "+ New workspace" row). */
  onNewWorkspace: () => void;
  /** App-driven request to open the new-session page with this workspace
   *  preselected (auto-return after creating one from the New Workspace
   *  sheet). Consumed once via onConsumeOpenNewForWorkspace. */
  openNewForWorkspace?: string | null;
  onConsumeOpenNewForWorkspace?: () => void;
  onCreateSession: (input: CreateSessionInput) => OperationRun;
  /** Latest create run, owned by App so timed-out attempts survive this
   * view unmounting during mode switches. */
  sessionCreateRun?: OperationRun;
  /** Global session.create pending state survives view/mode unmounts, so
   * reopening the form cannot accidentally submit a duplicate create. */
  creatingSession: boolean;
  onClearSessionCreateRun: () => void;
  /** Reload canonical sessions after an unknown create outcome. Only a
   * successful reload releases the retry interlock. */
  onVerifySessionCreate: () => Promise<void>;
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
    context?: ApprovalActionContext,
  ) => void;
  onQueueAdd: (sessionId: string, text: string, attachments?: Array<{ path: string; name: string; mime: string; size?: number }>) => void;
  onQueueRemove: (sessionId: string, queueId: string) => void;
  onQueueUpdate: (sessionId: string, queueId: string, text: string) => void;
  onQueueClear: (sessionId: string) => void;
  onQueueSendNow: (sessionId: string) => void;
  /** Codex-only mid-turn injection (`turn/steer`) — the composer's Ctrl+Enter
   *  path while a turn is running. Other executors never call it. */
  onSteer: (sessionId: string, text: string, attachments?: Array<{ path: string; name: string; mime: string; size?: number }>) => void;
  onSetMode: (sessionId: string, approvalMode: ApprovalMode) => void;
  onSetModel: (sessionId: string, model: string) => void;
  onSetEffort: (sessionId: string, effort: import('@gian/shared').ThinkingEffort | null) => void;
  onSetServiceTier: (sessionId: string, tier: 'fast' | null) => void;
  onSetNativeConfig: (
    sessionId: string,
    configId: string,
    value: NativeConfigValue,
  ) => void;
  onDelete: (sessionId: string) => void;
  onReopenSession: (sessionId: string) => void;
  /** Toggle a session's pinned marker (sidebar ordering). */
  onPinSession: (sessionId: string, pinned: boolean) => void;
  /** Archive a session from the sidebar row. */
  onArchiveSession: (sessionId: string) => void;
  /** Toggle a workspace's pinned marker (sidebar group ordering). */
  onToggleWorkspacePin: (workspace: Workspace) => void;
  /** Open the Files view in Changed mode for this session's working tree. */
  onShowChanges: (session: Session) => void;
  /** Open a selected file in Diffs pinned to the card's Last-turn scope. */
  onShowLastTurnChanges: (session: Session, turn: number, path: string) => void;
  /** Active session's working tree id (`wt:<id>` or `ws:<id>`), null if none. */
  activeWorkingTreeId: string | null;
  /** Branch name for the active session's working tree. */
  activeBranch: string | null;
  /** App-owned four-panel layout. Optional for isolated component renders. */
  railLayout?: RailLayoutController;
}

export function CodingView(p: CodingViewProps) {
  const [showNew, setShowNew] = useState(false);
  const [verifyingCreate, setVerifyingCreate] = useState(false);
  const [verifyCreateError, setVerifyCreateError] = useState<string | null>(null);
  const createRun = p.sessionCreateRun;
  const createUnknown = createRun?.phase === 'timed-out';
  const preserveCreateRun = createUnknown
    || createRun?.phase === 'pending'
    || createRun?.phase === 'optimistic';
  const creatingSession = p.creatingSession
    || createRun?.phase === 'pending'
    || createRun?.phase === 'optimistic';
  const createError = createRun?.phase === 'failed'
    ? (createRun.error ?? 'Session creation failed. You can adjust the form and retry.')
    : createRun?.phase === 'timed-out'
      ? 'Session creation status is unknown. Refresh sessions before retrying.'
      : null;
  /** Workspace preselected in NewSessionView when opened via a workspace
   *  row's "+" action. Undefined when opened from the header "+" button. */
  const [newForWs, setNewForWs] = useState<string | undefined>(undefined);
  const fallbackRail = useResizableWidth('rail.w', 272, 200, 480, 'left');
  const rail = p.railLayout ?? fallbackRail;

  // The Host broadcasts session:created before the correlated result. Close
  // only on a confirmed run; failures remain visible and retryable in-place.
  useEffect(() => {
    if (createRun?.phase === 'confirmed') {
      setShowNew(false);
      p.onClearSessionCreateRun();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRun?.phase]);

  // Auto-return from the New Workspace sheet: App re-opens the new-session
  // page with the just-created workspace preselected.
  useEffect(() => {
    if (p.openNewForWorkspace == null) return;
    setNewForWs(p.openNewForWorkspace);
    if (!preserveCreateRun) p.onClearSessionCreateRun();
    setShowNew(true);
    p.onConsumeOpenNewForWorkspace?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.openNewForWorkspace]);

  async function verifyUnknownCreate() {
    if (!createUnknown || verifyingCreate) return;
    setVerifyingCreate(true);
    setVerifyCreateError(null);
    try {
      await p.onVerifySessionCreate();
    } catch (thrown) {
      setVerifyCreateError(
        thrown instanceof Error ? thrown.message : 'Failed to refresh sessions',
      );
    } finally {
      setVerifyingCreate(false);
    }
  }

  const resetNewSession = () => {
    // Explicit failures are safe to forget. In-flight and unknown outcomes
    // remain globally interlocked even if the form closes.
    if (!preserveCreateRun) p.onClearSessionCreateRun();
    setShowNew(false);
  };

  // Topbar's brand burger emits this event — primary discoverable affordance
  // for hiding/showing the rail. The in-sidebar collapse button is the
  // secondary path. Listening at the window level keeps Topbar decoupled.
  useEffect(() => {
    if (p.railLayout) return;
    const onToggle = () => rail.setCollapsed(!rail.collapsed);
    window.addEventListener('gian.toggle-rail', onToggle);
    return () => window.removeEventListener('gian.toggle-rail', onToggle);
  }, [p.railLayout, rail.collapsed, rail.setCollapsed]);

  return (
    <div
      className={`view${rail.collapsed ? ' rail-collapsed' : ''}`}
      style={{ '--rail-w': `${rail.width}px` } as React.CSSProperties}
    >
      {/* The rail stays mounted while collapsed so its width can transition
          (phase 6); `.view.rail-collapsed` shrinks it to zero and disables
          interaction. As a side benefit, sidebar state (collapsed groups)
          survives a hide/show cycle. */}
      <Sidebar
        mode={p.mode}
        onSetMode={p.onSetAppMode}
        onOpenSearch={p.onOpenSearch}
        workspaces={p.workspaces}
        sessions={p.sessions}
        activeSessionId={p.activeSessionId}
        showNew={showNew}
        onToggleNew={() => {
          setNewForWs(undefined);
          if (!preserveCreateRun) p.onClearSessionCreateRun();
          setShowNew(v => !v);
        }}
        onNewForWorkspace={id => {
          setNewForWs(id);
          if (!preserveCreateRun) p.onClearSessionCreateRun();
          setShowNew(true);
        }}
        onToggleWorkspacePin={p.onToggleWorkspacePin}
        onPinSession={p.onPinSession}
        onArchiveSession={p.onArchiveSession}
        onSelect={id => { resetNewSession(); p.onSelectSession(id); }}
      />
      <RailSplitter onMouseDown={rail.onMouseDown} ariaLabel="Resize sidebar" />
      {showNew ? (
        <NewSessionView
          workspaces={p.workspaces}
          initialWorkspaceId={newForWs}
          onCancel={resetNewSession}
          onNewWorkspace={p.onNewWorkspace}
          creating={creatingSession}
          createError={verifyCreateError ?? createError}
          createUnknown={createUnknown}
          verifyingCreate={verifyingCreate}
          onVerifyCreate={() => void verifyUnknownCreate()}
          onCreate={input => {
            setVerifyCreateError(null);
            p.onCreateSession(input);
          }}
        />
      ) : p.activeSession ? (
        <SessionMain
          key={p.activeSession.id}
          session={p.activeSession}
          workspace={p.activeWorkspace}
          items={p.itemsBySession[p.activeSession.id] ?? []}
          hydrated={p.historyBySession[p.activeSession.id]?.phase === 'page'
            || p.historyBySession[p.activeSession.id]?.phase === 'complete'}
          history={p.historyBySession[p.activeSession.id]}
          onLoadOlder={() => p.onLoadOlder(p.activeSession!.id, p.activeSession!.executor)}
          onRetryHistory={() => p.onRetryHistory(p.activeSession!.id, p.activeSession!.executor)}
          pending={p.pendingBySession[p.activeSession.id] ?? false}
          queue={p.queueBySession[p.activeSession.id] ?? []}
          planText={p.planStateBySession[p.activeSession.id]?.text}
          codexPlanCompleted={p.planStateBySession[p.activeSession.id]?.completed}
          codexPlanStatus={p.planStateBySession[p.activeSession.id]?.status}
          codexPlanTurn={p.planStateBySession[p.activeSession.id]?.turn}
          onSend={(text, opts) => p.onSend(p.activeSession!.id, text, opts)}
          onSendSkill={(name, path) => p.onSendSkill(p.activeSession!.id, name, path)}
          onStop={() => p.onStop(p.activeSession!.id)}
          onApprove={(approvalId, decision, answers, context) => p.onApprove(p.activeSession!.id, approvalId, decision, answers, context)}
          onQueueAdd={(text, items) => p.onQueueAdd(p.activeSession!.id, text, items)}
          onQueueRemove={queueId => p.onQueueRemove(p.activeSession!.id, queueId)}
          onQueueUpdate={(queueId, text) => p.onQueueUpdate(p.activeSession!.id, queueId, text)}
          onQueueClear={() => p.onQueueClear(p.activeSession!.id)}
          onQueueSendNow={() => p.onQueueSendNow(p.activeSession!.id)}
          onSteer={(text, opts) => p.onSteer(p.activeSession!.id, text, opts?.attachments)}
          onSetMode={mode => p.onSetMode(p.activeSession!.id, mode)}
          onSetModel={model => p.onSetModel(p.activeSession!.id, model)}
          onSetEffort={effort => p.onSetEffort(p.activeSession!.id, effort)}
          onSetServiceTier={tier => p.onSetServiceTier(p.activeSession!.id, tier)}
          onSetNativeConfig={(configId, value) =>
            p.onSetNativeConfig(p.activeSession!.id, configId, value)}
          onDelete={() => p.onDelete(p.activeSession!.id)}
          onReopen={() => p.onReopenSession(p.activeSession!.id)}
          onShowChanges={() => p.onShowChanges(p.activeSession!)}
          onShowLastTurnChanges={(turn, path) =>
            p.onShowLastTurnChanges(p.activeSession!, turn, path)}
          workingTreeId={p.activeWorkingTreeId}
          branch={p.activeBranch}
        />
      ) : (
        <CodingViewEmpty />
      )}
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
  mode,
  onSetMode,
  onOpenSearch,
  workspaces,
  sessions,
  activeSessionId,
  onToggleNew,
  onNewForWorkspace,
  onToggleWorkspacePin,
  onPinSession,
  onArchiveSession,
  onSelect,
}: {
  mode: Mode;
  onSetMode: (mode: Mode) => void;
  onOpenSearch: () => void;
  workspaces: Workspace[];
  sessions: Session[];
  activeSessionId: string | null;
  showNew: boolean;
  onToggleNew: () => void;
  onNewForWorkspace: (workspaceId: string) => void;
  onToggleWorkspacePin: (workspace: Workspace) => void;
  onPinSession: (sessionId: string, pinned: boolean) => void;
  onArchiveSession: (sessionId: string) => void;
  onSelect: (id: string) => void;
}) {
  const t = useT();

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

  function makeRowHandlers(s: Session) {
    return {
      active: s.id === activeSessionId,
      onSelect: () => onSelect(s.id),
      onPin: (pinned: boolean) => onPinSession(s.id, pinned),
      onArchive: () => onArchiveSession(s.id),
    };
  }

  const wsById = new Map(workspaces.map(w => [w.id, w]));

  const active = sessions.filter(s => s.archived === 0);

  const filtered = active.filter(s => {
    // The per-Task Manager (type='manager') lives in Tasks mode only — it is
    // never a row in the Sessions list. Subtasks (type='subtask') DO appear
    // here: a subtask is a 1:1 session. Hidden-workspace sessions are NOT
    // dropped either (2026-08-06): buildRailSections collects them into the
    // 无归属 group so they stay reachable — e.g. before deleting the hidden
    // workspace, which refuses while any session still references it.
    return s.type !== 'manager';
  });

  // Every session groups by workspace — no "needs you" section pinned to the
  // top (it overrode workspace grouping). Attention is conveyed per-row via the
  // StatusIcon (pending/error/unread), not by reordering. Pinned sessions and
  // pinned workspaces split off into a Codex-style "Pinned" section
  // (2026-08-03); the rest render under "Projects".
  const sections = buildRailSections(filtered, workspaces);

  function renderRow(s: Session) {
    return (
      <SessionRow
        key={s.id}
        session={s}
        wsHidden={s.workspace_id != null && wsById.get(s.workspace_id)?.hidden === 1}
        {...makeRowHandlers(s)}
      />
    );
  }

  function renderGroup(wsId: string) {
    const list = sections.byWs.get(wsId)!;
    const ws = wsById.get(wsId);
    const name = ws?.name ?? wsId;
    const isCollapsed = collapsed.has(wsId);
    // Group count = sessions that NEED the user (待处理), not the raw total —
    // the total says nothing actionable (2026-07-31). Hidden when zero.
    const attn = list.filter(sessionNeedsAttention).length;
    return (
      <div key={wsId}>
        <div className="sb-group" onClick={() => toggleGroup(wsId)}>
          <span className="sb-group-ico"><SvgIcon d={isCollapsed ? ICON.folder : ICON.folderOpen} size={14} /></span>
          <span>{name}</span>
          {attn > 0 && <span className="count">{attn}</span>}
          <span className="sb-group-acts">
            <button
              type="button"
              className="sb-act"
              data-testid={`sb-pin-ws-${wsId}`}
              aria-label={t(ws?.pinned === 1 ? 'coding.sidebar.ws.unpin' : 'coding.sidebar.ws.pin')}
              title={t(ws?.pinned === 1 ? 'coding.sidebar.ws.unpin' : 'coding.sidebar.ws.pin')}
              onClick={e => { e.stopPropagation(); if (ws) onToggleWorkspacePin(ws); }}
            >
              <SvgIcon d={ICON.pin} size={13} filled={ws?.pinned === 1} />
            </button>
            <button
              type="button"
              className="sb-act"
              data-testid={`sb-new-session-${wsId}`}
              aria-label={t('coding.sidebar.ws.new')}
              title={t('coding.sidebar.ws.new')}
              onClick={e => { e.stopPropagation(); onNewForWorkspace(wsId); }}
            >
              <SvgIcon d={ICON.plus} size={13} />
            </button>
          </span>
        </div>
        {!isCollapsed && list.map(s => renderRow(s))}
      </div>
    );
  }

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
            <SvgIcon d={ICON.search} />
          </button>
          <button
            type="button"
            className="sb-iconbtn"
            data-testid="sb-new-session"
            aria-label={t('coding.sidebar.new')}
            title={t('coding.sidebar.new')}
            onClick={onToggleNew}
          >
            <SvgIcon d={ICON.plus} />
          </button>
        </div>
      </div>

      <div className="sb-scroll">
        {/* Section labels only appear once something is pinned — with no
            pinned content the rail looks exactly like before. */}
        {sections.hasPinned && (
          <>
            <div className="sb-section static" data-testid="sb-section-pinned">
              <span className="sb-section-label">{t('coding.sidebar.section.pinned')}</span>
            </div>
            {sections.pinnedSessions.map(s => renderRow(s))}
            {sections.pinnedWsIds.map(renderGroup)}
          </>
        )}
        {sections.hasPinned && sections.projectWsIds.length > 0 && (
          <div className="sb-section static" data-testid="sb-section-projects">
            <span className="sb-section-label">{t('coding.sidebar.section.projects')}</span>
          </div>
        )}
        {sections.projectWsIds.map(renderGroup)}
        {/* 无归属: sessions of hidden workspaces stay reachable here instead
            of disappearing from the rail. Same collapsible affordance as the
            task 完成 section; the collapse state shares the rail's persisted
            set under a reserved key. */}
        {sections.unfiled.length > 0 && (
          <>
            <button
              className="sb-section"
              onClick={() => toggleGroup(UNFILED_GROUP_KEY)}
              aria-expanded={!collapsed.has(UNFILED_GROUP_KEY)}
              data-testid="sb-section-unfiled"
            >
              <SvgIcon d={collapsed.has(UNFILED_GROUP_KEY) ? ICON.caretRight : ICON.caretDown} size={12} />
              <span className="sb-section-label">{t('coding.sidebar.section.unfiled')}</span>
              <span className="count">{sections.unfiled.length}</span>
            </button>
            {!collapsed.has(UNFILED_GROUP_KEY) && sections.unfiled.map(s => renderRow(s))}
          </>
        )}
      </div>
    </aside>
  );
}

function SessionRow({
  session, active, wsHidden, onSelect, onPin, onArchive,
}: {
  session: Session;
  active: boolean;
  wsHidden?: boolean;
  onSelect: () => void;
  onPin: (pinned: boolean) => void;
  onArchive: () => void;
}) {
  const t = useT();
  const pinned = session.pinned_at != null;
  // Destructive-delete rule (proposal §5): the row stays visible with a
  // pending affordance until the canonical session:deleted removes it.
  const deleting = useSessionOperationPending(session.id, 'session.delete');
  return (
    <div
      className={`rail-item session-row${active ? ' active' : ''}${deleting ? ' deleting' : ''}`}
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
      {deleting
        ? <span className="spinner" role="status" aria-label={t('coding.session.deleting')} />
        : statusGlyphShown(session.status, session.unread === 1 && !active)
          ? <StatusIcon status={session.status} unread={session.unread === 1 && !active} />
          : <span className={`ri-age ${session.executor}`} title={t('coding.session.lastActivity')}>{relTime(session.updated_at)}</span>}
      {wsHidden && (
        <span
          className="ri-hidden-badge"
          title={t('coding.session.workspaceHidden')}
          aria-label={t('coding.session.workspaceHidden.aria')}
        >
          <SvgIcon d={ICON.eyeOff} size={11} />
        </span>
      )}
      {/* Hover actions: pin / archive. They cover the row-end glyph on hover
          (CSS). Pinned rows show no always-on pin glyph — membership in the
          "Pinned" section already says it (2026-08-03). */}
      <span className="ri-acts">
        <button
          type="button"
          className="ri-act"
          data-testid={`session-pin-${session.id}`}
          aria-label={t(pinned ? 'coding.session.unpin' : 'coding.session.pin')}
          title={t(pinned ? 'coding.session.unpin' : 'coding.session.pin')}
          onClick={e => { e.stopPropagation(); onPin(!pinned); }}
        >
          <SvgIcon d={ICON.pin} size={13} filled={pinned} />
        </button>
        <button
          type="button"
          className="ri-act"
          data-testid={`session-archive-${session.id}`}
          aria-label={t('coding.session.archive')}
          title={t('coding.session.archive')}
          onClick={e => { e.stopPropagation(); onArchive(); }}
        >
          <SvgIcon d={ICON.archive} size={13} />
        </button>
      </span>
    </div>
  );
}
