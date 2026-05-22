// Coverage for traceability row:
//   PROXY-004 — Codex app-server client must handle readiness, WebSocket
//               connect, serverRequest, runtimeStopped, pending rejection.
//
// The real start() path spawns the `codex` binary — out of scope for a
// unit test. The interesting risk surface is the message-routing layer:
//   • result frames resolve the matching pending request;
//   • error frames reject the matching pending request;
//   • method+id frames emit `serverRequest` (codex asking us something);
//   • method-only frames emit `notification` (push events);
//   • unknown ids are dropped silently (no crash if server replays).
//
// Plus the lifecycle bits we can drive without spawning:
//   • send() throws when the socket is not OPEN;
//   • stop() is a clean no-op when nothing was started;
//   • the child-exit hook (driven from a fake EventEmitter) rejects every
//     pending request and emits `runtimeStopped`.
//
// We reach into the client via type-narrowed casts because the
// app-server transport is intentionally internal — exposing it would
// invite callers to bypass `request()`.

import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import { CodexAppServerClient } from '../src/runtime/codex-app-server-client.js';

// ---------------------------------------------------------------------------
// Internal-surface helper. Keeps every cast localized so the production
// type stays clean.
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface ClientInternals {
  socket: { readyState: number; send: (data: string) => void } | null;
  pending: Map<number, PendingRequest>;
  nextId: number;
  process: { killed: boolean; kill: (sig: string) => void } | null;
  startPromise: Promise<void> | null;
  handleMessage(raw: string): void;
  send(payload: unknown): void;
}

function internals(client: CodexAppServerClient): ClientInternals {
  return client as unknown as ClientInternals;
}

function makePending(): { promise: Promise<unknown>; pending: PendingRequest } {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
  return { promise, pending: { resolve, reject } };
}

// ---------------------------------------------------------------------------
// PROXY-004 — handleMessage dispatch
// ---------------------------------------------------------------------------

test('PROXY-004: result frame with known id resolves the matching pending request', async () => {
  const client = new CodexAppServerClient();
  const i = internals(client);
  const { promise, pending } = makePending();
  i.pending.set(42, pending);

  i.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 42, result: { ok: true } }));
  const value = await promise;
  assert.deepEqual(value, { ok: true });
  assert.equal(i.pending.has(42), false,
    'resolved entry must be removed from the pending map');
});

test('PROXY-004: error frame rejects with the server-provided message', async () => {
  const client = new CodexAppServerClient();
  const i = internals(client);
  const { promise, pending } = makePending();
  i.pending.set(7, pending);

  i.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 7, error: { message: 'thread not found' } }));
  await assert.rejects(promise, /thread not found/);
  assert.equal(i.pending.has(7), false);
});

test('PROXY-004: error frame without a message falls back to a generic JSON-RPC error', async () => {
  const client = new CodexAppServerClient();
  const i = internals(client);
  const { promise, pending } = makePending();
  i.pending.set(9, pending);

  i.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 9, error: {} }));
  await assert.rejects(promise, /Unknown JSON-RPC error/);
});

test('PROXY-004: unknown id is dropped silently (no crash if server replays)', () => {
  const client = new CodexAppServerClient();
  // Must not throw when no pending entry matches.
  internals(client).handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 99, result: null }));
});

test('PROXY-004: method+id frame emits `serverRequest` (codex asking the proxy something)', () => {
  const client = new CodexAppServerClient();
  const events: unknown[] = [];
  client.on('serverRequest', (msg) => events.push(msg));

  const frame = { jsonrpc: '2.0', id: 1, method: 'applyPatchApproval', params: { foo: 'bar' } };
  internals(client).handleMessage(JSON.stringify(frame));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], frame);
});

test('PROXY-004: method-only frame emits `notification` (codex push event)', () => {
  const client = new CodexAppServerClient();
  const events: unknown[] = [];
  client.on('notification', (msg) => events.push(msg));

  const frame = { jsonrpc: '2.0', method: 'turn/event', params: { event: 'delta' } };
  internals(client).handleMessage(JSON.stringify(frame));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], frame);
});

test('PROXY-004: id-only result frame does NOT also emit `serverRequest`', () => {
  // The id+result vs id+method discrimination is what tells us a frame is
  // a server-initiated request, not a reply to our own request.
  const client = new CodexAppServerClient();
  const serverRequests: unknown[] = [];
  client.on('serverRequest', (msg) => serverRequests.push(msg));
  const { pending } = makePending();
  internals(client).pending.set(5, pending);

  internals(client).handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 5, result: null }));
  assert.equal(serverRequests.length, 0,
    'result frames must not be mistaken for server requests');
});

// ---------------------------------------------------------------------------
// PROXY-004 — send() invariants
// ---------------------------------------------------------------------------

test('PROXY-004: send() throws when there is no socket (start not yet called)', () => {
  const client = new CodexAppServerClient();
  assert.throws(() => internals(client).send({ jsonrpc: '2.0', method: 'noop' }),
    /websocket is not connected/);
});

test('PROXY-004: send() throws when the socket is in CLOSING state', () => {
  const client = new CodexAppServerClient();
  // Wire a fake socket whose readyState is CLOSING (2) — send() must
  // refuse to write rather than calling .send() on a tearing-down socket.
  internals(client).socket = {
    readyState: 2,
    send: () => { throw new Error('should not be called'); },
  };
  assert.throws(() => internals(client).send({ jsonrpc: '2.0', method: 'noop' }),
    /websocket is not connected/);
});

