import { useEffect, useRef, useState } from 'react';
import type { ApprovalDecision, ApprovalMode, NativeConfigValue, Session, Workspace } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { ModeDropdown } from '../components/ModeDropdown.js';
import type { Mode } from '../components/Topbar.js';
import { useResizableWidth, RailSplitter } from '../components/RailLayout.js';
import type { PlanLifecycleState } from '../transcript/apply.js';
import type { ApprovalActionContext, QueueEntry, TranscriptItem } from '../types.js';
import { sessionNeedsAttention } from '../session-routing.js';
import { SessionMain } from './SessionMain.js';
import { relTime, statusGlyphShown, StatusIcon } from './session-list-status.js';
import { NewSessionView } from './new-session-view.js';
import type { CreateSessionInput } from './new-session-view.js';
export { buildSessionCreatePayload } from './new-session-view.js';
export type { CreateSessionInput, SessionCreateFormState } from './new-session-view.js';

// ─── V2 inline icons (24-grid, 1.5px stroke, round caps — phase 6 grid) ────
function SvgIcon({ d, size = 16, stroke = 1.5 }: { d: string; size?: number; stroke?: number }) {
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
  plus:   'M12 5v14 M5 12h14',
  kebabV: 'M12 5.01v-.02 M12 12.01v-.02 M12 19.01v-.02',
  branch: 'M5 3v10M11 6v7M5 6h6M11 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4ZM5 15a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  eyeOff: 'M2 2l12 12M6.5 6.5a2 2 0 0 0 2.8 2.8M3.5 4.5a8 8 0 0 0-1.5 3.5C3 11.5 5.5 13 8 13a8 8 0 0 0 4-1.1M9 3a8 8 0 0 1 5 5 8 8 0 0 1-1 2',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  folderOpen: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2.5 M3 7v10a2 2 0 0 0 2 2h12.5a2 2 0 0 0 1.9-1.4L21.8 11H7.5a2 2 0 0 0-1.9 1.4L4 17.5',
};


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
    context?: ApprovalActionContext,
  ) => void;
  onQueueAdd: (sessionId: string, text: string, attachments?: Array<{ path: string; name: string; mime: string; size?: number }>) => void;
  onQueueRemove: (sessionId: string, queueId: string) => void;
  onQueueReorder: (sessionId: string, order: string[]) => void;
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
  /** Open the Files view in Changed mode for this session's working tree. */
  onShowChanges: (session: Session) => void;
  /** Active session's working tree id (`wt:<id>` or `ws:<id>`), null if none. */
  activeWorkingTreeId: string | null;
  /** Branch name for the active session's working tree. */
  activeBranch: string | null;
  /** Switch app mode to Spaces (workspace management). Triggered from
   *  the sidebar's hidden-workspace footer link. */
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
        onToggleNew={() => setShowNew(v => !v)}
        onSelect={id => { setShowNew(false); p.onSelectSession(id); }}
        onOpenSpaces={p.onOpenSpaces}
      />
      <RailSplitter onMouseDown={rail.onMouseDown} ariaLabel="Resize sidebar" />
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
          queue={p.queueBySession[p.activeSession.id] ?? []}
          planText={p.planStateBySession[p.activeSession.id]?.text}
          codexPlanCompleted={p.planStateBySession[p.activeSession.id]?.completed}
          onSend={(text, opts) => p.onSend(p.activeSession!.id, text, opts)}
          onSendSkill={(name, path) => p.onSendSkill(p.activeSession!.id, name, path)}
          onStop={() => p.onStop(p.activeSession!.id)}
          onApprove={(approvalId, decision, answers, context) => p.onApprove(p.activeSession!.id, approvalId, decision, answers, context)}
          onQueueAdd={(text, items) => p.onQueueAdd(p.activeSession!.id, text, items)}
          onQueueRemove={queueId => p.onQueueRemove(p.activeSession!.id, queueId)}
          onQueueReorder={order => p.onQueueReorder(p.activeSession!.id, order)}
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
          onShowChanges={() => p.onShowChanges(p.activeSession!)}
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
  onSelect,
  onOpenSpaces,
}: {
  mode: Mode;
  onSetMode: (mode: Mode) => void;
  onOpenSearch: () => void;
  workspaces: Workspace[];
  sessions: Session[];
  activeSessionId: string | null;
  showNew: boolean;
  onToggleNew: () => void;
  onSelect: (id: string) => void;
  onOpenSpaces: () => void;
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
    };
  }

  const wsById = new Map(workspaces.map(w => [w.id, w]));

  const active = sessions.filter(s => s.archived === 0);

  const filtered = active.filter(s => {
    // The per-Task Manager (type='manager') lives in Tasks mode only — it is
    // never a row in the Sessions list. Subtasks (type='subtask') DO appear
    // here: a subtask is a 1:1 session.
    if (s.type === 'manager') return false;
    const ws = wsById.get(s.workspace_id);
    // Sessions whose workspace is hidden disappear from the list — UNLESS
    // they're the currently active session, in which case we keep the row
    // visible with a "wsHidden" badge so the user has a route back.
    if (ws?.hidden && s.id !== activeSessionId) return false;
    return true;
  });

  // Every session groups by workspace — no "needs you" section pinned to the
  // top (it overrode workspace grouping). Attention is conveyed per-row via the
  // StatusIcon (pending/error/unread), not by reordering.
  const rest = filtered;

  function renderRow(s: Session) {
    return (
      <SessionRow
        key={s.id}
        session={s}
        wsHidden={wsById.get(s.workspace_id)?.hidden === 1}
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
      // Group count = sessions that NEED the user (待处理), not the raw total —
      // the total says nothing actionable (2026-07-31). Hidden when zero.
      const attn = list.filter(sessionNeedsAttention).length;
      return (
        <div key={wsId}>
          <div className="sb-group" onClick={() => toggleGroup(wsId)}>
            <span className="sb-group-ico"><SvgIcon d={isCollapsed ? ICON.folder : ICON.folderOpen} size={14} /></span>
            <span>{name}</span>
            {attn > 0 && <span className="count">{attn}</span>}
          </div>
          {!isCollapsed && sorted.map(s => renderRow(s))}
        </div>
      );
    });
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
        {renderGroups()}

        {(() => {
          const hiddenCount = workspaces.filter(workspace => workspace.hidden === 1).length;
          if (hiddenCount === 0) return null;
          return (
            <button type="button" className="sb-hidden-link" onClick={onOpenSpaces}>
              ↳ {hiddenCount}{' '}
              {t(hiddenCount === 1
                ? 'coding.sidebar.hiddenOne'
                : 'coding.sidebar.hiddenMany')}
              {' · '}
              {t('coding.sidebar.manage')}
            </button>
          );
        })()}
      </div>
    </aside>
  );
}

function SessionRow({
  session, active, wsHidden, onSelect,
}: {
  session: Session;
  active: boolean;
  wsHidden?: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  return (
    <div
      className={`rail-item session-row${active ? ' active' : ''}`}
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
    </div>
  );
}
