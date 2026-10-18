/**
 * Inbox read model (Issue #53 / 0.6.7). A module-level store (same shape as
 * controllers/schedule-confirmations.ts) so the pending badge and panel state
 * survive view switches and ride the existing WS reconnect cycle.
 *
 * Hydration: `state_sync.inbox` (pending items + authoritative pending_count
 * + inbox_revision) seeds the store on every (re)connect; live
 * `inbox:changed` frames upsert one row; a bulk `inbox:invalidated`, a stale
 * generation conflict, or a missing snapshot field re-pulls via REST.
 *
 * Freshness rules (review 2026-10-12, round 2):
 * - `highWater` is a persistent per-item (revision, generation) ratchet. It
 *   survives snapshot/page replacement, so a late mutation response for an
 *   older generation can never resurrect an item that a newer frame or
 *   snapshot already moved on from — even when the newer snapshot no longer
 *   contains the row at all.
 * - The collection revision (`inbox_revision`) only moves with sources that
 *   carry one: sync snapshots, WS frames, and list pages. A read/unread
 *   mutation response has no collection revision and never moves it.
 * - Accepted writes (snapshot, fresh frame, mutation result) bump the write
 *   token AND clear the busy flags of the in-flight reads they invalidate,
 *   so a discarded refresh can neither overwrite newer state nor leave the
 *   store spinning forever (load-more stays reachable).
 * - Count, rows and revision come from ONE list-page transaction (InboxPage
 *   carries pending_count + inbox_revision).
 * - On a truncated pending window the membership of an unknown id is
 *   unknowable: the row is shown but the authoritative count is re-pulled
 *   rather than guessed from the partial set. On a complete window an
 *   unknown pending row is genuinely new; writing its membership first keeps
 *   the later WS frame for the same row idempotent.
 *
 * The topbar badge counts PENDING work, never unread. Opening the panel or
 * the list never marks anything read; only opening a specific item does
 * (exact generation, enforced Host-side with a 409 `stale` fence).
 */
import type { InboxItemPublic, InboxSyncSnapshot } from '@gian/shared';
import { InboxApiError, loadInboxPage } from '../api.js';
import { markInboxRead, markInboxUnread, skipInboxVersion } from '../operations/inbox.js';

export interface InboxState {
  /** True once a sync snapshot or a REST page landed. */
  hydrated: boolean;
  /** Pending (unresolved) item count — the topbar badge. */
  pendingCount: number;
  inboxRevision: number;
  /** Pending items, newest first; may be capped (see `truncated`). */
  pendingItems: InboxItemPublic[];
  /** Cursor for the next pending page; null when the window came from the
   *  cursor-less sync snapshot (load-more then restarts via REST). */
  pendingNextCursor: string | null;
  /** True while the pending window is known to be incomplete. */
  truncated: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  /** The last refresh/page load failed. Last known-good rows are retained;
   *  the panel surfaces a retry instead of a fake empty list. */
  error: boolean;
}

const initialState: InboxState = {
  hydrated: false,
  pendingCount: 0,
  inboxRevision: 0,
  pendingItems: [],
  pendingNextCursor: null,
  truncated: false,
  refreshing: false,
  loadingMore: false,
  error: false,
};

let state: InboxState = initialState;
const listeners = new Set<() => void>();
/** Persistent per-item write fence: the newest (revision, generation) ever
 *  accepted, plus the accepted row itself. Ratchet-only; snapshot/page
 *  replacement must not shrink it. The row is kept so a contradictory
 *  collection write can be reconciled onto the newer evidence (and
 *  re-pulled) instead of flashing the older row. */
let highWater = new Map<string, { revision: number; generation: number; item: InboxItemPublic }>();
/** Membership in the current pending window. Complete windows hold every
 *  pending id; truncated windows hold only the loaded ones. */
let knownPending = new Set<string>();
/** Latest-writer token: any accepted write invalidates in-flight reads. */
let writeToken = 0;

