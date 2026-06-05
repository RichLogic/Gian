// Coverage for traceability row:
//   BILLING-001 — New Claude sessions route first-turn text through the
//                 interactive TTY path instead of `message:send`/`claude -p`.

import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@gian/shared';
import type { ApprovalItem } from '../src/types.js';
import { applyEnvelope } from '../src/transcript/apply.js';
import {
  formatBetaQuestionAnswers,
  planApprovalResponseDispatch,
  planBetaComposerSend,
  planCreatedSessionFirstMessage,
} from '../src/session-routing.js';

describe('BILLING-001: first message routing for newly-created sessions', () => {
  it('routes Claude first-turn text to TTY and never to structured message:send', () => {
    expect(planCreatedSessionFirstMessage('claude', '  hello  ')).toEqual({
      switchToTty: true,
      ttyText: 'hello',
      structuredText: null,
      seedOptimisticEcho: false,
    });
  });

  it('still switches empty Claude sessions to TTY by default', () => {
    expect(planCreatedSessionFirstMessage('claude', '   ')).toEqual({
      switchToTty: true,
      ttyText: null,
      structuredText: null,
      seedOptimisticEcho: false,
    });
  });

  it('keeps Codex on structured message:send with an optimistic echo', () => {
    expect(planCreatedSessionFirstMessage('codex', '  implement it  ')).toEqual({
      switchToTty: false,
      ttyText: null,
      structuredText: 'implement it',
      seedOptimisticEcho: true,
    });
  });
});

describe('BILLING-001: Beta question routing avoids structured approval resolve', () => {
  it('routes Claude Beta AskUserQuestion answers through TTY input', () => {
    const plan = planApprovalResponseDispatch({
      executor: 'claude',
      runtimeMode: 'tty',
      surface: 'beta',
      decision: 'allow_once',
      answers: { 'Pick dinner': ['Noodles', 'Soup'] },
      context: { category: 'question' },
    });

    expect(plan).toEqual({
      channel: 'tty',
      text: [
        'The user answered your AskUserQuestion via the Gian web UI rather than letting the tool run. Use these answers and continue as if AskUserQuestion had returned them.',
        '',
        'Q: Pick dinner',
        'A: Noodles; Soup',
      ].join('\n'),
    });
  });

  it('keeps non-question approvals on the structured approval channel', () => {
    expect(planApprovalResponseDispatch({
      executor: 'claude',
      runtimeMode: 'tty',
      surface: 'beta',
      decision: 'allow_once',
      context: { category: 'command' },
    })).toEqual({ channel: 'structured' });
  });

  it('keeps question approvals structured outside Claude Beta TTY', () => {
    expect(planApprovalResponseDispatch({
      executor: 'claude',
      runtimeMode: 'structured',
      surface: 'chat',
      decision: 'allow_once',
      answers: { 'Pick dinner': 'Rice' },
      context: { category: 'question' },
    })).toEqual({ channel: 'structured' });
  });

  it('still routes TTY question answers through the PTY even when surface is chat', () => {
    // The Beta surface is normally the only place a TTY question card is
    // visible, but the surface state lags one render behind a runtime flip.
    // If the user clicks Submit during that window we must not fall through to
    // the structured bridge — cc-proxy has no MCP approval registered in TTY
    // mode and would 404.
    const plan = planApprovalResponseDispatch({
      executor: 'claude',
      runtimeMode: 'tty',
      surface: 'chat',
      decision: 'allow_once',
      answers: { 'Pick dinner': 'Rice' },
      context: { category: 'question' },
    });
    expect(plan.channel).toBe('tty');
  });

  it('also routes TTY question answers through the PTY when surface is cli', () => {
    const plan = planApprovalResponseDispatch({
      executor: 'claude',
      runtimeMode: 'tty',
      surface: 'cli',
      decision: 'decline',
      context: { category: 'question' },
    });
    expect(plan.channel).toBe('tty');
  });

  it('formats single and multi answers in the same shape the agent already sees', () => {
    expect(formatBetaQuestionAnswers({
      'Pick dinner': 'Rice',
      'Add sides': ['Soup', 'Salad'],
    })).toBe([
      'The user answered your AskUserQuestion via the Gian web UI rather than letting the tool run. Use these answers and continue as if AskUserQuestion had returned them.',
      '',
      'Q: Pick dinner',
      'A: Rice',
      '',
      'Q: Add sides',
      'A: Soup; Salad',
    ].join('\n'));
  });
});

