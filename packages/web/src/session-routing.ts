import type {
  Session,
  SessionStatus,
} from '@gian/shared';

export interface CreatedSessionFirstMessagePlan {
  structuredText: string | null;
  seedOptimisticEcho: boolean;
}

/**
 * Decide how the App should dispatch the first message after session:create.
 * Both executors stay on the structured path (`message:send`).
 */
export function planCreatedSessionFirstMessage(
  pendingMessage: string | null | undefined,
): CreatedSessionFirstMessagePlan {
  const text = pendingMessage?.trim() || null;
  return {
    structuredText: text,
    seedOptimisticEcho: text !== null,
  };
}
/**
 * Whether the Stop button should show (a turn is actually in flight) — NOT
 * merely because the composer is blocked on a pending question.
 * `status==='running'` covers proxy lifecycle and `pending` covers the
 * structured in-flight window.
 */
export function isTurnRunning(status: SessionStatus, pending: boolean): boolean {
  return pending || status === 'running';
}

/** A session needs the user's attention when it is waiting for input, or when
 * its completed/failed turn has not been read yet. */
export function sessionNeedsAttention(
  session: Pick<Session, 'status' | 'unread'>,
): boolean {
  return session.status === 'pending'
    || ((session.status === 'done' || session.status === 'error') && session.unread === 1);
}

/** Apply a session:updated payload to the active-only client collection. */
export function applySessionUpdate(
  sessions: Session[],
  update: Pick<Session, 'id'> & Partial<Session>,
): Session[] {
  if (update.archived === 1) {
    return sessions.filter(session => session.id !== update.id);
  }

  const existing = sessions.findIndex(session => session.id === update.id);
  if (existing >= 0) {
    return sessions.map(session => session.id === update.id
      ? { ...session, ...update }
      : session);
  }

  // An unarchive broadcast carries a complete Session because the archived
  // row was not present in the initial active-only state sync.
  if (
    update.archived === 0
    && update.workspace_id !== undefined
    && update.executor !== undefined
    && update.type !== undefined
    && update.created_at !== undefined
  ) {
    return [update as Session, ...sessions];
  }

  return sessions;
}

/** Sidebar rail ordering inside one workspace group: pinned first
 *  (most-recently-pinned first), then by last activity. */
export function sortSessionsForRail<T extends Pick<Session, 'pinned_at' | 'updated_at'>>(
  sessions: T[],
): T[] {
  return sessions.slice().sort((a, b) => {
    const ap = a.pinned_at ? 1 : 0;
    const bp = b.pinned_at ? 1 : 0;
    if (ap !== bp) return bp - ap;
    if (a.pinned_at && b.pinned_at) return Date.parse(b.pinned_at) - Date.parse(a.pinned_at);
    return Date.parse(b.updated_at) - Date.parse(a.updated_at);
  });
}

/** Sidebar rail ordering for workspace groups: pinned first, stable within
 *  each pinned/unpinned group (host `sort_order` is the incoming order). */
export function sortWorkspacesForRail<T extends { pinned: 0 | 1 }>(workspaces: T[]): T[] {
  return workspaces.slice().sort((a, b) => b.pinned - a.pinned);
}

/** Sidebar rail sections (Codex-style, 2026-08-03): pinned content lives in a
 *  dedicated "Pinned" section above "Projects". A pinned SESSION becomes a
 *  standalone row in Pinned (it leaves its workspace group); a pinned
 *  WORKSPACE moves its whole group (header + its unpinned sessions) into
 *  Pinned. Everything else stays grouped by workspace under Projects.
 *  Sessions of a HIDDEN workspace (2026-08-06) no longer vanish from the
 *  rail: they collect in the bottom 无归属 (Unfiled) group so they stay
 *  reachable — e.g. before deleting the workspace, which refuses while any
 *  session still references it. */
export interface RailSections<T> {
  /** Standalone pinned session rows, most-recently-pinned first. */
  pinnedSessions: T[];
  /** Unpinned sessions grouped by workspace_id (each list rail-sorted). */
  byWs: Map<string, T[]>;
  /** Pinned workspace ids that have visible sessions, in host order. */
  pinnedWsIds: string[];
  /** Unpinned workspace ids that have visible sessions, in host order
   *  (orphan ids — sessions whose workspace isn't in the list — appended). */
  projectWsIds: string[];
  /** Unpinned sessions whose workspace is hidden — or gone (NULL after the
   *  workspace was deleted, migration 045) — rail-sorted. */
  unfiled: T[];
  /** False when nothing is pinned — the rail then renders without section
   *  labels, exactly like the pre-sections layout. */
  hasPinned: boolean;
}

export function buildRailSections<T extends Pick<Session, 'workspace_id' | 'pinned_at' | 'updated_at'>>(
  sessions: T[],
  workspaces: Array<{ id: string; pinned: 0 | 1; hidden?: 0 | 1 }>,
): RailSections<T> {
  const hiddenWsIds = new Set(workspaces.filter(w => w.hidden === 1).map(w => w.id));
  const pinnedSessions = sortSessionsForRail(sessions.filter(s => s.pinned_at != null));
  const byWs = new Map<string, T[]>();
  const unfiled: T[] = [];
  for (const s of sessions) {
    if (s.pinned_at != null) continue;
    // NULL workspace_id (workspace deleted → ON DELETE SET NULL) and hidden
    // workspaces both land in 无归属 (Unfiled).
    if (s.workspace_id == null || hiddenWsIds.has(s.workspace_id)) {
      unfiled.push(s);
      continue;
    }
    const list = byWs.get(s.workspace_id) ?? [];
    list.push(s);
    byWs.set(s.workspace_id, list);
  }
  for (const [id, list] of byWs) byWs.set(id, sortSessionsForRail(list));
  const sortedUnfiled = sortSessionsForRail(unfiled);
  const pinnedWsIds: string[] = [];
  const projectWsIds: string[] = [];
  const seen = new Set<string>();
  for (const w of workspaces) {
    if (!byWs.has(w.id)) continue;
    seen.add(w.id);
    (w.pinned === 1 ? pinnedWsIds : projectWsIds).push(w.id);
  }
  for (const wsId of byWs.keys()) {
    if (!seen.has(wsId)) projectWsIds.push(wsId);
  }
  return {
    pinnedSessions,
    byWs,
    pinnedWsIds,
    projectWsIds,
    unfiled: sortedUnfiled,
    hasPinned: pinnedSessions.length > 0 || pinnedWsIds.length > 0,
  };
}
