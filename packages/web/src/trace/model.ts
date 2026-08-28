/**
 * Pure trace view-model logic (Trace frontend MVP, 2026-08-15).
 *
 * Everything here is side-effect free and unit-tested; the React components
 * (`TraceView.tsx`, `TraceTimeline.tsx`) are thin renderers over these
 * functions. Works against the frozen contract in `types.ts` regardless of
 * whether the snapshot came from the transcript projection (derived) or a
 * fixture (synthetic), so the future Host feed only has to swap the source.
 */

import type { TraceItem, TraceSnapshot, TraceStatus } from './types.js';

/** Identity used for upsert: streaming updates for one logical call share a
 *  correlationId (toolCallId on the wire); items without one key by `id`. */
export function traceItemKey(item: TraceItem): string {
  return item.correlationId ?? item.id;
}

/**
 * Upsert one trace item into `items`: an update carrying the same
 * correlationId (or id) for the same turn REPLACES the original row in
 * place — it must never append a duplicate. If a previous race already left
 * duplicates behind, the first is replaced and the rest retired (mirrors the
 * transcript's `upsertToolItem`). Returns a new array; the input is not
 * mutated.
 */
export function upsertTraceItem(items: TraceItem[], item: TraceItem): TraceItem[] {
  const key = traceItemKey(item);
  const matches = items.flatMap((current, index) => (
    current.turnId === item.turnId && traceItemKey(current) === key ? [index] : []
  ));
  if (matches.length === 0) return [...items, item];
  const first = matches[0]!;
  const matchSet = new Set(matches);
  const next = items.filter((_current, index) => !matchSet.has(index));
  next.splice(first, 0, item);
  return next;
}

/** Fold a stream of item updates into the deduped list (fixtures + the
 *  future push-based Host feed both arrive as update sequences). */
export function applyTraceUpdates(items: TraceItem[], updates: TraceItem[]): TraceItem[] {
  return updates.reduce(upsertTraceItem, items);
}

/** Stable chronological order: by `at`, ties keep arrival order. */
export function sortTraceItems(items: TraceItem[]): TraceItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const delta = Date.parse(a.item.at) - Date.parse(b.item.at);
      return delta !== 0 ? delta : a.index - b.index;
    })
    .map(entry => entry.item);
}

