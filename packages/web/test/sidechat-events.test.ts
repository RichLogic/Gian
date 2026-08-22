/**
 * Side Chat snapshot projector (`src/presentation/sidechat-events.ts`,
 * gian.proxy/2.0 proposal §10.5): folds the Host-broadcast public snapshot
 * (raw notifications + user_inputs + uncertain_turn_id) through the shared
 * display pipeline, with deterministic turn numbering, and merges live
 * optimistic echoes until the snapshot catches up (SES-003 semantics).
 */
import { describe, expect, it } from 'vitest';
import type { SideChatInfo } from '@gian/shared';

import {
  mergeSideChatEchoes,
  projectSideChatSnapshot,
} from '../src/presentation/sidechat-events.js';
import type { MsgItem, TranscriptItem } from '../src/types.js';

function snapshot(overrides: Partial<SideChatInfo> = {}): SideChatInfo {
  return {
    id: 'sc-1',
    parent_session_id: 's-parent',
    stream_id: 'stream-1',
    state: 'idle',
    status: 'open',
    anchor: { type: 'empty' },
    session_config: {},
    last_error: null,
    uncertain_turn_id: null,
    events: [],
    user_inputs: [],
    created_at: '2026-08-20T08:00:00.000Z',
    updated_at: '2026-08-20T08:00:00.000Z',
    ...overrides,
  };
}

function notify(
  method: string,
  data: Record<string, unknown>,
  turnId: string | null = 'pt-1',
  emittedAt = '2026-08-20T08:01:00.000Z',
): unknown {
  return {
    jsonrpc: '2.0',
    method,
    params: { sessionId: 'sc-1', ...(turnId !== null ? { turnId } : {}), emittedAt, data },
  };
}

const OPTIONS = { uncertainTurnMessage: 'Turn interrupted — outcome uncertain.' };