function set(next: InboxState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeInbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getInboxSnapshot(): InboxState {
  return state;
}

/** An accepted write supersedes every in-flight read: bump the token AND
 *  retire its busy flags — the discarded read will not write, so nothing
 *  else ever clears them. */
function noteAcceptedWrite(): void {
  writeToken += 1;
  if (state.refreshing || state.loadingMore) {
    set({ ...state, refreshing: false, loadingMore: false });
  }
}

/** Ratchet the per-item fence — never lower it, not even from a canonical
 *  snapshot/page (the fence's whole job is to outlive collection writes so a
 *  late stale mutation response stays fenced). */
function ratchet(item: InboxItemPublic): void {
  const fence = highWater.get(item.id);
  if (!fence || item.revision > fence.revision
    || (item.revision === fence.revision && item.generation > fence.generation)) {
    highWater.set(item.id, { revision: item.revision, generation: item.generation, item });
  }
}

/** True when the row contradicts the accepted per-item evidence. */
function contradictedByFence(item: InboxItemPublic): boolean {
  const fence = highWater.get(item.id);
  return !!fence && (item.revision < fence.revision
    || (item.revision === fence.revision && item.generation < fence.generation));
}

/** A snapshot/page built BEFORE an already-accepted mutation would flash the
 *  older row: reconcile the affected rows onto the accepted evidence.
 *  Terminal evidence also drops the row from the pending list — known-closed
 *  beats the collection's older membership. The authoritative count is kept
 *  as-is and a re-pull follows (the Host already applied the mutation, so
 *  the re-pull converges). */
function reconcileRows(rows: InboxItemPublic[]): { rows: InboxItemPublic[]; contradicted: boolean } {
  let contradicted = false;
  const out: InboxItemPublic[] = [];
  for (const row of rows) {
    const fence = highWater.get(row.id);
    const stale = !!fence && (row.revision < fence.revision
      || (row.revision === fence.revision && row.generation < fence.generation));
    const effective = stale ? fence!.item : row;
    if (stale) contradicted = true;
    if (effective.status !== 'pending') {
      // Closed elsewhere — never render as pending.
      if (!stale || effective !== row) contradicted = true;
      continue;
    }
    out.push(effective);
  }
  return { rows: out, contradicted };
}

/** Row-level application shared by WS frames, mutation responses and detail
 *  re-reads. `applied` is false when the per-item fence rejected the row as
 *  stale; `needsCountRefresh` when the pending window is truncated and the
 *  row's previous membership is unknowable — the caller must re-pull the
 *  authoritative count rather than guess a delta. */
function applyRow(item: InboxItemPublic, collectionRevision?: number): { applied: boolean; needsCountRefresh: boolean } {
  if (contradictedByFence(item)) {
    return { applied: false, needsCountRefresh: false };
  }
  ratchet(item);
  const wasPending = knownPending.has(item.id);
  const isPending = item.status === 'pending';
  if (isPending) knownPending.add(item.id);
  else knownPending.delete(item.id);
  let pendingCount = state.pendingCount;
  let unknownMembership = false;
  if (!wasPending && isPending) {
    if (state.truncated) unknownMembership = true;
    else pendingCount += 1;
  } else if (wasPending && !isPending) {
    pendingCount -= 1;
  } else if (!wasPending && !isPending && state.truncated) {
    // Unknown terminal row on a truncated window: it may have been an
    // unloaded pending item closing — the count cannot be derived locally.
    unknownMembership = true;
  }
  const index = state.pendingItems.findIndex(entry => entry.id === item.id);
  let pendingItems = state.pendingItems;
  if (isPending) {
    pendingItems = index === -1
      ? [item, ...state.pendingItems]
      : state.pendingItems.map(entry => (entry.id === item.id ? item : entry));
  } else if (index !== -1) {
    pendingItems = state.pendingItems.filter(entry => entry.id !== item.id);
  }
  set({
    ...state,
    pendingCount,
    pendingItems,
    ...(collectionRevision !== undefined ? { inboxRevision: collectionRevision } : {}),
  });
  return { applied: true, needsCountRefresh: unknownMembership };
}

/** state_sync.inbox is the reconnect authority: a pending snapshot (possibly
 *  Host-capped) with the authoritative count and revision. A snapshot older
 *  than the collection revision we already hold is stale — dropped wholesale.
 *  Applying a fresh one invalidates in-flight reads. The high-water fence is
 *  ratcheted, never lowered, and rows absent from the snapshot keep their
 *  fence evidence. */
export function applyInboxSyncSnapshot(snapshot: InboxSyncSnapshot): void {
  if (state.hydrated && snapshot.inbox_revision < state.inboxRevision) return;
  noteAcceptedWrite();
  for (const item of snapshot.items) ratchet(item);
  // A snapshot built before an already-accepted mutation contradicts the
  // per-item evidence: reconcile the affected rows onto the newer evidence
  // (terminal evidence also drops the row) and re-pull — the display never
  // regresses to the older row.
  const reconciled = reconcileRows(snapshot.items);
  knownPending = new Set(reconciled.rows.map(item => item.id));
  set({
    hydrated: true,
    pendingCount: snapshot.pending_count,
    inboxRevision: snapshot.inbox_revision,
    pendingItems: reconciled.rows,
    pendingNextCursor: null,
    truncated: snapshot.truncated,
    refreshing: false,
    loadingMore: false,
    error: false,
  });
  if (reconciled.contradicted) invalidateInbox();
}

/** One-row update from `inbox:changed`. Stale frames (older collection
 *  revision) are dropped wholesale; a fresh frame is a newer canonical fact
 *  than any in-flight REST read. */
export function applyInboxItemChanged(item: InboxItemPublic, inboxRevision: number): void {
  if (!state.hydrated) {
    // No baseline yet (frame raced the first state_sync) — pull canonically.
    invalidateInbox();
    return;
  }
  if (inboxRevision < state.inboxRevision) return;
  noteAcceptedWrite();
  const { needsCountRefresh } = applyRow(item, inboxRevision);
  if (needsCountRefresh) invalidateInbox();
}

/** Item-level canonical reads without a collection revision (mutation
 *  responses, detail re-reads): fenced row write, never move inboxRevision.
 *  The write invalidates older in-flight reads so a slow refresh cannot
 *  paint over it. Returns whether the row was actually applied. */
export function applyInboxItem(item: InboxItemPublic): boolean {
  noteAcceptedWrite();
  const { applied, needsCountRefresh } = applyRow(item);
  if (needsCountRefresh) invalidateInbox();
  return applied;
}

/** The current write epoch. A mutation/detail request binds it at start. */
export function inboxWriteEpoch(): number {
  return writeToken;
}

export type InboxItemApplyResult = 'applied' | 'discarded' | 'fenced';

/** Apply a mutation/detail response only when no authoritative write
 *  (snapshot, frame, refresh) has been accepted since the request started.
 *  These responses carry no collection revision, so the request's start
 *  epoch is the only honest fence: a moved epoch means canonical state
 *  advanced past the response — discard the row and re-pull instead of
 *  resurrecting an item a newer snapshot already dropped. A row the
 *  per-item fence rejects is reported as `fenced`, never applied — callers
 *  must not proceed with side effects off a rejected stale read. */
export function applyInboxItemIfCurrent(item: InboxItemPublic, epoch: number): InboxItemApplyResult {
  if (epoch !== writeToken) {
    invalidateInbox();
    return 'discarded';
  }
  if (!applyInboxItem(item)) return 'fenced';
  return 'applied';
}

/** Re-pull the first pending page from REST. Count, rows and revision come
 *  from that ONE list transaction. Only the latest write wins; a superseded
 *  request discards its result (the superseding write already retired its
 *  busy flags), and a failed one surfaces `error`. */
export function refreshInbox(): Promise<void> {
  const token = ++writeToken;
  set({ ...state, refreshing: true, error: false });
  return loadInboxPage({ status: 'pending', limit: 50 })
    .then(page => {
      if (token !== writeToken) return;
      for (const item of page.items) ratchet(item);
      const reconciled = reconcileRows(page.items);
      knownPending = new Set(reconciled.rows.map(item => item.id));
      set({
        hydrated: true,
        pendingCount: page.pending_count,
        inboxRevision: page.inbox_revision,
        pendingItems: reconciled.rows,
        pendingNextCursor: page.next_cursor,
        truncated: page.next_cursor !== null,
        refreshing: false,
        loadingMore: false,
        error: false,
      });
      if (reconciled.contradicted) invalidateInbox();
    })
    .catch(() => {
      if (token !== writeToken) return;
      set({ ...state, refreshing: false, error: true });
    });
}

/** Bulk-change signal (`inbox:invalidated`) — the frame carries no rows, so
 *  the only honest recovery is a canonical re-pull. */
export function invalidateInbox(): void {
  void refreshInbox();
}

/** Page the pending window forward. A truncated sync snapshot has no cursor,
 *  so its first load-more restarts via REST; a stale cursor (409) discards
 *  the window and re-pulls from the top. */
export function loadMorePending(): Promise<void> {
  if (!state.truncated || state.loadingMore || state.refreshing) return Promise.resolve();
  if (state.pendingNextCursor === null) return refreshInbox();
  const cursor = state.pendingNextCursor;
  const token = ++writeToken;
  set({ ...state, loadingMore: true, error: false });
  return loadInboxPage({ status: 'pending', limit: 50, cursor })
    .then(page => {
      if (token !== writeToken) return;
      const seen = new Set(state.pendingItems.map(item => item.id));
      for (const item of page.items) ratchet(item);
      const reconciled = reconcileRows(page.items);
      for (const item of reconciled.rows) knownPending.add(item.id);
      set({
        ...state,
        pendingItems: [...state.pendingItems, ...reconciled.rows.filter(item => !seen.has(item.id))],
        pendingCount: page.pending_count,
        inboxRevision: page.inbox_revision,
        pendingNextCursor: page.next_cursor,
        truncated: page.next_cursor !== null,
        loadingMore: false,
        error: false,
      });
      // A contradictory page poisons the window's continuity — restart from
      // the top rather than appending around stale evidence.
      if (reconciled.contradicted) invalidateInbox();
    })
    .catch(error => {
      if (token !== writeToken) return;
      set({ ...state, loadingMore: false });
      if (error instanceof InboxApiError && error.code === 'stale') {
        invalidateInbox();
        return;
      }
      set({ ...state, error: true });
    });
}

export type InboxReadResult = 'ok' | 'stale' | 'error';

/** Mark exactly the observed generation read. A 409 `stale` means the item
 *  moved under the user: refresh canonical state, never retry the old
 *  generation against the latest item.
 *
 *  When the strict epoch fence discards the response (a newer canonical
 *  write landed mid-flight), one case is still an honest success: canonical
 *  state ALREADY carries this exact read — same id, same generation, already
 *  read. That is the WS echo of this very request (or the same read applied
 *  by another client), so it converges; the late REST body is not applied.
 *  A terminal item, an item absent from the latest snapshot, or a moved
 *  generation is never reported ok. */
export async function markInboxItemRead(item: InboxItemPublic): Promise<InboxReadResult> {
  // History/closed rows: a read changes read state only — there is no
  // pending membership or count to fence, so the epoch ceremony would only
  // false-positive (the WS echo lands outside the pending window). The
  // exact-occurrence contract still holds: the response must BE the observed
  // generation and clear the per-item fence. A WS frame that already advanced
  // this id to a NEW generation (a fresh pending occurrence) fences the old
  // body — report stale so the caller never swaps the click onto the new
  // occurrence. A verified same-generation WS echo applies idempotently and
  // still reports ok.
  if (item.status !== 'pending') {
    try {
      const updated = await markInboxRead(item.id, item.generation);
      const applied = applyInboxItem(updated);
      if (!applied || updated.generation !== item.generation) {
        invalidateInbox();
        return 'stale';
      }
      return 'ok';
    } catch (error) {
      if (error instanceof InboxApiError && error.code === 'stale') {
        invalidateInbox();
        return 'stale';
      }
      return 'error';
    }
  }
  const epoch = writeToken;
  try {
    const updated = await markInboxRead(item.id, item.generation);
    const applied = applyInboxItemIfCurrent(updated, epoch);
    if (applied === 'applied') return 'ok';
    if (applied === 'fenced') return 'stale';
    // Discarded by epoch: accept only the idempotent echo — canonical state
    // already shows this exact generation as read.
    const live = state.pendingItems.find(entry => entry.id === item.id);
    if (live && live.generation === item.generation && !live.unread) return 'ok';
    return 'stale';
  } catch (error) {
    if (error instanceof InboxApiError && error.code === 'stale') {
      invalidateInbox();
      return 'stale';
    }
    return 'error';
  }
}

export async function markInboxItemUnread(item: InboxItemPublic): Promise<InboxReadResult> {
  // Same exact-occurrence contract as markInboxItemRead for closed rows.
  if (item.status !== 'pending') {
    try {
      const updated = await markInboxUnread(item.id, item.generation);
      const applied = applyInboxItem(updated);
      if (!applied || updated.generation !== item.generation) {
        invalidateInbox();
        return 'stale';
      }
      return 'ok';
    } catch (error) {
      if (error instanceof InboxApiError && error.code === 'stale') {
        invalidateInbox();
        return 'stale';
      }
      return 'error';
    }
  }
  const epoch = writeToken;
  try {
    const updated = await markInboxUnread(item.id, item.generation);
    return applyInboxItemIfCurrent(updated, epoch) === 'applied' ? 'ok' : 'stale';
  } catch (error) {
    if (error instanceof InboxApiError && error.code === 'stale') {
      invalidateInbox();
      return 'stale';
    }
    return 'error';
  }
}

/** Version+channel scoped skip for a product/Integration update item. Same
 *  exact-generation fence as read/unread. */
export async function skipInboxItemVersion(item: InboxItemPublic): Promise<InboxReadResult> {
  if (item.display.kind !== 'product.update') return 'error';
  const epoch = writeToken;
  try {
    const updated = await skipInboxVersion(item.id, item.generation, item.display.version);
    return applyInboxItemIfCurrent(updated, epoch) === 'applied' ? 'ok' : 'stale';
  } catch (error) {
    if (error instanceof InboxApiError && error.code === 'stale') {
      invalidateInbox();
      return 'stale';
    }
    return 'error';
  }
}

/** Mark the exact notified Inbox occurrence read (renderer-fallback
 *  notification click). Epoch-bound like every mutation response. */
export async function markInboxRefRead(ref: { id: string; generation: number }): Promise<void> {
  const epoch = writeToken;
  try {
    const updated = await markInboxRead(ref.id, ref.generation);
    applyInboxItemIfCurrent(updated, epoch);
  } catch {
    invalidateInbox();
  }
}

/** Test-only reset (same convention as __resetScheduleConfirmations). */
export function __resetInboxForTests(): void {
  state = initialState;
  highWater = new Map();
  knownPending = new Set();
  writeToken += 1;
  for (const listener of listeners) listener();
}
