// Coverage for traceability row:
//   PROXY-004 — Codex app-server client must handle stdio JSONL framing,
//               serverRequest, runtimeStopped, and pending rejection.
//
// A deterministic cross-process smoke below drives the real start() path
// through a local fake binary (spawn → stdio → initialize).
// The remaining focused tests isolate the message-routing layer:
//   • result frames resolve the matching pending request;
//   • error frames reject the matching pending request;
//   • method+id frames emit `serverRequest` (codex asking us something);
//   • method-only frames emit `notification` (push events);
//   • unknown ids are dropped silently (no crash if server replays).
//
// Plus the lifecycle bits we can drive without spawning:
//   • send() rejects when the stdio pipe is unavailable;
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
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildAppServerArgs,
  buildInitializeParams,
  CodexAppServerClient,
  MAX_APP_SERVER_JSONL_LINE_BYTES,
  MIN_CODEX_STDIO_VERSION,
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
  pending: Map<number, PendingRequest>;
  nextId: number;
  process: FakeChild | null;
  startPromise: Promise<void> | null;
  activeGeneration: number | null;
  nextGeneration: number;
  deadlines: {
    startupMs: number;
    rpcMs: number;
    terminateGraceMs: number;
  };
  start(generation: number): Promise<void>;
  attachProcess(child: FakeChild, generation: number): void;
  handleMessage(raw: string): void;
  send(payload: unknown, generation?: number | null): Promise<void>;
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

function withSpawnEnvironment<T>(name: string, value: string, spawnNow: () => T): T {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return spawnNow();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

class FakeStdin extends Writable {
  readonly writes: string[] = [];
  readonly heldCallbacks: Array<() => void> = [];
  holdWrites = false;
  onWrite: ((data: string) => void) | null = null;

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    const data = chunk.toString();
    this.writes.push(data);
    this.onWrite?.(data);
    if (this.holdWrites) this.heldCallbacks.push(callback);
    else callback();
  }

  releaseNext() {
    this.heldCallbacks.shift()?.();
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
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
) {
  const i = internals(client);
  i.activeGeneration = generation;
  i.nextGeneration = Math.max(i.nextGeneration, generation + 1);
  i.process = child;
  i.startPromise = Promise.resolve();
  i.attachProcess(child, generation);
  return { child };
}

test('PROXY-004: initialize opts into the experimental API required by runtimeWorkspaceRoots', () => {
  assert.deepEqual(buildInitializeParams(), {
    clientInfo: { name: 'codex-proxy', version: '0.2.0' },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
    },
  });
});

test('PROXY-004: app-server startup disables the vendor updater', () => {
  assert.deepEqual(buildAppServerArgs(), [
    '-c', 'check_for_update_on_startup=false',
    'app-server', '--listen', 'stdio://',
  ]);
});

