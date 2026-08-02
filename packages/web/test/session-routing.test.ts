// Coverage for the session-routing helpers in
// packages/web/src/session-routing.ts.

import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@gian/shared';
import type { ApprovalItem } from '../src/types.js';
import { applyEnvelope } from '../src/transcript/apply.js';
import {
  isSessionCreateDispatchError,
  isTurnRunning,
  planCreatedSessionFirstMessage,
  sortSessionsForRail,
  sortWorkspacesForRail,
} from '../src/session-routing.js';

describe('session:create error correlation', () => {
  it('settles create state for executor-native AUTH_REQUIRED errors', () => {
    expect(isSessionCreateDispatchError({
      code: 'AUTH_REQUIRED',
      request_type: 'session:create',
    })).toBe(true);
  });

  it('keeps the legacy SESSION_CREATE_FAILED fallback', () => {
    expect(isSessionCreateDispatchError({
      code: 'SESSION_CREATE_FAILED',
    })).toBe(true);
  });

  it('does not settle create state for unrelated errors', () => {
    expect(isSessionCreateDispatchError({
      code: 'AUTH_REQUIRED',
      request_type: 'message:send',
    })).toBe(false);
  });
});

describe('isTurnRunning', () => {
  it('true while a turn runs', () => {
    expect(isTurnRunning('running', false)).toBe(true);
  });
  it('true when the pending flag is set (structured in-flight)', () => {
    expect(isTurnRunning('done', true)).toBe(true);
  });
  it('false when idle / done / merely locked-out', () => {
    expect(isTurnRunning('done', false)).toBe(false);
    expect(isTurnRunning('new', false)).toBe(false);
  });
});

describe('planCreatedSessionFirstMessage: first message stays on structured message:send', () => {
  it('routes first-turn text to structured message:send with an optimistic echo', () => {
    expect(planCreatedSessionFirstMessage('  hello  ')).toEqual({
      structuredText: 'hello',
      seedOptimisticEcho: true,
    });
  });

  it('does not seed an echo when there is no pending message', () => {
    expect(planCreatedSessionFirstMessage('   ')).toEqual({
      structuredText: null,
      seedOptimisticEcho: false,
    });
  });

  it('keeps Codex on structured message:send with an optimistic echo', () => {
    expect(planCreatedSessionFirstMessage('  implement it  ')).toEqual({
      structuredText: 'implement it',
      seedOptimisticEcho: true,
    });
  });
});

