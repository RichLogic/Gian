// Per-session persistence for the view-level working-tree override (the
// breadcrumb branch/worktree picker). The picker used to keep the choice in
// component state only, so a reload silently fell back to the workspace's
// primary checkout ("it reverts to main after a while", 2026-08-06). The
// override is view-only — execution cwd, terminal cwd, and file-mention stay
// bound to the session's own worktree — so localStorage is the right home.

const KEY_PREFIX = 'gian.wt.view.';

/** The wtId the user (or worktree auto-detect) last picked for this session,
 *  or null. Never throws — storage can be disabled. */
export function readWtViewOverride(sessionId: string): string | null {
  try {
    return localStorage.getItem(KEY_PREFIX + sessionId);
  } catch {
    return null;
  }
}

export function writeWtViewOverride(sessionId: string, wtId: string): void {
  try {
    localStorage.setItem(KEY_PREFIX + sessionId, wtId);
  } catch { /* storage disabled */ }
}

// Worktree auto-detect bookkeeping: the last detected path that was
// auto-applied for a session. Persisted so a page reload doesn't re-apply an
// old detection over a newer manual pick (the in-memory ref alone resets on
// reload); a genuinely NEW detection (different path) still auto-switches.
const AUTO_KEY_PREFIX = 'gian.wt.auto.';

export function readWtAutoApplied(sessionId: string): string | null {
  try {
    return localStorage.getItem(AUTO_KEY_PREFIX + sessionId);
  } catch {
    return null;
  }
}

export function writeWtAutoApplied(sessionId: string, detectedPath: string): void {
  try {
    localStorage.setItem(AUTO_KEY_PREFIX + sessionId, detectedPath);
  } catch { /* storage disabled */ }
}

/** Resolve which tree a session's views should show, in priority order:
 *  the in-memory pick for the active session, then the persisted override
 *  (only if that tree still exists — worktrees get deleted), then the
 *  session's own default. Pure so the precedence is unit-testable. */
export function resolveViewedTreeId(opts: {
  sessionId: string;
  inMemory: { sessionId: string; wtId: string } | null;
  stored: string | null;
  trees: ReadonlyArray<{ id: string }>;
  defaultId: string | null;
}): string | null {
  if (opts.inMemory && opts.inMemory.sessionId === opts.sessionId) return opts.inMemory.wtId;
  if (opts.stored && opts.trees.some(t => t.id === opts.stored)) return opts.stored;
  return opts.defaultId;
}
