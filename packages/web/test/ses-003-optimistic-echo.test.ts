// Coverage for traceability rows (transcript reducer dimension):
//   SES-003 — Sending a message produces an optimistic user echo with
//             pending=true. When the host broadcasts the matching
//             `user_message` event, the echo reconciles (pending drops).
//   ERR-007 — When the host sends an `error` envelope mid-send, the most
//             recent pending echo is marked failed=true.
//   WS-003  — `error` envelope routing: the failed-echo + pending-reset
//             is what the App must do on dispatch error.
//
// All three share the same transcript reducer surface
// (`applyEnvelope` + `markLatestPendingEchoFailed`), so we exercise
// them in one file as pure-function tests over `TranscriptItem[]`.

import { describe, it, expect } from 'vitest';
import type { EventEnvelope } from '@gian/shared';
import type { MsgItem, TranscriptItem } from '../src/types.js';
import {
  applyEnvelope,
  markLatestPendingEchoFailed,
} from '../src/transcript/apply.js';

function optimisticEcho(text: string, idSuffix = 'x'): MsgItem {
  return {
    kind: 'user',
    id: `optimistic:sess-1:${idSuffix}`,
    text,
    exec: 'claude',
    ts: 1_700_000_000_000,
    turn: 1,
    pending: true,
  };
}

function userMessageEnvelope(text: string, call_id = 'real-user-1'): EventEnvelope {
  return {
    session_id: 'sess-1',
    turn: 1,
    call_id,
    event: 'user_message',
    ts: 1_700_000_000_500,
    data: { text },
  };
}

// ---------------------------------------------------------------------------
// SES-003 — optimistic echo + server reconciliation
// ---------------------------------------------------------------------------

describe('SES-003: optimistic user echo reconciliation', () => {
  it('replaces the pending optimistic echo with the server-side user_message item', () => {
    const before: TranscriptItem[] = [optimisticEcho('hello')];
    const after = applyEnvelope(before, userMessageEnvelope('hello'), 'claude');

    expect(after).toHaveLength(1);
    const it = after[0]!;
    expect(it.kind).toBe('user');
    expect((it as MsgItem).pending).toBeUndefined();
    expect((it as MsgItem).failed).toBeUndefined();
    expect((it as MsgItem).text).toBe('hello');
    expect((it as MsgItem).id).toBe('real-user-1');
  });

  it('SES-003: reconciles the LATEST pending echo, not an older one', () => {
    // Two sends in flight: only the latest pending echo for the same
    // text should reconcile when the matching user_message arrives.
    const before: TranscriptItem[] = [
      optimisticEcho('first', 'a'),
      optimisticEcho('second', 'b'),
    ];
    const after = applyEnvelope(before, userMessageEnvelope('second', 'real-second'), 'claude');
    expect(after).toHaveLength(2);
    // First echo stays pending; second was reconciled.
    expect((after[0] as MsgItem).pending).toBe(true);
    expect((after[1] as MsgItem).id).toBe('real-second');
    expect((after[1] as MsgItem).pending).toBeUndefined();
  });

  it('SES-003: appends a fresh user_message when no pending echo matches the text', () => {
    // Background turn (e.g. queue auto-drain) — no client-side
    // optimistic echo. The envelope creates a new transcript row.
    const before: TranscriptItem[] = [];
    const after = applyEnvelope(before, userMessageEnvelope('queued text'), 'claude');
    expect(after).toHaveLength(1);
    expect((after[0] as MsgItem).text).toBe('queued text');
    expect((after[0] as MsgItem).pending).toBeUndefined();
  });

  it('SES-003: only reconciles when the optimistic echo text matches the server text exactly', () => {
    // If the user typed two messages and the server confirms a
    // different text first, the optimistic echo for the OTHER text must
    // not be incorrectly reconciled.
    const before: TranscriptItem[] = [optimisticEcho('hello')];
    const after = applyEnvelope(before, userMessageEnvelope('different text'), 'claude');
    expect(after).toHaveLength(2);
    expect((after[0] as MsgItem).pending).toBe(true); // echo unchanged
    expect((after[1] as MsgItem).text).toBe('different text');
  });

  it('SES-003: a non-pending user message in the transcript is NOT touched by reconciliation', () => {
    // Once an echo is reconciled (pending=undefined), a second
    // user_message must not overwrite it.
    const reconciled: MsgItem = {
      kind: 'user', id: 'real-1', text: 'old', exec: 'claude', ts: 0, turn: 1,
    };
    const before: TranscriptItem[] = [reconciled];
    const after = applyEnvelope(before, userMessageEnvelope('old'), 'claude');
    expect(after).toHaveLength(2);
    expect((after[0] as MsgItem).id).toBe('real-1');
  });
});