export interface TraceTurnGroup {
  turnId: string;
  /** The turn's own `kind: 'turn'` item when the snapshot carries one. */
  turn?: TraceItem;
  /** Non-turn items of this turn, chronologically sorted. */
  items: TraceItem[];
  /** First activity timestamp of the turn (turn item or first child). */
  startAt: string;
  status: TraceStatus;
  durationMs?: number;
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function deriveTurnStatus(turn: TraceItem | undefined, items: TraceItem[]): TraceStatus {
  if (turn?.status) return turn.status;
  if (items.some(item => item.status === 'failed')) return 'failed';
  if (items.some(item => item.status === 'interrupted')) return 'interrupted';
  if (items.some(item => item.status === 'running' || item.status === undefined)) {
    return 'running';
  }
  return 'succeeded';
}

function deriveTurnDuration(turn: TraceItem | undefined, items: TraceItem[]): number | undefined {
  if (turn?.durationMs !== undefined) return turn.durationMs;
  if (turn?.endAt) return Math.max(0, parseTime(turn.endAt) - parseTime(turn.at));
  if (turn) return undefined;
  // No turn track: bound the group by its children's timestamps. Only
  // meaningful when every child is terminal (a running child has no end).
  const start = items.reduce((min, item) => Math.min(min, parseTime(item.at)), Infinity);
  const end = items.reduce((max, item) => Math.max(max, parseTime(item.endAt ?? item.at)), 0);
  if (!Number.isFinite(start) || end < start) return undefined;
  return end - start;
}

/**
 * Group snapshot items by turn with a stable chronological order — turns by
 * first activity, items within a turn by `at` (arrival order on ties). Kinds
 * the snapshot does not carry simply never appear; no placeholder tracks are
 * manufactured for missing capabilities (reasoning/plan/...).
 */
export function groupTraceByTurn(items: TraceItem[]): TraceTurnGroup[] {
  const turnsById = new Map<string, { turn?: TraceItem; items: TraceItem[]; firstIndex: number }>();
  items.forEach((item, index) => {
    const group = turnsById.get(item.turnId) ?? { items: [], firstIndex: index };
    if (item.kind === 'turn') group.turn = item;
    else group.items.push(item);
    turnsById.set(item.turnId, group);
  });
  const groups: TraceTurnGroup[] = [];
  for (const [turnId, group] of turnsById) {
    const sorted = sortTraceItems(group.items);
    const startAt = group.turn?.at ?? sorted[0]?.at ?? '';
    groups.push({
      turnId,
      turn: group.turn,
      items: sorted,
      startAt,
      status: deriveTurnStatus(group.turn, sorted),
      durationMs: deriveTurnDuration(group.turn, sorted),
    });
  }
  return groups
    .map((group, index) => ({ group, index }))
    .sort((a, b) => {
      const delta = parseTime(a.group.startAt) - parseTime(b.group.startAt);
      if (delta !== 0) return delta;
      if (a.index - b.index !== 0) return a.index - b.index;
      return a.group.turnId.localeCompare(b.group.turnId);
    })
    .map(entry => entry.group);
}

/** Item duration: explicit durationMs wins, else endAt − at. Undefined when
 *  the item is still running or carries no end marker. */
export function traceItemDurationMs(item: TraceItem): number | undefined {
  if (item.durationMs !== undefined) return item.durationMs;
  if (item.endAt) return Math.max(0, parseTime(item.endAt) - parseTime(item.at));
  return undefined;
}

export type TraceTimelineMode = 'sequence' | 'duration';

export interface TraceTimelinePosition {
  item: TraceItem;
  leftPct: number;
  widthPct: number;
  point: boolean;
  open: boolean;
}

const MAX_INTER_TURN_IDLE_SHARE = 0.12;
const MIN_TURN_DURATION_SHARE = 0.02;

interface DurationTurnPlacement {
  start: number;
  duration: number;
  virtualStart: number;
  scale: number;
}

function itemTimeBounds(item: TraceItem): { start: number; end: number; duration?: number } {
  const start = parseTime(item.at);
  const duration = traceItemDurationMs(item);
  return {
    start,
    end: duration === undefined ? start : start + duration,
    ...(duration !== undefined ? { duration } : {}),
  };
}

/**
 * Build an active-time axis: each Turn retains its real internal timing, but
 * idle gaps between Turns are capped to a small shared visual budget. A long-
 * lived Session therefore stays readable without pretending overnight idle
 * time was model/tool execution.
 */
function durationTurnPlacements(items: TraceItem[]): {
  placements: Map<string, DurationTurnPlacement>;
  domainMs: number;
} {
  const grouped = new Map<string, { start: number; end: number }>();
  for (const item of items) {
    const bounds = itemTimeBounds(item);
    const group = grouped.get(item.turnId);
    if (group) {
      group.start = Math.min(group.start, bounds.start);
      group.end = Math.max(group.end, bounds.end);
    } else {
      grouped.set(item.turnId, { start: bounds.start, end: bounds.end });
    }
  }
  const turns = [...grouped.entries()]
    .map(([turnId, bounds]) => ({
      turnId,
      ...bounds,
      duration: Math.max(0, bounds.end - bounds.start),
    }))
    .sort((a, b) => a.start - b.start || a.turnId.localeCompare(b.turnId));
  const realDurationMs = turns.reduce((sum, turn) => sum + turn.duration, 0);
  const minimumTurnMs = realDurationMs > 0
    ? Math.max(1, (realDurationMs / turns.length) * MIN_TURN_DURATION_SHARE)
    : 1;
  const effectiveDurationMs = turns.reduce(
    (sum, turn) => sum + Math.max(turn.duration, minimumTurnMs),
    0,
  );
  const gapCapMs = turns.length > 1
    ? (effectiveDurationMs * MAX_INTER_TURN_IDLE_SHARE) / (turns.length - 1)
    : 0;
  const placements = new Map<string, DurationTurnPlacement>();
  let cursor = 0;
  let previousEnd: number | null = null;
  for (const turn of turns) {
    if (previousEnd !== null) {
      cursor += Math.min(Math.max(0, turn.start - previousEnd), gapCapMs);
    }
    const effectiveDuration = Math.max(turn.duration, minimumTurnMs);
    placements.set(turn.turnId, {
      start: turn.start,
      duration: turn.duration,
      virtualStart: cursor,
      scale: turn.duration > 0 ? effectiveDuration / turn.duration : 1,
    });
    cursor += effectiveDuration;
    previousEnd = Math.max(previousEnd ?? turn.end, turn.end);
  }
  return { placements, domainMs: Math.max(1, cursor) };
}

/** Timeline geometry shared by every lane. Duration mode uses real time
 * within each Turn and caps only inter-Turn idle gaps; point events and truly
 * open spans render as ticks. */
export function layoutTraceTimeline(
  items: TraceItem[],
  mode: TraceTimelineMode,
): TraceTimelinePosition[] {
  const ordered = sortTraceItems(items);
  if (ordered.length === 0) return [];
  if (mode === 'sequence') {
    const slot = 100 / ordered.length;
    return ordered.map((item, index) => {
      const point = item.shape === 'event';
      const open = item.shape === 'span' && traceItemDurationMs(item) === undefined;
      return {
        item,
        leftPct: point || open ? (index + 0.5) * slot : index * slot,
        widthPct: point || open ? 0 : slot,
        point,
        open,
      };
    });
  }

  const { placements, domainMs } = durationTurnPlacements(ordered);
  return ordered.map(item => {
    const bounds = itemTimeBounds(item);
    const placement = placements.get(item.turnId)!;
    const point = item.shape === 'event';
    const open = item.shape === 'span' && bounds.duration === undefined;
    const relativeStart = placement.duration > 0
      ? Math.max(0, Math.min(placement.duration, bounds.start - placement.start))
      : 0;
    const virtualStart = placement.virtualStart + relativeStart * placement.scale;
    const virtualDuration = bounds.duration === undefined ? 0 : bounds.duration * placement.scale;
    return {
      item,
      leftPct: Math.max(0, Math.min(100, (virtualStart / domainMs) * 100)),
      widthPct: point || open ? 0 : Math.max(0, (virtualDuration / domainMs) * 100),
      point,
      open,
    };
  });
}

function traceSearchText(item: TraceItem): string {
  let detail = '';
  try {
    detail = item.detail === undefined ? '' : JSON.stringify(item.detail);
  } catch {
    detail = '';
  }
  return [
    item.id,
    item.turnId,
    item.kind,
    item.shape,
    item.title,
    item.summary,
    item.status,
    item.correlationId,
    detail,
  ].filter(Boolean).join('\n').toLowerCase();
}

/** Search matches semantic content and retains the item's step/turn ancestors
 * so filtered results never lose their execution context. */
export function filterTraceItems(items: TraceItem[], query: string): TraceItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  const byId = new Map(items.map(item => [item.id, item]));
  const turnByTurnId = new Map(
    items.filter(item => item.kind === 'turn').map(item => [item.turnId, item]),
  );
  const retained = new Set<string>();
  for (const item of items) {
    if (!traceSearchText(item).includes(needle)) continue;
    retained.add(item.id);
    let parentId = item.parentId;
    while (parentId) {
      const parent = byId.get(parentId);
      if (!parent || retained.has(parent.id)) break;
      retained.add(parent.id);
      parentId = parent.parentId;
    }
    const turn = turnByTurnId.get(item.turnId);
    if (turn) retained.add(turn.id);
  }
  return items.filter(item => retained.has(item.id));
}

