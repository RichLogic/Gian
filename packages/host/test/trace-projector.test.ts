import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { TraceEvidenceRow } from '../src/trace/evidence-store.js';
import { projectTraceSnapshot } from '../src/trace/projector.js';
import type { TraceItem, TraceSnapshot } from '@gian/shared';

const T0 = '2026-08-10T05:30:00.000Z';

function at(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

function evt(
  eventId: string,
  method: string,
  sequence: number,
  turnId: string | null,
  data: Record<string, unknown>,
  emittedAt = at(sequence * 1000),
  streamGeneration = 1,
): TraceEvidenceRow {
  return {
    eventId,
    streamId: 'stream-1',
    sequence,
    streamGeneration,
    sessionId: 's1',
    turnId,
    emittedAt,
    method,
    data,
  };
}

function snapshot(rows: TraceEvidenceRow[]): TraceSnapshot {
  return projectTraceSnapshot('s1', rows, '2026-08-10T06:00:00.000Z');
}

function byKind(snap: TraceSnapshot, kind: TraceItem['kind']): TraceItem[] {
  return snap.items.filter(item => item.kind === kind);
}

test('TRACE: a normal turn projects turn/input/assistant/tool items in sequence order', () => {
  const rows = [
    evt('e1', 'turn.started', 1, 't1', {}),
    evt('e2', 'input.recorded', 2, 't1', { inputId: 'in-1', input: [{ type: 'text', text: 'hello' }] }),
    evt('e3', 'content.delta', 3, 't1', { contentId: 'c1', kind: 'text', delta: 'Hel' }),
    evt('e4', 'content.delta', 4, 't1', { contentId: 'c1', kind: 'text', delta: 'lo ' }),
    evt('e5', 'content.completed', 5, 't1', { contentId: 'c1', kind: 'text', content: 'Hello world' }),
    evt('e6', 'tool.started', 6, 't1', { toolCallId: 'bash-1', name: 'Bash', input: { command: 'ls' } }),
    evt('e7', 'tool.updated', 7, 't1', { toolCallId: 'bash-1', statusText: 'running' }),
    evt('e8', 'tool.completed', 8, 't1', { toolCallId: 'bash-1', status: 'succeeded' }),
    evt('e9', 'tool.started', 9, 't1', { toolCallId: 'read-1', name: 'Read', title: 'Read file' }),
    evt('e10', 'tool.completed', 10, 't1', {
      toolCallId: 'read-1',
      status: 'failed',
      error: { code: 'TOOL_ERROR', message: 'boom', retryable: false },
    }),
    evt('e11', 'turn.completed', 11, 't1', { stopReason: 'completed' }),
  ];
  const snap = snapshot(rows);
  assert.equal(snap.partial, false);
  assert.deepEqual(snap.items.map(item => item.kind), [
    'turn', 'input', 'assistant', 'tool', 'tool',
  ]);

  const [turn] = byKind(snap, 'turn');
  assert.equal(turn!.turnId, 't1');
  assert.equal(turn!.status, 'succeeded');
  assert.equal(turn!.at, at(1000));
  assert.equal(turn!.endAt, at(11000));
  assert.equal(turn!.durationMs, 10000);
  assert.equal(turn!.evidence, 'derived');
  assert.equal(turn!.summary, 'hello');
  assert.deepEqual(turn!.sourceEventIds, ['e1', 'e11']);

  const [input] = byKind(snap, 'input');
  assert.equal(input!.evidence, 'native');
  assert.equal(input!.correlationId, 'in-1');
  assert.equal(input!.summary, 'hello');

  const [assistant] = byKind(snap, 'assistant');
  assert.equal(assistant!.summary, 'Hello world');
  assert.equal(assistant!.status, 'succeeded');
  assert.equal(assistant!.evidence, 'derived');
  assert.deepEqual(assistant!.sourceEventIds, ['e3', 'e4', 'e5']);
  assert.equal(assistant!.durationMs, 2000);

  const tools = byKind(snap, 'tool');
  assert.equal(tools.length, 2);
  const bash = tools.find(tool => tool.correlationId === 'bash-1');
  assert.equal(bash!.title, 'Bash');
  assert.equal(bash!.status, 'succeeded');
  assert.equal(bash!.evidence, 'derived');
  assert.equal(bash!.summary, JSON.stringify({ command: 'ls' }));
  assert.deepEqual(bash!.sourceEventIds, ['e6', 'e7', 'e8']);
  const read = tools.find(tool => tool.correlationId === 'read-1');
  assert.equal(read!.title, 'Read file');
  assert.equal(read!.status, 'failed');
  assert.equal((read!.detail as { error: { code: string } }).error.code, 'TOOL_ERROR');
  assert.equal(read!.durationMs, 1000);
  assert.equal(byKind(snap, 'reasoning').length, 0);
  assert.equal(byKind(snap, 'plan').length, 0);
  assert.equal(byKind(snap, 'agent').length, 0);
  assert.equal(byKind(snap, 'notice').length, 0);
});

test('TRACE: one tool with started + multiple updates + completed yields one item', () => {
  const rows = [
    evt('e1', 'turn.started', 1, 't1', {}),
    evt('e2', 'tool.started', 2, 't1', { toolCallId: 'bash-1', name: 'Bash', input: { command: 'x' } }),
    evt('e3', 'tool.updated', 3, 't1', { toolCallId: 'bash-1', statusText: 'working' }),
    evt('e4', 'tool.updated', 4, 't1', { toolCallId: 'bash-1', statusText: 'still working' }),
    evt('e5', 'tool.completed', 5, 't1', { toolCallId: 'bash-1', status: 'succeeded' }),
    evt('e6', 'turn.completed', 6, 't1', { stopReason: 'completed' }),
  ];
  const snap = snapshot(rows);
  const tools = byKind(snap, 'tool');
  assert.equal(tools.length, 1);
  const tool = tools[0]!;
  assert.equal(tool.correlationId, 'bash-1');
  assert.equal(tool.status, 'succeeded');
  assert.deepEqual(tool.sourceEventIds, ['e2', 'e3', 'e4', 'e5']);
  assert.equal(tool.durationMs, 3000);
  assert.equal(tool.detail && (tool.detail as { statusText: string }).statusText, 'still working');
  assert.equal(snap.partial, false);
});

test('TRACE: tool failed and interrupted map to their own statuses', () => {
  const rows = [
    evt('e1', 'turn.started', 1, 't1', {}),
    evt('e2', 'tool.started', 2, 't1', { toolCallId: 'f-1', name: 'Bash', input: {} }),
    evt('e3', 'tool.completed', 3, 't1', {
      toolCallId: 'f-1',
      status: 'failed',
      error: { code: 'E', message: 'nope', retryable: false },
    }),
    evt('e4', 'tool.started', 4, 't1', { toolCallId: 'i-1', name: 'Read', input: {} }),
    evt('e5', 'tool.completed', 5, 't1', { toolCallId: 'i-1', status: 'interrupted' }),
    evt('e6', 'turn.completed', 6, 't1', { stopReason: 'completed' }),
  ];
  const snap = snapshot(rows);
  const tools = byKind(snap, 'tool');
  assert.equal(tools.find(tool => tool.correlationId === 'f-1')!.status, 'failed');
  assert.equal(tools.find(tool => tool.correlationId === 'i-1')!.status, 'interrupted');
  assert.equal(tools.find(tool => tool.correlationId === 'i-1')!.endAt, at(5000));
  assert.equal(snap.partial, false);
});

test('TRACE: duplicate eventIds and replay input never duplicate items', () => {
  const rows = [
    evt('e1', 'turn.started', 1, 't1', {}),
    evt('e2', 'tool.started', 2, 't1', { toolCallId: 'bash-1', name: 'Bash', input: {} }),
    // replay re-delivers the same eventIds
    evt('e1', 'turn.started', 1, 't1', {}),
    evt('e2', 'tool.started', 2, 't1', { toolCallId: 'bash-1', name: 'Bash', input: {} }),
    evt('e3', 'tool.completed', 3, 't1', { toolCallId: 'bash-1', status: 'succeeded' }),
    evt('e3', 'tool.completed', 3, 't1', { toolCallId: 'bash-1', status: 'succeeded' }),
    evt('e4', 'turn.completed', 4, 't1', { stopReason: 'completed' }),
  ];
  const snap = snapshot(rows);
  assert.equal(byKind(snap, 'turn').length, 1);
  assert.equal(byKind(snap, 'tool').length, 1);
  const tool = byKind(snap, 'tool')[0]!;
  assert.deepEqual(tool.sourceEventIds, ['e2', 'e3']);
  assert.equal(tool.durationMs, 1000);
});

test('TRACE: reasoning/plan/agent/notice appear only when events exist', () => {
  const rows = [
    evt('e1', 'turn.started', 1, 't1', {}),
    evt('e2', 'content.completed', 2, 't1', { contentId: 'r1', kind: 'reasoning', content: 'think' }),
    evt('e3', 'plan.updated', 3, 't1', {
      planId: 'p1',
      title: 'Plan A',
      steps: [{ status: 'completed', text: 'do it' }, { status: 'pending', text: 'ship' }],
    }),
    evt('e4', 'agent.updated', 4, 't1', {
      agentId: 'a1',
      status: 'completed',
      description: 'Subagent',
      agentType: 'subagent',
      model: 'm1',
      output: 'done',
    }),
    evt('e5', 'notice.created', 5, 't1', {
      noticeId: 'n1',
      severity: 'warning',
      code: 'WARN',
      title: 'Heads up',
      message: 'careful',
    }),
    evt('e6', 'turn.completed', 6, 't1', { stopReason: 'completed' }),
  ];
  const snap = snapshot(rows);
  const reasoning = byKind(snap, 'reasoning');
  assert.equal(reasoning.length, 1);
  assert.equal(reasoning[0]!.summary, 'think');
  assert.equal(reasoning[0]!.evidence, 'native');
  const plan = byKind(snap, 'plan');
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.summary, '- [x] do it\n- [ ] ship');
  assert.equal(plan[0]!.title, 'Plan A');
  const agent = byKind(snap, 'agent');
  assert.equal(agent.length, 1);
  assert.equal(agent[0]!.status, 'succeeded');
  assert.equal(agent[0]!.summary, 'done');
  const notice = byKind(snap, 'notice');
  assert.equal(notice.length, 1);
  assert.equal(notice[0]!.title, 'Heads up');
  assert.equal(notice[0]!.summary, 'careful');
  assert.equal(snap.partial, false);
});