describe('projectSideChatSnapshot', () => {
  it('projects user inputs ahead of their turn and runtime events in order, with sequential turn numbers', () => {
    const items = projectSideChatSnapshot(snapshot({
      user_inputs: [
        { turn_id: 'pt-1', input: [{ type: 'text', text: 'first question' }], created_at: '2026-08-20T08:00:30.000Z' },
        { turn_id: 'pt-2', input: [{ type: 'text', text: 'second question' }], created_at: '2026-08-20T08:03:30.000Z' },
      ],
      events: [
        notify('turn.started', {}, 'pt-1', '2026-08-20T08:00:31.000Z'),
        notify('content.delta', { contentId: 'c-1', kind: 'text', delta: 'answer one' }, 'pt-1', '2026-08-20T08:01:00.000Z'),
        notify('turn.completed', {}, 'pt-1', '2026-08-20T08:02:00.000Z'),
        notify('turn.started', {}, 'pt-2', '2026-08-20T08:03:31.000Z'),
        notify('content.delta', { contentId: 'c-2', kind: 'text', delta: 'answer two' }, 'pt-2', '2026-08-20T08:04:00.000Z'),
      ],
    }), 'codex', OPTIONS);

    const visible = items.filter(item => item.kind !== 'turn-end');
    expect(visible.map(item => item.kind)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(visible[0]).toMatchObject({ text: 'first question', turn: 1, exec: 'codex' });
    expect(visible[1]).toMatchObject({ text: 'answer one', turn: 1 });
    expect(visible[2]).toMatchObject({ text: 'second question', turn: 2 });
    expect(visible[3]).toMatchObject({ text: 'answer two', turn: 2 });
  });

  it('renders reasoning, tool, command, interaction and diff content through the shared pipeline (never a fake tool-less mode)', () => {
    const items = projectSideChatSnapshot(snapshot({
      events: [
        notify('turn.started', {}, 'pt-1', '2026-08-20T08:00:31.000Z'),
        notify('content.delta', { contentId: 'r-1', kind: 'reasoning', delta: 'thinking' }, 'pt-1', '2026-08-20T08:00:40.000Z'),
        notify('activity.updated', {
          activityId: 'a-cmd', status: 'succeeded', title: 'ls',
          presentation: { type: 'command', data: { command: 'ls -la' } },
        }, 'pt-1', '2026-08-20T08:00:50.000Z'),
        notify('activity.updated', {
          activityId: 'a-tool', status: 'running', title: 'Custom Gadget',
          presentation: { type: 'gadget', data: { input: { x: 1 } } },
        }, 'pt-1', '2026-08-20T08:01:00.000Z'),
        notify('interaction.requested', {
          interactionId: 'i-1', title: 'Allow?', description: 'rm it',
          presentation: { kind: 'permission', tone: 'danger' },
          actions: [{ id: 'allow', label: 'Allow', style: 'primary' }],
          context: { subject: { toolName: 'Bash', inputPreview: 'rm -rf /tmp/x' } },
        }, 'pt-1', '2026-08-20T08:01:30.000Z'),
        notify('interaction.resolved', { interactionId: 'i-1', outcome: 'submitted', actionId: 'allow' }, 'pt-1', '2026-08-20T08:02:00.000Z'),
        notify('diff.updated', { diffId: 'd-1', files: [{ path: 'a.ts', status: 'added' }], diff: '+++ b/a.ts' }, 'pt-1', '2026-08-20T08:02:30.000Z'),
      ],
    }), 'claude', OPTIONS);

    const kinds = items.map(item => item.kind);
    expect(kinds).toContain('reasoning');
    expect(kinds).toContain('command');
    // Unknown activity kinds land on the stable generic tool card (§15).
    expect(kinds).toContain('tool');
    expect(kinds).toContain('approval');
    expect(kinds).toContain('diff');
    const approval = items.find(item => item.kind === 'approval');
    expect(approval).toMatchObject({ approvalId: 'i-1', status: 'approved-once' });
  });

  it('skips trace-only and unknown notifications (step/request updated, catalog.changed)', () => {
    const items = projectSideChatSnapshot(snapshot({
      events: [
        notify('step.updated', { stepId: 's-1' }),
        notify('request.updated', { requestId: 'req-1' }),
        notify('catalog.changed', {}, null),
        notify('some.future.method', { whatever: true }),
      ],
    }), 'codex', OPTIONS);
    expect(items).toEqual([]);
  });

  it('marks a crash-interrupted uncertain turn as failed/interrupted (§10.5.3) — but not one that terminated', () => {
    const uncertain = projectSideChatSnapshot(snapshot({
      uncertain_turn_id: 'pt-1',
      events: [notify('turn.started', {}, 'pt-1', '2026-08-20T08:00:31.000Z')],
    }), 'codex', OPTIONS);
    expect(uncertain.some(item => item.kind === 'error')).toBe(true);

    const terminated = projectSideChatSnapshot(snapshot({
      uncertain_turn_id: 'pt-1',
      events: [
        notify('turn.started', {}, 'pt-1', '2026-08-20T08:00:31.000Z'),
        notify('turn.completed', {}, 'pt-1', '2026-08-20T08:02:00.000Z'),
      ],
    }), 'codex', OPTIONS);
    expect(terminated.some(item => item.kind === 'error')).toBe(false);
  });

  it('is pure: the same snapshot projects to identical items (stable ids for re-projection)', () => {
    const snap = snapshot({
      user_inputs: [{ turn_id: 'pt-1', input: [{ type: 'text', text: 'q' }], created_at: '2026-08-20T08:00:30.000Z' }],
      events: [notify('content.delta', { contentId: 'c-1', kind: 'text', delta: 'a' })],
    });
    expect(projectSideChatSnapshot(snap, 'codex', OPTIONS))
      .toEqual(projectSideChatSnapshot(snap, 'codex', OPTIONS));
  });
});

describe('mergeSideChatEchoes', () => {
  const echo = (text: string, overrides: Partial<MsgItem> = {}): MsgItem => ({
    kind: 'user',
    id: `optimistic:sc-1:run-1`,
    text,
    exec: 'codex',
    ts: 1,
    turn: 0,
    pending: true,
    sendRunId: 'run-1',
    ...overrides,
  });
  const projectedUser = (text: string): TranscriptItem => ({
    kind: 'user', id: `sidechat-input:pt-1:1`, text, exec: 'codex', ts: 1, turn: 1,
  });

  it('keeps a pending echo while the snapshot has not caught up, drops it once the canonical user message is projected', () => {
    const previous = [echo('hello')];
    expect(mergeSideChatEchoes([], previous)).toHaveLength(1);
    expect(mergeSideChatEchoes([projectedUser('hello')], previous)).toEqual([projectedUser('hello')]);
  });

  it('always keeps FAILED echoes (the retry affordance) and never touches non-echo items', () => {
    const failed = echo('lost', { pending: false, failed: true });
    const merged = mergeSideChatEchoes([projectedUser('lost')], [failed]);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ failed: true });
  });
});
