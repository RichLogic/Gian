// Trace frontend MVP — transcript → TraceSnapshot projection tests.
// Pins the interim bridge the Trace tab is fed from until the Host
// publishes native snapshots: kind mapping, 'derived'
// evidence on every item, turn tracks with explicit status, tool status
// mapping, correlationId = provider call id, partial flag pass-through, and
// that the projection invents nothing (no reasoning/plan placeholders).

import { describe, expect, it } from 'vitest';
import { deriveTraceSnapshot } from '../src/trace/derive.js';
import { groupTraceByTurn } from '../src/trace/model.js';
import type { TranscriptItem } from '../src/types.js';

const OPTS = { partial: false, generatedAt: '2026-08-15T10:00:00.000Z' };

function items(): TranscriptItem[] {
  return [
    { kind: 'turn-start', id: 'ts-1', text: '', ts: 1_000, turn: 1 },
    { kind: 'user', id: 'u-1', text: 'hello there', exec: 'claude', ts: 1_100, turn: 1 },
    {
      kind: 'tool', id: 'call-1', name: 'Bash', summary: '{"command":"ls"}',
      status: 'success', output: 'ok', ts: 1_500, turn: 1,
    },
    {
      kind: 'tool', id: 'call-2', name: 'Read', summary: '',
      status: 'running', ts: 1_800, turn: 1,
    },
    { kind: 'assistant', id: 'a-1', text: 'done', exec: 'claude', ts: 2_000, turn: 1 },
    { kind: 'turn-end', id: 'te-1', text: '', ts: 3_000, turn: 1 },
  ];
}

describe('deriveTraceSnapshot', () => {
  it('maps transcript kinds onto the trace contract', () => {
    const snapshot = deriveTraceSnapshot(items(), 'sess-1', OPTS);
    const byKind = new Map(snapshot.items.map(i => [i.kind, i]));
    expect(byKind.get('input')?.title).toBe('hello there');
    expect(byKind.get('assistant')?.title).toBe('done');
    const tools = snapshot.items.filter(i => i.kind === 'tool');
    expect(tools.map(i => i.title)).toEqual(['Bash', 'Read']);
  });

  it('stamps every projected item as derived evidence', () => {
    const snapshot = deriveTraceSnapshot(items(), 'sess-1', OPTS);
    expect(snapshot.items.length).toBeGreaterThan(0);
    for (const item of snapshot.items) {
      expect(item.evidence).toBe('derived');
      expect(item.sourceEventIds.length).toBeGreaterThan(0);
    }
  });

  it('synthesizes one turn track with bounds and an explicit status', () => {
    const snapshot = deriveTraceSnapshot(items(), 'sess-1', OPTS);
    const turn = snapshot.items.find(i => i.kind === 'turn');
    expect(turn).toBeDefined();
    expect(turn!.turnId).toBe('turn:1');
    expect(turn!.status).toBe('succeeded');
    expect(turn!.at).toBe(new Date(1_000).toISOString());
    expect(turn!.endAt).toBe(new Date(3_000).toISOString());
    const groups = groupTraceByTurn(snapshot.items);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.durationMs).toBe(2_000);
  });

  it('marks a turn without turn-end as running', () => {
    const snapshot = deriveTraceSnapshot(
      items().filter(i => i.kind !== 'turn-end'),
      'sess-1',
      OPTS,
    );
    expect(snapshot.items.find(i => i.kind === 'turn')?.status).toBe('running');
  });

  it('marks a turn with an error item as failed', () => {
    const snapshot = deriveTraceSnapshot(
      [...items(), { kind: 'error', id: 'e-1', text: 'boom', ts: 2_500, turn: 1 }],
      'sess-1',
      OPTS,
    );
    expect(snapshot.items.find(i => i.kind === 'turn')?.status).toBe('failed');
    const notice = snapshot.items.find(i => i.id === '1:error:e-1');
    expect(notice?.kind).toBe('notice');
    expect(notice?.status).toBe('failed');
  });

  it('maps tool statuses and keeps the provider call id as correlationId', () => {
    const snapshot = deriveTraceSnapshot(items(), 'sess-1', OPTS);
    const bash = snapshot.items.find(i => i.title === 'Bash');
    const read = snapshot.items.find(i => i.title === 'Read');
    expect(bash?.status).toBe('succeeded');
    expect(bash?.correlationId).toBe('call-1');
    expect(read?.status).toBe('running');
    expect(read?.correlationId).toBe('call-2');
  });

  it('passes the partial flag through untouched', () => {
    const snapshot = deriveTraceSnapshot(items(), 'sess-1', { ...OPTS, partial: true });
    expect(snapshot.partial).toBe(true);
    expect(snapshot.generatedAt).toBe(OPTS.generatedAt);
    expect(snapshot.sessionId).toBe('sess-1');
  });

  it('invents no reasoning/plan items when the transcript has none', () => {
    const snapshot = deriveTraceSnapshot(items(), 'sess-1', OPTS);
    expect(snapshot.items.some(i => i.kind === 'reasoning')).toBe(false);
    expect(snapshot.items.some(i => i.kind === 'plan')).toBe(false);
  });

  it('anchors a turn seen only on content items (no turn-start marker)', () => {
    const snapshot = deriveTraceSnapshot(
      [{ kind: 'user', id: 'u-9', text: 'loose', exec: 'claude', ts: 5_000, turn: 9 }],
      'sess-1',
      OPTS,
    );
    const turn = snapshot.items.find(i => i.kind === 'turn');
    expect(turn?.turnId).toBe('turn:9');
    expect(turn?.at).toBe(new Date(5_000).toISOString());
    expect(turn?.status).toBe('running');
  });

  it('projects agent spawns with their own time bounds', () => {
    const snapshot = deriveTraceSnapshot(
      [{
        kind: 'agent-spawn', id: 'agent-1', provider: 'claude',
        description: 'Explore the repo', status: 'done',
        startedAt: 10_000, updatedAt: 11_000, completedAt: 16_000,
        ts: 10_000, turn: 2,
      }],
      'sess-1',
      OPTS,
    );
    const agent = snapshot.items.find(i => i.kind === 'agent');
    expect(agent?.status).toBe('succeeded');
    expect(agent?.at).toBe(new Date(10_000).toISOString());
    expect(agent?.endAt).toBe(new Date(16_000).toISOString());
  });
});
