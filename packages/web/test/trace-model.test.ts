// Trace frontend MVP — pure view-model tests.
// Pins: upsert dedupe by correlationId (one logical call = one row), turn
// grouping with stable chronological order, item duration derivation, and
// that missing optional kinds never get placeholder tracks.

import { describe, expect, it } from 'vitest';
import {
  traceFixtureMultiStep,
  traceFixtureMultiTurn,
  traceFixtureOrphanParent,
  traceFixturePartialCapability,
  traceFixtureStepRequest,
  traceFixtureUpsertUpdates,
} from '../src/trace/fixtures.js';
import {
  applyTraceUpdates,
  deriveStepTimeline,
  filterTraceItems,
  groupSnapshotByTurn,
  groupTraceByTurn,
  layoutTraceTimeline,
  sortTraceItems,
  summarizeTrace,
  traceItemDurationMs,
  traceItemKey,
  upsertTraceItem,
} from '../src/trace/model.js';
import type { TraceItem } from '../src/trace/types.js';

function tool(overrides: Partial<TraceItem> & Pick<TraceItem, 'id' | 'turnId'>): TraceItem {
  return {
    kind: 'tool',
    shape: 'span',
    title: 'Bash',
    at: '2026-08-15T10:00:01.000Z',
    status: 'running',
    evidence: 'synthetic',
    sourceEventIds: ['evt-1'],
    ...overrides,
  };
}

describe('upsertTraceItem', () => {
  it('replaces the original row for the same correlationId instead of appending', () => {
    let items: TraceItem[] = [];
    for (const update of traceFixtureUpsertUpdates) {
      items = upsertTraceItem(items, update);
    }
    expect(items).toHaveLength(1);
    expect(items[0]!.status).toBe('succeeded');
    expect(items[0]!.detail).toEqual({ output: 'Build completed in 38s' });
    expect(items[0]!.endAt).toBe('2026-08-15T10:00:40.000Z');
  });

  it('applyTraceUpdates folds an update stream into one deduped list', () => {
    const items = applyTraceUpdates([], traceFixtureUpsertUpdates);
    expect(items).toHaveLength(1);
  });

  it('keeps distinct correlationIds as separate rows', () => {
    let items: TraceItem[] = [];
    items = upsertTraceItem(items, tool({ id: 'a', turnId: 'turn-1', correlationId: 'call-1' }));
    items = upsertTraceItem(items, tool({ id: 'b', turnId: 'turn-1', correlationId: 'call-2' }));
    expect(items).toHaveLength(2);
  });

  it('scopes the upsert to the turn: same correlationId in another turn appends', () => {
    let items: TraceItem[] = [];
    items = upsertTraceItem(items, tool({ id: 'a', turnId: 'turn-1', correlationId: 'call-1' }));
    items = upsertTraceItem(items, tool({ id: 'a', turnId: 'turn-2', correlationId: 'call-1' }));
    expect(items).toHaveLength(2);
  });

  it('falls back to the item id when no correlationId is present', () => {
    let items: TraceItem[] = [];
    items = upsertTraceItem(items, tool({ id: 'a', turnId: 'turn-1', status: 'running' }));
    items = upsertTraceItem(items, tool({ id: 'a', turnId: 'turn-1', status: 'succeeded' }));
    expect(items).toHaveLength(1);
    expect(items[0]!.status).toBe('succeeded');
  });

  it('retires pre-existing duplicates in place instead of leaving stale rows', () => {
    const stale = [
      tool({ id: 'a', turnId: 'turn-1', correlationId: 'call-1', title: 'old' }),
      tool({ id: 'x', turnId: 'turn-1' }),
      tool({ id: 'b', turnId: 'turn-1', correlationId: 'call-1', title: 'older' }),
    ];
    const items = upsertTraceItem(stale, tool({ id: 'c', turnId: 'turn-1', correlationId: 'call-1', title: 'new' }));
    expect(items).toHaveLength(2);
    expect(items[0]!.title).toBe('new');
    expect(items[1]!.id).toBe('x');
  });
});

