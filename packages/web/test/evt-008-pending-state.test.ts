// Coverage for traceability rows (App pending-state dimension):
//   EVT-008 — `turn_started` flips the App's per-session pending state
//             to true (driving the spinner) but adds no transcript row;
//             `turn_completed` (and `session_error`) clears it.
//   SES-003 / ERR-007 / WS-003 — the shared App-level pending-state
//             clear that runs alongside `markLatestPendingEchoFailed`
//             when the host emits an `error` envelope. The clear path
//             for `error` lives in App's `error`-case handler, not
//             `nextPendingFromEnvelope`; it's a synchronous setter
//             call that pairs with the failed-echo mark.
//
// We extract the pending-state decision into `nextPendingFromEnvelope`
// so it's testable without mounting the full App.

import { describe, it, expect } from 'vitest';
import type { EventEnvelope } from '@gian/shared';
import { nextPendingFromEnvelope } from '../src/transcript/apply.js';

function env(event: string, sessionId = 'sess-1'): EventEnvelope {
  return {
    session_id: sessionId,
    turn: 1,
    call_id: `call-${event}`,
    event,
    ts: 1_700_000_000_000,
    data: {},
  };
}

// ---------------------------------------------------------------------------
// EVT-008 — turn lifecycle flips pending state
// ---------------------------------------------------------------------------

describe('EVT-008: pending-state transitions from envelopes', () => {
  it('turn_started → true (spinner ON)', () => {
    expect(nextPendingFromEnvelope(env('turn_started'))).toBe(true);
  });

  it('EVT-008: turn_completed → false (spinner OFF)', () => {
    expect(nextPendingFromEnvelope(env('turn_completed'))).toBe(false);
  });

  it('EVT-008: session_error → false (treat as turn end)', () => {
    // Per the App: a session_error envelope ends the active turn the
    // same way turn_completed does. Pin the contract.
    expect(nextPendingFromEnvelope(env('session_error'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EVT-008 — non-lifecycle envelopes leave pending state untouched (null
// signal). The App's reducer only flips state when `nextPending !== null`.
// ---------------------------------------------------------------------------

describe('EVT-008: pending-state is left untouched for non-lifecycle envelopes', () => {
  it('returns null for assistant_text (text streaming mid-turn)', () => {
    expect(nextPendingFromEnvelope(env('assistant_text'))).toBeNull();
  });

  it('EVT-008: returns null for reasoning (Codex thinking stream)', () => {
    expect(nextPendingFromEnvelope(env('reasoning'))).toBeNull();
  });

  it('EVT-008: returns null for plan_update (Codex plan stream)', () => {
    expect(nextPendingFromEnvelope(env('plan_update'))).toBeNull();
  });

  it('EVT-008: returns null for tool / file events', () => {
    for (const ev of ['command_execution', 'file_change', 'file_read', 'file_search']) {
      expect(nextPendingFromEnvelope(env(ev))).toBeNull();
    }
  });

  it('EVT-008: returns null for approval lifecycle', () => {
    // Approval events flip APPROVAL state, not turn pending state.
    expect(nextPendingFromEnvelope(env('approval_requested'))).toBeNull();
    expect(nextPendingFromEnvelope(env('approval_resolved'))).toBeNull();
  });

  it('EVT-008: returns null for token_usage.updated (stats only)', () => {
    expect(nextPendingFromEnvelope(env('token_usage.updated'))).toBeNull();
  });

  it('EVT-008: returns null for user_message (host-side reconciliation event)', () => {
    expect(nextPendingFromEnvelope(env('user_message'))).toBeNull();
  });

  it('EVT-008: returns null for unknown / future events', () => {
    expect(nextPendingFromEnvelope(env('some.future.event'))).toBeNull();
  });
});
