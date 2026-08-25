import type { TranscriptItem } from '../types.js';

/**
 * Event box / Panel-2 event feed (2026-08-24): while a turn is in flight
 * (no `turn-end` item yet), its process events collect into ONE scrolling
 * "event box" (≤5 lines, newest at bottom) instead of flooding the
 * transcript row by row. Resolved interactions join the box as one-line
 * summaries; PENDING approvals stay inline — they wait on the user, not on
 * the model. As soon as the turn ends, the existing "完成即折" turnsum fold
 * takes over the exact same items, so history rendering is unchanged.
 *
 * Clicking the box routes the same live item set to panel 2 as
 * `{kind:'event-feed'}`; ChatContextPanel re-projects it from the session's
 * `items` via `eventFeedItems`, so box and panel always render the SAME
 * predicate and the panel updates in real time.
 */

/** Process-event kinds that collect into the event box (one line each). */
export const EVENT_BOX_KINDS: ReadonlySet<TranscriptItem['kind']> = new Set([
  'tool',
  'command',
  'diff',
  'file-read',
  'file-search',
  'web-search',
  'reasoning',
  'agent-spawn',
  'auto-notice',
  'compaction',
]);

/** Box-eligible: every process kind plus RESOLVED approvals. Two classes
 *  stay out:
 *  - a PENDING approval is the interactive surface and never enters the
 *    box until `interaction.resolved` flips its status in place;
 *  - an error-level auto-notice (circuit-breaker / severity error) is a
 *    danger signal, not process noise — it stays inline as the minimal
 *    error card, exactly like an `error` item. */
export function isEventBoxItem(item: TranscriptItem): boolean {
  if (item.kind === 'auto-notice') {
    return item.variant === 'classifier-denied'
      || (item.variant === 'notice' && item.severity !== 'error');
  }
  if (EVENT_BOX_KINDS.has(item.kind)) return true;
  return item.kind === 'approval' && item.status !== 'pending';
}

/** The live projection behind both the box and the panel-2 event feed. */
export function eventFeedItems(items: TranscriptItem[], turn: number): TranscriptItem[] {
  return items.filter(it => it.turn === turn && isEventBoxItem(it));
}
