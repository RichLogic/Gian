import { describe, it, expect } from 'vitest';
import type { Approval, EventEnvelope, Session } from '@gian/shared';
import {
  applyApprovalCreated,
  blockingCount,
  classifyEnvelope,
  clearFyi,
  clearSessionError,
  ingestEnvelope,
  INBOX_CAP,
  markAllRead,
  markSessionRead,
  reconcileFromSync,
  removeApproval,
  removeSession,
  tierOf,
  type InboxItem,
} from '../src/inbox.js';
import { DEFAULT_NOTIFICATION_PREFS } from '../src/notifications.js';

const PREFS = DEFAULT_NOTIFICATION_PREFS;

function env(event: string, data: Record<string, unknown>, over: Partial<EventEnvelope> = {}): EventEnvelope {
  return { session_id: 's1', turn: 1, call_id: 'c1', event, ts: 1000, data, ...over };
}

const ctx = (activeSessionId: string | null = null) => ({ prefs: PREFS, activeSessionId });

describe('classifyEnvelope', () => {
  it('maps approval_requested to a blocking approval keyed by approvalId', () => {
    const c = classifyEnvelope(env('approval_requested', { approvalId: 'a1', title: 'Run npm test' }));
    expect(c).toEqual({ kind: 'approval', id: 'approval:a1', subject: 'Run npm test' });
    expect(tierOf(c!.kind)).toBe('blocking');
  });

  it('maps session_error to one error row per session', () => {
    expect(classifyEnvelope(env('session_error', { message: 'boom' }))).toEqual({
      kind: 'error', id: 'error:s1', subject: 'boom',
    });
  });

  it('maps turn_completed to a per-turn done (FYI) row', () => {
    const c = classifyEnvelope(env('turn_completed', { summary: 'Done.' }, { turn: 4 }));
    expect(c).toEqual({ kind: 'done', id: 'done:s1:4', subject: 'Done.' });
    expect(tierOf(c!.kind)).toBe('fyi');
  });

  it('ignores unrelated events', () => {
    expect(classifyEnvelope(env('assistant_text', { text: 'hi' }))).toBeNull();
  });
});

describe('ingestEnvelope', () => {
  it('adds an approval and removes it on resolve (same approvalId)', () => {
    let items = ingestEnvelope([], env('approval_requested', { approvalId: 'a1', title: 'X' }), ctx());
    expect(items).toHaveLength(1);
    expect(blockingCount(items)).toBe(1);
    items = ingestEnvelope(items, env('approval_resolved', { approvalId: 'a1', decision: 'allow_once', auto: false }), ctx());
    expect(items).toHaveLength(0);
  });

  it('falls back to call_id when approvalId is absent', () => {
    const items = ingestEnvelope([], env('approval_requested', { title: 'X' }, { call_id: 'cc9' }), ctx());
    expect(items[0]!.id).toBe('approval:cc9');
  });

  it('skips a completed turn for the session you are watching', () => {
    expect(ingestEnvelope([], env('turn_completed', { summary: 'y' }), ctx('s1'))).toHaveLength(0);
    expect(ingestEnvelope([], env('turn_completed', { summary: 'y' }), ctx('other'))).toHaveLength(1);
  });

  it('clears a stale error row when the session completes a turn', () => {
    let items = ingestEnvelope([], env('session_error', { message: 'boom' }), ctx());
    expect(blockingCount(items)).toBe(1);
    items = ingestEnvelope(items, env('turn_completed', { summary: 'recovered' }), ctx('other'));
    expect(items.filter(i => i.kind === 'error')).toHaveLength(0);
    expect(items.filter(i => i.kind === 'done')).toHaveLength(1);
  });

  it('honors prefs (errors off → not added)', () => {
    const items = ingestEnvelope([], env('session_error', { message: 'boom' }), { prefs: { ...PREFS, errors: false }, activeSessionId: null });
    expect(items).toHaveLength(0);
  });

  it('caps the list by dropping oldest FYI while keeping all blocking', () => {
    let items: InboxItem[] = [];
    // One blocking item first.
    items = ingestEnvelope(items, env('approval_requested', { approvalId: 'keep', title: 'keep' }, { ts: 1 }), ctx());
    // Flood with done items beyond the cap.
    for (let i = 0; i < INBOX_CAP + 10; i++) {
      items = ingestEnvelope(items, env('turn_completed', { summary: `t${i}` }, { session_id: `done${i}`, turn: i, ts: 100 + i }), ctx('active'));
    }
    expect(items.length).toBeLessThanOrEqual(INBOX_CAP);
    // The blocking approval survives the cull.
    expect(items.some(i => i.id === 'approval:keep')).toBe(true);
  });
});

