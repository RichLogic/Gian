import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { parseCodexLine, parseNativeJsonlLines } from '../src/native/replay.js';

test('parseCodexLine ignores headers, junk, and empty agent text', () => {
  assert.equal(parseCodexLine(''), null);
  assert.equal(parseCodexLine('{'), null);
  assert.equal(parseCodexLine(JSON.stringify({ type: 'session_meta' })), null);
  assert.equal(parseCodexLine(JSON.stringify({
    type: 'event_msg',
    payload: { type: 'agent_message', message: '   ' },
  })), null);
});

test('parseCodexLine opens a turn on user_message and continues on agent_message', () => {
  const user = parseCodexLine(JSON.stringify({
    type: 'event_msg',
    payload: { type: 'user_message', message: 'hello' },
  }));
  assert.equal(user?.boundary, 'turn-start');
  assert.equal(user?.events[0]?.type, 'user_message');
  assert.deepEqual(user?.events[0]?.data, { text: 'hello' });

  const agent = parseCodexLine(JSON.stringify({
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'world' },
  }));
  assert.equal(agent?.boundary, 'continue');
  assert.equal(agent?.events[0]?.type, 'codex.event_msg.agent_message');
  assert.equal(
    (agent?.events[0]?.data as { display?: { data?: { text?: string } } }).display?.data?.text,
    'world',
  );
});

test('parseNativeJsonlLines assembles Codex turns and skips ignored lines', () => {
  const turns = parseNativeJsonlLines([
    JSON.stringify({ type: 'session_meta', payload: { id: 't' } }),
    '{',
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'one' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: '  ' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'first' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'two' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'second' } }),
  ], 'codex');

  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.events.length, 2);
  assert.equal(turns[0]?.events[0]?.type, 'user_message');
  assert.equal(turns[0]?.events[1]?.type, 'codex.event_msg.agent_message');
  assert.equal(turns[1]?.events[0]?.data && (turns[1].events[0].data as { text?: string }).text, 'two');
});
