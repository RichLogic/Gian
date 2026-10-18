/**
 * Pending schedule create confirmations (Issue #51 / ADR-0053, contract L).
 * A module-level store (same shape as feedback.ts) so the confirmation queue
 * survives view switches: the Host persists confirmations and blocks the
 * Tool call until the user resolves them, so the web client must never lose
 * a pending card by navigating.
 *
 * Hydration: `hydrateScheduleConfirmations()` runs on every WS auth_ok (app
 * start + every reconnect) and re-pulls the pending list; live
 * `schedule:confirmation` frames upsert individual records. Resolved records
 * stay in the store (their status flips) so an in-flight card can settle
 * from either the REST response or the broadcast; the UI only renders
 * `status === 'pending'`, oldest first.
 */
import type { ScheduleConfirmation } from '@gian/shared';
import { loadScheduleConfirmations } from '../api.js';

export interface ScheduleConfirmationState {
  /** True once the first GET answered (success or failure). */
  hydrated: boolean;
  confirmations: ScheduleConfirmation[];
  /** Deep-link focus (0.6.7 OS/Inbox): the exact confirmation the user
   *  opened, with the observed Inbox ref its resolve must carry. Without a
   *  focus the queue keeps the oldest-first order. */
  focus?: { id: string; inboxRef?: { id: string; generation: number } } | null;
}

let state: ScheduleConfirmationState = { hydrated: false, confirmations: [], focus: null };
const listeners = new Set<() => void>();

function set(next: ScheduleConfirmationState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeScheduleConfirmations(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getScheduleConfirmationsSnapshot(): ScheduleConfirmationState {
  return state;
}

/** Deep-link focus: surface exactly this confirmation (OS notification /
 *  Inbox open). The observed Inbox ref rides along so the resolve binds the
 *  generation the user saw. */
export function focusScheduleConfirmation(
  id: string,
  inboxRef?: { id: string; generation: number },
): void {
  set({ ...state, focus: { id, ...(inboxRef ? { inboxRef } : {}) } });
}

/** Clear the focus — the card resolved, or the id is no longer pending. */
export function clearScheduleConfirmationFocus(id?: string): void {
  if (!state.focus || (id !== undefined && state.focus.id !== id)) return;
  set({ ...state, focus: null });
}

/** Pending confirmations in creation order — the UI resolves them strictly
 *  sequentially (one card at a time). */
export function pendingScheduleConfirmations(
  snapshot: ScheduleConfirmationState = state,
): ScheduleConfirmation[] {
  return snapshot.confirmations
    .filter(confirmation => confirmation.status === 'pending')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Insert or replace one confirmation (WS `schedule:confirmation` upsert or
 *  the resolve REST response). Terminal facts are one-way: a pending record
 *  can never overwrite a terminal one — a confirmation id does not reopen. */
export function upsertScheduleConfirmation(confirmation: ScheduleConfirmation): void {
  storeRevision += 1;
  const index = state.confirmations.findIndex(entry => entry.id === confirmation.id);
  const existing = index === -1 ? null : state.confirmations[index]!;
  if (existing && existing.status !== 'pending' && confirmation.status === 'pending') return;
  const next = state.confirmations.slice();
  if (index === -1) next.push(confirmation);
  else next[index] = confirmation;
  set({ ...state, confirmations: next });
}

let hydrating: Promise<boolean> | null = null;
/** Bumped on every upsert — a hydrate GET binds this revision at request
 *  start; a newer WS/REST fact mid-flight discards the stale response. */
let storeRevision = 0;

/** Re-pull pending confirmations from the Host. Concurrent calls share one
 *  flight; a failure keeps the last known state (cards stay actionable).
 *  Resolves false on transport failure so deep-link navigation can retry
 *  the target instead of trusting a stale snapshot.
 *
 * Freshness: terminal facts are one-way — a confirmation resolved anywhere
 *  (WS frame, REST resolve response) can never be resurrected by an older
 *  pending list. A WS upsert landing mid-flight makes that response older
 *  than local facts: it is discarded and the loop reads once more against
 *  the newer epoch. At most MAX_HYDRATE_ROUNDS reads per flight; exhaustion
 *  reports false and keeps the current state. Only the flight owner clears
 *  the flight reference. */
const MAX_HYDRATE_ROUNDS = 2;

export function hydrateScheduleConfirmations(): Promise<boolean> {
  if (!hydrating) {
    // The flight body never references itself. Cleanup is attached AFTER
    // creation: on either settle branch, only this owner clears the shared
    // reference (a later flight is never clobbered). The rejection branch is
    // handled here, so no unhandled rejection escapes.
    const flight: Promise<boolean> = (async (): Promise<boolean> => {
      for (let round = 0; round < MAX_HYDRATE_ROUNDS; round += 1) {
        const epoch = storeRevision;
        const pending = await loadScheduleConfirmations({ status: 'pending' });
        if (storeRevision === epoch) {
          set({
            ...state,
            hydrated: true,
            confirmations: [
              // Terminal facts are one-way: always kept.
              ...state.confirmations.filter(confirmation => confirmation.status !== 'pending'),
              // Response pendings win only over records that are not
              // already terminal locally.
              ...pending.filter(confirmation =>
                !state.confirmations.some(local =>
                  local.id === confirmation.id && local.status !== 'pending')),
            ],
          });
          return true;
        }
        // A newer fact landed mid-read: this response is stale — loop and
        // read again against the newer epoch (bounded).
      }
      return false;
    })();
    hydrating = flight;
    void flight.then(
      () => { if (hydrating === flight) hydrating = null; },
      () => { if (hydrating === flight) hydrating = null; },
    );
  }
  // Swallow transport errors: the next reconnect/upsert retries, and the
  // card list simply stays empty until then. The shared reference keeps its
  // Promise<boolean> type; each caller gets its own caught view.
  return hydrating.catch(() => {
    set({ ...state, hydrated: true });
    return false;
  });
}

/** Test helper — clears all state. */
export function __resetScheduleConfirmations(): void {
  storeRevision = 0;
  set({ hydrated: false, confirmations: [], focus: null });
}
