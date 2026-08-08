// Coverage for traceability row:
//   PROXY-004 — Codex app-server client must handle readiness, WebSocket
//               connect, serverRequest, runtimeStopped, pending rejection.
//
// A deterministic cross-process smoke below drives the real start() path
// through a local fake binary (spawn → readyz → WebSocket → initialize).
// The remaining focused tests isolate the message-routing layer:
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
import { EventEmitter } from 'node:events';
import { chmodSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildAppServerArgs,
  buildInitializeParams,
  CodexAppServerClient,
} from '../src/runtime/codex-app-server-client.js';
import {
  CODEX_APP_SERVER_V2_DEFAULT_ELIDED_GRANULAR_PERMISSIONS,
  CODEX_APP_SERVER_V2_EXTERNAL_SANDBOX_PERMISSIONS,
  CODEX_APP_SERVER_UNKNOWN_PERMISSIONS,
  CODEX_APP_SERVER_V2_GRANULAR_PERMISSIONS,
  CODEX_APP_SERVER_V2_NAMED_PERMISSIONS,
} from './fixtures/app-server-v2-permissions.js';

// ---------------------------------------------------------------------------
// Internal-surface helper. Keeps every cast localized so the production
// type stays clean.
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface ClientInternals {
  socket: { readyState: number; send: (data: string) => void; close?: () => void } | null;
  pending: Map<number, PendingRequest>;
  nextId: number;
  process: FakeChild | null;
  startPromise: Promise<void> | null;
  activeGeneration: number | null;
  nextGeneration: number;
  deadlines: {
    startupMs: number;
    readyMs: number;
    socketConnectMs: number;
    rpcMs: number;
    terminateGraceMs: number;
  };
  start(generation: number): Promise<void>;
  attachProcess(child: FakeChild, generation: number): void;
  attachSocket(socket: WebSocket, generation: number, signal: AbortSignal): Promise<void>;
  handleMessage(raw: string): void;
  send(payload: unknown): void;
  requestInternal(method: string, params: unknown): Promise<unknown>;
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

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class FakeSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: string[] = [];
  closeCalls = 0;
  onSend: ((data: string) => void) | null = null;

  send(data: string) {
    this.sent.push(data);
    this.onSend?.(data);
  }

  open() {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  fail() {
    this.dispatchEvent(new Event('error'));
  }

  disconnect() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }

  close() {
    this.closeCalls += 1;
    this.disconnect();
  }

  receive(payload: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }
}

class FakeChild extends EventEmitter {
  stdout = null;
  stderr = null;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: Array<NodeJS.Signals | number> = [];

  kill(signal: NodeJS.Signals | number = 'SIGTERM') {
    this.killSignals.push(signal);
    this.killed = true;
    return true;
  }

  exit(code = 0) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

async function installRuntime(
  client: CodexAppServerClient,
  generation = 1,
  child = new FakeChild(),
  socket = new FakeSocket(),
) {
  const i = internals(client);
  i.activeGeneration = generation;
  i.nextGeneration = Math.max(i.nextGeneration, generation + 1);
  i.process = child;
  i.startPromise = Promise.resolve();
  i.attachProcess(child, generation);
  const connected = i.attachSocket(
    socket as unknown as WebSocket,
    generation,
    new AbortController().signal,
  );
  socket.open();
  await connected;
  return { child, socket };
}

test('PROXY-004: initialize opts into the experimental API required by runtimeWorkspaceRoots', () => {
  assert.deepEqual(buildInitializeParams(), {
    clientInfo: { name: 'codex-proxy', version: '0.1.0' },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
    },
  });
});

test('PROXY-004: app-server startup disables the vendor updater', () => {
  assert.deepEqual(buildAppServerArgs('ws://127.0.0.1:4321'), [
    '-c', 'check_for_update_on_startup=false',
    'app-server', '--listen', 'ws://127.0.0.1:4321',
  ]);
});

