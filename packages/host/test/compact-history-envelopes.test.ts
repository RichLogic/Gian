import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { EventEnvelope } from '@gian/shared';
import { compactHistoryEnvelopes } from '../src/session/history-store.js';

function envelope(overrides: Partial<EventEnvelope> & { display?: EventEnvelope['display'] }): EventEnvelope {
  return {
    session_id: 's-unit',
    turn: 1,
    call_id: 'stream-a',
    event: 'output.text',
    ts: 10,
    data: {},
    ...overrides,
  };
}

test('compactHistoryEnvelopes leaves an empty list unchanged', () => {
  assert.deepEqual(compactHistoryEnvelopes([]), []);
});

test('compactHistoryEnvelopes concatenates assistant message deltas', () => {
  const compacted = compactHistoryEnvelopes([
    envelope({
      ts: 1,
      display: { type: 'message', data: { text: 'Hel', delta: true } },
    }),
    envelope({
      ts: 2,
      data: { chunk: 2 },
      display: { type: 'message', data: { text: 'lo', delta: true } },
    }),
  ]);
  assert.equal(compacted.length, 1);
  assert.deepEqual(compacted[0]?.display?.data, { text: 'Hello', delta: false });
});

test('compactHistoryEnvelopes replaces text when a later fragment sets delta false', () => {
  const compacted = compactHistoryEnvelopes([
    envelope({
      display: { type: 'message', data: { text: 'draft', delta: true } },
    }),
    envelope({
      display: { type: 'message', data: { text: 'final', delta: false } },
    }),
  ]);
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0]?.display?.data.text, 'final');
});

test('compactHistoryEnvelopes concatenates command stdoutDelta and keeps non-streams', () => {
  const tool = envelope({
    call_id: 'tool-1',
    event: 'tool.output',
    display: { type: 'activity.tool', data: { itemId: 'tool-1' } },
  });
  const compacted = compactHistoryEnvelopes([
    envelope({
      call_id: 'cmd-1',
      event: 'activity.command',
      display: { type: 'activity.command', data: { stdoutDelta: 'out-' } },
    }),
    tool,
    envelope({
      call_id: 'cmd-1',
      event: 'activity.command',
      display: { type: 'activity.command', data: { stdoutDelta: 'put' } },
    }),
  ]);
  assert.equal(compacted.length, 2);
  assert.equal(compacted[0], tool);
  assert.equal(compacted[1]?.call_id, 'cmd-1');
  assert.equal(compacted[1]?.display?.data.stdout, 'out-put');
});

test('compactHistoryEnvelopes does not merge user_message rows', () => {
  const first = envelope({
    event: 'user_message',
    call_id: 'u1',
    display: { type: 'message', data: { text: 'one', role: 'user' } },
  });
  const second = envelope({
    event: 'user_message',
    call_id: 'u1',
    display: { type: 'message', data: { text: 'two', role: 'user' } },
  });
  const compacted = compactHistoryEnvelopes([first, second]);
  assert.deepEqual(compacted, [first, second]);
});