describe('groupTraceByTurn', () => {
  it('groups items by turn in stable chronological order', () => {
    const groups = groupTraceByTurn(traceFixtureMultiTurn.items);
    expect(groups.map(g => g.turnId)).toEqual(['turn-1', 'turn-2']);
    const kinds1 = groups[0]!.items.map(i => i.kind);
    expect(kinds1).toEqual(['input', 'reasoning', 'tool', 'tool', 'assistant']);
    expect(groups[0]!.status).toBe('succeeded');
    expect(groups[0]!.durationMs).toBe(2 * 60 * 1000);
  });

  it('orders items by timestamp and keeps arrival order on ties', () => {
    const a = tool({ id: 'a', turnId: 'turn-1', at: '2026-08-15T10:00:05.000Z' });
    const b = tool({ id: 'b', turnId: 'turn-1', at: '2026-08-15T10:00:01.000Z' });
    const c = tool({ id: 'c', turnId: 'turn-1', at: '2026-08-15T10:00:05.000Z' });
    const groups = groupTraceByTurn([a, b, c]);
    expect(groups[0]!.items.map(i => i.id)).toEqual(['b', 'a', 'c']);
  });

  it('anchors a turn without a turn track and derives status from children', () => {
    const groups = groupTraceByTurn([
      tool({ id: 'a', turnId: 'turn-7', status: 'failed' }),
      tool({ id: 'b', turnId: 'turn-7', status: 'succeeded' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.turn).toBeUndefined();
    expect(groups[0]!.status).toBe('failed');
  });

  it('marks a turn with a still-running item as running', () => {
    const groups = groupTraceByTurn([
      tool({ id: 'a', turnId: 'turn-1', status: 'succeeded' }),
      tool({ id: 'b', turnId: 'turn-1', status: 'running' }),
    ]);
    expect(groups[0]!.status).toBe('running');
  });

  it('never manufactures tracks for kinds the snapshot does not carry', () => {
    const groups = groupTraceByTurn(traceFixturePartialCapability.items);
    const kinds = groups.flatMap(g => g.items.map(i => i.kind));
    expect(kinds).toEqual(['input', 'tool', 'assistant']);
    expect(kinds).not.toContain('reasoning');
    expect(kinds).not.toContain('plan');
    expect(kinds).not.toContain('agent');
  });
});

describe('traceItemDurationMs', () => {
  it('prefers explicit durationMs, then endAt − at, then undefined', () => {
    const explicit = tool({ id: 'a', turnId: 'turn-1', durationMs: 1234 });
    expect(traceItemDurationMs(explicit)).toBe(1234);
    const bounded = tool({
      id: 'b', turnId: 'turn-1',
      at: '2026-08-15T10:00:00.000Z', endAt: '2026-08-15T10:00:03.500Z',
    });
    expect(traceItemDurationMs(bounded)).toBe(3500);
    const running = tool({ id: 'c', turnId: 'turn-1' });
    expect(traceItemDurationMs(running)).toBeUndefined();
  });
});

describe('trace shape, filtering, and summary controls', () => {
  it('lays duration spans on the real time domain and leaves events as points', () => {
    const event: TraceItem = {
      ...tool({ id: 'event', turnId: 'turn-1', at: '2026-08-15T10:00:00.000Z' }),
      kind: 'input', shape: 'event',
    };
    const short = tool({
      id: 'short', turnId: 'turn-1', at: '2026-08-15T10:00:01.000Z',
      endAt: '2026-08-15T10:00:02.000Z',
    });
    const long = tool({
      id: 'long', turnId: 'turn-1', at: '2026-08-15T10:00:02.000Z',
      endAt: '2026-08-15T10:00:12.000Z',
    });
    const layout = layoutTraceTimeline([event, short, long], 'duration');
    expect(layout.find(entry => entry.item.id === 'event')).toMatchObject({ point: true, widthPct: 0 });
    expect(layout.find(entry => entry.item.id === 'long')!.widthPct)
      .toBeGreaterThan(layout.find(entry => entry.item.id === 'short')!.widthPct);
  });

  it('searches semantic detail and retains the matching item ancestors', () => {
    const filtered = filterTraceItems(traceFixtureStepRequest.items, 'deepseek-chat');
    expect(filtered.map(item => item.id)).toEqual([
      'turn-1', 'step:turn-1:native-turn-1:0', 'request-1',
    ]);
  });

  it('summarizes turns, calls, events, and real span durations', () => {
    const stats = summarizeTrace(traceFixtureMultiTurn.items);
    expect(stats).toMatchObject({ turns: 2, steps: 0, calls: 5, events: 2 });
    expect(stats.toolDurationMs).toBe(107_000);
  });
});

describe('deriveStepTimeline', () => {
  const nonTurn = (items: TraceItem[]) => items.filter(item => item.kind !== 'turn');

  it('nests every item whose parentId matches a known step, in chronological order', () => {
    const timeline = deriveStepTimeline(nonTurn(traceFixtureStepRequest.items));
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.type).toBe('step');
    if (timeline[0]?.type !== 'step') throw new Error('missing step entry');
    expect(timeline[0].step.id).toBe('step:turn-1:native-turn-1:0');
    expect(timeline[0].children.map(item => item.kind)).toEqual([
      'request', 'tool', 'assistant', 'notice',
    ]);
  });

  it('builds one group per step in a multi-step turn, sorted by the step time', () => {
    const timeline = deriveStepTimeline(nonTurn(traceFixtureMultiStep.items));
    expect(timeline.map(entry => entry.type)).toEqual(['step', 'step']);
    const [first, second] = timeline;
    if (first?.type !== 'step' || second?.type !== 'step') {
      throw new Error('expected two step entries');
    }
    expect(first.step.title).toBe('Step 1');
    expect(second.step.title).toBe('Step 2');
    expect(first.children.map(item => item.id)).toEqual(['ms-request-1', 'ms-tool-1']);
    expect(second.children.map(item => item.id)).toEqual(['ms-request-2', 'ms-assistant-2']);
  });

  it('keeps an orphan parentId at top level instead of dropping or inventing a step', () => {
    const timeline = deriveStepTimeline(nonTurn(traceFixtureOrphanParent.items));
    const orphan = timeline.find(
      entry => entry.type === 'item' && entry.item.id === 'orphan-row',
    );
    expect(orphan).toBeDefined();
    // The real step groups its own child; the orphan attaches nowhere.
    const step = timeline.find(entry => entry.type === 'step');
    if (step?.type !== 'step') throw new Error('missing step entry');
    expect(step.children.map(item => item.id)).toEqual(['orphan-child']);
    expect(timeline).toHaveLength(2);
  });

  it('leaves items without parentId as top-level entries (pre-step data unchanged)', () => {
    const source = nonTurn(traceFixtureMultiTurn.items);
    const timeline = deriveStepTimeline(source);
    expect(timeline.every(entry => entry.type === 'item')).toBe(true);
    expect(timeline.map(entry => (entry as { item: TraceItem }).item.id).sort())
      .toEqual(source.map(item => item.id).sort());
  });

  it('keeps standalone request items as ordinary top-level entries', () => {
    const timeline = deriveStepTimeline(nonTurn(traceFixtureMultiStep.items)
      .map(item => item.id === 'ms-request-1' ? { ...item, parentId: undefined } : item));
    const request = timeline.find(
      entry => entry.type === 'item' && entry.item.id === 'ms-request-1',
    );
    expect(request).toBeDefined();
    const first = timeline.find(entry => entry.type === 'step');
    if (first?.type !== 'step') throw new Error('missing step entry');
    expect(first.children.map(item => item.id)).toEqual(['ms-tool-1']);
  });
});

describe('traceItemKey / sortTraceItems / groupSnapshotByTurn', () => {
  it('keys by correlationId then id', () => {
    expect(traceItemKey(tool({ id: 'a', turnId: 't', correlationId: 'call-1' }))).toBe('call-1');
    expect(traceItemKey(tool({ id: 'a', turnId: 't' }))).toBe('a');
  });

  it('sorts by timestamp and keeps arrival order on ties', () => {
    const later = tool({ id: 'b', turnId: 't', at: '2026-08-15T10:00:02.000Z' });
    const earlier = tool({ id: 'a', turnId: 't', at: '2026-08-15T10:00:01.000Z' });
    const tied = tool({ id: 'c', turnId: 't', at: '2026-08-15T10:00:01.000Z' });
    expect(sortTraceItems([later, earlier, tied]).map(item => item.id)).toEqual(['a', 'c', 'b']);
  });

  it('groupSnapshotByTurn delegates to groupTraceByTurn', () => {
    const snapshot = {
      sessionId: 's-1',
      generatedAt: '2026-08-15T10:00:00.000Z',
      partial: false,
      items: traceFixtureMultiTurn.items,
    };
    expect(groupSnapshotByTurn(snapshot)).toEqual(groupTraceByTurn(snapshot.items));
  });
});
