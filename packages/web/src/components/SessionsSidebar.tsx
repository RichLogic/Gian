import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProductExecutor, Session, Workspace } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { confirm } from '../feedback.js';
import { AgentLogo } from './AgentLogo.js';
import type { Mode } from './Topbar.js';
import {
  GROUP_INITIAL_SHOWN,
  GROUP_SHOW_MORE_STEP,
  SidebarListSwitch,
  SidebarNavRows,
  SidebarSection,
  type SidebarListMode,
} from './SidebarChrome.js';
import {
  useOperationDispatchOptional,
  useSessionOperationPending,
  useSessionOrderOverlay,
} from '../operations/use-operations.js';
import { sessionNeedsAttention, buildRailSections, orderByIds } from '../session-routing.js';
import { moveById, useDragReorder } from '../dnd-reorder.js';
import type { DropPlace, RowDragProps } from '../dnd-reorder.js';
import { relTime, statusGlyphShown, StatusIcon } from '../views/session-list-status.js';
import { useScheduledSessionIds } from '../controllers/use-schedules.js';

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
  plus:   'M12 5v14 M5 12h14',
  // lucide "timer" — session owns at least one live Schedule (row-end badge)
  timer:  'M10 2h4 M12 14l3-3 M20 14a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  folderOpen: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2.5 M3 7v10a2 2 0 0 0 2 2h12.5a2 2 0 0 0 1.9-1.4L21.8 11H7.5a2 2 0 0 0-1.9 1.4L4 17.5',
  // pushpin — pin / unpin rows (same glyph as the task pin in PathBreadcrumb)
  pin: 'M12 17v5 M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
  archive: 'M3 4h18v4H3z M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8 M10 12h4',
  // kebab (horizontal ⋯) — the project group's more-actions menu trigger
  // (same glyph as the task row's TaskMenu).
  kebab: 'M5 12.01v-.02 M12 12.01v-.02 M19 12.01v-.02',
};

/** localStorage key for the Repos rail's collapsed SECTIONS (pinned /
 *  projects / unfiled). Distinct from `gian.sidebar.collapsed.workspace`
 *  (workspace groups). Value: string[] of collapsed keys; default []. */
const SIDEBAR_SECTIONS_KEY = 'gian.sidebar.sections.collapsed';

/** The Project (formerly Sessions) rail: workspace-grouped session list.
 *  Shared by CodingView and the top-level pages (Agents / Timer / Custom),
 *  whose main pane swaps while the rail stays (2026-08-31 sidebar redesign).
 *  Scroll-area order: Agents/Custom/Timer nav rows → the Tasks/Repos
 *  list-switch dropdown row (2026-09-08, replaces the sticky segmented
 *  switch) → the list; a long list scrolls the nav rows away while the
 *  list-switch row sticks. The
 *  top-row New button is gone (2026-09-07): the Repos section header's hover
 *  "+" opens the New Repo dialog (a modal since 2026-09-09, previously a
 *  Workbench sheet tab), new sessions start from a workspace group's
 *  "+" or ⌘N. Search lives on ⌘K / the Command Palette (the rail's search
 *  button was removed 2026-09-06). */
