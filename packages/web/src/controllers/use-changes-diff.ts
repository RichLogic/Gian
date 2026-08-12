/**
 * Diffs rail — panel-2 multi-diff view-state controller.
 *
 * The Changes inspector unmounts whenever the rail collapses or another rail
 * opens, but its state must survive both that and session/worktree switches:
 * the scope selection (lifted out of the inspector), the changed-file list,
 * per-file patch cache, per-file collapse state and the anchor-jump request
 * are all keyed by workingTreeId in this module-level store — same pattern as
 * controllers/use-history.ts, and likewise never shared across trees.
 *
 * Components read via `useChangesDiffState(workingTreeId)`
 * (useSyncExternalStore) and mutate through the actions below; all fetches go
 * through the frozen Web API client in `api.ts`.
 */
import { useCallback, useSyncExternalStore } from 'react';
import {
  loadChanged,
  loadBranchList,
  loadDiff,
  type BranchList,
  type ChangedEntry,
  type ChangeScope,
} from '../api.js';

export interface ChangesDiffPatch {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  diff: string | null;
  truncated: boolean;
}

export interface ChangesDiffAnchor {
  path: string;
  requestId: number;
}

export interface ChangesDiffState {
  // ── Scope (lifted from the Changes inspector) ──
  scope: ChangeScope;
  /** Pinned commit for the `commit` scope (null = HEAD's delta). */
  commitSha: string | null;
  /** Explicit compare base for the `branch` scope (null = remote default). */
  baseBranch: string | null;
  /** Host-resolved default plus the refs offered by the Branch picker. */
  branchList: BranchList | null;
  /** Exact session+turn a transcript entry pinned for the `lastturn` scope. */
  lastTurn: { sessionId: string; turn: number } | null;
  /** Active session forwarded by the inspector — the lastturn fallback for
   *  `ws:`/`ext:` trees that carry no session of their own. */
  sessionId: string | null;
  // ── Changed-file list for the current scope ──
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  files: ChangedEntry[];
  // ── Per-file patches, keyed by path; dropped on any scope-identity change ──
  patches: Record<string, ChangesDiffPatch>;
  // ── Collapse state, keyed by path; survives scope switches and refreshes ──
  collapsed: Record<string, boolean>;
  // ── One-shot "jump to this file's block" request (inspector row click) ──
  anchor: ChangesDiffAnchor | null;
}

const SCOPES: readonly ChangeScope[] = ['all', 'unstaged', 'staged', 'commit', 'branch', 'lastturn'];

function initialState(workingTreeId: string): ChangesDiffState {
  let scope: ChangeScope = 'branch';
  try {
    const stored = localStorage.getItem('gian.changes.scope');
    if (stored && (SCOPES as readonly string[]).includes(stored)) scope = stored as ChangeScope;
  } catch { /* storage disabled */ }
  // The compare base is remembered per working tree (it answers "where did
  // THIS tree's branch come from", which differs across trees).
  let baseBranch: string | null = null;
  try {
    baseBranch = localStorage.getItem(`gian.changes.base.${workingTreeId}`);
  } catch { /* storage disabled */ }
  return {
    scope,
    commitSha: null,
    baseBranch,
    branchList: null,
    lastTurn: null,
    sessionId: null,
    status: 'idle',
    error: null,
    files: [],
    patches: {},
    collapsed: {},
    anchor: null,
  };
}