// ---------------------------------------------------------------------------
// ERR-007 + WS-003 — failed-echo marking on `error` envelope
// ---------------------------------------------------------------------------

describe('ERR-007: markLatestPendingEchoFailed flips the latest pending user echo to failed', () => {
  it('marks pending=false and failed=true on the most recent pending user echo', () => {
    const before: TranscriptItem[] = [optimisticEcho('hello')];
    const after = markLatestPendingEchoFailed(before);

    expect(after).toHaveLength(1);
    // The implementation explicitly sets `pending: false, failed: true`
    // (rather than deleting the key) so React's shallow diff still picks
    // up the change.
    expect((after[0] as MsgItem).pending).toBe(false);
    expect((after[0] as MsgItem).failed).toBe(true);
    expect((after[0] as MsgItem).text).toBe('hello');
  });

  it('ERR-007: only touches the LATEST pending echo, leaving earlier pending echoes alone', () => {
    // Two pending echoes. The server `error` envelope only references
    // one in-flight send, so only the latest pending must be marked.
    const before: TranscriptItem[] = [
      optimisticEcho('first', 'a'),
      optimisticEcho('second', 'b'),
    ];
    const after = markLatestPendingEchoFailed(before);
    expect((after[0] as MsgItem).pending).toBe(true);
    expect((after[0] as MsgItem).failed).toBeUndefined();
    expect((after[1] as MsgItem).pending).toBeFalsy();
    expect((after[1] as MsgItem).failed).toBe(true);
  });

  it('ERR-007: returns the original array reference when there is no pending echo (React identity stable)', () => {
    // No-op when there's nothing to mark — important for React: if we
    // returned a new array every time, every error envelope would
    // trigger a full Transcript re-render.
    const reconciled: MsgItem = {
      kind: 'user', id: 'real-1', text: 'normal', exec: 'claude', ts: 0, turn: 1,
    };
    const before: TranscriptItem[] = [reconciled];
    const after = markLatestPendingEchoFailed(before);
    expect(after).toBe(before);
  });

  it('ERR-007: works on an empty transcript without throwing', () => {
    const before: TranscriptItem[] = [];
    const after = markLatestPendingEchoFailed(before);
    expect(after).toBe(before);
  });

  it('ERR-007: does NOT mark assistant items as failed', () => {
    // The reducer skips non-user kinds even when they're at the tail of
    // the array. Pin this so a refactor doesn't accidentally extend the
    // failed-state to assistant text bubbles.
    const before: TranscriptItem[] = [
      optimisticEcho('user pending'),
      // tail-position assistant must NOT be marked
      { kind: 'assistant', id: 'a-1', text: 'partial', exec: 'claude', ts: 0, turn: 1 },
    ];
    const after = markLatestPendingEchoFailed(before);
    expect((after[1] as MsgItem).kind).toBe('assistant');
    expect((after[1] as MsgItem).failed).toBeUndefined();
    expect((after[0] as MsgItem).failed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WS-003 — error envelope shape contract (host emits, app consumes)
//
// We can't easily mount the full App here without a much larger harness,
// but we can pin the reducer contract that the WS handler ultimately
// drives: on error envelope with a session_id, the transcript is
// updated AND pending state is supposed to reset. The reducer surface
// is `markLatestPendingEchoFailed` — combined with `setPendingBySession`
// in App.tsx (not exercised here). The matrix GAP说明 for WS-003 reflects
// the App-level e2e dimension as remaining.
// ---------------------------------------------------------------------------

describe('WS-003: error-envelope reducer surface (App-level wiring is a remaining gap)', () => {
  it('reducer produces a failed echo that the Transcript can render with a distinct visual', () => {
    // The Transcript component branches on `failed === true` to show the
    // "send failed — retry?" surface. Pin the field name so a refactor
    // that renames `failed` to `error` is loud.
    const before: TranscriptItem[] = [optimisticEcho('doomed')];
    const after = markLatestPendingEchoFailed(before);
    expect(after[0]).toMatchObject({
      kind: 'user',
      text: 'doomed',
      failed: true,
    });
  });
});
