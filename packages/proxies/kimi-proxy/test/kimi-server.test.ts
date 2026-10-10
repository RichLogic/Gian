import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';

import { KimiServerRuntime } from '../src/runtime/kimi-server.js';
import { KimiServerSupervisor, type KimiServerSupervisorResult } from '../src/runtime/server-supervisor.js';
import { WsSocket } from '../src/runtime/ws.js';

class FakeSocket extends EventEmitter {
  status: 'open' | 'closed' = 'open';
  readonly sent: Array<Record<string, unknown>> = [];

  sendText(text: string): void {
    if (this.status !== 'open') throw new Error('socket closed');
    const frame = JSON.parse(text) as Record<string, unknown>;
    this.sent.push(frame);
    // The real server acknowledges every subscribe frame; the Proxy's
    // subscription barrier awaits that ACK before any prompt may run.
    if (frame['type'] === 'subscribe') {
      const payload = (frame['payload'] ?? {}) as { session_ids?: unknown };
      const sessionIds = Array.isArray(payload.session_ids) ? payload.session_ids : [];
      queueMicrotask(() => {
        this.emit('message', JSON.stringify({
          type: 'ack',
          id: frame['id'] ?? '',
          code: 0,
          msg: 'success',
          payload: { accepted: sessionIds, not_found: [], resync_required: [] },
        }));
      });
    }
  }

  close(): void {
    this.status = 'closed';
    this.emit('close', new Error('peer closed'));
  }
}

function supervisor(t: TestContext): { result: KimiServerSupervisorResult; exit: () => void } {
  let exit!: () => void;
  const result: KimiServerSupervisorResult = {
    endpoint: { baseUrl: 'http://127.0.0.1:1', token: 'fixture' },
    pid: 1,
    exit: new Promise((resolve) => { exit = () => resolve({ code: 9, signal: null }); }),
    stop: async () => undefined,
  };
  t.mock.method(KimiServerSupervisor.prototype, 'start', async () => result);
  return { result, exit };
}

test('event socket loss reconnects at the durable cursor without runtime down or stale socket callbacks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  supervisor(t);
  const sockets = [new FakeSocket(), new FakeSocket()];
  let connection = 0;
  const connect = t.mock.method(WsSocket, 'connect', async () => sockets[connection++] as unknown as WsSocket);
  const runtime = new KimiServerRuntime({ kimiBin: '/fixture/kimi' });
  let down = 0;
  const events: number[] = [];
  const resyncs: string[] = [];
  runtime.on('down', () => { down += 1; });
  runtime.on('session-event', (frame) => { events.push(frame.seq); });
  runtime.on('resync', (notice) => { resyncs.push(notice.sessionId); });
  try {
    await runtime.start();
    await runtime.subscribe('native', { seq: 0 });
    runtime.advanceCursor('native', { seq: 21, epoch: 'epoch' });
    sockets[0]!.close();
    sockets[0]!.emit('close');
    assert.equal(down, 0);
    t.mock.timers.tick(500);
    await setImmediate();
    assert.equal(connect.mock.callCount(), 2);
    assert.deepEqual((sockets[1]!.sent[0]!.payload as { cursors: unknown }).cursors, {
      native: { seq: 21, epoch: 'epoch' },
    });
    sockets[0]!.emit('close');
    sockets[0]!.emit('message', JSON.stringify({ type: 'assistant.delta', session_id: 'native', seq: 99, payload: {} }));
    sockets[1]!.emit('message', JSON.stringify({ type: 'assistant.delta', session_id: 'native', seq: 22, payload: {} }));
    assert.deepEqual(events, [22]);
    sockets[1]!.emit('message', JSON.stringify({ type: 'resync_required', session_id: 'native', payload: { reason: 'overflow' } }));
    assert.deepEqual(resyncs, ['native']);
    assert.equal(down, 0, 'resync and event-channel loss are not child exits');
    sockets[1]!.close();
    await runtime.stop();
    t.mock.timers.tick(10_000);
    await setImmediate();
    assert.equal(connect.mock.callCount(), 2, 'shutdown cancels scheduled reconnect');
  } finally {
    await runtime.stop();
  }
});

test('only child exit emits runtime down and closes its event socket once', async (t) => {
  const child = supervisor(t);
  const socket = new FakeSocket();
  t.mock.method(WsSocket, 'connect', async () => socket as unknown as WsSocket);
  const runtime = new KimiServerRuntime({ kimiBin: '/fixture/kimi' });
  let down = 0;
  runtime.on('down', () => { down += 1; });
  try {
    await runtime.start();
    await runtime.subscribe('native');
    child.exit();
    await setImmediate();
    assert.equal(down, 1);
    assert.equal(socket.status, 'closed');
    socket.emit('close');
    assert.equal(down, 1);
    assert.throws(() => runtime.rest, /not started/);
  } finally {
    await runtime.stop();
  }
});

test('shutdown during an outstanding upgrade closes the late socket without reconnecting', async (t) => {
  supervisor(t);
  const socket = new FakeSocket();
  let connected!: (socket: WsSocket) => void;
  const connect = t.mock.method(WsSocket, 'connect', () => new Promise<WsSocket>((resolve) => { connected = resolve; }));
  const runtime = new KimiServerRuntime({ kimiBin: '/fixture/kimi' });
  await runtime.start();
  const subscription = runtime.subscribe('native');
  const rejected = assert.rejects(subscription, /runtime (is )?stopped/);
  await setImmediate();
  await runtime.stop();
  connected(socket as unknown as WsSocket);
  await rejected;
  assert.equal(socket.status, 'closed');
  assert.equal(connect.mock.callCount(), 1);
});

test('shutdown during server startup stops the late child instead of making it available', async (t) => {
  let started!: (result: KimiServerSupervisorResult) => void;
  t.mock.method(KimiServerSupervisor.prototype, 'start', () => new Promise<KimiServerSupervisorResult>((resolve) => { started = resolve; }));
  const stop = t.mock.fn(async () => undefined);
  const runtime = new KimiServerRuntime({ kimiBin: '/fixture/kimi' });
  const startup = runtime.start();
  const rejected = assert.rejects(startup, /runtime is stopped/);
  await runtime.stop();
  started({
    endpoint: { baseUrl: 'http://127.0.0.1:1', token: 'fixture' }, pid: 1,
    exit: new Promise(() => undefined), stop,
  });
  await rejected;
  assert.equal(stop.mock.callCount(), 1);
  assert.throws(() => runtime.rest, /not started/);
});