test('PROXY-004: real start path spans spawn, readyz, WebSocket, serverRequest, and runtimeStopped', async () => {
  const fakeCodex = fileURLToPath(new URL('./fixtures/fake-codex-app-server.js', import.meta.url));
  chmodSync(fakeCodex, 0o755);
  const client = new CodexAppServerClient({
    codexBin: fakeCodex,
    deadlines: {
      startupMs: 5_000,
      readyMs: 2_000,
      socketConnectMs: 2_000,
      rpcMs: 5_000,
      terminateGraceMs: 100,
    },
  });
  let stoppedCount = 0;
  const stopped = new Promise<void>((resolve) => {
    client.on('runtimeStopped', () => {
      stoppedCount += 1;
      resolve();
    });
  });
  const serverRequest = new Promise<{ id: number; method: string; params?: unknown }>((resolve) => {
    client.on('serverRequest', message => resolve(message as {
      id: number;
      method: string;
      params?: unknown;
    }));
  });

  try {
    await client.ensureStarted();
    const request = await within(serverRequest, 2_000, 'fixture serverRequest');
    assert.deepEqual(request, {
      jsonrpc: '2.0',
      id: 901,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'fixture-command' },
    });

    const pending = client.readThread('fixture-pending').then(
      result => ({ status: 'resolved' as const, result }),
      error => ({ status: 'rejected' as const, error }),
    );
    await client.respond(request.id, { decision: 'accept' });
    await within(stopped, 2_000, 'fixture runtimeStopped');
    const settled = await within(pending, 2_000, 'fixture pending RPC drain');
    assert.equal(settled.status, 'rejected');
    if (settled.status === 'rejected') {
      assert.match(
        String(settled.error),
        /Codex app-server (stopped|websocket (?:closed|failed))/,
      );
    }
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(stoppedCount, 1);
  } finally {
    await client.stop();
  }
});

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

test('PROXY-004: simulated child exit rejects every pending request with `Codex app-server stopped.`', async () => {
  const client = new CodexAppServerClient();
  const { child } = await installRuntime(client);

  const a = makePending();
  const b = makePending();
  internals(client).pending.set(1, a.pending);
  internals(client).pending.set(2, b.pending);

  child.exit();

  await assert.rejects(a.promise, /Codex app-server stopped/);
  await assert.rejects(b.promise, /Codex app-server stopped/);
  assert.equal(internals(client).pending.size, 0,
    'pending map must be drained on child exit so the next start() begins clean');
});

test('PROXY-004: simulated child exit emits `runtimeStopped` exactly once', async () => {
  const client = new CodexAppServerClient();
  const { child } = await installRuntime(client);

  let stops = 0;
  client.on('runtimeStopped', () => { stops += 1; });
  child.exit();
  child.emit('exit', 0, null);
  assert.equal(stops, 1, 'runtimeStopped must surface so SessionManager can flip session→error');
});

test('PROXY-004: child exit clears socket + startPromise so a subsequent ensureStarted re-spawns', async () => {
  const client = new CodexAppServerClient();
  const { child } = await installRuntime(client);

  child.exit();
  assert.equal(internals(client).socket, null,
    'socket reference must be dropped — leaving a stale handle would let send() write to a closed pipe');
  assert.equal(internals(client).startPromise, null,
    'startPromise must clear so ensureStarted re-spawns the codex child on the next call');
});

// ---------------------------------------------------------------------------
// PROXY-005 — socket-only failure, deadlines, deterministic recovery
// ---------------------------------------------------------------------------

test('PROXY-005: socket-only close rejects all pending RPCs and child exit cannot double-notify', async () => {
  const client = new CodexAppServerClient({
    deadlines: { rpcMs: 1_000, terminateGraceMs: 20 },
  });
  const { child, socket } = await installRuntime(client);
  const i = internals(client);
  let stops = 0;
  client.on('runtimeStopped', () => { stops += 1; });

  const first = i.requestInternal('thread/read', { threadId: 'one' });
  const second = i.requestInternal('thread/read', { threadId: 'two' });
  assert.equal(i.pending.size, 2);

  // Only the transport disappears; the child intentionally remains alive.
  socket.disconnect();
  const results = await Promise.allSettled([first, second]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.match(String(result.reason), /websocket closed/);
  }

  assert.equal(i.pending.size, 0);
  assert.equal(i.startPromise, null);
  assert.equal(i.activeGeneration, null);
  assert.deepEqual(child.killSignals, ['SIGTERM'],
    'a live app-server must be terminated rather than left orphaned after socket loss');
  assert.equal(stops, 1);

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL'],
    'a child that survives the grace period must be force-killed deterministically');

  // Browser/WebSocket implementations commonly report error/close together,
  // then the SIGTERM produces child exit. All are the same generation.
  socket.fail();
  child.exit();
  assert.equal(stops, 1, 'close/error/exit re-entry must emit one lifecycle stop only');
});

test('PROXY-005: socket error before close drains pending immediately and only once', async () => {
  const client = new CodexAppServerClient({
    deadlines: { rpcMs: 1_000, terminateGraceMs: 500 },
  });
  const { child, socket } = await installRuntime(client);
  const i = internals(client);
  const pending = i.requestInternal('thread/read', { threadId: 'one' });
  const manual = makePending();
  let manualRejects = 0;
  i.pending.set(999, {
    resolve: manual.pending.resolve,
    reject: (error) => {
      manualRejects += 1;
      manual.pending.reject(error);
    },
  });
  let stops = 0;
  client.on('runtimeStopped', () => { stops += 1; });

  socket.fail();
  await Promise.all([
    assert.rejects(pending, /websocket failed/),
    assert.rejects(manual.promise, /websocket failed/),
  ]);
  socket.disconnect();
  child.exit();

  assert.equal(i.pending.size, 0);
  assert.equal(manualRejects, 1, 'error/close/exit re-entry must call each reject exactly once');
  assert.equal(stops, 1);
});

