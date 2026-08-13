/**
 * Diffs rail — panel-2 multi-diff view-state controller.
 *
 * The Changes inspector unmounts whenever the rail collapses or another rail
 * opens, but its state must survive both that and session/worktree switches:
 * the scope selection (lifted out of the inspector), the changed-file list,
 * per-file patch cache, per-file collapse state and the anchor-jump request
 * are keyed by {sessionId, workingTreeId} in this module-level store. The
 * working tree still selects the Git data source, while the Session key keeps
 * two conversations in one workspace from sharing scope, selection, collapse,
 * patch, or anchor state (Issue #46).
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
  // ── Panel-3 directory expansion, keyed by folder path ──
  folderOpen: Record<string, boolean>;
  // ── Panel scroll positions ──
  inspectorScrollTop: number;
  bodyScrollTop: number;
  // ── One-shot "jump to this file's block" request (inspector row click) ──
  anchor: ChangesDiffAnchor | null;
}

const SCOPES: readonly ChangeScope[] = ['all', 'unstaged', 'staged', 'commit', 'branch', 'lastturn'];

function stateKey(workingTreeId: string, ownerSessionId?: string | null): string {
  return JSON.stringify([ownerSessionId ?? null, workingTreeId]);
}

function scopeStorageKey(ownerSessionId?: string | null): string {
  return ownerSessionId
    ? `gian.changes.scope.${ownerSessionId}`
    : 'gian.changes.scope';
}

function baseStorageKey(workingTreeId: string, ownerSessionId?: string | null): string {
  return ownerSessionId
    ? `gian.changes.base.${ownerSessionId}.${workingTreeId}`
    : `gian.changes.base.${workingTreeId}`;
}

function initialState(
  workingTreeId: string,
  ownerSessionId?: string | null,
): ChangesDiffState {
  let scope: ChangeScope = 'branch';
  try {
    const stored = localStorage.getItem(scopeStorageKey(ownerSessionId));
    if (stored && (SCOPES as readonly string[]).includes(stored)) scope = stored as ChangeScope;
  } catch { /* storage disabled */ }
  // The compare base is remembered per working tree (it answers "where did
  // THIS tree's branch come from", which differs across trees).
  let baseBranch: string | null = null;
  try {
    baseBranch = localStorage.getItem(baseStorageKey(workingTreeId, ownerSessionId));
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
    folderOpen: {},
    inspectorScrollTop: 0,
    bodyScrollTop: 0,
    anchor: null,
  };
}

const states = new Map<string, ChangesDiffState>();
const owners = new Map<string, { workingTreeId: string; ownerSessionId: string | null }>();
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

export function getChangesDiffState(
  workingTreeId: string,
  ownerSessionId?: string | null,
): ChangesDiffState {
  const key = stateKey(workingTreeId, ownerSessionId);
  let state = states.get(key);
  if (!state) {
    state = initialState(workingTreeId, ownerSessionId);
    states.set(key, state);
    owners.set(key, { workingTreeId, ownerSessionId: ownerSessionId ?? null });
  }
  return state;
}

function patch(
  workingTreeId: string,
  partial: Partial<ChangesDiffState>,
  ownerSessionId?: string | null,
): void {
  const key = stateKey(workingTreeId, ownerSessionId);
  states.set(key, {
    ...getChangesDiffState(workingTreeId, ownerSessionId),
    ...partial,
  });
  emit();
}

