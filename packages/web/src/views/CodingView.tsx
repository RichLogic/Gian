import { useEffect, useRef, useState } from 'react';
import type { ApprovalDecision, ApprovalMode, Session, Workspace } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { createWorkspace } from '../api.js';
import { Composer } from '../components/Composer.js';
import { FilePreviewDrawer } from '../components/FilePreviewDrawer.js';
import { GitBadge } from '../components/GitBadge.js';
import { JobProgress } from '../components/JobProgress.js';
import { PlanChip } from '../components/PlanChip.js';
import { QueueList } from '../components/QueueList.js';
import { StatusPill, UsageChip } from '../components/Chips.js';
import { useResizableWidth, RailSplitter } from '../components/RailLayout.js';
import { Transcript } from '../transcript/Transcript.js';
import type { QueueEntry, TokenUsage, TranscriptItem } from '../types.js';

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

type GroupBy = 'time' | 'workspace' | 'status';

function timeBucket(iso: string): 'TODAY' | 'YESTERDAY' | 'THIS WEEK' | 'EARLIER' {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const ts = Date.parse(iso);
  const diff = todayStart - ts;
  if (ts >= todayStart) return 'TODAY';
  if (diff < 86400000) return 'YESTERDAY';
  if (diff < 6 * 86400000) return 'THIS WEEK';
  return 'EARLIER';
}

const STATUS_ORDER: Record<string, number> = { running: 0, pending: 1, error: 2, done: 3, new: 4 };
const BUCKET_ORDER = ['TODAY', 'YESTERDAY', 'THIS WEEK', 'EARLIER'] as const;

export interface CreateSessionInput {
  workspaceId: string;
  name: string;
  executor: 'claude' | 'codex';
  approvalMode: ApprovalMode;
  mode?: 'regular' | 'worktree';
  baseBranch?: string;
  /** Optional first message to send right after the session is created. */
  firstMessage?: string;
}

export interface CodingViewProps {
  workspaces: Workspace[];
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
  onLoadArchived: () => void | Promise<void>;
  onSelectSession: (id: string) => void;
  onWorkspaceCreated: (ws: Workspace) => void;
  onCreateSession: (input: CreateSessionInput) => void;
  onSend: (sessionId: string, text: string, opts?: { oneShotBypass?: boolean }) => void;
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
}

