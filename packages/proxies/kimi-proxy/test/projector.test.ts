/** Kimi Code 2.1.1 volatile frames reuse the current durable journal seq.
 *  Assistant text is kind `text` and split per step so it stays a message
 *  outside the Working basket. Tool rows stay activities inside that basket. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { KimiSessionProjector, type KimiProjectedFrame, type OuterNotification } from '../src/core/projector.js';

function createProjector(): { projector: KimiSessionProjector; events: OuterNotification[] } {
  const events: OuterNotification[] = [];
  let sequence = 0;
  const projector = new KimiSessionProjector({
    gianSessionId: 's',
    nativeSessionId: 'native',
    nextSequence: () => {
      sequence += 1;
      return sequence;
    },
    emit: (notification) => events.push(notification),
    finalUsage: async () => null,
    fileDiff: async () => null,
  });
  projector.setStreamId('stream-1');
  projector.bindTurn({ gianTurnId: 't', promptId: 'p' });
  return { projector, events };
}

function frame(partial: KimiProjectedFrame): KimiProjectedFrame {
  return partial;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function dataOf(event: OuterNotification): Record<string, unknown> {
  return event.params.data as Record<string, unknown>;
}

test('volatile thinking and assistant deltas that reuse the durable seq are projected', async () => {
  const { projector, events } = createProjector();
  assert.equal(projector.handleFrame(frame({
    type: 'turn.started', seq: 4, payload: { agentId: 'main', turnId: 1 },
  })), true);
  assert.equal(projector.handleFrame(frame({
    type: 'turn.step.started', seq: 5, payload: { agentId: 'main', turnId: 1, step: 1 },
  })), true);
  assert.equal(projector.handleFrame(frame({
    type: 'thinking.delta', seq: 5, volatile: true, offset: 0,
    payload: { agentId: 'main', delta: 'Think' },
  })), true);
  assert.equal(projector.handleFrame(frame({
    type: 'thinking.delta', seq: 5, volatile: true, offset: 5,
    payload: { agentId: 'main', delta: 'ing' },
  })), true);
  assert.equal(projector.handleFrame(frame({
    type: 'thinking.delta', seq: 5, volatile: true, offset: 0,
    payload: { agentId: 'main', delta: 'dup' },
  })), true, 'a stale offset is consumed and not appended');
  assert.equal(projector.handleFrame(frame({
    type: 'assistant.delta', seq: 5, volatile: true, offset: 0,
    payload: { agentId: 'main', delta: 'Hi' },
  })), true);
  assert.equal(projector.handleFrame(frame({
    type: 'assistant.delta', seq: 5, volatile: true, offset: 2,
    payload: { agentId: 'main', delta: '!' },
  })), true);
  assert.equal(projector.handleFrame(frame({
    type: 'turn.ended', seq: 6, payload: { agentId: 'main', turnId: 1, reason: 'completed' },
  })), true, 'the next durable seq is still accepted');

  await flush();
  const deltas = events.filter((event) => event.method === 'content.delta');
  const reasoning = deltas.filter((event) => dataOf(event).kind === 'reasoning');
  const text = deltas.filter((event) => dataOf(event).kind === 'text');
  assert.deepEqual(reasoning.map((event) => dataOf(event).delta), ['Think', 'ing']);
  assert.deepEqual(text.map((event) => dataOf(event).delta), ['Hi', '!']);
  assert.equal(dataOf(text[0]!).contentId, 'assistant:p:1');
  assert.equal(dataOf(reasoning[0]!).contentId, 'thinking:p:1');
  const ids = deltas.map((event) => event.params.eventId);
  assert.equal(new Set(ids).size, ids.length, 'each delta keeps its own eventId');

  const completed = events.filter((event) => event.method === 'content.completed');
  assert.equal(dataOf(completed.find((event) => dataOf(event).kind === 'reasoning')!).content, 'Thinking');
  assert.equal(dataOf(completed.find((event) => dataOf(event).kind === 'text')!).content, 'Hi!');
  assert.equal(events.some((event) => event.method === 'turn.completed'), true);
});

test('each step keeps its own assistant message and its own thinking card', async () => {
  const { projector, events } = createProjector();
  projector.handleFrame(frame({ type: 'turn.started', seq: 1, payload: { agentId: 'main', turnId: 1 } }));
  projector.handleFrame(frame({ type: 'turn.step.started', seq: 2, payload: { agentId: 'main', turnId: 1, step: 1 } }));
  projector.handleFrame(frame({
    type: 'thinking.delta', seq: 2, volatile: true, offset: 2,
    payload: { agentId: 'main', delta: 'ab' },
  }));
  projector.handleFrame(frame({
    type: 'assistant.delta', seq: 2, volatile: true, offset: 0,
    payload: { agentId: 'main', delta: '还没有' },
  }));
  projector.handleFrame(frame({ type: 'turn.step.started', seq: 3, payload: { agentId: 'main', turnId: 1, step: 2 } }));
  projector.handleFrame(frame({
    type: 'thinking.delta', seq: 3, volatile: true, offset: 0,
    payload: { agentId: 'main', delta: 'ab' },
  }));
  projector.handleFrame(frame({
    type: 'assistant.delta', seq: 3, volatile: true, offset: 0,
    payload: { agentId: 'main', delta: '找到了' },
  }));
  projector.handleFrame(frame({
    type: 'turn.ended', seq: 4, payload: { agentId: 'main', turnId: 1, reason: 'completed' },
  }));
  await flush();

  const text = events.filter((event) => event.method === 'content.delta' && dataOf(event).kind === 'text');
  const reasoning = events.filter((event) => event.method === 'content.delta' && dataOf(event).kind === 'reasoning');
  assert.deepEqual(text.map((event) => dataOf(event).contentId), ['assistant:p:1', 'assistant:p:2']);
  assert.deepEqual(reasoning.map((event) => dataOf(event).contentId), ['thinking:p:1', 'thinking:p:2']);
  const completedText = events.filter((event) => event.method === 'content.completed' && dataOf(event).kind === 'text');
  const completedReasoning = events.filter((event) => event.method === 'content.completed' && dataOf(event).kind === 'reasoning');
  assert.deepEqual(completedText.map((event) => dataOf(event).content), ['还没有', '找到了']);
  assert.deepEqual(completedReasoning.map((event) => dataOf(event).content), ['ab', 'ab']);
});

test('a volatile frame older than the durable watermark is dropped', () => {
  const { projector, events } = createProjector();
  projector.handleFrame(frame({ type: 'turn.started', seq: 8, payload: { agentId: 'main', turnId: 1 } }));
  assert.equal(projector.handleFrame(frame({
    type: 'thinking.delta', seq: 7, volatile: true, offset: 0,
    payload: { agentId: 'main', delta: 'late' },
  })), false);
  assert.equal(events.length, 0);
});

test('tool displays stay activities and keep their presentation through the result', () => {
  const { projector, events } = createProjector();
  projector.handleFrame(frame({ type: 'turn.started', seq: 1, payload: { agentId: 'main', turnId: 1 } }));
  const calls: Array<{ toolCallId: string; name: string; args: Record<string, unknown>; display: Record<string, unknown> }> = [
    { toolCallId: 'bash', name: 'Bash', args: { command: 'echo hi' }, display: { kind: 'command', command: 'echo hi' } },
    { toolCallId: 'read', name: 'Read', args: {}, display: { kind: 'file_io', operation: 'read', path: 'a.ts' } },
    { toolCallId: 'edit', name: 'Edit', args: {}, display: { kind: 'file_io', operation: 'edit', path: 'b.ts' } },
    { toolCallId: 'grep', name: 'Grep', args: { pattern: 'mergeAdjacentLists' }, display: { kind: 'file_io', operation: 'grep', path: 'src' } },
    { toolCallId: 'fetch', name: 'FetchURL', args: {}, display: { kind: 'url_fetch', url: 'https://example.com' } },
  ];
  let seq = 1;
  for (const call of calls) {
    seq += 1;
    projector.handleFrame(frame({
      type: 'tool.call.started', seq, payload: { agentId: 'main', ...call },
    }));
    seq += 1;
    projector.handleFrame(frame({
      type: 'tool.result', seq, payload: { agentId: 'main', toolCallId: call.toolCallId, output: 'ok' },
    }));
  }
  const rows = events.filter((event) => event.method === 'activity.updated')
    .map((event) => dataOf(event));
  const presentation = (id: string, status: string) => {
    const row = rows.find((entry) => entry.activityId === id && entry.status === status);
    return row?.presentation as { type: string; data: Record<string, unknown> };
  };
  assert.deepEqual(presentation('bash', 'running'), { type: 'command', data: { command: 'echo hi' } });
  assert.equal(presentation('bash', 'succeeded').type, 'command');
  assert.equal(rows.find((entry) => entry.activityId === 'bash' && entry.status === 'succeeded')?.summary, 'ok');
  assert.deepEqual(presentation('read', 'succeeded').data.operation, 'read');
  assert.equal(presentation('read', 'succeeded').type, 'file');
  assert.deepEqual(presentation('edit', 'running'), { type: 'file', data: { path: 'b.ts', operation: 'write' } });
  assert.equal(presentation('edit', 'succeeded').type, 'file');
  assert.deepEqual(presentation('grep', 'running'), {
    type: 'file-search',
    data: { pattern: 'mergeAdjacentLists', searchKind: 'grep', path: 'src' },
  });
  assert.equal(presentation('grep', 'succeeded').type, 'file-search');
  assert.deepEqual(presentation('fetch', 'running'), { type: 'search', data: { query: 'https://example.com' } });
  assert.equal(presentation('fetch', 'succeeded').type, 'search');
});

test('volatile usage updates that share a seq keep distinct event ids', () => {
  const { projector, events } = createProjector();
  projector.handleFrame(frame({ type: 'turn.started', seq: 3, payload: { agentId: 'main', turnId: 1 } }));
  const status = (inputOther: number, output: number): KimiProjectedFrame => frame({
    type: 'agent.status.updated',
    seq: 3,
    volatile: true,
    payload: {
      agentId: 'main',
      usage: { total: { inputOther, output, inputCacheRead: 0, inputCacheCreation: 0 } },
    },
  });
  projector.handleFrame(status(1, 1));
  projector.handleFrame(status(1, 1));
  projector.handleFrame(status(4, 2));
  const usage = events.filter((event) => event.method === 'usage.updated');
  assert.equal(usage.length, 2);
  assert.notEqual(usage[0]!.params.eventId, usage[1]!.params.eventId);
  assert.equal((dataOf(usage[1]!).conversation as { inputTokens: number }).inputTokens, 4);
});

test('the same session usage snapshot on a later turn keeps a distinct event id', async () => {
  const events: OuterNotification[] = [];
  let sequence = 0;
  const snapshot = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost_usd: 0,
    context_tokens: 0,
    context_limit: 0,
    turn_count: 0,
  };
  const projector = new KimiSessionProjector({
    gianSessionId: 's',
    nativeSessionId: 'session_cfdd46ed-9296-44d7-9ec5-ebd02e11163d',
    nextSequence: () => {
      sequence += 1;
      return sequence;
    },
    emit: (notification) => events.push(notification),
    finalUsage: async () => snapshot,
    fileDiff: async () => null,
  });
  projector.setStreamId('stream-1');
  const status = (seq: number): KimiProjectedFrame => frame({
    type: 'agent.status.updated',
    seq,
    volatile: true,
    payload: {
      agentId: 'main',
      usage: { total: { inputOther: 3, output: 1, inputCacheRead: 0, inputCacheCreation: 0 } },
    },
  });

  projector.bindTurn({ gianTurnId: 't1', promptId: 'prompt-1' });
  projector.handleFrame(frame({ type: 'turn.started', seq: 1, payload: { agentId: 'main', turnId: 0 } }));
  projector.handleFrame(status(1));
  await projector.finalizeTurn('interrupted');

  projector.bindTurn({ gianTurnId: 't2', promptId: 'prompt-2' });
  projector.handleFrame(frame({ type: 'turn.started', seq: 2, payload: { agentId: 'main', turnId: 1 } }));
  projector.handleFrame(status(2));
  await projector.finalizeTurn('completed');

  const usage = events.filter((event) => event.method === 'usage.updated');
  assert.equal(usage.length, 4, 'each turn emits its live total and its final snapshot');
  const ids = usage.map((event) => String(event.params.eventId));
  assert.equal(new Set(ids).size, ids.length);
  const finals = usage.filter((event) => event.params.sourceTurnId === 'prompt-1' || event.params.sourceTurnId === 'prompt-2')
    .filter((event) => (dataOf(event).conversation as { inputTokens?: number }).inputTokens === 0);
  assert.deepEqual(finals.map((event) => event.params.sourceTurnId), ['prompt-1', 'prompt-2']);
  assert.notEqual(finals[0]!.params.eventId, finals[1]!.params.eventId);
});