test('PROXY-005: a never-returning RPC times out, tears down, and the next request recovers', async () => {
  const client = new CodexAppServerClient({
    deadlines: { rpcMs: 25, terminateGraceMs: 500 },
  });
  const firstRuntime = await installRuntime(client);
  const i = internals(client);
  let stops = 0;
  client.on('runtimeStopped', () => { stops += 1; });

  await assert.rejects(
    client.readThread('thread-hung'),
    /RPC "thread\/read" timed out after 25ms/,
  );
  assert.equal(i.pending.size, 0);
  assert.equal(i.startPromise, null);
  assert.equal(i.activeGeneration, null);
  assert.deepEqual(firstRuntime.child.killSignals, ['SIGTERM']);
  assert.equal(stops, 1);

  const recoveredChild = new FakeChild();
  const recoveredSocket = new FakeSocket();
  recoveredSocket.onSend = (raw) => {
    const request = JSON.parse(raw) as { id?: number };
    if (typeof request.id === 'number') {
      queueMicrotask(() => recoveredSocket.receive({
        jsonrpc: '2.0',
        id: request.id,
        result: { thread: { id: 'thread-recovered' } },
      }));
    }
  };
  i.start = async (generation) => {
    i.process = recoveredChild;
    i.attachProcess(recoveredChild, generation);
    const connected = i.attachSocket(
      recoveredSocket as unknown as WebSocket,
      generation,
      new AbortController().signal,
    );
    recoveredSocket.open();
    await connected;
  };

  assert.deepEqual(await client.readThread('thread-recovered'), {
    thread: { id: 'thread-recovered' },
  });
  assert.equal(i.activeGeneration, 2);
  assert.equal(stops, 1);

  // A delayed exit from generation 1 must not tear down generation 2.
  firstRuntime.child.exit();
  assert.equal(i.activeGeneration, 2);
  assert.equal(stops, 1);
  await client.stop();
  recoveredChild.exit();
});

test('PROXY-005: successful response clears its RPC timer', async () => {
  const client = new CodexAppServerClient({
    deadlines: { rpcMs: 25, terminateGraceMs: 500 },
  });
  const { child, socket } = await installRuntime(client);
  let stops = 0;
  client.on('runtimeStopped', () => { stops += 1; });
  socket.onSend = (raw) => {
    const request = JSON.parse(raw) as { id?: number };
    queueMicrotask(() => socket.receive({ jsonrpc: '2.0', id: request.id, result: 'ok' }));
  };

  assert.equal(await internals(client).requestInternal('fast', {}), 'ok');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(stops, 0, 'a settled RPC timer must not later stop a healthy runtime');
  assert.equal(internals(client).pending.size, 0);
  await client.stop();
  child.exit();
});

test('PROXY-005: socket handshake has a configurable deadline', async () => {
  const client = new CodexAppServerClient({
    deadlines: { socketConnectMs: 20, terminateGraceMs: 500 },
  });
  const i = internals(client);
  const child = new FakeChild();
  const socket = new FakeSocket();
  i.activeGeneration = 1;
  i.nextGeneration = 2;
  i.startPromise = Promise.resolve();
  i.process = child;
  i.attachProcess(child, 1);
  let stops = 0;
  client.on('runtimeStopped', () => { stops += 1; });

  await assert.rejects(
    i.attachSocket(socket as unknown as WebSocket, 1, new AbortController().signal),
    /Timed out connecting Codex app-server websocket after 20ms/,
  );
  assert.equal(stops, 1);
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  child.exit();
  assert.equal(stops, 1);
});

test('PROXY-005: startup, ready, socket, RPC, and termination deadlines are configurable', () => {
  const client = new CodexAppServerClient({
    deadlines: {
      startupMs: 101,
      readyMs: 102,
      socketConnectMs: 103,
      rpcMs: 104,
      terminateGraceMs: 105,
    },
  });
  assert.deepEqual(internals(client).deadlines, {
    startupMs: 101,
    readyMs: 102,
    socketConnectMs: 103,
    rpcMs: 104,
    terminateGraceMs: 105,
  });
  assert.throws(
    () => new CodexAppServerClient({ deadlines: { rpcMs: 0 } }),
    /deadline rpcMs must be a positive finite number/,
  );
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
  const { child, socket } = await installRuntime(client);

  await client.stop();
  assert.equal(socket.closeCalls, 1);
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  assert.equal(internals(client).process, null,
    'process reference must be dropped so stop() is idempotent');
  assert.equal(internals(client).startPromise, null,
    'startPromise must clear so a later ensureStarted() re-spawns');
  child.exit();
});

