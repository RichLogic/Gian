import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { EventEnvelope } from '@gian/shared';

import {
  canonicalizeHistoryEnvelopes,
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
