// Coverage for traceability rows (reducer dimension):
//   EVT-006 — Codex reasoning must distinguish summary/full, accumulate
//             by itemId, and emit a ReasoningItem the Transcript renders
//             as a folded "reasoning card".
//   EVT-007 — Codex plan_update must support delta append AND final
//             replace via `applyPlanUpdate`; completed checklists disappear
//             only after `turn_completed`.
//   EVT-008 — `turn_started` must NOT produce a transcript row (it's a
//             signal-only event); the App-level pending state flip is
//             tested separately. `turn_completed` adds the turn-end separator
//             used by Plan/Agent cleanup.
//
// All three are pure-function reducer tests against
// `applyEnvelope` + `applyPlanUpdate`. App-level state hookup (which
// translates `turn_started` into `pendingBySession`) is the remaining UI
// dimension noted in the matrix GAP说明.

import { describe, it, expect } from 'vitest';
import type { EventEnvelope } from '@gian/shared';
import type { MsgItem, ReasoningItem, TranscriptItem } from '../src/types.js';
import {
  applyEnvelope,
  applyPlanLifecycle,
  applyPlanUpdate,
  isPlanChecklistComplete,
} from '../src/transcript/apply.js';

function reasoning(
  kind: 'summary' | 'full',
  itemId: string,
  text: string,
  opts: { delta?: boolean; turn?: number; ts?: number; call_id?: string } = {},
): EventEnvelope {
  return {
    session_id: 'sess-1',
    turn: opts.turn ?? 1,
    call_id: opts.call_id ?? itemId,
    event: 'reasoning',
    ts: opts.ts ?? 1_700_000_000_000,
    data: { itemId, text, kind, delta: opts.delta ?? true },
  };
}

function planUpdate(
  text: string,
  opts: { delta?: boolean; ts?: number } = {},
): EventEnvelope {
  return {
    session_id: 'sess-1',
    turn: 1,
    call_id: 'plan',
    event: 'plan_update',
    ts: opts.ts ?? 1_700_000_000_000,
    data: { text, delta: opts.delta ?? true },
  };
}

function assistantText(
  itemId: string,
  text: string,
  opts: { turn?: number; ts?: number } = {},
): EventEnvelope {
  return {
    session_id: 'sess-1',
    turn: opts.turn ?? 1,
    call_id: itemId,
    event: 'assistant_text',
    ts: opts.ts ?? 1_700_000_000_000,
    data: { itemId, text, delta: true },
  };
}

function turnEnvelope(
  event: 'turn_started' | 'turn_completed',
  opts: { turn?: number; callId?: string; ts?: number } = {},
): EventEnvelope {
  return {
    session_id: 'sess-1',
    turn: opts.turn ?? 1,
    call_id: opts.callId ?? 'turn-evt',
    event,
    ts: opts.ts ?? 1_700_000_000_000,
    data: {},
  };
}

// ---------------------------------------------------------------------------
// EVT-006 — reasoning summary/full accumulation
// ---------------------------------------------------------------------------

