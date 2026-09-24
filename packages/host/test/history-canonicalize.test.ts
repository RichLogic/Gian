import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { EventEnvelope } from '@gian/shared';

import {
  canonicalizeHistoryEnvelopes,
  compactHistoryEnvelopes,
  conversationMessagesFromEvents,
  snapshotIdentity,
} from '../src/session/history-store.js';

function envelope(overrides: Partial<EventEnvelope> & Pick<EventEnvelope, 'event'>): EventEnvelope {
  return {
    session_id: 's1',
    turn: 1,
    call_id: 'c1',
    ts: 1,
    data: {},
    ...overrides,
  };
}

test('snapshotIdentity keys replaceable diffs and ACP tool calls', () => {
  assert.equal(
    snapshotIdentity(envelope({ event: 'diff.updated' })),
    '1\u0000diff.updated',
  );
  assert.equal(
    snapshotIdentity(envelope({
      event: 'acp.sessionUpdate',
      data: { update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1' } },
    })),
    '1\u0000acp.tool\u0000tc-1',
  );
  assert.equal(
    snapshotIdentity(envelope({
      event: 'acp.sessionUpdate',
      data: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1' } },
    })),
    '1\u0000acp.tool\u0000tc-1',
  );
  assert.equal(snapshotIdentity(envelope({ event: 'user_message' })), null);
});

test('canonicalizeHistoryEnvelopes keeps the latest replaceable snapshot', () => {
  const earlier = envelope({
    event: 'diff.updated',
    call_id: 'old',
    ts: 1,
    data: { revision: 1 },
  });
  const later = envelope({
    event: 'diff.updated',
    call_id: 'new',
    ts: 2,
    data: { revision: 2 },
  });
  const user = envelope({
    event: 'user_message',
    call_id: 'u1',
    data: { text: 'hi' },
  });

  const canonical = canonicalizeHistoryEnvelopes([earlier, user, later]);
  assert.deepEqual(canonical.map(event => event.call_id), ['u1', 'new']);
  assert.deepEqual(canonical[1]?.data, { revision: 2 });
});

test('canonicalizeHistoryEnvelopes collapses Kimi tool_call updates by id', () => {
  const started = envelope({
    event: 'acp.sessionUpdate',
    call_id: 'start',
    ts: 1,
    data: { update: { sessionUpdate: 'tool_call', toolCallId: 'tc-9' } },
  });
  const updated = envelope({
    event: 'acp.sessionUpdate',
    call_id: 'update',
    ts: 2,
    data: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-9' } },
  });
  const other = envelope({
    event: 'acp.sessionUpdate',
    call_id: 'other',
    ts: 3,
    data: { update: { sessionUpdate: 'agent_message_chunk' } },
  });

  const canonical = canonicalizeHistoryEnvelopes([started, updated, other]);
  assert.deepEqual(canonical.map(event => event.call_id), ['update', 'other']);
});

test('conversationMessagesFromEvents keeps user and assistant text in order, excluding tool noise', () => {
  const events = compactHistoryEnvelopes([
    envelope({
      event: 'user_message',
      call_id: 'u1',
      data: { text: 'first question' },
    }),
    envelope({
      event: 'output.text.delta',
      call_id: 'a1',
      display: { type: 'message', data: { text: 'ans', delta: true } },
    }),
    envelope({
      event: 'output.text.delta',
      call_id: 'a1',
      display: { type: 'message', data: { text: 'wer', delta: true } },
    }),
    envelope({
      event: 'tool_execution',
      call_id: 't1',
      display: { type: 'activity.tool', data: { itemId: 't1' } },
    }),
    envelope({
      event: 'user_message',
      call_id: 'u2',
      data: { text: 'follow up' },
    }),
    envelope({
      event: 'output.text',
      call_id: 'a2',
      display: { type: 'message', data: { text: 'second answer', role: 'assistant' } },
    }),
  ]);
  assert.deepEqual(conversationMessagesFromEvents(events), [
    { role: 'user', text: 'first question' },
    { role: 'assistant', text: 'answer' },
    { role: 'user', text: 'follow up' },
    { role: 'assistant', text: 'second answer' },
  ]);
});

test('conversationMessagesFromEvents treats native user-role messages as user text', () => {
  const events = compactHistoryEnvelopes([
    envelope({
      event: 'gian.user',
      call_id: 'n1',
      display: { type: 'message', data: { text: 'native user note', role: 'user' } },
    }),
    envelope({
      event: 'user_message',
      call_id: 'u1',
      data: {},
    }),
    envelope({
      event: 'output.text',
      call_id: 'a1',
      display: { type: 'message', data: { text: '' } },
    }),
  ]);
  // Empty user_message payloads and empty assistant texts are skipped.
  assert.deepEqual(conversationMessagesFromEvents(events), [
    { role: 'user', text: 'native user note' },
  ]);
});