export interface TraceStats {
  turns: number;
  steps: number;
  calls: number;
  events: number;
  modelDurationMs: number;
  toolDurationMs: number;
}

export function summarizeTrace(items: TraceItem[]): TraceStats {
  const turns = new Set(items.map(item => item.turnId));
  let modelDurationMs = 0;
  let toolDurationMs = 0;
  for (const item of items) {
    const duration = traceItemDurationMs(item) ?? 0;
    if (item.kind === 'assistant' || item.kind === 'reasoning') modelDurationMs += duration;
    if (item.kind === 'tool' || item.kind === 'agent') toolDurationMs += duration;
  }
  return {
    turns: turns.size,
    steps: items.filter(item => item.kind === 'step').length,
    calls: items.filter(item => item.kind === 'tool' || item.kind === 'agent').length,
    events: items.filter(item => item.shape === 'event').length,
    modelDurationMs,
    toolDurationMs,
  };
}

/** Convenience for views: group a whole snapshot in one call. */
export function groupSnapshotByTurn(snapshot: TraceSnapshot): TraceTurnGroup[] {
  return groupTraceByTurn(snapshot.items);
}

/**
 * One row of the step-grouped timeline inside a turn: either a standalone
 * item or a `kind: 'step'` group node with the children that reported it via
 * `parentId` (gian.proxy/2.0 step hierarchy, 2026-08-19).
 */
export type TraceTimelineEntry =
  | { type: 'item'; item: TraceItem }
  | { type: 'step'; step: TraceItem; children: TraceItem[] };

/**
 * Group step-linked Trace items by `parentId` without manufacturing missing
 * steps. `kind: 'step'` items are group nodes; an item whose `parentId`
 * matches a known step nests under it; a `parentId` pointing at a
 * non-existent step falls back to an ordinary top-level row (orphans are
 * never dropped and a step is never fabricated). Entries sort by their own
 * `at` (arrival order on ties); children keep the same chronological order
 * within their group. `kind: 'request'` items are standalone entries unless
 * they carry a valid `parentId`.
 */
export function deriveStepTimeline(items: TraceItem[]): TraceTimelineEntry[] {
  const ordered = sortTraceItems(items);
  const steps = new Map(
    ordered.filter(item => item.kind === 'step').map(item => [item.id, item]),
  );
  const children = new Map<string, TraceItem[]>();
  const childIds = new Set<string>();
  for (const item of ordered) {
    if (!item.parentId || !steps.has(item.parentId)) continue;
    const group = children.get(item.parentId) ?? [];
    group.push(item);
    children.set(item.parentId, group);
    childIds.add(item.id);
  }
  const timeline: TraceTimelineEntry[] = [];
  for (const item of ordered) {
    if (childIds.has(item.id)) continue;
    if (item.kind === 'step') {
      timeline.push({ type: 'step', step: item, children: children.get(item.id) ?? [] });
    } else {
      timeline.push({ type: 'item', item });
    }
  }
  return timeline;
}