test('TRACE: orphan tool completion and missing boundaries mark partial without crashing', () => {
  // Only a tool.completed and a turn.completed: no turn.started, no tool.started.
  const rows = [
    evt('e1', 'tool.completed', 1, 't1', { toolCallId: 'bash-1', status: 'succeeded' }),
    evt('e2', 'turn.completed', 2, 't1', { stopReason: 'completed' }),
  ];
  const snap = snapshot(rows);
  assert.equal(snap.partial, true);
  const turn = byKind(snap, 'turn')[0]!;
  assert.equal(turn.status, 'succeeded');
  assert.equal(turn.at, at(1000), 'turn time falls back to the first evidence event');
  assert.equal(turn.durationMs, undefined);
  const tool = byKind(snap, 'tool')[0]!;
  assert.equal(tool.status, 'succeeded');
  assert.equal(tool.evidence, 'derived');
  assert.equal(tool.durationMs, undefined);
});

test('TRACE: completion-only tool never fabricates a duration', () => {
  const rows = [
    evt('e1', 'turn.started', 1, 't1', {}),
    evt('e2', 'tool.completed', 2, 't1', { toolCallId: 'bash-1', status: 'succeeded' }),
    evt('e3', 'turn.completed', 3, 't1', { stopReason: 'completed' }),
  ];
  const snap = snapshot(rows);
  const tool = byKind(snap, 'tool')[0]!;
  assert.equal(tool.status, 'succeeded');
  assert.equal(tool.endAt, at(2000), 'endAt comes from the real terminal event');
  assert.equal(tool.durationMs, undefined, 'completion-only must not fabricate duration');
  assert.equal(snap.partial, true, 'missing tool.started is an evidence gap');
});