describe('EVT-006: Codex reasoning summary vs full accumulation', () => {
  it('first delta creates a ReasoningItem with the requested variant', () => {
    const summary = applyEnvelope([], reasoning('summary', 'r-1', 'hello'), 'codex');
    expect(summary).toHaveLength(1);
    const item = summary[0] as ReasoningItem;
    expect(item.kind).toBe('reasoning');
    expect(item.id).toBe('r-1');
    expect(item.variant).toBe('summary');
    expect(item.text).toBe('hello');
  });

  it('EVT-006: full variant is created as kind=reasoning with variant=full', () => {
    const out = applyEnvelope([], reasoning('full', 'r-2', 'long trace…'), 'codex');
    expect((out[0] as ReasoningItem).variant).toBe('full');
  });

  it('EVT-006: subsequent deltas APPEND to the same itemId, not replace', () => {
    let items: TranscriptItem[] = [];
    items = applyEnvelope(items, reasoning('summary', 'r-1', 'part-a '), 'codex');
    items = applyEnvelope(items, reasoning('summary', 'r-1', 'part-b'), 'codex');
    expect(items).toHaveLength(1);
    expect((items[0] as ReasoningItem).text).toBe('part-a part-b');
  });

  it('EVT-006: summary and full streams are tracked under DIFFERENT itemIds so they don\'t merge', () => {
    let items: TranscriptItem[] = [];
    items = applyEnvelope(items, reasoning('summary', 'r-summary', 'sum1'), 'codex');
    items = applyEnvelope(items, reasoning('full', 'r-full', 'full1'), 'codex');
    items = applyEnvelope(items, reasoning('summary', 'r-summary', '-sum2'), 'codex');
    items = applyEnvelope(items, reasoning('full', 'r-full', '-full2'), 'codex');

    expect(items).toHaveLength(2);
    const byId = Object.fromEntries(items.map((i) => [(i as ReasoningItem).id, i as ReasoningItem]));
    expect(byId['r-summary']!.variant).toBe('summary');
    expect(byId['r-summary']!.text).toBe('sum1-sum2');
    expect(byId['r-full']!.variant).toBe('full');
    expect(byId['r-full']!.text).toBe('full1-full2');
  });

  it('keeps summary and full streams separate even when the provider reuses one itemId', () => {
    let items: TranscriptItem[] = [];
    items = applyEnvelope(items, reasoning('summary', 'shared', 'summary'), 'codex');
    items = applyEnvelope(items, reasoning('full', 'shared', 'full'), 'codex');
    items = applyEnvelope(items, reasoning('summary', 'shared', ' update'), 'codex');

    expect(items).toHaveLength(2);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'reasoning', id: 'shared', variant: 'summary', text: 'summary update' }),
      expect.objectContaining({ kind: 'reasoning', id: 'shared', variant: 'full', text: 'full' }),
    ]));
  });

  it('does not merge reused message/reasoning ids across turns', () => {
    let items: TranscriptItem[] = [];
    items = applyEnvelope(items, assistantText('reused', 'turn one', { turn: 1 }), 'kimi');
    items = applyEnvelope(items, assistantText('reused', 'turn two', { turn: 2 }), 'kimi');
    items = applyEnvelope(items, reasoning('full', 'reused', 'thought one', { turn: 1 }), 'kimi');
    items = applyEnvelope(items, reasoning('full', 'reused', 'thought two', { turn: 2 }), 'kimi');

    expect(items).toHaveLength(4);
    expect(items.filter(item => item.kind === 'assistant')).toMatchObject([
      { id: 'reused', turn: 1, text: 'turn one' },
      { id: 'reused', turn: 2, text: 'turn two' },
    ]);
    expect(items.filter(item => item.kind === 'reasoning')).toMatchObject([
      { id: 'reused', turn: 1, text: 'thought one' },
      { id: 'reused', turn: 2, text: 'thought two' },
    ]);
  });

  it('EVT-006: a non-delta full snapshot REPLACES the accumulated text (delta:false branch)', () => {
    // The reducer special-cases `delta === false`: instead of appending,
    // the chunk becomes the new text. Used when Codex emits a final
    // full-trace snapshot at the end of reasoning.
    let items: TranscriptItem[] = [];
    items = applyEnvelope(items, reasoning('full', 'r-1', 'partial '), 'codex');
    items = applyEnvelope(items, reasoning('full', 'r-1', 'partial more '), 'codex');
    expect((items[0] as ReasoningItem).text).toBe('partial partial more ');

    // Final non-delta snapshot — replace.
    items = applyEnvelope(
      items,
      reasoning('full', 'r-1', 'final canonical trace', { delta: false }),
      'codex',
    );
    expect((items[0] as ReasoningItem).text).toBe('final canonical trace');
  });

  it('EVT-006: empty text chunks are ignored (no zero-length appends)', () => {
    const out = applyEnvelope([], reasoning('summary', 'r-1', ''), 'codex');
    expect(out).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EVT-007 — plan_update is dropped from the transcript and folded into
// per-session plan state via `applyPlanUpdate`.
// ---------------------------------------------------------------------------

describe('EVT-007: plan_update reducer surface', () => {
  it('applyEnvelope drops plan_update from the transcript list (PlanChip subscribes separately)', () => {
    const out = applyEnvelope([], planUpdate('plan body'), 'codex');
    expect(out).toEqual([]);
  });

  it('EVT-007: applyEnvelope does NOT mutate the transcript when a plan_update arrives mid-stream', () => {
    // Confirm React identity stability — the transcript reducer must
    // return the original list reference to avoid re-renders.
    const original: TranscriptItem[] = [
      { kind: 'assistant', id: 'a', text: 'existing', exec: 'codex', ts: 0, turn: 1 } as MsgItem,
    ];
    const after = applyEnvelope(original, planUpdate('plan body'), 'codex');
    expect(after).toBe(original);
  });

  it('EVT-007: applyPlanUpdate appends when delta:true', () => {
    expect(applyPlanUpdate('## Step 1\n', planUpdate('## Step 2\n', { delta: true }))).toBe('## Step 1\n## Step 2\n');
    expect(applyPlanUpdate(undefined, planUpdate('first ', { delta: true }))).toBe('first ');
  });

  it('EVT-007: applyPlanUpdate REPLACES when delta:false (final snapshot semantics)', () => {
    // Codex emits one terminal `output.plan.final` after streaming
    // `output.plan.delta` chunks. The terminal snapshot must NOT be
    // concatenated onto the deltas — it's already the canonical plan.
    expect(applyPlanUpdate('streamed deltas', planUpdate('CANONICAL', { delta: false }))).toBe('CANONICAL');
  });

  it('EVT-007: applyPlanUpdate accepts undefined prior state without throwing', () => {
    expect(applyPlanUpdate(undefined, planUpdate('first', { delta: true }))).toBe('first');
    expect(applyPlanUpdate(undefined, planUpdate('first', { delta: false }))).toBe('first');
  });

  it('recognizes only non-empty checklists whose every step is complete', () => {
    expect(isPlanChecklistComplete('- [x] inspect\n- [X] test')).toBe(true);
    expect(isPlanChecklistComplete('- [x] inspect\n- [ ] test')).toBe(false);
    expect(isPlanChecklistComplete('Implementation complete.')).toBe(false);
  });

  it('finalizes a complete plan at turn_completed, not during plan streaming', () => {
    const streamed = applyPlanLifecycle(
      { completed: false },
      planUpdate('- [x] inspect\n- [x] test', { delta: false }),
    );
    expect(streamed).toEqual({
      text: '- [x] inspect\n- [x] test',
      completed: false,
      status: 'active',
      turn: 1,
    });

    const finalized = applyPlanLifecycle(streamed, turnEnvelope('turn_completed'));
    expect(finalized).toMatchObject({
      completed: true,
      status: 'completed',
      turn: 1,
    });
  });

  it('keeps incomplete plans visible and lets a later update restart a finalized plan', () => {
    const incomplete = applyPlanLifecycle(
      { completed: false },
      planUpdate('- [x] inspect\n- [ ] test', { delta: false }),
    );
    expect(applyPlanLifecycle(incomplete, turnEnvelope('turn_completed'))).toMatchObject({
      completed: false,
      status: 'paused',
      turn: 1,
    });

    const restarted = applyPlanLifecycle(
      { text: '- [x] old', completed: true },
      planUpdate('- [ ] new', { delta: false }),
    );
    expect(restarted).toEqual({
      text: '- [ ] new',
      completed: false,
      status: 'active',
      turn: 1,
    });
  });

  it('does not let later terminal turns reassign and perpetually pause an old plan', () => {
    const active = applyPlanLifecycle(
      { completed: false },
      planUpdate('- [x] inspect\n- [ ] test', { delta: false }),
    );
    const paused = applyPlanLifecycle(active, turnEnvelope('turn_completed'));
    const laterTerminal = {
      ...turnEnvelope('turn_completed'),
      turn: 8,
      call_id: 'turn-8-complete',
    };

    expect(paused).toMatchObject({ status: 'paused', turn: 1 });
    expect(applyPlanLifecycle(paused, laterTerminal)).toBe(paused);
  });
});

// ---------------------------------------------------------------------------
// EVT-008 — turn lifecycle envelopes are signal-only at the reducer
// ---------------------------------------------------------------------------

describe('EVT-008: turn_started / turn_completed do not produce transcript rows', () => {
  it('turn_started does NOT add an item to the transcript', () => {
    const out = applyEnvelope([], turnEnvelope('turn_started'), 'claude');
    expect(out).toEqual([]);
  });

  it('EVT-008: turn_started preserves React identity when there are existing items', () => {
    const before: TranscriptItem[] = [
      { kind: 'user', id: 'u-1', text: 'hi', exec: 'claude', ts: 0, turn: 1 },
    ];
    const after = applyEnvelope(before, turnEnvelope('turn_started'), 'claude');
    expect(after).toBe(before);
  });

  it('EVT-008: turn_completed appends a `turn-end` separator with "Turn N · complete" label', () => {
    // Unlike `turn_started`, the reducer surfaces turn-end as a visible
    // transcript separator (a StatusItem of kind='turn-end'). This is
    // what renders the horizontal divider between consecutive turns.
    const before: TranscriptItem[] = [
      { kind: 'user', id: 'u-1', text: 'hi', exec: 'claude', ts: 0, turn: 1 },
    ];
    const after = applyEnvelope(before, turnEnvelope('turn_completed'), 'claude');
    expect(after).toHaveLength(2);
    const sep = after[1] as { kind: string; text: string };
    expect(sep.kind).toBe('turn-end');
    expect(sep.text).toBe('Turn 1 · complete');
  });

  it('absorbs duplicate completion signals for the same turn', () => {
    const once = applyEnvelope([], turnEnvelope('turn_completed', {
      turn: 4, callId: 'provider-complete', ts: 10,
    }), 'kimi');
    const twice = applyEnvelope(once, turnEnvelope('turn_completed', {
      turn: 4, callId: 'late-complete', ts: 11,
    }), 'kimi');

    expect(twice).toBe(once);
    expect(twice.filter(item => item.kind === 'turn-end' && item.turn === 4)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// approval_requested dedupe by approvalId
//
// A single AskUserQuestion can surface twice: the live PreToolUse hook
// broadcasts it while the tool is pending, and the JSONL watcher re-emits
// the same approvalId once the tool_use lands in the transcript. Both carry
// the same approvalId, so the reducer must render ONE card.
// ---------------------------------------------------------------------------

function approvalRequested(
  approvalId: string,
  opts: { ts?: number; turn?: number } = {},
): EventEnvelope {
  return {
    session_id: 'sess-1',
    turn: opts.turn ?? 1,
    call_id: approvalId,
    event: 'approval_requested',
    ts: opts.ts ?? 1_700_000_000_000,
    data: {
      approvalId,
      category: 'question',
      title: '这个周末你想怎么过?',
      questions: [
        { question: '这个周末你想怎么过?', options: [{ label: '户外探险' }, { label: '宅家充电' }] },
      ],
      scopeOptions: ['once'],
      risk: 'low',
    },
  };
}

describe('approval_requested dedupe by approvalId', () => {
  it('renders a single card when the same approvalId arrives twice (live PreToolUse + JSONL watcher)', () => {
    let items: TranscriptItem[] = [];
    items = applyEnvelope(items, approvalRequested('toolu_q1', { ts: 1 }), 'claude');
    items = applyEnvelope(items, approvalRequested('toolu_q1', { ts: 2 }), 'claude');
    expect(items.filter(i => i.kind === 'approval')).toHaveLength(1);
  });

  it('preserves a resolved status when a duplicate request arrives after resolution', () => {
    let items: TranscriptItem[] = [];
    items = applyEnvelope(items, approvalRequested('toolu_q1', { ts: 1 }), 'claude');
    items = applyEnvelope(items, {
      session_id: 'sess-1', turn: 1, call_id: 'toolu_q1', event: 'approval_resolved',
      ts: 2, data: { approvalId: 'toolu_q1', decision: 'allow_once' },
    }, 'claude');
    // late duplicate request (JSONL watcher replay) must not resurrect a pending card
    items = applyEnvelope(items, approvalRequested('toolu_q1', { ts: 3 }), 'claude');
    const approvals = items.filter(i => i.kind === 'approval') as { status: string }[];
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.status).not.toBe('pending');
  });

  it('still renders distinct cards for different approvalIds', () => {
    let items: TranscriptItem[] = [];
    items = applyEnvelope(items, approvalRequested('toolu_a'), 'claude');
    items = applyEnvelope(items, approvalRequested('toolu_b'), 'claude');
    expect(items.filter(i => i.kind === 'approval')).toHaveLength(2);
  });
});
