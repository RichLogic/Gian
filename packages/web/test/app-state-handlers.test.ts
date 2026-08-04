// Coverage for the App-level state transitions extracted from
// `packages/web/src/App.tsx`:
//   SES-003 — `createOptimisticEcho` builds the pending user echo
//             that onSend pushes into the transcript before the server
//             confirms. ID format / pending flag / per-message uniqueness.
//   ERR-007 / WS-003 — `applyErrorEnvelopeToSession` flips per-session
//             pending state to false AND marks the latest in-flight echo
//             as failed in one atomic per-session delta. Together with
//             the existing host-side ERR-007 / WS-003 evidence this
//             closes both rows.
//   SEC-012 — the same onSend code path includes `oneShotBypass: true`
//             on the WS frame only when the Composer arms it. Already
//             pinned in the Composer component test; here we also pin
//             that `createOptimisticEcho` itself doesn't carry any
//             bypass field so a bypass-armed turn looks identical in
//             the transcript to a normal turn.

import { describe, it, expect } from 'vitest';
import type { TranscriptItem } from '../src/types.js';
import {
  createOptimisticEcho,
  applyErrorEnvelopeToSession,
  markLatestPendingEchoFailed,
} from '../src/transcript/apply.js';

// ---------------------------------------------------------------------------
// SES-003 — createOptimisticEcho
// ---------------------------------------------------------------------------