describe('approval_resolved reducer behavior for question cards', () => {
  function pendingQuestion(): ApprovalItem {
    return {
      kind: 'approval',
      id: 'env-q-1',
      approvalId: 'toolu_question_1',
      title: 'Pick dinner',
      reason: '',
      cmd: '',
      risk: 'low',
      status: 'pending',
      category: 'question',
      scopeOptions: ['once'],
      questions: [{
        question: 'Pick dinner',
        header: 'DINNER',
        options: [
          { label: 'Rice' },
          { label: 'Noodles' },
        ],
      }],
      ts: Date.UTC(2026, 5, 1, 0, 0, 0),
      turn: 1,
    };
  }

  function resolveEnvelope(
    approvalId: string,
    decision: 'allow_once' | 'decline' | 'keep_planning',
    answers?: Record<string, string | string[]>,
  ): EventEnvelope {
    return {
      session_id: 'sess-1',
      turn: 0,
      call_id: approvalId,
      event: 'approval_resolved',
      ts: Date.UTC(2026, 5, 1, 0, 0, 5),
      data: { approvalId, decision, auto: false, ...(answers ? { answers } : {}) },
    };
  }

  it('an approval_resolved transitions a pending question to approved-once', () => {
    const items = applyEnvelope([pendingQuestion()], resolveEnvelope('toolu_question_1', 'allow_once'), 'claude');
    const after = items[0] as ApprovalItem;
    expect(after.status).toBe('approved-once');
  });

  it('a decline resolve flips the card to declined', () => {
    const items = applyEnvelope([pendingQuestion()], resolveEnvelope('toolu_question_1', 'decline'), 'claude');
    const after = items[0] as ApprovalItem;
    expect(after.status).toBe('declined');
  });

  it('keep_planning keeps the Claude plan in revision-requested state', () => {
    const items = applyEnvelope(
      [pendingQuestion()],
      resolveEnvelope('toolu_question_1', 'keep_planning'),
      'claude',
    );
    expect((items[0] as ApprovalItem).status).toBe('declined');
  });

  it('a resolve is idempotent against later watcher duplicates', () => {
    // After the resolve, the JSONL watcher may still emit an
    // approval_requested for the same approvalId once claude writes the tool
    // record. apply.ts dedupes by approvalId and keeps the *resolved* state.
    let items = applyEnvelope([pendingQuestion()], resolveEnvelope('toolu_question_1', 'allow_once'), 'claude');
    const dupRequested: EventEnvelope = {
      session_id: 'sess-1',
      turn: 0,
      call_id: 'toolu_question_1',
      event: 'approval_requested',
      ts: Date.UTC(2026, 5, 1, 0, 0, 6),
      data: {
        approvalId: 'toolu_question_1',
        category: 'question',
        risk: 'low',
        title: 'Pick dinner',
        scopeOptions: ['once'],
        questions: [{ question: 'Pick dinner', options: [{ label: 'Rice' }] }],
      },
    };
    items = applyEnvelope(items, dupRequested, 'claude');
    const after = items[0] as ApprovalItem;
    // status must not regress to pending
    expect(after.status).toBe('approved-once');
    // and we should still have exactly one card, not two
    expect(items.filter(i => i.kind === 'approval').length).toBe(1);
  });

  it('stores the picked answer on the resolved item as answeredWith', () => {
    const items = applyEnvelope(
      [pendingQuestion()],
      resolveEnvelope('toolu_question_1', 'allow_once', { 'Pick dinner': 'Rice' }),
      'claude',
    );
    expect((items[0] as ApprovalItem).answeredWith).toBe('Rice');
  });

  it('flattens multi-question / multi-select answers into one answeredWith line', () => {
    const items = applyEnvelope(
      [pendingQuestion()],
      resolveEnvelope('toolu_question_1', 'allow_once', {
        'Pick dinner': 'Rice',
        'Add sides': ['Soup', 'Salad'],
      }),
      'claude',
    );
    expect((items[0] as ApprovalItem).answeredWith).toBe('Rice · Soup, Salad');
  });

  it('a later answer-less resolve does not blank an existing answeredWith', () => {
    let items = applyEnvelope(
      [pendingQuestion()],
      resolveEnvelope('toolu_question_1', 'allow_once', { 'Pick dinner': 'Rice' }),
      'claude',
    );
    items = applyEnvelope(items, resolveEnvelope('toolu_question_1', 'allow_once'), 'claude');
    expect((items[0] as ApprovalItem).answeredWith).toBe('Rice');
  });

  it('a late auto:true decline does NOT overwrite an already-answered question', () => {
    // The reducer must ignore auto-resolves once the card is no longer
    // pending, so the answer + status survive.
    const answered = applyEnvelope(
      [pendingQuestion()],
      resolveEnvelope('toolu_question_1', 'allow_once', { 'Pick dinner': 'Rice' }),
      'claude',
    );
    expect((answered[0] as ApprovalItem).status).toBe('approved-once');

    const autoDecline: EventEnvelope = {
      session_id: 'sess-1',
      turn: 0,
      call_id: 'toolu_question_1',
      event: 'approval_resolved',
      ts: Date.UTC(2026, 5, 1, 0, 0, 9),
      data: { approvalId: 'toolu_question_1', decision: 'decline', auto: true },
    };
    const after = applyEnvelope(answered, autoDecline, 'claude');
    expect((after[0] as ApprovalItem).status).toBe('approved-once');
    expect((after[0] as ApprovalItem).answeredWith).toBe('Rice');
  });
});

describe('sortSessionsForRail: pinned first, then recent activity', () => {
  function row(pinned_at: string | null, updated_at: string) {
    return { pinned_at, updated_at };
  }

  it('pinned sessions sort above unpinned, most-recently-pinned first', () => {
    const a = row(null, '2026-08-01T12:00:00Z');
    const b = row('2026-08-01T10:00:00Z', '2026-07-01T00:00:00Z');
    const c = row('2026-08-01T11:00:00Z', '2026-06-01T00:00:00Z');
    expect(sortSessionsForRail([a, b, c])).toEqual([c, b, a]);
  });

  it('unpinned sessions keep updated_at DESC order', () => {
    const a = row(null, '2026-08-01T10:00:00Z');
    const b = row(null, '2026-08-01T12:00:00Z');
    expect(sortSessionsForRail([a, b])).toEqual([b, a]);
  });

  it('does not mutate the input array', () => {
    const input = [row(null, '2026-08-01T10:00:00Z'), row('2026-08-01T09:00:00Z', '2026-08-01T11:00:00Z')];
    const copy = input.slice();
    sortSessionsForRail(input);
    expect(input).toEqual(copy);
  });
});

describe('sortWorkspacesForRail: pinned groups first, stable otherwise', () => {
  it('pinned workspaces lead, arrival order preserved within each group', () => {
    const a = { id: 'a', pinned: 0 as const };
    const b = { id: 'b', pinned: 1 as const };
    const c = { id: 'c', pinned: 0 as const };
    const d = { id: 'd', pinned: 1 as const };
    expect(sortWorkspacesForRail([a, b, c, d]).map(w => w.id)).toEqual(['b', 'd', 'a', 'c']);
  });
});
