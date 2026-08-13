import assert from 'node:assert/strict';
import test from 'node:test';
import type { AttentionMessage } from '@gian/shared';
import {
  AttentionClient,
  attentionWebSocketUrl,
  parseAttentionMessage,
  type AttentionSocket,
} from '../src/attention-client.js';

class FakeSocket implements AttentionSocket {
  listeners = new Map<string, Array<(event?: { data: unknown }) => void>>();
  sent: string[] = [];
  closed = false;

  addEventListener(type: string, listener: (event?: { data: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; }
  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

const attention: AttentionMessage = {
  type: 'attention',
  id: 'gian:s1:2:turn-completed:done',
  session_id: 's1',
  turn: 2,
  kind: 'turn-completed',
  timestamp: 100,
  title: 'Gian · Session completed',
  body: 'Turn 2 completed.',
  provider: 'codex',
};

test('attention URL uses the Host WebSocket endpoint', () => {
  assert.equal(attentionWebSocketUrl('http://127.0.0.1:8990'), 'ws://127.0.0.1:8990/ws');
  assert.equal(attentionWebSocketUrl('https://example.test'), 'wss://example.test/ws');
});

test('client authenticates and explicitly opts out of full transcript events', () => {
  const socket = new FakeSocket();
  let captured: { url: string; headers: Record<string, string> } | null = null;
  const received: AttentionMessage[] = [];
  const client = new AttentionClient({
    hostUrl: 'http://127.0.0.1:8990',
    token: 'desktop-secret',
    tokenHeader: 'X-Gian-Desktop-Token',
    socketFactory: (url, init) => {
      captured = { url, headers: init.headers };
      return socket;
    },
    onAttention: message => received.push(message),
  });

  client.start();
  assert.deepEqual(captured, {
    url: 'ws://127.0.0.1:8990/ws',
    headers: {
      Origin: 'http://127.0.0.1:8990',
      'X-Gian-Desktop-Token': 'desktop-secret',
    },
  });
  socket.emit('open');
  assert.deepEqual(socket.sent.map(message => JSON.parse(message)), [{
    type: 'auth',
    token: 'desktop-secret',
    client: 'attention',
  }]);

  socket.emit('message', JSON.stringify({ type: 'state_sync' }));
  socket.emit('message', JSON.stringify(attention));
  assert.deepEqual(received, [attention]);
  client.stop();
  assert.equal(socket.closed, true);
});

test('client reconnects once after close and stop cancels pending reconnect', () => {
  const sockets = [new FakeSocket(), new FakeSocket()];
  const timers: Array<() => void> = [];
  let calls = 0;
  const client = new AttentionClient({
    hostUrl: 'http://127.0.0.1:8990',
    token: 'desktop-secret',
    tokenHeader: 'X-Gian-Desktop-Token',
    socketFactory: () => sockets[calls++]!,
    onAttention: () => {},
    setTimer: callback => {
      timers.push(callback);
      return callback as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: timer => {
      const index = timers.indexOf(timer as unknown as () => void);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  client.start();
  sockets[0]!.emit('close');
  assert.equal(timers.length, 1);
  timers.shift()!();
  assert.equal(calls, 2);
  sockets[1]!.emit('close');
  assert.equal(timers.length, 1);
  client.stop();
  assert.equal(timers.length, 0);
});

test('parser rejects oversized or non-attention messages', () => {
  assert.deepEqual(parseAttentionMessage(JSON.stringify(attention)), attention);
  assert.equal(parseAttentionMessage(JSON.stringify({ ...attention, title: 'x'.repeat(257) })), null);
  assert.equal(parseAttentionMessage(JSON.stringify({ type: 'event' })), null);
  assert.equal(parseAttentionMessage(Buffer.from(JSON.stringify(attention))), null);
});