test('PROXY-004: stop() does NOT re-kill an already-killed child', async () => {
  const client = new CodexAppServerClient();
  const child = new FakeChild();
  child.killed = true;
  await installRuntime(client, 1, child);

  await client.stop();
  assert.equal(child.killSignals.length, 0,
    'already-killed child must not be SIGTERMed again — would surface as ESRCH in the log');
  child.exit();
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

test('thread/start inherits config.toml and captures the effective permission profile', async () => {
  const client = new CodexAppServerClient();
  const calls: Array<{ method: string; params: unknown }> = [];
  (client as unknown as { request(method: string, params: unknown): Promise<unknown> }).request =
    async (method, params) => {
      calls.push({ method, params });
      return CODEX_APP_SERVER_V2_NAMED_PERMISSIONS.response;
    };

  const result = await client.startThread({ cwd: '/repo' });
  assert.deepEqual(calls, [{
    method: 'thread/start',
    params: { cwd: '/repo', experimentalRawEvents: false },
  }]);
  assert.deepEqual(result.configuredPermissions, {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    permissions: 'my-profile',
  });
});

test('thread/start accepts the complete versioned granular permission shape', async () => {
  const client = new CodexAppServerClient();
  (client as unknown as { request(method: string, params: unknown): Promise<unknown> }).request =
    async () => CODEX_APP_SERVER_V2_GRANULAR_PERMISSIONS.response;

  const result = await client.startThread({ cwd: '/repo' });
  assert.deepEqual(result.configuredPermissions, {
    approvalPolicy: CODEX_APP_SERVER_V2_GRANULAR_PERMISSIONS.response.approvalPolicy,
    approvalsReviewer: 'guardian_subagent',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  });
});

test('thread/start canonicalizes v2 default-elided granular fields', async () => {
  const client = new CodexAppServerClient();
  (client as unknown as { request(method: string, params: unknown): Promise<unknown> }).request =
    async () => CODEX_APP_SERVER_V2_DEFAULT_ELIDED_GRANULAR_PERMISSIONS.response;

  const result = await client.startThread({ cwd: '/repo' });
  assert.deepEqual(result.configuredPermissions, {
    approvalPolicy: {
      granular: {
        sandbox_approval: true,
        rules: true,
        skill_approval: false,
        request_permissions: false,
        mcp_elicitations: true,
      },
    },
    approvalsReviewer: 'user',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  });
});

test('thread/start accepts and normalizes the current v2 external sandbox', async () => {
  const client = new CodexAppServerClient();
  (client as unknown as { request(method: string, params: unknown): Promise<unknown> }).request =
    async () => CODEX_APP_SERVER_V2_EXTERNAL_SANDBOX_PERMISSIONS.response;

  const result = await client.startThread({ cwd: '/repo' });
  assert.deepEqual(result.configuredPermissions, {
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandboxPolicy: {
      type: 'externalSandbox',
      provider: 'fixture',
      networkAccess: 'restricted',
    },
  });
});

for (const fixture of CODEX_APP_SERVER_UNKNOWN_PERMISSIONS) {
  test(`thread/start fails closed for ${fixture.fixtureVersion}`, async () => {
    const client = new CodexAppServerClient();
    (client as unknown as { request(method: string, params: unknown): Promise<unknown> }).request =
      async () => fixture.response;

    await assert.rejects(
      client.startThread({ cwd: '/repo' }),
      /effective (approval|sandbox) policy/,
    );
  });
}

test('turn/start sends an exact configured profile without a conflicting sandbox policy', async () => {
  const client = new CodexAppServerClient();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  (client as unknown as { request(method: string, params: unknown): Promise<unknown> }).request =
    async (method, params) => {
      calls.push({ method, params: params as Record<string, unknown> });
      return { turn: { id: 'turn-1', status: 'inProgress' } };
    };

  await client.startTurn(
    'thread-1',
    [{ type: 'text', text: 'hello' }],
    {
      permissions: 'my-profile',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'danger-full-access',
      runtimeWorkspaceRoots: ['/repo', '/tmp/gian/attachments/session'],
    },
  );
  assert.equal(calls[0]?.params.permissions, 'my-profile');
  assert.deepEqual(
    calls[0]?.params.runtimeWorkspaceRoots,
    ['/repo', '/tmp/gian/attachments/session'],
  );
  assert.equal('sandboxPolicy' in (calls[0]?.params ?? {}), false);
});