const states = new Map<string, ChangesDiffState>();
/** Monotonic file-list request sequence per tree — late responses lose. */
const requestSeq = new Map<string, number>();
const anchorSeq = new Map<string, number>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeChangesDiff(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getChangesDiffState(workingTreeId: string): ChangesDiffState {
  let state = states.get(workingTreeId);
  if (!state) {
    state = initialState(workingTreeId);
    states.set(workingTreeId, state);
  }
  return state;
}

function patch(workingTreeId: string, partial: Partial<ChangesDiffState>): void {
  states.set(workingTreeId, { ...getChangesDiffState(workingTreeId), ...partial });
  emit();
}

/** React binding — one subscription for every tree, snapshot per tree. */
export function useChangesDiffState(workingTreeId: string | null): ChangesDiffState {
  const getSnapshot = useCallback(
    () => (workingTreeId ? getChangesDiffState(workingTreeId) : IDLE_STATE),
    [workingTreeId],
  );
  return useSyncExternalStore(subscribeChangesDiff, getSnapshot);
}

const IDLE_STATE: ChangesDiffState = {
  scope: 'branch',
  commitSha: null,
  baseBranch: null,
  branchList: null,
  lastTurn: null,
  sessionId: null,
  status: 'idle',
  error: null,
  files: [],
  patches: {},
  collapsed: {},
  anchor: null,
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Identity of the comparison the current scope describes. Any change drops
 *  every cached patch — the same path under another scope/commit/base/turn is
 *  a different diff. */
function scopeKeyOf(state: ChangesDiffState): string {
  const lt = state.lastTurn;
  return [
    state.scope,
    state.commitSha ?? '',
    state.baseBranch ?? '',
    lt ? `${lt.sessionId}:${lt.turn}` : '',
  ].join('|');
}

/** Apply a scope-identity change, resetting the patch cache when the
 *  comparison actually changed. Never touches collapse state. */
function patchScope(
  workingTreeId: string,
  partial: Partial<Pick<ChangesDiffState, 'scope' | 'commitSha' | 'baseBranch' | 'lastTurn'>>,
): void {
  const state = getChangesDiffState(workingTreeId);
  const changed = scopeKeyOf({ ...state, ...partial }) !== scopeKeyOf(state);
  states.set(workingTreeId, {
    ...state,
    ...partial,
    patches: changed ? {} : state.patches,
  });
  emit();
}

/** (Re)load the changed-file list for the state's current scope. */
export async function reloadChangesDiffFiles(workingTreeId: string): Promise<void> {
  const state = getChangesDiffState(workingTreeId);
  const seq = (requestSeq.get(workingTreeId) ?? 0) + 1;
  requestSeq.set(workingTreeId, seq);
  patch(workingTreeId, { status: 'loading', error: null });
  try {
    const [files, branchList] = await Promise.all([
      loadChanged(
        workingTreeId,
        state.scope,
        state.commitSha,
        state.baseBranch,
        state.scope === 'lastturn'
          ? state.lastTurn?.sessionId ?? state.sessionId
          : state.sessionId,
        state.scope === 'lastturn' ? state.lastTurn?.turn : undefined,
      ),
      state.scope === 'branch'
        ? loadBranchList(workingTreeId)
        : Promise.resolve(state.branchList),
    ]);
    if (requestSeq.get(workingTreeId) !== seq) return;
    patch(workingTreeId, { status: 'ready', files, branchList });
  } catch (err) {
    if (requestSeq.get(workingTreeId) !== seq) return;
    patch(workingTreeId, { status: 'error', error: errorMessage(err) });
  }
}

/** Lazy entry: load the list only when this tree has never loaded. */
export function ensureChangesDiffLoaded(workingTreeId: string): void {
  if (getChangesDiffState(workingTreeId).status !== 'idle') return;
  void reloadChangesDiffFiles(workingTreeId);
}

/** Refresh (button, stage/unstage settle): re-read the list, keep collapse
 *  state, and silently mark loaded patches stale — expanded/visible blocks
 *  lazily refetch, errored blocks keep their error + retry. */
export function refreshChangesDiff(workingTreeId: string): void {
  const state = getChangesDiffState(workingTreeId);
  const patches: Record<string, ChangesDiffPatch> = {};
  for (const [path, p] of Object.entries(state.patches)) {
    patches[path] = p.status === 'loaded' ? { status: 'idle', diff: null, truncated: false } : p;
  }
  patch(workingTreeId, { patches });
  void reloadChangesDiffFiles(workingTreeId);
}

/** The host's `workspace:git-updated` broadcast is workspace-scoped while this
 *  store is tree-scoped and doesn't track workspace membership — refresh every
 *  tree that has ever loaded (in practice only the viewed tree holds state).
 *  Idle trees stay lazy. */
export function invalidateAllChangesDiffs(): void {
  for (const [workingTreeId, state] of states) {
    if (state.status !== 'idle') refreshChangesDiff(workingTreeId);
  }
}

/** Scope picker selection (inspector). Clears the pinned last-turn target and,
 *  outside the commit scope, the pinned commit — same rules the inspector's
 *  local pickScope enforced. */
export function setChangesDiffScope(workingTreeId: string, scope: ChangeScope): void {
  const state = getChangesDiffState(workingTreeId);
  patchScope(workingTreeId, {
    scope,
    lastTurn: null,
    commitSha: scope === 'commit' ? state.commitSha : null,
  });
  try { localStorage.setItem('gian.changes.scope', scope); } catch { /* storage disabled */ }
  void reloadChangesDiffFiles(workingTreeId);
}

/** Pin (or unpin, null = latest commit) the Committed scope's commit. */
export function setChangesDiffCommit(workingTreeId: string, sha: string | null): void {
  patchScope(workingTreeId, { commitSha: sha });
  void reloadChangesDiffFiles(workingTreeId);
}

/** Pin (or unpin, null = remote default) the Branch scope's compare base. */
export function setChangesDiffBase(workingTreeId: string, base: string | null): void {
  patchScope(workingTreeId, { baseBranch: base });
  try {
    const key = `gian.changes.base.${workingTreeId}`;
    if (base) localStorage.setItem(key, base); else localStorage.removeItem(key);
  } catch { /* storage disabled */ }
  void reloadChangesDiffFiles(workingTreeId);
}

/** External scope request (GitBadge click → All changes, transcript entries →
 *  Last turn with its exact session+turn). Replaces the inspector's old
 *  `scopeRequest` prop: App writes the store directly. */
export function applyChangesScopeRequest(
  workingTreeId: string,
  scope: ChangeScope,
  target?: { sessionId: string; turn: number },
): void {
  patchScope(workingTreeId, {
    scope,
    commitSha: null,
    lastTurn: scope === 'lastturn' && target ? { sessionId: target.sessionId, turn: target.turn } : null,
  });
  try { localStorage.setItem('gian.changes.scope', scope); } catch { /* storage disabled */ }
  void reloadChangesDiffFiles(workingTreeId);
}

/** The inspector forwards the active session so the lastturn scope can fall
 *  back to it. Only lastturn queries carry a session, so only they refetch. */
export function setChangesDiffSession(workingTreeId: string, sessionId: string | null): void {
  const state = getChangesDiffState(workingTreeId);
  if (state.sessionId === sessionId) return;
  patch(workingTreeId, { sessionId });
  if (state.scope === 'lastturn' && !state.lastTurn) {
    void reloadChangesDiffFiles(workingTreeId);
  }
}

// ─── Per-file patches ───────────────────────────────────────────────────────

function setPatch(workingTreeId: string, path: string, next: ChangesDiffPatch): void {
  const state = getChangesDiffState(workingTreeId);
  patch(workingTreeId, { patches: { ...state.patches, [path]: next } });
}

async function loadPatch(workingTreeId: string, path: string): Promise<void> {
  const state = getChangesDiffState(workingTreeId);
  const scopeKey = scopeKeyOf(state);
  setPatch(workingTreeId, path, { status: 'loading', diff: null, truncated: false });
  try {
    const result = state.scope === 'lastturn'
      ? await loadDiff(
          workingTreeId,
          path,
          state.scope,
          state.commitSha,
          state.baseBranch,
          state.lastTurn?.sessionId ?? state.sessionId,
          state.lastTurn?.turn,
        )
      : await loadDiff(
          workingTreeId,
          path,
          state.scope,
          state.commitSha,
          state.baseBranch,
        );
    // A scope switch mid-flight dropped this patch — the late result must not
    // resurrect it under the new comparison.
    if (scopeKeyOf(getChangesDiffState(workingTreeId)) !== scopeKey) return;
    setPatch(workingTreeId, path, { status: 'loaded', diff: result.diff, truncated: result.truncated });
  } catch {
    if (scopeKeyOf(getChangesDiffState(workingTreeId)) !== scopeKey) return;
    setPatch(workingTreeId, path, { status: 'error', diff: null, truncated: false });
  }
}

/** Lazy per-file load (IntersectionObserver / expand). No-op while a load for
 *  the path is in flight or already loaded — the caller's IO may fire twice. */
export function ensureChangesDiffPatch(workingTreeId: string, path: string): void {
  const current = getChangesDiffState(workingTreeId).patches[path];
  if (current && current.status !== 'idle') return;
  void loadPatch(workingTreeId, path);
}

/** Error-state retry: force a reload even if a patch object exists. */
export function retryChangesDiffPatch(workingTreeId: string, path: string): void {
  void loadPatch(workingTreeId, path);
}

// ─── Collapse state ─────────────────────────────────────────────────────────

export function toggleChangesDiffCollapsed(workingTreeId: string, path: string): void {
  const state = getChangesDiffState(workingTreeId);
  patch(workingTreeId, {
    collapsed: { ...state.collapsed, [path]: !(state.collapsed[path] ?? false) },
  });
}

/** Toolbar collapse-all/expand-all over the CURRENT file list. */
export function setAllChangesDiffCollapsed(workingTreeId: string, collapse: boolean): void {
  const state = getChangesDiffState(workingTreeId);
  const collapsed: Record<string, boolean> = {};
  if (collapse) for (const file of state.files) collapsed[file.path] = true;
  patch(workingTreeId, { collapsed });
}

// ─── Anchor (inspector row click → jump to the file's block in panel 2) ─────

/** Request a jump: expand the file's block and ask the mounted
 *  ChangesDiffBody to scroll it into view (again after the patch loads). */
export function requestChangesDiffAnchor(workingTreeId: string, path: string): void {
  const state = getChangesDiffState(workingTreeId);
  const requestId = (anchorSeq.get(workingTreeId) ?? 0) + 1;
  anchorSeq.set(workingTreeId, requestId);
  states.set(workingTreeId, {
    ...state,
    anchor: { path, requestId },
    collapsed: { ...state.collapsed, [path]: false },
  });
  emit();
}

/** The body consumes the slot so later, unrelated patch updates don't
 *  re-scroll — only this anchor's own load settle does. */
export function consumeChangesDiffAnchor(workingTreeId: string, requestId: number): void {
  const state = getChangesDiffState(workingTreeId);
  if (state.anchor?.requestId !== requestId) return;
  patch(workingTreeId, { anchor: null });
}

/** Test hook: the module-level store survives across tests in one file. */
export function __resetChangesDiffForTests(): void {
  states.clear();
  requestSeq.clear();
  anchorSeq.clear();
}