/** React binding — one subscription for every Session/tree owner. */
export function useChangesDiffState(
  workingTreeId: string | null,
  ownerSessionId?: string | null,
): ChangesDiffState {
  const getSnapshot = useCallback(
    () => (workingTreeId
      ? getChangesDiffState(workingTreeId, ownerSessionId)
      : IDLE_STATE),
    [workingTreeId, ownerSessionId],
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
  folderOpen: {},
  inspectorScrollTop: 0,
  bodyScrollTop: 0,
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
  ownerSessionId?: string | null,
): void {
  const key = stateKey(workingTreeId, ownerSessionId);
  const state = getChangesDiffState(workingTreeId, ownerSessionId);
  const changed = scopeKeyOf({ ...state, ...partial }) !== scopeKeyOf(state);
  states.set(key, {
    ...state,
    ...partial,
    patches: changed ? {} : state.patches,
  });
  emit();
}

/** (Re)load the changed-file list for the state's current scope. */
export async function reloadChangesDiffFiles(
  workingTreeId: string,
  ownerSessionId?: string | null,
): Promise<void> {
  const key = stateKey(workingTreeId, ownerSessionId);
  const state = getChangesDiffState(workingTreeId, ownerSessionId);
  const seq = (requestSeq.get(key) ?? 0) + 1;
  requestSeq.set(key, seq);
  patch(workingTreeId, { status: 'loading', error: null }, ownerSessionId);
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
    if (requestSeq.get(key) !== seq) return;
    patch(workingTreeId, { status: 'ready', files, branchList }, ownerSessionId);
  } catch (err) {
    if (requestSeq.get(key) !== seq) return;
    patch(workingTreeId, { status: 'error', error: errorMessage(err) }, ownerSessionId);
  }
}

/** Lazy entry: load the list only when this tree has never loaded. */
export function ensureChangesDiffLoaded(
  workingTreeId: string,
  ownerSessionId?: string | null,
): void {
  if (getChangesDiffState(workingTreeId, ownerSessionId).status !== 'idle') return;
  void reloadChangesDiffFiles(workingTreeId, ownerSessionId);
}

/** Refresh (button, stage/unstage settle): re-read the list, keep collapse
 *  state, and silently mark loaded patches stale — expanded/visible blocks
 *  lazily refetch, errored blocks keep their error + retry. */
export function refreshChangesDiff(
  workingTreeId: string,
  ownerSessionId?: string | null,
): void {
  const state = getChangesDiffState(workingTreeId, ownerSessionId);
  const patches: Record<string, ChangesDiffPatch> = {};
  for (const [path, p] of Object.entries(state.patches)) {
    patches[path] = p.status === 'loaded' ? { status: 'idle', diff: null, truncated: false } : p;
  }
  patch(workingTreeId, { patches }, ownerSessionId);
  void reloadChangesDiffFiles(workingTreeId, ownerSessionId);
}

/** The host's `workspace:git-updated` broadcast is workspace-scoped while this
 *  store is tree-scoped and doesn't track workspace membership — refresh every
 *  tree that has ever loaded (in practice only the viewed tree holds state).
 *  Idle trees stay lazy. */
export function invalidateAllChangesDiffs(): void {
  for (const [key, state] of states) {
    const owner = owners.get(key);
    if (owner && state.status !== 'idle') {
      refreshChangesDiff(owner.workingTreeId, owner.ownerSessionId);
    }
  }
}

/** Scope picker selection (inspector). Clears the pinned last-turn target and,
 *  outside the commit scope, the pinned commit — same rules the inspector's
 *  local pickScope enforced. */
export function setChangesDiffScope(
  workingTreeId: string,
  scope: ChangeScope,
  ownerSessionId?: string | null,
): void {
  const state = getChangesDiffState(workingTreeId, ownerSessionId);
  patchScope(workingTreeId, {
    scope,
    lastTurn: null,
    commitSha: scope === 'commit' ? state.commitSha : null,
  }, ownerSessionId);
  try { localStorage.setItem(scopeStorageKey(ownerSessionId), scope); } catch { /* storage disabled */ }
  void reloadChangesDiffFiles(workingTreeId, ownerSessionId);
}

/** Pin (or unpin, null = latest commit) the Committed scope's commit. */
export function setChangesDiffCommit(
  workingTreeId: string,
  sha: string | null,
  ownerSessionId?: string | null,
): void {
  patchScope(workingTreeId, { commitSha: sha }, ownerSessionId);
  void reloadChangesDiffFiles(workingTreeId, ownerSessionId);
}