describe('structured approval messages', () => {
  it('adds when pending, removes when auto-approved (same id → self-dedup)', () => {
    let items = applyApprovalCreated([], { id: 'a1', session_id: 's1', description: 'cmd', status: 'pending' }, PREFS, 5);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('approval:a1');
    items = applyApprovalCreated(items, { id: 'a1', session_id: 's1', description: 'cmd', status: 'auto-approved' }, PREFS, 6);
    expect(items).toHaveLength(0);
  });

  it('does not double-count the envelope + message for one approval', () => {
    let items = ingestEnvelope([], env('approval_requested', { approvalId: 'a1', title: 'X' }), ctx());
    items = applyApprovalCreated(items, { id: 'a1', session_id: 's1', description: 'X', status: 'pending' }, PREFS, 7);
    expect(items).toHaveLength(1);
  });

  it('removeApproval drops by approvalId (approval:updated has no session_id)', () => {
    const items = applyApprovalCreated([], { id: 'a1', session_id: 's1', description: 'x', status: 'pending' }, PREFS, 1);
    expect(removeApproval(items, 'a1')).toHaveLength(0);
  });
});

describe('reconcileFromSync', () => {
  const approval = (over: Partial<Approval>): Approval => ({
    id: 'a1', session_id: 's1', turn_id: 't', category: 'command', title: 'Run', command: '', reason: null,
    status: 'pending', resolved_by: null, resolved_at: null, created_at: '2026-06-05T00:00:00.000Z', ...over,
  });
  const session = (over: Partial<Session>): Session => ({
    id: 's1', workspace_id: 'w', name: 'S', executor: 'claude', status: 'error',
    runtime_mode: 'structured', branch: null, base_branch: null, worktree_outcome: null,
    archived: 0, created_at: '', updated_at: '2026-06-05T00:00:00.000Z', ...over,
  } as Session);

  it('rebuilds pending approvals + errored sessions, ignores the rest', () => {
    const items = reconcileFromSync(
      [approval({ id: 'a1', status: 'pending' }), approval({ id: 'a2', status: 'approved' })],
      [session({ id: 's1', status: 'error' }), session({ id: 's2', status: 'done' })],
    );
    expect(items.map(i => i.id).sort()).toEqual(['approval:a1', 'error:s1']);
    // Reconstructed items are pre-seen (read) so a reload doesn't spike the badge.
    expect(items.every(i => i.read)).toBe(true);
  });
});

describe('list maintenance', () => {
  const base: InboxItem[] = [
    { id: 'approval:a1', sessionId: 's1', kind: 'approval', subject: 'x', ts: 3, read: false },
    { id: 'error:s2', sessionId: 's2', kind: 'error', subject: 'y', ts: 2, read: false },
    { id: 'done:s1:1', sessionId: 's1', kind: 'done', subject: 'z', ts: 1, read: false },
  ];

  it('blockingCount counts approvals + errors only', () => {
    expect(blockingCount(base)).toBe(2);
  });
  it('clearFyi drops done rows', () => {
    expect(clearFyi(base).every(i => i.kind !== 'done')).toBe(true);
  });
  it('removeSession drops every row for a session', () => {
    expect(removeSession(base, 's1').map(i => i.id)).toEqual(['error:s2']);
  });
  it('clearSessionError drops only that session error row', () => {
    expect(clearSessionError(base, 's2').some(i => i.id === 'error:s2')).toBe(false);
  });
  it('markAllRead flips every unread item', () => {
    expect(markAllRead(base).every(i => i.read)).toBe(true);
  });
  it('markSessionRead flips only that session', () => {
    const read = markSessionRead(base, 's1');
    expect(read.find(i => i.id === 'approval:a1')!.read).toBe(true);
    expect(read.find(i => i.id === 'error:s2')!.read).toBe(false);
  });
});
