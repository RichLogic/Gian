import type { TranscriptItem } from '../types.js';

/**
 * Turn work boundary / Panel-2 event feed: process events stay behind one
 * compact Working/terminal row. Resolved interactions join the details;
 * PENDING approvals stay inline after the row.
 *
 * Clicking a long boundary routes the same item set to panel 2 as
 * `{kind:'event-feed'}`; ChatContextPanel re-projects it from the session's
 * `items` via `eventFeedItems`, so the boundary and panel always render the SAME
 * predicate and the panel updates in real time.
 */

/** Process-event kinds that collect into the Turn work details. */
export const TURN_WORK_KINDS: ReadonlySet<TranscriptItem['kind']> = new Set([
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

/** Detail-eligible: every process kind plus RESOLVED approvals. Two classes
 *  stay out:
 *  - a PENDING approval is the interactive surface and never enters the
 *    details until `interaction.resolved` flips its status in place;
 *  - an error-level auto-notice (circuit-breaker / severity error) is a
 *    danger signal, not process noise — it stays inline as the minimal
 *    error card, exactly like an `error` item. */
export function isTurnWorkItem(item: TranscriptItem): boolean {
  if (item.kind === 'auto-notice') {
    return item.variant === 'classifier-denied'
      || (item.variant === 'notice' && item.severity !== 'error');
  }
  if (TURN_WORK_KINDS.has(item.kind)) return true;
  return item.kind === 'approval' && item.status !== 'pending';
}

/** The live projection behind both the boundary and the panel-2 event feed. */
export function eventFeedItems(items: TranscriptItem[], turn: number): TranscriptItem[] {
  return items.filter(it => it.turn === turn && isTurnWorkItem(it));
}