/** Pin (or unpin, null = remote default) the Branch scope's compare base. */
export function setChangesDiffBase(
  workingTreeId: string,
  base: string | null,
  ownerSessionId?: string | null,
): void {
  patchScope(workingTreeId, { baseBranch: base }, ownerSessionId);
  try {
    const key = baseStorageKey(workingTreeId, ownerSessionId);
    if (base) localStorage.setItem(key, base); else localStorage.removeItem(key);
  } catch { /* storage disabled */ }
  void reloadChangesDiffFiles(workingTreeId, ownerSessionId);
}

/** External scope request (GitBadge click → All changes, transcript entries →
 *  Last turn with its exact session+turn). Replaces the inspector's old
 *  `scopeRequest` prop: App writes the store directly. */
export function applyChangesScopeRequest(
  workingTreeId: string,
  scope: ChangeScope,
  target?: { sessionId: string; turn: number },
  ownerSessionId?: string | null,
): void {
  patchScope(workingTreeId, {
    scope,
    commitSha: null,
    lastTurn: scope === 'lastturn' && target ? { sessionId: target.sessionId, turn: target.turn } : null,
  }, ownerSessionId);
  try { localStorage.setItem(scopeStorageKey(ownerSessionId), scope); } catch { /* storage disabled */ }
  void reloadChangesDiffFiles(workingTreeId, ownerSessionId);
}

/** The inspector forwards the active session so the lastturn scope can fall
 *  back to it. Only lastturn queries carry a session, so only they refetch. */
export function setChangesDiffSession(
  workingTreeId: string,
  sessionId: string | null,
  ownerSessionId?: string | null,
): void {
  const state = getChangesDiffState(workingTreeId, ownerSessionId);
  if (state.sessionId === sessionId) return;
  patch(workingTreeId, { sessionId }, ownerSessionId);
  if (state.scope === 'lastturn' && !state.lastTurn) {
    void reloadChangesDiffFiles(workingTreeId, ownerSessionId);
  }
}

// ─── Per-file patches ───────────────────────────────────────────────────────

function setPatch(
  workingTreeId: string,
  path: string,
  next: ChangesDiffPatch,
  ownerSessionId?: string | null,
): void {
  const state = getChangesDiffState(workingTreeId, ownerSessionId);
  patch(workingTreeId, { patches: { ...state.patches, [path]: next } }, ownerSessionId);
}

async function loadPatch(
  workingTreeId: string,
  path: string,
  ownerSessionId?: string | null,
): Promise<void> {
  const state = getChangesDiffState(workingTreeId, ownerSessionId);
  const scopeKey = scopeKeyOf(state);
  setPatch(
    workingTreeId,
    path,
    { status: 'loading', diff: null, truncated: false },
    ownerSessionId,
  );
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
    if (scopeKeyOf(getChangesDiffState(workingTreeId, ownerSessionId)) !== scopeKey) return;
    setPatch(
      workingTreeId,
      path,
      { status: 'loaded', diff: result.diff, truncated: result.truncated },
      ownerSessionId,
    );
  } catch {
    if (scopeKeyOf(getChangesDiffState(workingTreeId, ownerSessionId)) !== scopeKey) return;
    setPatch(
      workingTreeId,
      path,
      { status: 'error', diff: null, truncated: false },
      ownerSessionId,
    );
  }
}

/** Lazy per-file load (IntersectionObserver / expand). No-op while a load for
 *  the path is in flight or already loaded — the caller's IO may fire twice. */
export function ensureChangesDiffPatch(
  workingTreeId: string,
  path: string,
  ownerSessionId?: string | null,
): void {
  const current = getChangesDiffState(workingTreeId, ownerSessionId).patches[path];
  if (current && current.status !== 'idle') return;
  void loadPatch(workingTreeId, path, ownerSessionId);
}

