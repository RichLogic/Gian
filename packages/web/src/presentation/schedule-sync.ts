/**
 * Schedule sync bus (Issue #51 / ADR-0053): the WS handler
 * (use-app-socket.ts) and the operation layer publish coarse schedule
 * signals here; the Timer list/detail controllers subscribe and re-fetch via
 * the schedules REST API. `schedule:changed` deliberately carries only
 * identities (shared/web.ts) — consumers always re-pull canonical state.
 *
 * This module is a dependency-free leaf so both controllers and the socket
 * layer can import it without cycles.
 */
import type { ScheduleChangedMessage } from '@gian/shared';

type ChangedListener = (message: ScheduleChangedMessage) => void;
type ResyncListener = () => void;

const changedListeners = new Set<ChangedListener>();
const resyncListeners = new Set<ResyncListener>();

export function onScheduleChanged(listener: ChangedListener): () => void {
  changedListeners.add(listener);
  return () => { changedListeners.delete(listener); };
}

/** Full-resync signal: fired on WS reconnect (state_sync) so schedule views
 *  re-pull even when individual schedule:changed frames were missed. */
export function onScheduleResync(listener: ResyncListener): () => void {
  resyncListeners.add(listener);
  return () => { resyncListeners.delete(listener); };
}

export function notifyScheduleChanged(message: ScheduleChangedMessage): void {
  for (const listener of changedListeners) listener(message);
}

export function notifyScheduleResync(): void {
  for (const listener of resyncListeners) listener();
}