export function SessionsSidebar({
  mode,
  onSetMode,
  listMode,
  onSetListMode,
  workspaces,
  sessions,
  activeSessionId,
  onNewWorkspace,
  onEditWorkspace,
  onNewForWorkspace,
  onPinSession,
  onArchiveSession,
  onSelect,
}: {
  mode: Mode;
  onSetMode: (mode: Mode) => void;
  listMode: SidebarListMode;
  onSetListMode: (mode: SidebarListMode) => void;
  workspaces: Workspace[];
  sessions: Session[];
  activeSessionId: string | null;
  /** Repos section "+": open the New Repo dialog. */
  onNewWorkspace: () => void;
  /** Workspace group ⋯ menu Edit: open the Edit Repo dialog (name-only). */
  onEditWorkspace: (workspace: Workspace) => void;
  onNewForWorkspace: (workspaceId: string) => void;
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

  // Section collapse (2026-09-07 Codex-style refactor): 置顶 / Repos / 无归属
  // labels all toggle their section, persisted so switching to the Tasks tab
  // and back (which unmounts this rail) keeps the state. Default: all
  // expanded. Distinct from the workspace-GROUP collapse set above.
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(SIDEBAR_SECTIONS_KEY);
      return new Set<string>(raw ? JSON.parse(raw) : []);
    } catch { return new Set(); }
  });
  const toggleSection = (key: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem(SIDEBAR_SECTIONS_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  function makeRowHandlers(s: Session) {
    return {
      active: s.id === activeSessionId,
      workspaceName: s.workspace_id != null ? wsById.get(s.workspace_id)?.name : undefined,
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
    // here: a subtask is a 1:1 session.
    return s.type !== 'manager';
  });

  // Every session groups by workspace — no "needs you" section pinned to the
  // top (it overrode workspace grouping). Attention is conveyed per-row via the
  // StatusIcon (pending/error/unread), not by reordering. Pinned sessions and
  // pinned workspaces split off into a Codex-style "Pinned" section
  // (2026-08-03); the rest render under "Projects".
  const sections = buildRailSections(filtered, workspaces);

  function renderRow(s: Session, drag?: { props: RowDragProps; className: string }) {
    return (
      <SessionRow
        key={s.id}
        session={s}
        drag={drag}
        {...makeRowHandlers(s)}
      />
    );
  }

  // Drag reorder (2026-08-29): workspace GROUP headers drag within their own
  // section (pinned groups among pinned, project groups among projects — the
  // two controllers never cross), and session rows drag within their
  // workspace group (SidebarGroup owns that controller). Both dispatch
  // whole-list reorder operations (operations/workspace.ts · session.ts).
  const dispatch = useOperationDispatchOptional();
  const reorderWorkspacesByDrag = (dragId: string, targetId: string, place: DropPlace) => {
    if (!dispatch) return;
    const current = workspaces.map(w => w.id);
    const next = moveById(current, dragId, targetId, place);
    if (next !== current) dispatch('workspace.reorder', { ids: next });
  };
  const pinnedWsDnd = useDragReorder(reorderWorkspacesByDrag);
  const projectWsDnd = useDragReorder(reorderWorkspacesByDrag);

  // The unfiled (无归属) rows drag among themselves — scope 'workspace' with
  // a NULL parent (see POST /api/sessions/reorder).
  const unfiledOrder = useSessionOrderOverlay('workspace', null);
  const unfiledRows = useMemo(
    () => (unfiledOrder ? orderByIds(sections.unfiled, unfiledOrder) : sections.unfiled),
    [sections, unfiledOrder],
  );
  const [unfiledShown, setUnfiledShown] = useState(GROUP_INITIAL_SHOWN);
  const unfiledDnd = useDragReorder((dragId, targetId, place) => {
    if (!dispatch) return;
    const current = unfiledRows.map(s => s.id);
    const next = moveById(current, dragId, targetId, place);
    if (next !== current) {
      dispatch('session.reorder', { scope: 'workspace', parentId: null, ids: next });
    }
  });

  return (
    <aside className="sidebar">
      <div className="sb-scroll">
        <SidebarNavRows mode={mode} onSetMode={onSetMode} />
        <SidebarListSwitch listMode={listMode} onSetListMode={onSetListMode} />
        {/* Section labels only appear once something is pinned — with no
            pinned content the rail looks exactly like before. */}
        {sections.hasPinned && (
          <>
            <SidebarSection
              label={t('coding.sidebar.section.pinned')}
              collapsed={collapsedSections.has('pinned')}
              onToggle={() => toggleSection('pinned')}
              testid="sb-section-pinned"
            />
            {!collapsedSections.has('pinned') && (
              <>
                {sections.pinnedSessions.map(s => renderRow(s))}
                {sections.pinnedWsIds.map(wsId => (
                  <SidebarGroup
                    key={wsId}
                    wsId={wsId}
                    list={sections.byWs.get(wsId) ?? []}
                    workspace={wsById.get(wsId)}
                    isCollapsed={collapsed.has(wsId)}
                    onToggle={() => toggleGroup(wsId)}
                    onEditWorkspace={onEditWorkspace}
                    onNewForWorkspace={onNewForWorkspace}
                    renderRow={renderRow}
                    groupDrag={{ props: pinnedWsDnd.rowProps(wsId), className: pinnedWsDnd.rowClass(wsId) }}
                  />
                ))}
              </>
            )}
          </>
        )}
        {/* The Repos header always renders — even with zero workspace groups —
            so its hover "+" (New Repo) stays reachable. */}
        <SidebarSection
          label={t('coding.sidebar.section.projects')}
          collapsed={collapsedSections.has('projects')}
          onToggle={() => toggleSection('projects')}
          onAdd={onNewWorkspace}
          addTitle={t('coding.new.workspace.new')}
          testid="sb-section-projects"
        />
        {!collapsedSections.has('projects') && sections.projectWsIds.map(wsId => (
          <SidebarGroup
            key={wsId}
            wsId={wsId}
            list={sections.byWs.get(wsId) ?? []}
            workspace={wsById.get(wsId)}
            isCollapsed={collapsed.has(wsId)}
            onToggle={() => toggleGroup(wsId)}
            onEditWorkspace={onEditWorkspace}
            onNewForWorkspace={onNewForWorkspace}
            renderRow={renderRow}
            groupDrag={{ props: projectWsDnd.rowProps(wsId), className: projectWsDnd.rowClass(wsId) }}
          />
        ))}
        {/* 无归属: sessions whose workspace is gone (NULL workspace_id after
            workspace delete) stay reachable here. */}
        {sections.unfiled.length > 0 && (
          <>
            <SidebarSection
              label={t('coding.sidebar.section.unfiled')}
              collapsed={collapsedSections.has('unfiled')}
              onToggle={() => toggleSection('unfiled')}
              testid="sb-section-unfiled"
            />
            {!collapsedSections.has('unfiled') && unfiledRows.slice(0, unfiledShown).map(s => renderRow(s, {
              props: unfiledDnd.rowProps(s.id),
              className: unfiledDnd.rowClass(s.id),
            }))}
            {!collapsedSections.has('unfiled') && unfiledRows.length > unfiledShown && (
              <button
                type="button"
                className="sb-showmore"
                data-testid="sb-showmore-unfiled"
                onClick={() => setUnfiledShown(n => n + GROUP_SHOW_MORE_STEP)}
              >
                {t('coding.sidebar.showMore').replace('{n}', String(unfiledRows.length - unfiledShown))}
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

/** One workspace group in the Sessions rail (2026-08-29: extracted from the
 *  Sidebar's renderGroup so the session list can own hooks): the `.sb-group`
 *  header toggles collapse on click and drags for WORKSPACE reorder via the
 *  Sidebar's section controller; its session rows drag WITHIN the group via
 *  this component's own controller (`session.reorder`, scope 'workspace'). */
function SidebarGroup({
  wsId,
  list,
  workspace,
  isCollapsed,
  onToggle,
  onEditWorkspace,
  onNewForWorkspace,
  renderRow,
  groupDrag,
}: {
  wsId: string;
  /** The group's rail-sorted sessions (all unpinned — pinned rows live in the
   *  Pinned section, see buildRailSections). */
  list: Session[];
  workspace: Workspace | undefined;
  isCollapsed: boolean;
  onToggle: () => void;
  onEditWorkspace: (workspace: Workspace) => void;
  onNewForWorkspace: (workspaceId: string) => void;
  renderRow: (s: Session, drag?: { props: RowDragProps; className: string }) => React.ReactNode;
  /** Workspace-level drag (owned by the Sidebar's pinned/projects controller). */
  groupDrag: { props: RowDragProps; className: string };
}) {
  const t = useT();
  const dispatch = useOperationDispatchOptional();
  // Session drag reorder within the group: while the run is in flight its
  // whole-group overlay (the dragged id order) wins over the canonical sort;
  // on confirm the Host's workspace_order column reproduces it.
  const orderOverlay = useSessionOrderOverlay('workspace', wsId);
  const rows = useMemo(
    () => (orderOverlay ? orderByIds(list, orderOverlay) : list),
    [list, orderOverlay],
  );
  const sessionDnd = useDragReorder((dragId, targetId, place) => {
    if (!dispatch) return;
    const current = rows.map(s => s.id);
    const next = moveById(current, dragId, targetId, place);
    if (next !== current) {
      dispatch('session.reorder', { scope: 'workspace', parentId: wsId, ids: next });
    }
  });
  const name = workspace?.name ?? wsId;
  // Group count = sessions that NEED the user (待处理), not the raw total —
  // the total says nothing actionable (2026-07-31). Hidden when zero.
  const attn = list.filter(sessionNeedsAttention).length;
  // Display cap: 5 rows up front, 显示更多 reveals 10 more per click
  // (2026-09-06 owner call). View-only; the drag order is unaffected.
  const [shown, setShown] = useState(GROUP_INITIAL_SHOWN);
  const visibleRows = rows.slice(0, shown);
  return (
    <div>
      <div className={`sb-group${groupDrag.className}`} onClick={onToggle} {...groupDrag.props}>
        <span className="sb-group-ico"><SvgIcon d={isCollapsed ? ICON.folder : ICON.folderOpen} size={17} /></span>
        <span className="sb-group-name">{name}</span>
        {attn > 0 && <span className="count">{attn}</span>}
        <span className="sb-group-acts">
          <WorkspaceMenu wsId={wsId} name={name} workspace={workspace} onEdit={onEditWorkspace} />
          <button
            type="button"
            className="sb-act"
            data-testid={`sb-new-session-${wsId}`}
            aria-label={t('coding.sidebar.ws.new')}
            title={t('coding.sidebar.ws.new')}
            onClick={e => { e.stopPropagation(); onNewForWorkspace(wsId); }}
          >
            <SvgIcon d={ICON.plus} size={14} />
          </button>
        </span>
      </div>
      {!isCollapsed && visibleRows.map(s => renderRow(s, {
        props: sessionDnd.rowProps(s.id),
        className: sessionDnd.rowClass(s.id),
      }))}
      {!isCollapsed && rows.length > shown && (
        <button
          type="button"
          className="sb-showmore"
          data-testid={`sb-showmore-${wsId}`}
          onClick={event => {
            event.stopPropagation();
            setShown(n => n + GROUP_SHOW_MORE_STEP);
          }}
        >
          {t('coding.sidebar.showMore').replace('{n}', String(rows.length - shown))}
        </button>
      )}
    </div>
  );
}

// ─── Session hover detail card (T3 → redesigned 2026-09-06, owner mockup) ──
// A delayed hover card floating right of the rail row: agent logo + full
// name (click to rename inline) + relative time on row one, the owning Repo
// on row two. Interactive: the card survives row→card pointer travel and
// stays up while the rename input is open. Shared by Project rows
// (SessionRow) and Tasks subtask rows.
const HOVER_CARD_OPEN_MS = 450;
const HOVER_CARD_CLOSE_MS = 120;

export function useSessionHoverCard() {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const close = () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    setRect(null);
  };
  const onMouseEnter = (event: React.MouseEvent<HTMLElement>) => {
    const next = event.currentTarget.getBoundingClientRect();
    window.clearTimeout(closeTimer.current);
    if (rect) return;
    window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => setRect(next), HOVER_CARD_OPEN_MS);
  };
  // Grace period so the pointer can travel from the row onto the card.
  const onMouseLeave = () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setRect(null), HOVER_CARD_CLOSE_MS);
  };
  const keepOpen = () => {
    window.clearTimeout(closeTimer.current);
  };
  return { rect, onMouseEnter, onMouseLeave, keepOpen, close };
}

export function SessionHoverCard({
  session,
  rect,
  workspaceName,
  keepOpen,
  scheduleClose,
  close,
}: {
  session: Session;
  rect: DOMRect;
  workspaceName?: string;
  /** Pointer entered the card — cancel the pending close. */
  keepOpen: () => void;
  /** Pointer left the card — close after the grace period (unless editing). */
  scheduleClose: () => void;
  close: () => void;
}) {
  const t = useT();
  const dispatch = useOperationDispatchOptional();
  const [editing, setEditing] = useState(false);
  const name = session.name || `session ${session.id.slice(0, 6)}`;
  const commit = (value: string) => {
    setEditing(false);
    const trimmed = value.trim();
    if (dispatch && trimmed && trimmed !== name) {
      dispatch('session.rename', { sessionId: session.id, name: trimmed });
    }
    close();
  };
  return createPortal(
    <div
      className="session-hover-card"
      data-testid={`session-hover-card-${session.id}`}
      style={{
        left: Math.min(rect.right + 8, window.innerWidth - 264),
        top: Math.max(8, Math.min(rect.top, window.innerHeight - 120)),
      }}
      onMouseEnter={keepOpen}
      onMouseLeave={() => { if (!editing) scheduleClose(); }}
    >
      <div className="shc-head">
        <AgentLogo proxy={session.executor as ProductExecutor | null} fallback={session.agent_name || session.executor} size={16} />
        {editing ? (
          <input
            className="shc-rename"
            data-testid={`session-rename-${session.id}`}
            defaultValue={session.name ?? ''}
            autoFocus
            onFocus={event => event.currentTarget.select()}
            onKeyDown={event => {
              if (event.key === 'Enter') commit(event.currentTarget.value);
              if (event.key === 'Escape') { setEditing(false); close(); }
            }}
            onBlur={event => commit(event.currentTarget.value)}
          />
        ) : (
          <button
            type="button"
            className="shc-name"
            title={t('path.menu.rename')}
            onClick={() => { setEditing(true); keepOpen(); }}
          >
            {name}
          </button>
        )}
        <span className="shc-time">{relTime(session.updated_at)}</span>
      </div>
      <div className="shc-repo">
        <SvgIcon d={ICON.folder} size={12} />
        <span>{workspaceName ?? '—'}</span>
      </div>
    </div>,
    document.body,
  );
}

export function SessionRow({
  session, active, hideAge = false, hidePin = false, workspaceName, onSelect, onPin, onArchive, drag,
}: {
  session: Session;
  active: boolean;
  /** Tasks rail (T4, 2026-09-06): no relative-time stamp at the row end. */
  hideAge?: boolean;
  /** Tasks rail (2026-09-06): no pin concept there — the pin button hides. */
  hidePin?: boolean;
  /** Hover-card context — the owning Repo's name. */
  workspaceName?: string;
  onSelect: () => void;
  onPin: (pinned: boolean) => void;
  onArchive: () => void;
  /** Drag-reorder wiring (the owning list's controller); absent for the
   *  standalone pinned rows, which keep their pinned_at order. */
  drag?: { props: RowDragProps; className: string };
}) {
  const t = useT();
  const pinned = session.pinned_at != null;
  const hover = useSessionHoverCard();
  // Row-end timer glyph (2026-09-15 owner): the session owns at least one
  // live (active/paused) Schedule.
  const hasSchedule = useScheduledSessionIds().has(session.id);
  // Destructive-delete rule (proposal §5): the row stays visible with a
  // pending affordance until the canonical session:deleted removes it.
  const deleting = useSessionOperationPending(session.id, 'session.delete');
  return (
    <div
      className={`rail-item session-row${active ? ' active' : ''}${deleting ? ' deleting' : ''}${drag?.className ?? ''}`}
      data-testid={`session-row-${session.id}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onMouseEnter={hover.onMouseEnter}
      onMouseLeave={hover.onMouseLeave}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
      }}
      {...(drag?.props ?? {})}
    >
      <div className="ri-body">
        <div className="ri-row1">
          {/* Timer glyph hangs in the row's icon gutter (2026-09-15 owner):
              the empty column left of the shared 43px title column, aligned
              with the group-header icons — the title never moves. */}
          {hasSchedule && (
            <span
              className="ri-schedule-badge"
              title={t('coding.session.scheduledTasks')}
              aria-label={t('coding.session.scheduledTasks')}
              data-testid={`session-schedule-${session.id}`}
            >
              <SvgIcon d={ICON.timer} size={13} />
            </span>
          )}
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
          : !hideAge && <span className={`ri-age ${session.executor}`} title={t('coding.session.lastActivity')}>{relTime(session.updated_at)}</span>}
      {hover.rect && !deleting && (
        <SessionHoverCard
          session={session}
          rect={hover.rect}
          workspaceName={workspaceName}
          keepOpen={hover.keepOpen}
          scheduleClose={hover.onMouseLeave}
          close={hover.close}
        />
      )}
      {/* Hover actions: pin / archive. They cover the row-end glyph on hover
          (CSS). Pinned rows show no always-on pin glyph — membership in the
          "Pinned" section already says it (2026-08-03). */}
      <span className="ri-acts">
        {!hidePin && (
        <button
          type="button"
          className="ri-act"
          data-testid={`session-pin-${session.id}`}
          aria-label={t(pinned ? 'coding.session.unpin' : 'coding.session.pin')}
          title={t(pinned ? 'coding.session.unpin' : 'coding.session.pin')}
          onClick={e => { e.stopPropagation(); onPin(!pinned); }}
        >
          <SvgIcon d={ICON.pin} size={14} filled={pinned} />
        </button>
        )}
        <button
          type="button"
          className="ri-act"
          data-testid={`session-archive-${session.id}`}
          aria-label={t('coding.session.archive')}
          title={t('coding.session.archive')}
          onClick={e => { e.stopPropagation(); onArchive(); }}
        >
          <SvgIcon d={ICON.archive} size={14} />
        </button>
      </span>
    </div>
  );
}

/** Project group ⋯ menu (2026-09-06, owner call): Edit (opens the Edit Repo
 *  dialog — name-only rename since 2026-09-09, previously inline) /
 *  Reveal in Finder / Remove (danger + confirm). The portaled fixed popover
 *  and its `ws-kebab-*` classes mirror the task row's TaskMenu — the rail
 *  clips absolute overflow, so the menu renders into <body>. */
function WorkspaceMenu({
  wsId,
  name,
  workspace,
  onEdit,
}: {
  wsId: string;
  name: string;
  /** Full workspace for the Edit Repo dialog; the Edit item hides without it. */
  workspace: Workspace | undefined;
  onEdit: (workspace: Workspace) => void;
}) {
  const t = useT();
  const dispatch = useOperationDispatchOptional();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);

  // Right-align to the trigger and clamp into the viewport; measure on the
  // first hidden pass so no misplaced frame is ever painted.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const btn = btnRef.current;
    const pop = popRef.current;
    if (!btn || !pop) return;
    const rect = btn.getBoundingClientRect();
    const width = pop.offsetWidth;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    setPos({ left, top: rect.bottom + 4 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (popRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    // position: fixed cannot track the anchor — close on scroll/resize.
    const onScrollOrResize = () => setOpen(false);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open]);

  function remove() {
    void confirm({
      title: t('coding.sidebar.ws.remove.title'),
      message: t('coding.sidebar.ws.remove.message').replace('{name}', name),
      confirmLabel: t('coding.sidebar.ws.remove.confirm'),
      danger: true,
    }).then(accepted => {
      if (accepted) dispatch?.('workspace.delete', { workspaceId: wsId });
    });
  }

  return (
    <span className="ws-kebab-anchor" ref={anchorRef}>
      <button
        ref={btnRef}
        type="button"
        className="sb-act"
        data-testid={`ws-menu-${wsId}`}
        aria-label={t('coding.sidebar.ws.menu')}
        title={t('coding.sidebar.ws.menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={event => { event.stopPropagation(); setOpen(o => !o); }}
      >
        <SvgIcon d={ICON.kebab} size={14} stroke={2.6} />
      </button>
      {open && createPortal(
        <span
          ref={popRef}
          className="ws-kebab-pop ws-kebab-pop--fixed"
          role="menu"
          onClick={event => event.stopPropagation()}
          style={pos
            ? { left: pos.left, top: pos.top }
            : { visibility: 'hidden', left: 0, top: 0 }}
        >
          {workspace && (
            <button
              className="ws-kebab-item"
              role="menuitem"
              data-testid={`ws-edit-${wsId}`}
              onClick={() => { setOpen(false); onEdit(workspace); }}
            >
              {t('coding.sidebar.ws.edit')}
            </button>
          )}
          <button
            className="ws-kebab-item"
            role="menuitem"
            data-testid={`ws-reveal-${wsId}`}
            onClick={() => {
              setOpen(false);
              // Whole-tree reveal rides the shared external-open operation
              // (files.openExternal, `reveal` target) — views never call the
              // mutation REST surface directly.
              dispatch?.('files.openExternal', {
                workingTreeId: `ws:${wsId}`,
                path: '',
                target: { kind: 'reveal' },
              });
            }}
          >
            {t('coding.sidebar.ws.reveal')}
          </button>
          <span className="ws-kebab-divider" />
          <button
            className="ws-kebab-item danger"
            role="menuitem"
            data-testid={`ws-remove-${wsId}`}
            onClick={() => { setOpen(false); remove(); }}
          >
            {t('coding.sidebar.ws.remove')}
          </button>
        </span>,
        document.body,
      )}
    </span>
  );
}
