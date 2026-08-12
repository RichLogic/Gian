import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { WSContext } from 'hono/ws';
import type { SessionManager } from '../src/session/manager.js';
import { createSessionToken, deleteToken } from '../src/auth/tokens.js';
import { WS_MAX_BUFFERED_BYTES, WsBroadcaster } from '../src/web/ws-broadcast.js';
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

test('global state broadcasts converge across every authenticated window', () => {
  const broadcaster = new WsBroadcaster();
  const firstMessages: string[] = [];
  const secondMessages: string[] = [];
  broadcaster.add(client(firstMessages));
  broadcaster.add(client(secondMessages));

  broadcaster.broadcast({
    type: 'session:updated',
    session: { id: 'session-a', status: 'done' },
  });
  broadcaster.broadcast({ type: 'session:deleted', session_id: 'session-a' });

  assert.deepEqual(firstMessages, secondMessages,
    'two windows must observe the same ordered global state mutations');
  assert.deepEqual(firstMessages.map(message => JSON.parse(message).type), [
    'session:updated',
    'session:deleted',
  ]);
});

test('a throwing socket is evicted after one failure while healthy windows continue', () => {
  const broadcaster = new WsBroadcaster();
  const healthyMessages: string[] = [];
  let failedSends = 0;
  let close: [number | undefined, string | undefined] | undefined;
  const broken = {
    send: () => { failedSends++; throw new Error('socket gone'); },
    close: (code?: number, reason?: string) => { close = [code, reason]; },
  } as unknown as WSContext;
  broadcaster.add(broken);
  broadcaster.add(client(healthyMessages));

  const originalError = console.error;
  console.error = () => undefined;
  try {
    for (let i = 0; i < 20; i++) {
      broadcaster.broadcast({ type: 'session:deleted', session_id: `session-${i}` });
    }
  } finally {
    console.error = originalError;
  }

  assert.equal(failedSends, 1, 'a dead socket must not be retried for every later broadcast');
  assert.equal(healthyMessages.length, 20, 'the healthy peer must receive the full burst');
  assert.equal(broadcaster.size, 1);
  assert.deepEqual(close, [1011, 'send failed']);
});

test('a slow socket over the backpressure budget is isolated before an event storm', () => {
  const broadcaster = new WsBroadcaster();
  const healthyMessages: string[] = [];
  let slowSends = 0;
  let close: [number | undefined, string | undefined] | undefined;
  const slow = {
    raw: { bufferedAmount: WS_MAX_BUFFERED_BYTES + 1 },
    send: () => { slowSends++; },
    close: (code?: number, reason?: string) => { close = [code, reason]; },
  } as unknown as WSContext;
  broadcaster.add(slow);
  broadcaster.add(client(healthyMessages));

  for (let i = 0; i < 2_000; i++) {
    broadcaster.broadcast({
      type: 'event',
      session_id: 'session-a',
      turn: 1,
      call_id: `message-${i}`,
      event: 'output.text.delta',
      ts: i,
      data: { delta: 'x' },
    });
  }

  assert.equal(slowSends, 0, 'an already-backed-up socket receives no additional payload');
  assert.equal(healthyMessages.length, 2_000,
    'one slow window must not interrupt delivery to a healthy window');
  assert.equal(broadcaster.size, 1);
  assert.deepEqual(close, [1013, 'client is not keeping up']);
});

test('removing one window also removes its transcript subscription without affecting peers', () => {
  const broadcaster = new WsBroadcaster();
  const firstMessages: string[] = [];
  const secondMessages: string[] = [];
  const first = client(firstMessages);
  const second = client(secondMessages);
  broadcaster.add(first);
  broadcaster.add(second);
  broadcaster.subscribeToEvents(first, 'session-a');
  broadcaster.subscribeToEvents(second, 'session-a');

  broadcaster.remove(first);
  broadcaster.broadcast({
    type: 'event',
    session_id: 'session-a',
    turn: 1,
    call_id: 'message-a',
    event: 'output.text.delta',
    ts: 1,
    data: { delta: 'still connected' },
  });

  assert.deepEqual(firstMessages, []);
  assert.equal(secondMessages.length, 1);
  assert.equal(broadcaster.size, 1);
});
