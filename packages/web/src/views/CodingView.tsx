import { useEffect, useRef, useState } from 'react';
import type { ApprovalDecision, ApprovalMode, Session, Workspace } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { createWorkspace } from '../api.js';
import { Composer } from '../components/Composer.js';
import { FilePreviewDrawer } from '../components/FilePreviewDrawer.js';
import { GitBadge } from '../components/GitBadge.js';
import { PlanChip } from '../components/PlanChip.js';
import { QueueList } from '../components/QueueList.js';
import { useResizableWidth, RailSplitter } from '../components/RailLayout.js';
import { Transcript } from '../transcript/Transcript.js';
import type { QueueEntry, TokenUsage, TranscriptItem } from '../types.js';

// ─── V2 inline icons (copied verbatim from design/gian-design-v2/js/data.jsx) ─
function BranchIcon({ size = 11 }: { size?: number }) {
  return (
    <svg className="branch-ico" viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="6" r="1.6" />
      <path d="M4 5v6 M4 11c0-3 8-2 8-4.5" />
    </svg>
  );
}

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
  group:  'M3 7h18 M6 12h12 M9 17h6',
  filter: 'M4 5h16l-6 8v6l-4-2v-4z',
  plus:   'M12 5v14 M5 12h14',
  x:      'M5 5l14 14 M5 19L19 5',
  kebabV: 'M12 5.01v-.02 M12 12.01v-.02 M12 19.01v-.02',
};

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
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [wsFilter, setWsFilter] = useState('all');
  const [groupBy, setGroupBy] = useState<GroupBy>('time');
  // V2 sidebar state — search box + popovers.
  const [search, setSearch] = useState('');
  const [filterExec, setFilterExec] = useState<null | 'claude' | 'codex'>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const headRef = useRef<HTMLDivElement>(null);

  // Close popovers on outside click / Escape.
  useEffect(() => {
    if (!groupOpen && !filterOpen) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Element | null;
      if (target?.closest('.sb-search-row')) return;
      setGroupOpen(false);
      setFilterOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setGroupOpen(false); setFilterOpen(false); }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [groupOpen, filterOpen]);

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
    const wsName = wsById.get(s.workspace_id)?.name ?? '';
    return matchesSearch(s, wsName);
  });

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
          <div key={wsId}>
            <div className="sb-group"><span>{name}</span></div>
            {sorted.map(s => renderRow(s, name))}
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
          <div key={status}>
            <div className="sb-group"><span>{label}</span></div>
            {list.map(s => renderRow(s, wsById.get(s.workspace_id)?.name ?? ''))}
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
        <div key={bucket}>
          <div className="sb-group"><span>{bucket}</span></div>
          {list.map(s => renderRow(s, wsById.get(s.workspace_id)?.name ?? ''))}
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
            className="sb-iconbtn"
            aria-label="Group sessions"
            title={`Group by · ${groupBy}`}
            onClick={() => { setGroupOpen(o => !o); setFilterOpen(false); }}
          >
            <SvgIcon d={ICON.group} />
          </button>
          <button
            type="button"
            className={`sb-iconbtn${hasFilter ? ' has-active' : ''}`}
            aria-label="Filter sessions"
            title="Filter"
            onClick={() => { setFilterOpen(o => !o); setGroupOpen(false); }}
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

          {groupOpen && (
            <div className="group-pop">
              <div className="head">Group by</div>
              {(['time', 'status', 'workspace'] as const).map(g => (
                <button
                  key={g}
                  type="button"
                  className={`item${groupBy === g ? ' active' : ''}`}
                  onClick={() => { setGroupBy(g); setGroupOpen(false); }}
                >
                  <span className="check">{groupBy === g ? '✓' : ''}</span>
                  {g === 'time' ? 'Time' : g === 'status' ? 'Status' : 'Workspace'}
                </button>
              ))}
            </div>
          )}
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
              .map(s => renderRow(s, wsById.get(s.workspace_id)?.name ?? ''))}
          </>
        )}

        {renderGroups()}

        {(() => {
          const visible = archivedSessions
            .filter(s => wsFilter === 'all' || s.workspace_id === wsFilter)
            .filter(s => !filterExec || s.executor === filterExec)
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
                  {visible.map(s => renderRow(s, wsById.get(s.workspace_id)?.name ?? '', true))}
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
  // V2 markup: rail-item only carries `.active`. We retain workspaceName for
  // search-only purposes (handled in Sidebar) — it's no longer rendered per
  // design decision §3.13. If the session has no branch, fall back to the
  // workspace name in the branch slot so the row still surfaces context.
  const branchLabel = session.branch ?? workspaceName;
  return (
    <div
      className={`rail-item${active ? ' active' : ''}${archived ? ' archived' : ''}`}
      data-testid={`session-row-${session.id}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
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
          <span className="ri-dot-sep">·</span>
          <span className="ri-sub" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <BranchIcon size={9} />{branchLabel}
          </span>
        </div>
      </div>
      <span className="ri-age" title="Last activity">{relTime(session.updated_at)}</span>
      <StatusIcon status={session.status} />
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
                  aria-label="Workspace"
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
  // V2 chat/cli toggle — local-only state. CLI tab is a no-op for now
  // (Phase 7 wires it). Switching the tab does not change render yet.
  const [chatMode, setChatMode] = useState<'chat' | 'cli'>('chat');

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
          <div className="chat-toggle">
            <button
              type="button"
              className={chatMode === 'chat' ? 'active' : ''}
              onClick={() => setChatMode('chat')}
            >
              Chat
            </button>
            <button
              type="button"
              className={chatMode === 'cli' ? 'active' : ''}
              onClick={() => setChatMode('cli')}
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
      <div className="main-scroll">
        <Transcript items={items} pending={pending} executor={session.executor} onApprove={onApprove} />
      </div>
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