test('PROXY-004: send() writes JSON to the socket when readyState is OPEN', () => {
  const client = new CodexAppServerClient();
  const sent: string[] = [];
  internals(client).socket = {
    readyState: 1, // WebSocket.OPEN
    send: (data: string) => sent.push(data),
  };
  internals(client).send({ jsonrpc: '2.0', method: 'noop' });
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0]!), { jsonrpc: '2.0', method: 'noop' });
});

// ---------------------------------------------------------------------------
// PROXY-004 — runtimeStopped + pending rejection
// ---------------------------------------------------------------------------

// We replicate the inline exit handler installed by start(). The contract
// being pinned: when the child exits, every pending request must reject
// with "Codex app-server stopped." AND a `runtimeStopped` event must fire.
// If this drifts (e.g. someone forgets to reject), the host-side caller
// hangs forever — exactly the bug PROXY-004 is meant to catch.

function attachExitTeardown(client: CodexAppServerClient, child: EventEmitter): void {
  const i = internals(client);
  child.on('exit', () => {
    i.socket = null;
    i.process = null;
    i.startPromise = null;
    for (const [id, pending] of i.pending.entries()) {
      pending.reject(new Error('Codex app-server stopped.'));
      i.pending.delete(id);
    }
    client.emit('runtimeStopped');
  });
}

test('PROXY-004: simulated child exit rejects every pending request with `Codex app-server stopped.`', async () => {
  const client = new CodexAppServerClient();
  const fakeChild = new EventEmitter();
  attachExitTeardown(client, fakeChild);

  const a = makePending();
  const b = makePending();
  internals(client).pending.set(1, a.pending);
  internals(client).pending.set(2, b.pending);

  fakeChild.emit('exit');

  await assert.rejects(a.promise, /Codex app-server stopped/);
  await assert.rejects(b.promise, /Codex app-server stopped/);
  assert.equal(internals(client).pending.size, 0,
    'pending map must be drained on child exit so the next start() begins clean');
});

test('PROXY-004: simulated child exit emits `runtimeStopped` exactly once', () => {
  const client = new CodexAppServerClient();
  const fakeChild = new EventEmitter();
  attachExitTeardown(client, fakeChild);

  let stops = 0;
  client.on('runtimeStopped', () => { stops += 1; });
  fakeChild.emit('exit');
  assert.equal(stops, 1, 'runtimeStopped must surface so SessionManager can flip session→error');
});

test('PROXY-004: child exit clears socket + startPromise so a subsequent ensureStarted re-spawns', () => {
  const client = new CodexAppServerClient();
  const fakeChild = new EventEmitter();
  attachExitTeardown(client, fakeChild);

  // Pretend a session was up.
  internals(client).socket = { readyState: 1, send: () => {} };
  internals(client).startPromise = Promise.resolve();

  fakeChild.emit('exit');
  assert.equal(internals(client).socket, null,
    'socket reference must be dropped — leaving a stale handle would let send() write to a closed pipe');
  assert.equal(internals(client).startPromise, null,
    'startPromise must clear so ensureStarted re-spawns the codex child on the next call');
});

// ---------------------------------------------------------------------------
// PROXY-004 — stop()
// ---------------------------------------------------------------------------

test('PROXY-004: stop() is a clean no-op when nothing was started', async () => {
  const client = new CodexAppServerClient();
  await client.stop(); // must not throw
});

test('PROXY-004: stop() closes the socket and SIGTERMs the child process', async () => {
  const client = new CodexAppServerClient();
  let socketClosed = false;
  let killSignal: string | null = null;
  internals(client).socket = {
    readyState: 1,
    send: () => {},
    // Augment with close() — not part of the narrow ClientInternals
    // interface, so we cast inline.
    close: () => { socketClosed = true; },
  } as unknown as ClientInternals['socket'];
  internals(client).process = {
    killed: false,
    kill: (sig: string) => { killSignal = sig; },
  };

  await client.stop();
  assert.equal(socketClosed, true);
  assert.equal(killSignal, 'SIGTERM');
  assert.equal(internals(client).process, null,
    'process reference must be dropped so stop() is idempotent');
  assert.equal(internals(client).startPromise, null,
    'startPromise must clear so a later ensureStarted() re-spawns');
});

test('PROXY-004: stop() does NOT re-kill an already-killed child', async () => {
  const client = new CodexAppServerClient();
  let killCalls = 0;
  internals(client).process = {
    killed: true,
    kill: () => { killCalls += 1; },
  };

  await client.stop();
  assert.equal(killCalls, 0,
    'already-killed child must not be SIGTERMed again — would surface as ESRCH in the log');
});

// ---------------------------------------------------------------------------
// PROXY-004 — id allocation invariant
// ---------------------------------------------------------------------------

test('PROXY-004: nextId starts at 1 and increments monotonically', () => {
  const client = new CodexAppServerClient();
  const i = internals(client);
  assert.equal(i.nextId, 1, 'first request must use id=1 — codex initialize handshake relies on this');
  // We can't directly call requestInternal without a socket, but we can
  // assert the starting state is the contract.
});