test('TRACE: update + completion without started never fabricates a duration', () => {
  const rows = [
    evt('e1', 'turn.started', 1, 't1', {}),
    evt('e2', 'tool.updated', 2, 't1', { toolCallId: 'bash-1', statusText: 'working' }),
    evt('e3', 'tool.updated', 3, 't1', { toolCallId: 'bash-1', statusText: 'still working' }),
    evt('e4', 'tool.completed', 4, 't1', { toolCallId: 'bash-1', status: 'succeeded' }),
    evt('e5', 'turn.completed', 5, 't1', { stopReason: 'completed' }),
  ];
  const snap = snapshot(rows);
  const tool = byKind(snap, 'tool')[0]!;
  assert.equal(tool.status, 'succeeded');
  assert.equal(tool.endAt, at(4000), 'endAt still comes from the terminal event');
  assert.equal(tool.durationMs, undefined, 'update time must not stand in for started');
  assert.equal(tool.detail && (tool.detail as { statusText: string }).statusText, 'still working');
  assert.equal(snap.partial, true);
});

test('TRACE: started + completed keeps the correct duration', () => {
  const rows = [
    evt('e1', 'turn.started', 1, 't1', {}),
    evt('e2', 'tool.started', 2, 't1', { toolCallId: 'bash-1', name: 'Bash', input: {} }),
    evt('e3', 'tool.updated', 3, 't1', { toolCallId: 'bash-1', statusText: 'working' }),
    evt('e4', 'tool.completed', 4, 't1', { toolCallId: 'bash-1', status: 'succeeded' }),
    evt('e5', 'turn.completed', 5, 't1', { stopReason: 'completed' }),
  ];
  const snap = snapshot(rows);
  const tool = byKind(snap, 'tool')[0]!;
  assert.equal(tool.durationMs, 2000, 'started -> completed duration is exact');
  assert.equal(tool.endAt, at(4000));
  assert.equal(snap.partial, false);
});