export function CodingView(p: CodingViewProps) {
  const [showNew, setShowNew] = useState(false);
  const rail = useResizableWidth('coding.rail.w', 272, 200, 480, 'left');

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
            sessions={p.sessions}
            archivedSessions={p.archivedSessions}
            archivedLoaded={p.archivedLoaded}
            activeSessionId={p.activeSessionId}
            showNew={showNew}
            onToggleNew={() => setShowNew(v => !v)}
            onSelect={id => { setShowNew(false); p.onSelectSession(id); }}
            onLoadArchived={p.onLoadArchived}
          />
          <RailSplitter onMouseDown={rail.onMouseDown} ariaLabel="Resize sidebar" />
        </>
      )}
      {showNew ? (
        <NewSessionView
          workspaces={p.workspaces}
          onCancel={() => setShowNew(false)}
          onWorkspaceCreated={p.onWorkspaceCreated}
          onCreate={input => {
            p.onCreateSession(input);
            setShowNew(false);
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

function FilterBar({
  workspaces,
  wsFilter, groupBy,
  onSetWs, onSetGroup,
}: {
  workspaces: Workspace[];
  wsFilter: string;
  groupBy: GroupBy;
  onSetWs: (v: string) => void;
  onSetGroup: (v: GroupBy) => void;
}) {
  const [open, setOpen] = useState<'ws' | 'group' | null>(null);

  // Close on click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target?.closest('.rail-fchip-wrap')) setOpen(null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const wsLabel = wsFilter === 'all' ? 'All' : workspaces.find(w => w.id === wsFilter)?.name ?? wsFilter;
  const groupLabel = groupBy === 'time' ? 'Time' : groupBy === 'workspace' ? 'Space' : 'Status';

  return (
    <div className="rail-filterbar">
      <div className="rail-filterbar-row">
        <FilterChip
          label="Group by"
          value={groupLabel}
          isOpen={open === 'group'}
          onToggle={() => setOpen(open === 'group' ? null : 'group')}
          options={[
            { value: 'time', label: 'Time' },
            { value: 'workspace', label: 'Space' },
            { value: 'status', label: 'Status' },
          ]}
          current={groupBy}
          onPick={v => { onSetGroup(v as GroupBy); setOpen(null); }}
        />
        <FilterChip
          label="Workspace"
          value={wsLabel}
          isOpen={open === 'ws'}
          onToggle={() => setOpen(open === 'ws' ? null : 'ws')}
          options={[{ value: 'all', label: 'All' }, ...workspaces.map(w => ({ value: w.id, label: w.name }))]}
          current={wsFilter}
          onPick={v => { onSetWs(v); setOpen(null); }}
        />
      </div>
    </div>
  );
}

function FilterChip({
  label, value, isOpen, onToggle, options, current, onPick,
}: {
  label: string;
  value: string;
  isOpen: boolean;
  onToggle: () => void;
  options: Array<{ value: string; label: string }>;
  current: string;
  onPick: (v: string) => void;
}) {
  return (
    <div className="rail-fchip-wrap">
      <button className="rail-fchip" type="button" onClick={onToggle} title={`Filter by ${label.toLowerCase()}`}>
        <span className="rfc-lbl">{label}</span>
        <span className="rfc-val">{value}</span>
        <span className="rfc-car">▾</span>
      </button>
      {isOpen && (
        <div className="rail-fchip-pop">
          {options.map(o => (
            <button
              key={o.value}
              type="button"
              className={`rail-fchip-opt${current === o.value ? ' active' : ''}`}
              onClick={() => onPick(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
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
          <kbd>⌘K</kbd> jump to session, file, or command
        </p>
      </div>
    </main>
  );
}

function Sidebar({
  workspaces,
  sessions,
  archivedSessions,
  archivedLoaded,
  activeSessionId,
  showNew,
  onToggleNew,
  onSelect,
  onLoadArchived,
}: {
  workspaces: Workspace[];
  sessions: Session[];
  archivedSessions: Session[];
  archivedLoaded: boolean;
  activeSessionId: string | null;
  showNew: boolean;
  onToggleNew: () => void;
  onSelect: (id: string) => void;
  onLoadArchived: () => void | Promise<void>;
}) {
  const t = useT();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [wsFilter, setWsFilter] = useState('all');
  const [groupBy, setGroupBy] = useState<GroupBy>('time');

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

  const filtered = wsFilter === 'all'
    ? active
    : active.filter(s => s.workspace_id === wsFilter);

  const needsYou = groupBy === 'status'
    ? []
    : filtered.filter(s => s.status === 'pending' || s.status === 'error');
  const needsYouIds = new Set(needsYou.map(s => s.id));
  const rest = groupBy === 'status' ? filtered : filtered.filter(s => !needsYouIds.has(s.id));

  function renderRow(s: Session, wsName: string, isArchived = false) {
    return (
      <SessionRow
        key={s.id}
        session={s}
        workspaceName={wsName}
        archived={isArchived}
        {...makeRowHandlers(s)}
      />
    );
  }

  function renderGroups() {
    if (rest.length === 0) return null;

    if (groupBy === 'workspace') {
      const grouped = new Map<string, Session[]>();
      for (const s of rest) {
        const list = grouped.get(s.workspace_id) ?? [];
        list.push(s);
        grouped.set(s.workspace_id, list);
      }
      return Array.from(grouped.entries()).map(([wsId, list]) => {
        const ws = wsById.get(wsId);
        const name = ws?.name ?? wsId;
        const sorted = list.slice().sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
        return (
          <div key={wsId} className="sb2-group">
            <div className="sb2-group-header">{name}</div>
            <div className="session-list">
              {sorted.map(s => renderRow(s, name))}
            </div>
          </div>
        );
      });
    }

    if (groupBy === 'status') {
      const grouped = new Map<string, Session[]>();
      for (const s of rest) {
        const list = grouped.get(s.status) ?? [];
        list.push(s);
        grouped.set(s.status, list);
      }
      const statusKeys = Array.from(grouped.keys()).sort(
        (a, b) => (STATUS_ORDER[a] ?? 99) - (STATUS_ORDER[b] ?? 99),
      );
      return statusKeys.map(status => {
        const list = (grouped.get(status) ?? []).slice().sort(
          (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
        );
        const label = status.charAt(0).toUpperCase() + status.slice(1);
        return (
          <div key={status} className="sb2-group">
            <div className="sb2-group-header">{label}</div>
            <div className="session-list">
              {list.map(s => renderRow(s, wsById.get(s.workspace_id)?.name ?? ''))}
            </div>
          </div>
        );
      });
    }

    const grouped = new Map<string, Session[]>();
    for (const s of rest) {
      const bucket = timeBucket(s.updated_at);
      const list = grouped.get(bucket) ?? [];
      list.push(s);
      grouped.set(bucket, list);
    }
    return BUCKET_ORDER.filter(b => grouped.has(b)).map(bucket => {
      const list = (grouped.get(bucket) ?? []).slice().sort(
        (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
      );
      return (
        <div key={bucket} className="sb2-group">
          <div className="sb2-group-header">{bucket}</div>
          <div className="session-list">
            {list.map(s => renderRow(s, wsById.get(s.workspace_id)?.name ?? ''))}
          </div>
        </div>
      );
    });
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title">{t('coding.sidebar.title')}</span>
        <button className="sidebar-action" onClick={onToggleNew}>
          {showNew ? t('coding.sidebar.cancel') : t('coding.sidebar.new')}
        </button>
      </div>

      <FilterBar
        workspaces={workspaces}
        wsFilter={wsFilter}
        groupBy={groupBy}
        onSetWs={setWsFilter}
        onSetGroup={setGroupBy}
      />

      <div className="sidebar-scroll">
        {workspaces.length === 0 && (
          <p style={{ padding: 'var(--sp-7)', color: 'var(--text-3)', fontSize: 'var(--fz-12)' }}>
            {t('coding.sidebar.noworkspaces')}
          </p>
        )}

        {needsYou.length > 0 && (
          <div className="sb2-needs-you">
            <div className="sb2-needs-you-header">
              <span className="sb2-needs-dot" />
              <span className="sb2-needs-label">NEEDS YOU</span>
              <span className="sb2-needs-count">{needsYou.length}</span>
            </div>
            <div className="session-list">
              {needsYou
                .slice()
                .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
                .map(s => renderRow(s, wsById.get(s.workspace_id)?.name ?? ''))}
            </div>
          </div>
        )}

        {renderGroups()}

        {(() => {
          const visible = archivedSessions
            .filter(s => wsFilter === 'all' || s.workspace_id === wsFilter)
            .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
          return (
            <div className="archived-section">
              <button className="archived-toggle" onClick={toggleArchived}>
                <span className="archived-toggle-caret">{archivedOpen ? '▾' : '▸'}</span>
                Archived {archivedLoaded ? `(${visible.length})` : ''}
              </button>
              {archivedOpen && (
                <div className="session-list">
                  {visible.map(s => renderRow(s, wsById.get(s.workspace_id)?.name ?? '', true))}
                  {archivedLoaded && visible.length === 0 && (
                    <span style={{ padding: '4px 10px', color: 'var(--text-3)', fontSize: 11 }}>
                      no archived sessions
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })()}
      </div>
    </aside>
  );
}

function SessionRow({
  session, workspaceName, active, archived,
  onSelect,
}: {
  session: Session;
  workspaceName: string;
  active: boolean;
  archived?: boolean;
  onSelect: () => void;
}) {
  const isWorktree = session.branch !== null;
  const terminal = session.worktree_outcome !== null;
  const badgeCls = terminal
    ? (session.worktree_outcome === 'merged' ? 'wt-badge merged' : 'wt-badge discarded')
    : 'wt-badge active';
  const showTurnBadge = session.status === 'running' && session.turns > 1;
  return (
    <div className={`session-row-wrap${active ? ' active' : ''}${archived ? ' archived' : ''}`}>
      <button
        className={`session-row rail-item${active ? ' active' : ''}`}
        data-status={session.status}
        onClick={onSelect}
      >
        <span className="ri-body">
          <span className="ri-row1">
            <span className="ri-title">{session.name || `session ${session.id.slice(0, 6)}`}</span>
            <StatusPill status={session.status} />
          </span>
          <span className="ri-row2">
            {showTurnBadge && (
              <>
                <span className="ri-turn">T·/{session.turns}</span>
                <span className="ri-dot-sep">·</span>
              </>
            )}
            <span className={`ri-exec-name ${session.executor}`}>{session.executor}</span>
            <span className="ri-dot-sep">·</span>
            <span className="ri-sub">{workspaceName}</span>
            {isWorktree && (
              <>
                <span className="ri-dot-sep">·</span>
                <span className={badgeCls} title={`${session.branch} → ${session.base_branch}${terminal ? ` · ${session.worktree_outcome}` : ''}`}>
                  {session.branch}
                </span>
              </>
            )}
          </span>
        </span>
        <span className="ri-age">{relTime(session.updated_at)}</span>
      </button>
    </div>
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
}: {
  workspaces: Workspace[];
  onWorkspaceCreated: (ws: Workspace) => void;
  onCreate: (input: CreateSessionInput) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [selectedWs, setSelectedWs] = useState(workspaces[0]?.id ?? '');
  const [sessionName, setSessionName] = useState('');
  const [executor, setExecutor] = useState<'claude' | 'codex'>('codex');
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('ask');
  const [mode, setMode] = useState<'regular' | 'worktree'>('regular');
  const [baseBranch, setBaseBranch] = useState('');
  const [firstMessage, setFirstMessage] = useState('');

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

  function submit() {
    if (!canCreate) return;
    const trimmedFirst = firstMessage.trim();
    onCreate({
      workspaceId: selectedWs,
      name: sessionName.trim(),
      executor,
      approvalMode,
      mode,
      ...(mode === 'worktree' && baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
      ...(trimmedFirst ? { firstMessage: trimmedFirst } : {}),
    });
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
                  value={selectedWs}
                  onChange={e => setSelectedWs(e.target.value)}
                >
                  {workspaces.map(w => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                  <option value="__new__">{t('coding.form.ws.createnew')}</option>
                </select>
              )}
              {showInlineCreate && (
                <div className="ns-inline-ws">
                  <input
                    className="input"
                    placeholder={t('coding.form.ws.name.placeholder')}
                    value={wsName}
                    onChange={e => setWsName(e.target.value)}
                  />
                  <input
                    className="input"
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
                    {t('coding.form.ws.create')}
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
                <input
                  className="input"
                  placeholder="Base branch (auto if blank)"
                  value={baseBranch}
                  onChange={e => setBaseBranch(e.target.value)}
                />
              )}
            </div>

            <div className="field">
              <div className="field-lbl">
                <span>{t('coding.new.name')}</span>
                <span className="field-hint">{t('coding.new.name.hint')}</span>
              </div>
              <input
                className="input"
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
                rows={4}
                placeholder={t('coding.new.first.placeholder')}
                value={firstMessage}
                onChange={e => setFirstMessage(e.target.value)}
              />
            </div>
          </div>
          <div className="ns-foot">
            <button className="btn ghost sm" onClick={onCancel}>{t('coding.new.cancel')}</button>
            <button className="btn primary sm" disabled={!canCreate} onClick={submit}>
              {t('coding.new.create')}
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
}: {
  session: Session;
  workspace: Workspace | null;
  items: TranscriptItem[];
  pending: boolean;
  usage: TokenUsage | null;
  queue: QueueEntry[];
  onSend: (text: string, opts?: { oneShotBypass?: boolean }) => void;
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
  const archived = session.archived === 1;
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Bump on pending → idle transition so GitBadge refetches at turn end.
  const [gitRefreshKey, setGitRefreshKey] = useState(0);
  const prevPendingRef = useRef(pending);
  useEffect(() => {
    if (prevPendingRef.current && !pending) setGitRefreshKey(k => k + 1);
    prevPendingRef.current = pending;
  }, [pending]);

  function startEdit() {
    setDraftName(session.name || `session ${session.id.slice(0, 8)}`);
    setEditing(true);
  }

  // Focus the input after it mounts.
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function commitEdit() {
    const trimmed = draftName.trim();
    if (trimmed) onRename(trimmed);
    setEditing(false);
  }

  function cancelEdit() {
    setEditing(false);
  }

  return (
    <main className="main">
      <div className="main-head">
        <div className="main-head-l">
          {editing ? (
            <input
              ref={inputRef}
              className="main-title-input"
              value={draftName}
              onChange={e => setDraftName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
                if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
              }}
              onBlur={commitEdit}
            />
          ) : (
            <span className="main-title-wrap">
              <span className="main-title">{session.name || `session ${session.id.slice(0, 8)}`}</span>
              {!terminal && (
                <button
                  type="button"
                  className="main-title-edit-btn"
                  title="Rename session"
                  onClick={startEdit}
                  aria-label="Rename session"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path d="M8.5 1.5a1.414 1.414 0 0 1 2 2L3.5 10.5l-3 .5.5-3L8.5 1.5z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              )}
            </span>
          )}
          <StatusPill status={session.status} />
        </div>
        <div className="main-head-r">
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
      <JobProgress session={session} items={items} />
      <Transcript items={items} pending={pending} executor={session.executor} onApprove={onApprove} />
      <QueueList queue={queue} onRemove={onQueueRemove} onReorder={onQueueReorder} onClear={onQueueClear} onSendNow={onQueueSendNow} />
      <PlanChip items={items} />
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
        footer={
          <TokStrip
            usage={usage}
            isWorktree={isWorktree}
            terminal={terminal}
            archived={archived}
            onResetContext={() => onSend('/clear')}
            onArchive={() => onArchive(!archived)}
            onDelete={onDelete}
            onRecover={onRecover}
            onMergeToBase={() => { void onMerge(); }}
            onDropWorktree={() => { void onDrop(); }}
          />
        }
      />
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
