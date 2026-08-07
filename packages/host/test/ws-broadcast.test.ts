import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { WSContext } from 'hono/ws';
import { WsBroadcaster } from '../src/web/ws-broadcast.js';

function client(messages: string[]): WSContext {
  return { send: (value: string) => { messages.push(value); } } as unknown as WSContext;
}

test('event subscriptions keep full transcript payloads scoped to the active session', () => {
  const broadcaster = new WsBroadcaster();
  const firstMessages: string[] = [];
  const secondMessages: string[] = [];
  const first = client(firstMessages);
  const second = client(secondMessages);
  broadcaster.add(first);
  broadcaster.add(second);
  broadcaster.subscribeToEvents(first, 'session-a');
  broadcaster.subscribeToEvents(second, 'session-b');

  broadcaster.broadcast({
    type: 'event',
    session_id: 'session-a',
    turn: 1,
    call_id: 'message-a',
    event: 'output.text.delta',
    ts: 1,
    data: { delta: 'a' },
  });
  broadcaster.broadcast({
    type: 'session:updated',
    session: { id: 'session-a', status: 'done' },
  });

  assert.deepEqual(firstMessages.map(message => JSON.parse(message).type), ['event', 'session:updated']);
  assert.deepEqual(secondMessages.map(message => JSON.parse(message).type), ['session:updated']);
});
