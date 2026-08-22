import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { TraceEvidenceRow } from '../src/trace/evidence-store.js';
import { projectTraceSnapshot } from '../src/trace/projector.js';

function row(
  sequence: number,
  method: string,
  data: Record<string, unknown>,
): TraceEvidenceRow {
  return {
    eventId: `event-${sequence}`,
    streamId: 'stream-1',
    streamGeneration: 1,
    sequence,
    sessionId: 'session-1',
    turnId: 'turn-1',
    emittedAt: new Date(Date.parse('2026-08-19T08:00:00.000Z') + sequence * 1_000)
      .toISOString(),
    method,
    data,
  };
}

test('TRACE: step/request evidence groups assistant, tool, and usage items under the step', () => {
  const stepId = 'native-turn-1:0';
  const rows = [
    row(1, 'turn.started', {}),
    row(2, 'step.updated', { stepId, index: 0, status: 'running' }),
    row(3, 'request.updated', {
      requestId: 'request-1',
      reason: 'initial',
      stepId,
      model: { provider: 'deepseek', id: 'deepseek-chat' },
      parameters: { effort: 'high' },
      systemPrompt: { text: 'Be precise.', truncated: false },
      tools: [{ name: 'read_file' }],
      context: { window: 128_000 },
      truncated: false,
    }),
    row(4, 'activity.updated', {
      activityId: 'tool-1',
      kind: 'tool',
      title: 'Read file',
      status: 'running',
      stepId,
      presentation: { type: 'tool', data: { name: 'read_file' } },
    }),
    row(5, 'activity.updated', {
      activityId: 'tool-1',
      kind: 'tool',
      title: 'Read file',
      status: 'succeeded',
      stepId,
      presentation: { type: 'tool', data: { name: 'read_file' } },
    }),
    row(6, 'content.completed', {
      contentId: 'assistant-1',
      kind: 'text',
      stepId,
      content: 'The file is ready.',
    }),
    row(7, 'usage.updated', {
      stepId,
      conversation: { mode: 'delta', inputTokens: 50, outputTokens: 10 },
    }),
    row(8, 'step.updated', { stepId, index: 0, status: 'completed' }),
    row(9, 'turn.completed', { stopReason: 'completed' }),
  ];

  const snapshot = projectTraceSnapshot('session-1', rows, '2026-08-19T08:01:00.000Z');
  assert.equal(snapshot.partial, false);
  assert.deepEqual(snapshot.items.map(item => item.kind), [
    'turn', 'step', 'request', 'tool', 'assistant', 'notice',
  ]);

  const step = snapshot.items.find(item => item.kind === 'step')!;
  assert.equal(step.id, `step:turn-1:${stepId}`);
  assert.equal(step.status, 'succeeded');
  assert.equal(step.durationMs, 6_000);
  assert.deepEqual(step.sourceEventIds, ['event-2', 'event-8']);

  for (const kind of ['request', 'tool', 'assistant'] as const) {
    assert.equal(snapshot.items.find(item => item.kind === kind)!.parentId, step.id);
  }
  const usage = snapshot.items.find(item => item.title === 'Usage')!;
  assert.equal(usage.kind, 'notice');
  assert.equal(usage.parentId, step.id);
  const request = snapshot.items.find(item => item.kind === 'request')!;
  assert.equal(request.title, 'deepseek-chat');
  assert.equal((request.detail as Record<string, unknown>)['reason'], 'initial');
});
