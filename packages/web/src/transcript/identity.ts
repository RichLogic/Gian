import type { ReasoningItem, TranscriptItem } from '../types.js';

const TOOL_PROJECTION_KINDS = new Set<TranscriptItem['kind']>([
  'command',
  'tool',
  'file-read',
  'file-search',
  'web-search',
  'diff',
  'agent-spawn',
]);

/**
 * Provider item ids are only stable within one turn and one display stream.
 * Keep every transcript consumer on the same logical identity so streaming,
 * hydration, and React reconciliation cannot merge unrelated rows.
 */
export function transcriptIdentity(
  turn: number,
  kind: TranscriptItem['kind'],
  id: string,
  reasoningVariant?: ReasoningItem['variant'],
): string {
  // Lifecycle markers are logical turn boundaries. A session-state fallback
  // and a later provider event may carry different physical ids, but must
  // still reconcile to one row during hydration.
  if (kind === 'turn-start' || kind === 'turn-end') return `${turn}:${kind}`;
  const variant = kind === 'reasoning' ? `:${reasoningVariant ?? 'full'}` : '';
  return `${turn}:${kind}${variant}:${id}`;
}

export function transcriptItemIdentity(item: TranscriptItem): string {
  return transcriptIdentity(
    item.turn,
    item.kind,
    item.id,
    item.kind === 'reasoning' ? item.variant : undefined,
  );
}

/** Generic and specialized tool cards are alternate projections of one
 * provider call. Reducer and hydration merges use this coarser identity while
 * React keys keep the exact display kind from `transcriptItemIdentity`. */
export function transcriptItemMergeIdentity(item: TranscriptItem): string {
  return TOOL_PROJECTION_KINDS.has(item.kind)
    ? `${item.turn}:tool-projection:${item.id}`
    : transcriptItemIdentity(item);
}

export function isToolProjectionItem(item: TranscriptItem): boolean {
  return TOOL_PROJECTION_KINDS.has(item.kind);
}