test('TRACE: running turn without terminal event has no fabricated end time', () => {
  const rows = [
    evt('e1', 'turn.started', 1, 't1', {}),
    evt('e2', 'content.delta', 2, 't1', { contentId: 'c1', kind: 'text', delta: 'partial' }),
    evt('e3', 'tool.started', 3, 't1', { toolCallId: 'bash-1', name: 'Bash', input: {} }),
  ];
  const snap = snapshot(rows);
  assert.equal(snap.partial, true);
  const turn = byKind(snap, 'turn')[0]!;
  assert.equal(turn.status, 'running');
  assert.equal(turn.endAt, undefined);
  assert.equal(turn.durationMs, undefined);
  const tool = byKind(snap, 'tool')[0]!;
  assert.equal(tool.status, 'running');
  assert.equal(tool.endAt, undefined);
  assert.equal(tool.durationMs, undefined);
  const assistant = byKind(snap, 'assistant')[0]!;
  assert.equal(assistant.status, 'running');
  assert.equal(assistant.endAt, undefined);
  assert.equal(assistant.durationMs, undefined);
});

test('TRACE: unattachable rows and unparseable timestamps mark partial', () => {
  const rows = [
    evt('e1', 'turn.started', 1, null, {}),
    evt('e2', 'usage.updated', 2, 't1', { conversation: { mode: 'absolute', inputTokens: 1 } }),
    evt('e3', 'turn.started', 3, 't2', {}, 'not-a-timestamp'),
    evt('e4', 'turn.completed', 4, 't2', { stopReason: 'completed' }, 'also-broken'),
  ];
  const snap = snapshot(rows);
  assert.equal(snap.partial, true);
  // usage.updated is turn-scoped, so it implies a running turn and a Usage
  // evidence item; the null-turnId row is skipped; t2 has broken timestamps.
  assert.deepEqual(snap.items.map(item => item.turnId), ['t1', 't1', 't2']);
  assert.equal(snap.items[2]!.at, 'not-a-timestamp');
  assert.equal(snap.items[2]!.status, 'succeeded');
});

