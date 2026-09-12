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
}

let state: ScheduleConfirmationState = { hydrated: false, confirmations: [] };
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
 *  the resolve REST response). */
export function upsertScheduleConfirmation(confirmation: ScheduleConfirmation): void {
  const index = state.confirmations.findIndex(entry => entry.id === confirmation.id);
  const next = state.confirmations.slice();
  if (index === -1) next.push(confirmation);
  else next[index] = confirmation;
  set({ ...state, confirmations: next });
}

let hydrating: Promise<void> | null = null;

/** Re-pull pending confirmations from the Host. Concurrent calls share one
 *  flight; a failure keeps the last known state (cards stay actionable). */
export async function hydrateScheduleConfirmations(): Promise<void> {
  hydrating ??= (async () => {
    try {
      const pending = await loadScheduleConfirmations({ status: 'pending' });
      const pendingIds = new Set(pending.map(confirmation => confirmation.id));
      // Keep locally-known non-pending records (a just-resolved card whose
      // broadcast/response arrived first); pending is Host-authoritative.
      set({
        hydrated: true,
        confirmations: [
          ...state.confirmations.filter(confirmation =>
            confirmation.status !== 'pending' && !pendingIds.has(confirmation.id)),
          ...pending,
        ],
      });
    } finally {
      hydrating = null;
    }
  })();
  // Swallow transport errors: the next reconnect/upsert retries, and the
  // card list simply stays empty until then.
  return hydrating.catch(() => {
    set({ ...state, hydrated: true });
  });
}

/** Test helper — clears all state. */
export function __resetScheduleConfirmations(): void {
  set({ hydrated: false, confirmations: [] });
}
