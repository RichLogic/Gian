import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { WSContext } from 'hono/ws';
import type { SessionManager } from '../src/session/manager.js';
import { createSessionToken, deleteToken } from '../src/auth/tokens.js';
import { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { makeWsHandlers } from '../src/web/ws-handler.js';

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

test('global broadcasts exclude connected peers until WebSocket authentication succeeds', async () => {
  const broadcaster = new WsBroadcaster();
  const handlers = makeWsHandlers({
    sessions: {} as SessionManager,
    broadcaster,
  });
  const authenticatedMessages: string[] = [];
  const unauthenticatedMessages: string[] = [];
  const authenticated = client(authenticatedMessages);
  const unauthenticated = client(unauthenticatedMessages);
  const token = await createSessionToken('authenticated-user');

  try {
    handlers.onOpen(new Event('open'), authenticated);
    handlers.onOpen(new Event('open'), unauthenticated);
    assert.equal(broadcaster.size, 0, 'new sockets must not enter broadcast state before auth');

    await handlers.onMessage(
      { data: JSON.stringify({ type: 'auth', token }) },
      authenticated,
    );
    assert.equal(broadcaster.size, 1, 'successful auth registers only that socket');
    authenticatedMessages.length = 0;

    broadcaster.broadcast({
      type: 'session:updated',
      session: { id: 'session-a', status: 'done' },
    });

    assert.deepEqual(
      authenticatedMessages.map(message => JSON.parse(message).type),
      ['session:updated'],
    );
    assert.deepEqual(unauthenticatedMessages, []);
  } finally {
    handlers.onClose({ code: 1000, reason: '', wasClean: true }, authenticated);
    handlers.onClose({ code: 1000, reason: '', wasClean: true }, unauthenticated);
    deleteToken(token);
  }
});