/** Error-state retry: force a reload even if a patch object exists. */
export function retryChangesDiffPatch(
  workingTreeId: string,
  path: string,
  ownerSessionId?: string | null,
): void {
  void loadPatch(workingTreeId, path, ownerSessionId);
}

// ─── Collapse state ─────────────────────────────────────────────────────────

export function toggleChangesDiffCollapsed(
  workingTreeId: string,
  path: string,
  ownerSessionId?: string | null,
): void {
  const state = getChangesDiffState(workingTreeId, ownerSessionId);
  patch(workingTreeId, {
    collapsed: { ...state.collapsed, [path]: !(state.collapsed[path] ?? false) },
  }, ownerSessionId);
}

/** Toolbar collapse-all/expand-all over the CURRENT file list. */
export function setAllChangesDiffCollapsed(
  workingTreeId: string,
  collapse: boolean,
  ownerSessionId?: string | null,
): void {
  const state = getChangesDiffState(workingTreeId, ownerSessionId);
  const collapsed: Record<string, boolean> = {};
  if (collapse) for (const file of state.files) collapsed[file.path] = true;
  patch(workingTreeId, { collapsed }, ownerSessionId);
}

/** Panel-3 changed-file tree folders default open, then remember expansion
 *  independently for every Session/tree owner. */
export function toggleChangesFolder(
  workingTreeId: string,
  path: string,
  ownerSessionId?: string | null,
): void {
  const state = getChangesDiffState(workingTreeId, ownerSessionId);
  const open = state.folderOpen[path] ?? true;
  patch(workingTreeId, {
    folderOpen: { ...state.folderOpen, [path]: !open },
  }, ownerSessionId);
}

export function saveChangesInspectorScroll(
  workingTreeId: string,
  scrollTop: number,
  ownerSessionId?: string | null,
): void {
  const key = stateKey(workingTreeId, ownerSessionId);
  states.set(key, { ...getChangesDiffState(workingTreeId, ownerSessionId), inspectorScrollTop: scrollTop });
}

export function saveChangesBodyScroll(
  workingTreeId: string,
  scrollTop: number,
  ownerSessionId?: string | null,
): void {
  const key = stateKey(workingTreeId, ownerSessionId);
  states.set(key, { ...getChangesDiffState(workingTreeId, ownerSessionId), bodyScrollTop: scrollTop });
}

// ─── Anchor (inspector row click → jump to the file's block in panel 2) ─────

/** Request a jump: expand the file's block and ask the mounted
 *  ChangesDiffBody to scroll it into view (again after the patch loads). */
export function requestChangesDiffAnchor(
  workingTreeId: string,
  path: string,
  ownerSessionId?: string | null,
): void {
  const key = stateKey(workingTreeId, ownerSessionId);
  const state = getChangesDiffState(workingTreeId, ownerSessionId);
  const requestId = (anchorSeq.get(key) ?? 0) + 1;
  anchorSeq.set(key, requestId);
  states.set(key, {
    ...state,
    anchor: { path, requestId },
    collapsed: { ...state.collapsed, [path]: false },
  });
  emit();
}

/** The body consumes the slot so later, unrelated patch updates don't
 *  re-scroll — only this anchor's own load settle does. */
export function consumeChangesDiffAnchor(
  workingTreeId: string,
  requestId: number,
  ownerSessionId?: string | null,
): void {
  const state = getChangesDiffState(workingTreeId, ownerSessionId);
  if (state.anchor?.requestId !== requestId) return;
  patch(workingTreeId, { anchor: null }, ownerSessionId);
}

/** Test hook: the module-level store survives across tests in one file. */
export function __resetChangesDiffForTests(): void {
  states.clear();
  owners.clear();
  requestSeq.clear();
  anchorSeq.clear();
}