test('TRACE: re-attached streams sort after older streams despite reset sequences', () => {
  // stream-1 (generation 1) runs to sequence 3; the session re-attaches with
  // stream-2 (generation 2) which resets sequence to 1.
  const rows = [
    evt('e1', 'turn.started', 1, 't1', {}),
    evt('e2', 'turn.completed', 2, 't1', { stopReason: 'completed' }),
    evt('e3', 'turn.started', 3, 't2', {}),
    evt('e4', 'turn.completed', 1, 't3', { stopReason: 'completed' }, at(4000), 2),
    evt('e5', 'turn.started', 2, 't3', {}, at(5000), 2),
  ];
  const snap = snapshot(rows);
  assert.deepEqual(snap.items.map(item => item.turnId), ['t1', 't2', 't3'],
    'generation 1 events (sequences 1-3) sort before generation 2 (sequence reset)');
  const t2 = byKind(snap, 'turn').find(item => item.turnId === 't2')!;
  const t3 = byKind(snap, 'turn').find(item => item.turnId === 't3')!;
  assert.equal(t2.status, 'running');
  assert.equal(t3.status, 'succeeded');
  assert.equal(t3.at, at(5000), 'turn.at comes from its real started event');
});

test('TRACE: stable ordering and durations across multiple turns', () => {
  const rows = [
    evt('e1', 'turn.started', 1, 't1', {}),
    evt('e2', 'turn.started', 2, 't2', {}),
    evt('e3', 'tool.started', 3, 't1', { toolCallId: 'bash-1', name: 'Bash', input: {} }),
    evt('e4', 'tool.completed', 4, 't1', { toolCallId: 'bash-1', status: 'succeeded' }),
    evt('e5', 'content.completed', 5, 't2', { contentId: 'c1', kind: 'text', content: 'second turn' }),
    evt('e6', 'turn.completed', 6, 't1', { stopReason: 'completed' }),
  ];
  const snap = snapshot(rows);
  assert.equal(snap.partial, true, 't2 has no terminal');
  assert.deepEqual(snap.items.map(item => item.id), [
    'turn:t1',
    'turn:t2',
    'tool:t1:bash-1',
    'content:t2:c1:text',
  ]);
  // Deterministic re-run gives the identical snapshot.
  assert.deepEqual(snapshot(rows), snap);
  const t1 = byKind(snap, 'turn').find(item => item.turnId === 't1')!;
  assert.equal(t1.durationMs, 5000);
  const t2 = byKind(snap, 'turn').find(item => item.turnId === 't2')!;
  assert.equal(t2.status, 'running');
  assert.equal(t2.durationMs, undefined);
});

test('TRACE: turn stop reasons map to interrupted/failed statuses', () => {
  const cases: Array<[string, string]> = [
    ['interrupted', 'interrupted'],
    ['cancelled', 'interrupted'],
    ['limit_reached', 'failed'],
    ['refused', 'failed'],
    ['other', 'failed'],
  ];
  for (const [reason, expected] of cases) {
    const snap = snapshot([
      evt('e1', 'turn.started', 1, 't1', {}),
      evt('e2', 'turn.completed', 2, 't1', { stopReason: reason }),
    ]);
    assert.equal(byKind(snap, 'turn')[0]!.status, expected, reason);
  }
  const failed = snapshot([
    evt('e1', 'turn.started', 1, 't1', {}),
    evt('e2', 'turn.failed', 2, 't1', {
      error: { code: 'TURN_FAILED', message: 'provider error', retryable: true },
    }),
  ]);
  const turn = byKind(failed, 'turn')[0]!;
  assert.equal(turn.status, 'failed');
  assert.equal((turn.detail as { error: { code: string } }).error.code, 'TURN_FAILED');
});

test('TRACE: single native event stays native; aggregated streams are derived', () => {
  const rows = [
    evt('e1', 'turn.started', 1, 't1', {}),
    evt('e2', 'content.completed', 2, 't1', { contentId: 'c1', kind: 'text', content: 'one shot' }),
    evt('e3', 'turn.completed', 3, 't1', { stopReason: 'completed' }),
  ];
  const snap = snapshot(rows);
  assert.equal(byKind(snap, 'assistant')[0]!.evidence, 'native');
  assert.equal(byKind(snap, 'turn')[0]!.evidence, 'derived');
});