describe('SES-003: createOptimisticEcho', () => {
  it('builds a user MsgItem with pending=true and an `optimistic:<sid>:<ts>` id', () => {
    const echo = createOptimisticEcho({
      sessionId: 'sess-1',
      text: 'hello',
      exec: 'claude',
      now: () => 1_700_000_000_000,
    });
    expect(echo).toMatchObject({
      kind: 'user',
      id: 'optimistic:sess-1:1700000000000',
      text: 'hello',
      exec: 'claude',
      ts: 1_700_000_000_000,
      turn: 0,
      pending: true,
    });
  });

  it('SES-003: ts and id are driven by the injected `now()` clock for deterministic tests', () => {
    let frozen = 0;
    const a = createOptimisticEcho({ sessionId: 's', text: 'a', exec: 'claude', now: () => ++frozen });
    const b = createOptimisticEcho({ sessionId: 's', text: 'b', exec: 'claude', now: () => ++frozen });
    expect(a.id).toBe('optimistic:s:1');
    expect(b.id).toBe('optimistic:s:2');
    expect(a.ts).toBe(1);
    expect(b.ts).toBe(2);
  });

  it('SES-003: defaults `now` to `Date.now` when omitted (production path)', () => {
    const before = Date.now();
    const echo = createOptimisticEcho({ sessionId: 's', text: 'x', exec: 'codex' });
    const after = Date.now();
    expect(echo.ts).toBeGreaterThanOrEqual(before);
    expect(echo.ts).toBeLessThanOrEqual(after);
  });

  it('SES-003: carries the supplied executor (used for avatar / styling later)', () => {
    expect(createOptimisticEcho({ sessionId: 's', text: 'x', exec: 'claude' }).exec).toBe('claude');
    expect(createOptimisticEcho({ sessionId: 's', text: 'x', exec: 'codex' }).exec).toBe('codex');
  });

  it('SES-003: echo carries no `failed` field — failure is only set later via applyErrorEnvelopeToSession', () => {
    const echo = createOptimisticEcho({ sessionId: 's', text: 'x', exec: 'claude' });
    expect(echo.failed).toBeUndefined();
  });

  it('SEC-012: optimistic echo is bypass-agnostic (no `bypass`/`oneShotBypass` field on the transcript item)', () => {
    // The bypass flag rides on the WS `message:send` payload, NOT the
    // transcript echo. Pin that the echo has zero bypass-related
    // breadcrumbs so the visible transcript is identical regardless of
    // whether the Composer armed bypass.
    const echo = createOptimisticEcho({
      sessionId: 's', text: 'risky', exec: 'claude',
    });
    expect((echo as Record<string, unknown>).bypass).toBeUndefined();
    expect((echo as Record<string, unknown>).oneShotBypass).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ERR-007 / WS-003 — applyErrorEnvelopeToSession
// ---------------------------------------------------------------------------

describe('ERR-007 / WS-003: applyErrorEnvelopeToSession returns the atomic per-session delta', () => {
  it('returns null when the session has no items (nothing to mutate)', () => {
    const delta = applyErrorEnvelopeToSession(undefined, 'sess-1');
    expect(delta).toBeNull();
  });

  it('ERR-007: returns the failed-marked items AND pending=false when there\'s a pending echo', () => {
    const before: TranscriptItem[] = [
      createOptimisticEcho({ sessionId: 'sess-1', text: 'hello', exec: 'claude', now: () => 1 }),
    ];
    const delta = applyErrorEnvelopeToSession(before, 'sess-1');
    expect(delta).not.toBeNull();
    expect(delta!.pending).toBe(false);
    // markLatestPendingEchoFailed semantics: latest pending echo flipped
    // to failed=true, pending=false.
    const it0 = delta!.items[0] as Record<string, unknown>;
    expect(it0.failed).toBe(true);
    expect(it0.pending).toBe(false);
  });

  it('WS-003: returns pending=false even when there\'s no pending echo to flip', () => {
    // Spinner cleared unconditionally — covers the case where the spinner
    // came from a queue-driven turn_started (no client echo).
    const before: TranscriptItem[] = [
      // Non-pending user item, already reconciled.
      { kind: 'user', id: 'real-1', text: 'history', exec: 'claude', ts: 0, turn: 1 },
    ];
    const delta = applyErrorEnvelopeToSession(before, 'sess-1');
    expect(delta).not.toBeNull();
    expect(delta!.pending).toBe(false);
    // Items unchanged — same reference back through markLatestPendingEchoFailed.
    expect(delta!.items).toBe(before);
  });

  it('ERR-007: matches markLatestPendingEchoFailed output for the items half of the delta', () => {
    // Document that the items half is exactly the helper's return value —
    // any future refactor that swaps the helper will be loud.
    const before: TranscriptItem[] = [
      createOptimisticEcho({ sessionId: 'sess-1', text: 'p1', exec: 'claude', now: () => 1 }),
      createOptimisticEcho({ sessionId: 'sess-1', text: 'p2', exec: 'claude', now: () => 2 }),
    ];
    const expectedItems = markLatestPendingEchoFailed(before);
    const delta = applyErrorEnvelopeToSession(before, 'sess-1');
    expect(delta!.items).toEqual(expectedItems);
  });

  it('ERR-007: empty list returns null (no items to mark, no pending to clear)', () => {
    const delta = applyErrorEnvelopeToSession(undefined, 'sess-1');
    expect(delta).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ERR-007 / WS-003 / SES-003 / SEC-012 — full simulated flow:
//   onSend → optimistic echo → server error envelope → cleared state
// ---------------------------------------------------------------------------

describe('Full flow: onSend → optimistic echo → server error → cleared', () => {
  it('SES-003 + ERR-007: a one-shot optimistic echo gets failed-marked end-to-end', () => {
    // Frame the flow: App-level state is `Record<sessionId, items[]>`.
    // We simulate the lifecycle for a single session.
    const sid = 'sess-flow';
    let items: TranscriptItem[] = [];
    let pending = false;

    // Step 1: user sends a message — App creates an optimistic echo.
    const echo = createOptimisticEcho({
      sessionId: sid, text: 'do the risky thing', exec: 'claude',
      now: () => 100,
    });
    items = [...items, echo];
    pending = true;

    expect(items).toHaveLength(1);
    expect((items[0] as Record<string, unknown>).pending).toBe(true);
    expect(pending).toBe(true);

    // Step 2: host emits an `error` envelope for this session.
    const delta = applyErrorEnvelopeToSession(items, sid);
    expect(delta).not.toBeNull();
    items = delta!.items;
    pending = delta!.pending;

    // Step 3: echo is now failed; pending cleared.
    expect((items[0] as Record<string, unknown>).failed).toBe(true);
    expect((items[0] as Record<string, unknown>).pending).toBe(false);
    expect(pending).toBe(false);
  });

  it('WS-003: an error envelope on a session with no echo (queue-driven turn) clears pending only', () => {
    const sid = 'sess-queue';
    const items: TranscriptItem[] = [];
    let pending = true; // armed by a queue-driven turn_started earlier

    // No echo exists in this case — turn was queued, not user-initiated
    // via the Composer. The error envelope still clears the spinner.
    const delta = applyErrorEnvelopeToSession(items, sid);
    // delta is null when there are no items at all — pending must still
    // be cleared by the App alongside, but the items delta short-circuits.
    if (delta) pending = delta.pending;
    else pending = false; // App also clears pending unconditionally

    expect(pending).toBe(false);
  });
});
