// Coverage for the session-routing helpers in
// packages/web/src/session-routing.ts.

import { describe, expect, it } from 'vitest';
import type { EventEnvelope, Session } from '@gian/shared';
import type { ApprovalItem } from '../src/types.js';
import { applyEnvelope } from '../src/transcript/apply.js';
import {
  buildRailSections,
  applySessionUpdate,
  isTurnRunning,
  planCreatedSessionFirstMessage,
  sortSessionsForRail,
  sortWorkspacesForRail,
} from '../src/session-routing.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: 'Task session',
    type: 'subtask',
    task_id: 'task-1',
    workspace_id: 'workspace-1',
    executor: 'codex',
    model: null,
    approval_mode: 'ask',
    executor_config: { schemaVersion: 1, values: {} },
    native_config_options: [],
    thinking_effort: null,
    service_tier: null,
    active_channel: 'web',
    status: 'done',
    archived: 0,
    pinned_at: null,
    unread: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    native_session_id: null,
    summary: null,
    completed_at: null,
    created_at: '2026-08-04T00:00:00.000Z',
    updated_at: '2026-08-04T00:00:00.000Z',
    ...overrides,
  };
}

describe('session:updated active-list reconciliation', () => {
  it('removes an archived session', () => {
    expect(applySessionUpdate([session()], { id: 'session-1', archived: 1 })).toEqual([]);
  });

  it('reinserts a restored full Session without changing completed_at', () => {
    const restored = session({
      archived: 0,
      completed_at: '2026-08-03T00:00:00.000Z',
    });
    expect(applySessionUpdate([], restored)).toEqual([restored]);
  });

  it('does not invent a missing row from a partial unarchive payload', () => {
    expect(applySessionUpdate([], { id: 'session-1', archived: 0 })).toEqual([]);
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

describe('buildRailSections: Pinned section above Projects (2026-08-03)', () => {
  function session(id: string, workspace_id: string, pinned_at: string | null = null, updated_at = '2026-08-01T00:00:00Z') {
    return { id, workspace_id, pinned_at, updated_at };
  }
  const workspaces = [
    { id: 'ws-a', pinned: 0 as const },
    { id: 'ws-b', pinned: 1 as const },
    { id: 'ws-c', pinned: 0 as const },
  ];

  it('pinned sessions become standalone rows and leave their workspace group', () => {
    const sections = buildRailSections([
      session('s1', 'ws-a'),
      session('s2', 'ws-a', '2026-08-01T10:00:00Z'),
      session('s3', 'ws-c'),
    ], workspaces);
    expect(sections.pinnedSessions.map(s => s.id)).toEqual(['s2']);
    expect(sections.byWs.get('ws-a')!.map(s => s.id)).toEqual(['s1']);
    expect(sections.projectWsIds).toEqual(['ws-a', 'ws-c']);
    expect(sections.pinnedWsIds).toEqual([]);
    expect(sections.hasPinned).toBe(true);
  });

  it('a pinned workspace moves its whole group into Pinned, in host order', () => {
    const sections = buildRailSections([
      session('s1', 'ws-b'),
      session('s2', 'ws-a'),
      session('s3', 'ws-c'),
    ], workspaces);
    expect(sections.pinnedWsIds).toEqual(['ws-b']);
    expect(sections.projectWsIds).toEqual(['ws-a', 'ws-c']);
    expect(sections.pinnedSessions).toEqual([]);
    expect(sections.hasPinned).toBe(true);
  });

  it('nothing pinned → no sections (labels stay hidden)', () => {
    const sections = buildRailSections([session('s1', 'ws-a')], workspaces);
    expect(sections.hasPinned).toBe(false);
    expect(sections.pinnedWsIds).toEqual([]);
    expect(sections.pinnedSessions).toEqual([]);
  });

  it('a pinned workspace with all sessions pinned leaves no empty group', () => {
    const sections = buildRailSections([
      session('s1', 'ws-b', '2026-08-01T10:00:00Z'),
      session('s2', 'ws-a'),
    ], workspaces);
    expect(sections.pinnedWsIds).toEqual([]);
    expect(sections.pinnedSessions.map(s => s.id)).toEqual(['s1']);
    expect(sections.projectWsIds).toEqual(['ws-a']);
  });

  it('orphan workspace ids append to Projects so their sessions stay visible', () => {
    const sections = buildRailSections([session('s1', 'ws-zzz')], workspaces);
    expect(sections.projectWsIds).toEqual(['ws-zzz']);
  });

  it('hidden-workspace sessions collect in unfiled and leave every workspace list', () => {
    const withHidden = [...workspaces, { id: 'ws-h', pinned: 0 as const, hidden: 1 as const }];
    const sections = buildRailSections([
      session('s1', 'ws-a'),
      session('s2', 'ws-h'),
      session('s3', 'ws-h'),
    ], withHidden);
    expect(sections.unfiled.map(s => s.id)).toEqual(['s2', 's3']);
    expect(sections.byWs.has('ws-h')).toBe(false);
    expect(sections.projectWsIds).toEqual(['ws-a']);
    expect(sections.pinnedWsIds).toEqual([]);
    expect(sections.hasPinned).toBe(false);
  });

  it('a pinned session of a hidden workspace stays a standalone pinned row', () => {
    const withHidden = [...workspaces, { id: 'ws-h', pinned: 0 as const, hidden: 1 as const }];
    const sections = buildRailSections([
      session('s1', 'ws-h', '2026-08-01T10:00:00Z'),
      session('s2', 'ws-h'),
    ], withHidden);
    expect(sections.pinnedSessions.map(s => s.id)).toEqual(['s1']);
    expect(sections.unfiled.map(s => s.id)).toEqual(['s2']);
    expect(sections.hasPinned).toBe(true);
  });

  it('a hidden workspace never enters pinnedWsIds even when pinned', () => {
    const withHiddenPinned = [...workspaces, { id: 'ws-h', pinned: 1 as const, hidden: 1 as const }];
    const sections = buildRailSections([session('s1', 'ws-h')], withHiddenPinned);
    expect(sections.unfiled.map(s => s.id)).toEqual(['s1']);
    expect(sections.pinnedWsIds).toEqual([]);
    expect(sections.hasPinned).toBe(false);
  });

  it('sessions without a workspace (deleted → NULL workspace_id) collect in unfiled', () => {
    const orphan = { id: 's1', workspace_id: null, pinned_at: null, updated_at: '2026-08-01T00:00:00Z' };
    const sections = buildRailSections([orphan, session('s2', 'ws-a')], workspaces);
    expect(sections.unfiled.map(s => s.id)).toEqual(['s1']);
    expect(sections.byWs.has(null as unknown as string)).toBe(false);
    expect(sections.projectWsIds).toEqual(['ws-a']);
  });
});