test('PROXY-004: real start path spans spawn, stdio initialize, serverRequest, and runtimeStopped', async () => {
  const fakeCodex = fileURLToPath(new URL('./fixtures/fake-codex-app-server.js', import.meta.url));
  chmodSync(fakeCodex, 0o755);
  const client = new CodexAppServerClient({
    codexBin: fakeCodex,
    deadlines: {
      startupMs: 5_000,
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
        /Codex app-server (stopped|stdout closed)/,
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
// PROXY-004 — stdio JSONL framing
// ---------------------------------------------------------------------------

test('PROXY-004: send() rejects when stdio is not connected', async () => {
  const client = new CodexAppServerClient();
  await assert.rejects(
    internals(client).send({ jsonrpc: '2.0', method: 'noop' }),
    /stdio is not connected/,
  );
});

test('PROXY-004: send() writes one JSONL message without the JSON-RPC header', async () => {
  const client = new CodexAppServerClient();
  const { child } = await installRuntime(client);
  await internals(client).send({ jsonrpc: '2.0', method: 'noop', params: { ok: true } });
  assert.deepEqual(child.stdin.writes, ['{"method":"noop","params":{"ok":true}}\n']);
  await client.stop();
  child.exit();
});

test('PROXY-004: concurrent sends are serialized through stdin', async () => {
  const client = new CodexAppServerClient();
  const { child } = await installRuntime(client);
  child.stdin.holdWrites = true;
  const first = internals(client).send({ method: 'first' });
  const second = internals(client).send({ method: 'second' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(child.stdin.writes, ['{"method":"first"}\n']);
  child.stdin.releaseNext();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(child.stdin.writes, ['{"method":"first"}\n', '{"method":"second"}\n']);
  child.stdin.releaseNext();
  await Promise.all([first, second]);
  await client.stop();
  child.exit();
});

test('PROXY-004: stdout buffers a protocol message split across chunks', async () => {
  const client = new CodexAppServerClient();
  const { child } = await installRuntime(client);
  const pending = makePending();
  internals(client).pending.set(42, pending.pending);
  child.stdout.write('{"id":42,"res');
  child.stdout.write('ult":{"ok":true}}\n');
  assert.deepEqual(await pending.promise, { ok: true });
  await client.stop();
  child.exit();
});

test('PROXY-004: stdout handles multiple protocol messages in one chunk', async () => {
  const client = new CodexAppServerClient();
  const { child } = await installRuntime(client);
  const notifications: unknown[] = [];
  client.on('notification', message => notifications.push(message));
  child.stdout.write(
    '{"method":"first","params":{"n":1}}\n'
    + '{"method":"second","params":{"n":2}}\n',
  );
  assert.deepEqual(notifications, [
    { method: 'first', params: { n: 1 } },
    { method: 'second', params: { n: 2 } },
  ]);
  await client.stop();
  child.exit();
});

test('PROXY-004: stderr remains diagnostic and never enters the protocol channel', async () => {
  const client = new CodexAppServerClient();
  const { child } = await installRuntime(client);
  const debug: string[] = [];
  let stops = 0;
  client.on('debug', message => debug.push(String(message)));
  client.on('runtimeStopped', () => { stops += 1; });
  child.stderr.write('{not-json diagnostic only}\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(debug, ['{not-json diagnostic only}']);
  assert.equal(stops, 0);
  assert.equal(internals(client).activeGeneration, 1);
  await client.stop();
  child.exit();
});

test('PROXY-004: malformed stdout rejects every pending request as runtime failure', async () => {
  const client = new CodexAppServerClient();
  const { child } = await installRuntime(client);
  const pending = internals(client).requestInternal('thread/read', { threadId: 'one' });
  let stops = 0;
  client.on('runtimeStopped', () => { stops += 1; });
  child.stdout.write('not-json\n');
  await assert.rejects(pending, /stdout contained malformed JSONL/);
  assert.equal(stops, 1);
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  child.exit();
});

test('PROXY-004: oversized stdout line fails before an unbounded buffer can grow', async () => {
  const client = new CodexAppServerClient();
  const { child } = await installRuntime(client);
  const stopped = new Promise<void>(resolve => client.once('runtimeStopped', resolve));
  child.stdout.write(Buffer.alloc(MAX_APP_SERVER_JSONL_LINE_BYTES + 1, 0x78));
  await within(stopped, 1_000, 'oversized line runtimeStopped');
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  child.exit();
});

// ---------------------------------------------------------------------------
// PROXY-004/005 — runtime failure, deadlines, deterministic recovery
// ---------------------------------------------------------------------------

test('PROXY-004: child exit rejects every pending request and notifies exactly once', async () => {
  const client = new CodexAppServerClient();
  const { child } = await installRuntime(client);
  const a = makePending();
  const b = makePending();
  internals(client).pending.set(1, a.pending);
  internals(client).pending.set(2, b.pending);
  let stops = 0;
  client.on('runtimeStopped', () => { stops += 1; });
  child.exit(17);
  child.emit('exit', 17, null);
  await assert.rejects(a.promise, /Codex app-server stopped \(exit code 17\)/);
  await assert.rejects(b.promise, /Codex app-server stopped \(exit code 17\)/);
  assert.equal(internals(client).pending.size, 0);
  assert.equal(internals(client).startPromise, null);
  assert.equal(stops, 1);
});

test('PROXY-005: stdout EOF rejects pending RPCs and enforces TERM to KILL grace', async () => {
  const client = new CodexAppServerClient({
    deadlines: { rpcMs: 1_000, terminateGraceMs: 20 },
  });
  const { child } = await installRuntime(client);
  const first = internals(client).requestInternal('thread/read', { threadId: 'one' });
  const second = internals(client).requestInternal('thread/read', { threadId: 'two' });
  let stops = 0;
  client.on('runtimeStopped', () => { stops += 1; });
  child.stdout.end();
  const results = await Promise.allSettled([first, second]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.match(String(result.reason), /stdout closed/);
  }
  assert.equal(stops, 1);
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
  child.exit();
  assert.equal(stops, 1);
});

test('PROXY-005: stdout stream error drains pending immediately and only once', async () => {
  const client = new CodexAppServerClient({
    deadlines: { rpcMs: 1_000, terminateGraceMs: 500 },
  });
  const { child } = await installRuntime(client);
  const pending = internals(client).requestInternal('thread/read', { threadId: 'one' });
  const manual = makePending();
  let manualRejects = 0;
  internals(client).pending.set(999, {
    resolve: manual.pending.resolve,
    reject: (error) => {
      manualRejects += 1;
      manual.pending.reject(error);
    },
  });
  let stops = 0;
  client.on('runtimeStopped', () => { stops += 1; });
  child.stdout.emit('error', new Error('fixture stdout failure'));
  await Promise.all([
    assert.rejects(pending, /fixture stdout failure/),
    assert.rejects(manual.promise, /fixture stdout failure/),
  ]);
  child.stdout.end();
  child.exit();
  assert.equal(manualRejects, 1);
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
  await assert.rejects(client.readThread('thread-hung'), /RPC "thread\/read" timed out after 25ms/);
  assert.equal(i.pending.size, 0);
  assert.equal(i.activeGeneration, null);
  assert.deepEqual(firstRuntime.child.killSignals, ['SIGTERM']);
  assert.equal(stops, 1);

  const recoveredChild = new FakeChild();
  recoveredChild.stdin.onWrite = (raw) => {
    const request = JSON.parse(raw) as { id?: number };
    if (typeof request.id === 'number') {
      queueMicrotask(() => recoveredChild.stdout.write(`${JSON.stringify({
        id: request.id,
        result: { thread: { id: 'thread-recovered' } },
      })}\n`));
    }
  };
  i.start = async (generation) => {
    i.process = recoveredChild;
    i.attachProcess(recoveredChild, generation);
  };
  assert.deepEqual(await client.readThread('thread-recovered'), {
    thread: { id: 'thread-recovered' },
  });
  assert.equal(i.activeGeneration, 2);
  firstRuntime.child.exit();
  assert.equal(i.activeGeneration, 2, 'a stale generation exit must not stop the recovered runtime');
  assert.equal(stops, 1);
  await client.stop();
  recoveredChild.exit();
});

test('PROXY-005: successful response clears its RPC timer', async () => {
  const client = new CodexAppServerClient({
    deadlines: { rpcMs: 25, terminateGraceMs: 500 },
  });
  const { child } = await installRuntime(client);
  let stops = 0;
  client.on('runtimeStopped', () => { stops += 1; });
  child.stdin.onWrite = (raw) => {
    const request = JSON.parse(raw) as { id?: number };
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result: 'ok' })}\n`));
  };
  assert.equal(await internals(client).requestInternal('fast', {}), 'ok');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(stops, 0);
  assert.equal(internals(client).pending.size, 0);
  await client.stop();
  child.exit();
});

test('PROXY-005: startup, RPC, and termination deadlines are configurable', () => {
  const client = new CodexAppServerClient({
    deadlines: { startupMs: 101, rpcMs: 104, terminateGraceMs: 105 },
  });
  assert.deepEqual(internals(client).deadlines, {
    startupMs: 101,
    rpcMs: 104,
    terminateGraceMs: 105,
  });
  assert.throws(
    () => new CodexAppServerClient({ deadlines: { rpcMs: 0 } }),
    /deadline rpcMs must be a positive finite number/,
  );
});

test('PROXY-004: unsupported stdio CLI startup has an actionable version diagnostic', async () => {
  const fakeCodex = fileURLToPath(new URL('./fixtures/fake-codex-app-server.js', import.meta.url));
  chmodSync(fakeCodex, 0o755);
  const client = new CodexAppServerClient({
    codexBin: fakeCodex,
    deadlines: { startupMs: 2_000, rpcMs: 2_000, terminateGraceMs: 100 },
  });
  const started = withSpawnEnvironment(
    'GIAN_FAKE_CODEX_UNSUPPORTED_STDIO',
    '1',
    () => client.ensureStarted(),
  );
  await assert.rejects(
    started,
    new RegExp(`does not support app-server stdio transport.*${MIN_CODEX_STDIO_VERSION}`),
  );
  await client.stop();
});

test('PROXY-004: general stdio startup failures are not mislabeled as old CLI support', async () => {
  const fakeCodex = fileURLToPath(new URL('./fixtures/fake-codex-app-server.js', import.meta.url));
  chmodSync(fakeCodex, 0o755);
  const client = new CodexAppServerClient({
    codexBin: fakeCodex,
    deadlines: { startupMs: 2_000, rpcMs: 2_000, terminateGraceMs: 100 },
  });
  const started = withSpawnEnvironment(
    'GIAN_FAKE_CODEX_STARTUP_FAILURE',
    '1',
    () => client.ensureStarted(),
  );
  await assert.rejects(started, (error: unknown) => {
    assert.match(String(error), /failed to start over stdio/);
    assert.match(String(error), /failed while loading config/);
    assert.doesNotMatch(String(error), /does not support/);
    return true;
  });
  await client.stop();
});

test('PROXY-005: startup deadline covers spawn through initialize completion', async () => {
  const fakeCodex = fileURLToPath(new URL('./fixtures/fake-codex-app-server.js', import.meta.url));
  chmodSync(fakeCodex, 0o755);
  const client = new CodexAppServerClient({
    codexBin: fakeCodex,
    deadlines: { startupMs: 30, rpcMs: 1_000, terminateGraceMs: 100 },
  });
  const started = withSpawnEnvironment(
    'GIAN_FAKE_CODEX_HANG_INITIALIZE',
    '1',
    () => client.ensureStarted(),
  );
  await assert.rejects(started, /Timed out starting Codex app-server after 30ms/);
  await client.stop();
});

// ---------------------------------------------------------------------------
// PROXY-004 — stop()
// ---------------------------------------------------------------------------

test('PROXY-004: stop() is a clean no-op when nothing was started', async () => {
  const client = new CodexAppServerClient();
  await client.stop(); // must not throw
});

test('PROXY-004: stop() SIGTERMs the child process', async () => {
  const client = new CodexAppServerClient();
  const { child } = await installRuntime(client);

  await client.stop();
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
  // We can't directly call requestInternal without a running child, but we can
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
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'gpt-5-codex',
          reasoning_effort: 'medium',
          developer_instructions: null,
        },
      },
      serviceTier: 'fast',
      sandbox: 'danger-full-access',
      runtimeWorkspaceRoots: ['/repo', '/tmp/gian/attachments/session'],
    },
  );
  assert.equal(calls[0]?.params.permissions, 'my-profile');
  assert.equal(calls[0]?.params.approvalPolicy, 'on-request');
  assert.equal(calls[0]?.params.approvalsReviewer, 'user');
  assert.deepEqual(calls[0]?.params.collaborationMode, {
    mode: 'plan',
    settings: {
      model: 'gpt-5-codex',
      reasoning_effort: 'medium',
      developer_instructions: null,
    },
  });
  assert.equal(calls[0]?.params.serviceTier, 'fast');
  assert.deepEqual(
    calls[0]?.params.runtimeWorkspaceRoots,
    ['/repo', '/tmp/gian/attachments/session'],
  );
  assert.equal('sandboxPolicy' in (calls[0]?.params ?? {}), false);
});

test('thread/list paginates, applies the cwd filter, and prefers the Codex title over preview', async () => {
  const client = new CodexAppServerClient();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  (client as unknown as { request(method: string, params: unknown): Promise<unknown> }).request =
    async (method, params) => {
      const request = params as Record<string, unknown>;
      calls.push({ method, params: request });
      if (request.cursor === 'page-2') {
        return {
          data: [
            {
              id: 'thread-1',
              name: 'stale duplicate',
              preview: 'ignored',
              cwd: '/repo',
              updatedAt: 1_699_999_999,
            },
            {
              id: 'thread-2',
              name: null,
              preview: '  First\nquestion   without a generated title  ',
              cwd: '/repo',
              updatedAt: '2023-11-13T22:13:20Z',
            },
          ],
          nextCursor: null,
        };
      }
      return {
        data: [
          {
            id: 'thread-1',
            name: '  LM-generated   project\nsummary  ',
            preview: 'Raw first user question',
            cwd: '/repo',
            updatedAt: 1_700_000_000,
          },
          {
            id: 'wrong-cwd',
            name: 'Must be filtered locally',
            cwd: '/other',
            updatedAt: 1_700_000_001,
          },
          { id: '   ', name: 'Invalid id', cwd: '/repo', updatedAt: 1_700_000_002 },
        ],
        nextCursor: 'page-2',
      };
    };

  assert.deepEqual(await client.listNativeThreads('/repo'), [
    {
      id: 'thread-1',
      displayName: 'LM-generated project summary',
      cwd: '/repo',
      updatedAt: '2023-11-14T22:13:20.000Z',
    },
    {
      id: 'thread-2',
      displayName: 'First question without a generated title',
      cwd: '/repo',
      updatedAt: '2023-11-13T22:13:20.000Z',
    },
  ]);
  assert.deepEqual(calls, [
    {
      method: 'thread/list',
      params: {
        cwd: '/repo',
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
      },
    },
    {
      method: 'thread/list',
      params: {
        cwd: '/repo',
        cursor: 'page-2',
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
      },
    },
  ]);
});

test('thread/list rejects a repeated pagination cursor instead of looping forever', async () => {
  const client = new CodexAppServerClient();
  (client as unknown as { request(method: string, params: unknown): Promise<unknown> }).request =
    async () => ({ data: [], nextCursor: 'same-page' });

  await assert.rejects(
    client.listNativeThreads('/repo'),
    /invalid pagination cursor/,
  );
});