describe('BILLING-001: TTY question synthetic approval_resolved flips the card', () => {
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

  function syntheticResolve(
    approvalId: string,
    decision: 'allow_once' | 'decline',
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

  it('paste-back path: a synthesized approval_resolved transitions a pending question to approved-once', () => {
    // Mirrors what App.tsx → onLocalApprovalResolve does after the Beta user
    // clicks Submit: the answer was pasted to the PTY, and we synthesize an
    // approval_resolved envelope so the QuestionCard leaves `pending`. Without
    // this the card stays interactive forever (no server-side event ever
    // arrives — TTY mode has no MCP approval bridge to fire one).
    const items = applyEnvelope([pendingQuestion()], syntheticResolve('toolu_question_1', 'allow_once'), 'claude');
    const after = items[0] as ApprovalItem;
    expect(after.status).toBe('approved-once');
  });

  it('paste-back decline path flips the card to declined', () => {
    const items = applyEnvelope([pendingQuestion()], syntheticResolve('toolu_question_1', 'decline'), 'claude');
    const after = items[0] as ApprovalItem;
    expect(after.status).toBe('declined');
  });

  it('synthesized approval_resolved is idempotent against later watcher duplicates', () => {
    // After the synthetic resolve, the JSONL watcher may still emit an
    // approval_requested for the same approvalId once claude writes the tool
    // record. apply.ts dedupes by approvalId and keeps the *resolved* state.
    let items = applyEnvelope([pendingQuestion()], syntheticResolve('toolu_question_1', 'allow_once'), 'claude');
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
      syntheticResolve('toolu_question_1', 'allow_once', { 'Pick dinner': 'Rice' }),
      'claude',
    );
    expect((items[0] as ApprovalItem).answeredWith).toBe('Rice');
  });

  it('flattens multi-question / multi-select answers into one answeredWith line', () => {
    const items = applyEnvelope(
      [pendingQuestion()],
      syntheticResolve('toolu_question_1', 'allow_once', {
        'Pick dinner': 'Rice',
        'Add sides': ['Soup', 'Salad'],
      }),
      'claude',
    );
    expect((items[0] as ApprovalItem).answeredWith).toBe('Rice · Soup, Salad');
  });

  it('a later answer-less watcher resolve does not blank an existing answeredWith', () => {
    // The JSONL watcher resolve arrives after the synthetic one and carries no
    // answers. It must not wipe the answer we already captured.
    let items = applyEnvelope(
      [pendingQuestion()],
      syntheticResolve('toolu_question_1', 'allow_once', { 'Pick dinner': 'Rice' }),
      'claude',
    );
    items = applyEnvelope(items, syntheticResolve('toolu_question_1', 'allow_once'), 'claude');
    expect((items[0] as ApprovalItem).answeredWith).toBe('Rice');
  });

  it('a late auto:true decline does NOT overwrite an already-answered question', () => {
    // Regression for the review P1: after the user answered, TtyManager's
    // SessionEnd/tty.exited/stop cleanup can broadcast a stale
    // `auto:true decline`. The reducer must ignore auto-resolves once the card
    // is no longer pending, so the answer + status survive.
    const answered = applyEnvelope(
      [pendingQuestion()],
      syntheticResolve('toolu_question_1', 'allow_once', { 'Pick dinner': 'Rice' }),
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

describe('BILLING-001: Beta composer first-message routing', () => {
  it('stages Beta text while the Claude session is still switching to TTY', () => {
    expect(planBetaComposerSend('structured', '  hello beta  ')).toEqual({
      channel: 'stage_for_tty',
      text: 'hello beta',
    });
  });

  it('sends Beta text directly to PTY once runtime is TTY, framing images for Read pickup', () => {
    expect(planBetaComposerSend('tty', '  hello tty  ', [{ path: '/tmp/a.png' }])).toEqual({
      channel: 'pty',
      // `[Attached image: …]` mirrors cc-proxy's structured framing — the form
      // the interactive claude reliably Reads.
      text: 'hello tty\n\n[Attached image: /tmp/a.png]',
    });
  });
});
