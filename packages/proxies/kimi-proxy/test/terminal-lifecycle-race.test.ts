import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Agent,
  type Client,
  type InitializeResponse,
} from '@agentclientprotocol/sdk';

import { KimiProxyService } from '../src/core/service.js';
import { KimiProtocolV2Adapter, type WireRequest } from '../src/protocol/v2-adapter.js';
import {
  KimiAcpClient,
  type KimiAcpExit,
  type KimiAcpTransportFactory,
} from '../src/runtime/kimi-acp-client.js';
import {
  KimiTerminalService,
  TerminalCleanupError,
  TerminalOwnershipError,
  type TerminalProcessGroupAdapter,
} from '../src/runtime/terminal-service.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function initializeResponse(): InitializeResponse {
  return {
    protocolVersion: 1,
    agentInfo: { name: 'fake-kimi', version: '0.0.0-test' },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: {
        list: {},
        resume: {},
        close: {},
      },
    },
    authMethods: [{ id: 'login', name: 'Login', type: 'terminal', args: ['login'] }],
  };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function tempCwd(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'kimi-race-')));
}

function killRealGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

const BASE_ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin' };

type TerminalServiceOptions = ConstructorParameters<typeof KimiTerminalService>[0];

// ---------------------------------------------------------------------------
// Service/client integration harness (tests 1-4): scripted cancel/close RPCs
// plus a reverse createTerminal probe, over the real ACP connection.
// ---------------------------------------------------------------------------

interface RaceHarness {
  service: KimiProxyService;
  runtime: KimiAcpClient;
  createTerminal: (params: { sessionId: string; command: string; args?: string[] }) => Promise<{ terminalId: string }>;
  nativeSessionId: () => string;
  sessionId: string;
  streamId: string;
}

async function makeHarnessWithLiveTerminal(
  adapterOptions: TerminalServiceOptions,
): Promise<RaceHarness & { liveTerminalId: string }> {
  const harness = await makeHarness({ adapterOptions });
  await harness.service.startTurn({
    sessionId: harness.sessionId,
    input: [{ type: 'text', text: 'hold a terminal' }],
  });
  const spawned = await harness.createTerminal({
    sessionId: harness.nativeSessionId(),
    command: '/bin/sleep',
    args: ['30'],
  });
  return { ...harness, liveTerminalId: spawned.terminalId };
}

async function makeHarness(options: {
  cancelDeferred?: Deferred<void>;
  closeDeferred?: Deferred<void>;
  cancelShouldReject?: boolean;
  closeShouldReject?: boolean;
  adapterOptions?: TerminalServiceOptions;
}): Promise<RaceHarness> {
  let remoteCreateTerminal: ((params: {
    sessionId: string;
    command: string;
    args?: string[];
  }) => Promise<unknown>) | null = null;
  let nativeSessionId = '';
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    terminalProcessGroupAdapter: options.adapterOptions,
    transportFactory: async (client: Client) => {
      const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
      const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
      const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);
      const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
      const exit = deferred<KimiAcpExit>();
      let remoteClientHandle: AgentSideConnection | null = null;
      new AgentSideConnection((remoteClient) => {
        remoteClientHandle = remoteClient;
        return {
        initialize: async () => initializeResponse(),
        newSession: async () => {
          nativeSessionId = `native-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          return { sessionId: nativeSessionId };
        },
        prompt: async () => {
          await new Promise<void>(() => undefined); // the turn stays active
        },
        cancel: async () => {
          if (options.cancelDeferred) await options.cancelDeferred.promise;
          if (options.cancelShouldReject) throw new Error('cancel exploded');
        },
        closeSession: async () => {
          if (options.closeDeferred) await options.closeDeferred.promise;
          if (options.closeShouldReject) throw new Error('native close exploded');
          return {};
        },
        setSessionConfigOption: async () => ({ configOptions: [] }),
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: async () => undefined,
        createTerminal: async (params: { sessionId: string; command: string; args?: string[] }) => {
          if (!remoteCreateTerminal) throw new Error('createTerminal probe not armed');
          return remoteCreateTerminal(params);
        },
        } as unknown as Agent;
      }, agentStream);
      remoteCreateTerminal = (params) => {
        if (!remoteClientHandle) {
          return Promise.reject(new Error('probe transport not ready'));
        }
        return remoteClientHandle.createTerminal({
          ...params,
          cwd: tempCwd(),
        }).then((handle) => ({ terminalId: handle.id }));
      };
      return {
        connection: new ClientSideConnection(() => client, clientStream),
        exit: exit.promise,
        async stop() {
          exit.resolve({ code: 0, signal: null });
        },
      };
    },
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new KimiProtocolV2Adapter(service, '0.2.6', (method, params) => {
    notifications.push({ method, params });
  });
  await adapter.handle({
    id: '1',
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['2.1'] },
      host: { name: 'Gian', version: '9.9.9' },
    },
  } as unknown as WireRequest);
  const created = await adapter.handle({
    id: '2',
    method: 'session.create',
    params: {
      sessionId: 'host-race',
      workspace: { cwd: tempCwd(), roots: [tempCwd()] },
      config: {},
    },
  } as unknown as WireRequest) as { session: { streamId: string } };

  // The service mints its own session id; the adapter maps 'host-race' to it.
  const serviceSessionId = [...(service as unknown as {
    sessionsById: Map<string, unknown>;
  }).sessionsById.keys()][0]!;

  return {
    service,
    runtime,
    createTerminal: (params) => remoteCreateTerminal!(params) as Promise<{ terminalId: string }>,
    nativeSessionId: () => nativeSessionId,
    sessionId: serviceSessionId,
    streamId: created.session.streamId,
  };
}

async function startTurn(harness: RaceHarness): Promise<void> {
  await harness.service.startTurn({
    sessionId: harness.sessionId,
    input: [{ type: 'text', text: 'work' }],
  });
}

test('interrupt: drain reaps the live terminal and re-enables creation', async () => {
  let killable = false;
  const deadAt = new Map<number, number>();
  const harness = await makeHarnessWithLiveTerminal({
    processGroupAdapter: {
      signalGroup(pgid, signal) {
        if (signal === 'SIGTERM' && killable) {
          deadAt.set(pgid, Date.now());
          killRealGroup(pgid);
        }
      },
      groupExists(pgid) {
        if (killable) return !deadAt.has(pgid);
        return true;
      },
    },
    termGraceMs: 60,
    groupVerifyMs: 60,
    groupPollMs: 5,
    exitSettleMs: 500,
    delay,
  });
  const native = harness.nativeSessionId();

  // Cleanup failure keeps the session blocked and fails the interrupt.
  await assert.rejects(
    harness.service.interruptTurn({ sessionId: harness.sessionId }),
    /Terminal cleanup after interrupt failed/,
  );
  await assert.rejects(harness.createTerminal({ sessionId: native, command: '/bin/pwd' }));

  // A later fully-successful drain cycle re-enables creation.
  killable = true;
  await harness.service.interruptTurn({ sessionId: harness.sessionId });
  const created = await harness.createTerminal({ sessionId: native, command: '/bin/pwd' });
  assert.ok(created.terminalId);
  await harness.service.close();
});



test('close pending window: creates are refused through cancel and native close', async () => {
  const cancelDeferred = deferred<void>();
  const closeDeferred = deferred<void>();
  const harness = await makeHarness({ cancelDeferred, closeDeferred });
  await startTurn(harness);
  const native = harness.nativeSessionId();

  const closing = harness.service.closeSession({ sessionId: harness.sessionId });
  // The wire wraps handler failures as opaque JSON-RPC errors; the refusal
  // itself (and its 'blocked' reason) is pinned by the TerminalService tests.
  await assert.rejects(harness.createTerminal({ sessionId: native, command: '/bin/pwd' }));
  cancelDeferred.resolve();
  // The wire wraps handler failures as opaque JSON-RPC errors; the refusal
  // itself (and its 'blocked' reason) is pinned by the TerminalService tests.
  await assert.rejects(harness.createTerminal({ sessionId: native, command: '/bin/pwd' }));
  closeDeferred.resolve();
  await closing;

  // Permanent cleanup deleted the binding: creates fail closed forever (the
  // wire reports the refusal as an opaque JSON-RPC error).
  await assert.rejects(harness.createTerminal({ sessionId: native, command: '/bin/pwd' }));
  await harness.service.close();
});

test('native close failure still drains and reports the combined failure', async () => {
  const harness = await makeHarness({ closeShouldReject: true });
  await startTurn(harness);
  const native = harness.nativeSessionId();

  await assert.rejects(
    harness.service.closeSession({ sessionId: harness.sessionId }),
    (error: unknown) => error instanceof Error
      && error.message.includes('Session close failed')
      && error.message.includes('native close'),
  );
  // The permanent drain still ran: binding deleted, creates closed forever.
  await assert.rejects(harness.createTerminal({ sessionId: native, command: '/bin/pwd' }));
  await harness.service.close();
});

// ---------------------------------------------------------------------------
// Client shutdown / restart barrier (tests 5-6).
// ---------------------------------------------------------------------------

function scriptedTransportFactory(
  agentFactory: (remoteClient: AgentSideConnection) => Agent,
  firstExit: Deferred<KimiAcpExit>,
  onRemote?: (remoteClient: AgentSideConnection) => void,
): { factory: KimiAcpTransportFactory; starts: () => number } {
  let startCount = 0;
  const factory: KimiAcpTransportFactory = async (client: Client) => {
    startCount += 1;
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);
    const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
    new AgentSideConnection((remoteClient) => {
      onRemote?.(remoteClient);
      return agentFactory(remoteClient);
    }, agentStream);
    // Only the FIRST transport shares the test-controlled exit; later
    // generations get their own live exit so a restart is really alive.
    const exit = startCount === 1 ? firstExit.promise : deferred<KimiAcpExit>().promise;
    return {
      connection: new ClientSideConnection(() => client, clientStream),
      exit,
      async stop() {
        if (startCount === 1) firstExit.resolve({ code: 0, signal: null });
      },
    };
  };
  return { factory, starts: () => startCount };
}

test('unexpected exit: ensureStarted waits for the old generation cleanup barrier', async () => {
  const exit = deferred<KimiAcpExit>();
  let probe: AgentSideConnection | null = null;
  const { factory, starts } = scriptedTransportFactory((remoteClient) => ({
    initialize: async () => initializeResponse(),
    newSession: async () => ({ sessionId: `native-${Date.now()}` }),
    prompt: async () => ({ stopReason: 'end_turn' as const }),
    cancel: async () => undefined,
  } as unknown as Agent), exit, (remoteClient) => {
    probe = remoteClient;
  });

  const slowCleanup: TerminalServiceOptions = {
    processGroupAdapter: {
      signalGroup: (pgid, signal) => {
        void pgid;
        void signal;
        /* scripted: the group is considered gone on the next probe anyway */
      },
      groupExists: () => true,
      // The real script: TERM marks the group gone via the scripting below.
    } as TerminalProcessGroupAdapter,
    exitSettleMs: 1_000,
    delay,
  };
  // Scripted liveness: alive until the first TERM, which the adapter records.
  let terminated = false;
  (slowCleanup.processGroupAdapter as TerminalProcessGroupAdapter).signalGroup = (pgid, signal) => {
    void pgid;
    if (signal === 'SIGTERM') terminated = true;
  };
  (slowCleanup.processGroupAdapter as TerminalProcessGroupAdapter).groupExists = () => !terminated;

  const client = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: factory,
    terminalProcessGroupAdapter: slowCleanup,
  });
  await client.ensureStarted();
  const session = await client.newSession({ cwd: tempCwd(), mcpServers: [] });
  // A live terminal created outside any turn: it survives until the runtime
  // exit, giving the retired generation a real, slow cleanup to barrier on.
  await probe!.createTerminal({
    sessionId: session.sessionId,
    command: '/bin/sleep',
    args: ['0.3'],
    cwd: tempCwd(),
  });

  // Unexpected exit (not via stop): the cleanup barrier assembles and takes
  // at least as long as the scripted harvest + real child exit (~300ms).
  exit.resolve({ code: 0, signal: null });
  await new Promise((resolve) => setImmediate(resolve));
  const restarting = client.ensureStarted();
  await delay(30);
  assert.equal(starts(), 1, 'a new transport must not start while the old cleanup runs');
  await restarting;
  assert.equal(starts(), 2, 'the new transport starts only after the cleanup settles');
  await client.stop().catch(() => undefined);
});

test('failed generation cleanup keeps ensureStarted failing instead of masking PGIDs', async () => {
  const exit = deferred<KimiAcpExit>();
  let probe: AgentSideConnection | null = null;
  const { factory, starts } = scriptedTransportFactory((remoteClient) => ({
    initialize: async () => initializeResponse(),
    newSession: async () => ({ sessionId: `native-${Date.now()}` }),
    prompt: async () => ({ stopReason: 'end_turn' as const }),
    cancel: async () => undefined,
  } as unknown as Agent), exit, (remoteClient) => {
    probe = remoteClient;
  });

  const unkillable: TerminalServiceOptions = {
    processGroupAdapter: {
      signalGroup: (pgid, signal) => {
        void pgid;
        void signal;
        /* scripted: never dies */
      },
      groupExists: () => true,
    },
    termGraceMs: 40,
    groupVerifyMs: 40,
    groupPollMs: 4,
    exitSettleMs: 120,
    delay,
  };

  const client = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: factory,
    terminalProcessGroupAdapter: unkillable,
  });
  await client.ensureStarted();
  const session = await client.newSession({ cwd: tempCwd(), mcpServers: [] });
  // A live terminal the scripted adapter refuses to reap: the retired
  // generation's cleanup must fail and stay failed.
  await probe!.createTerminal({
    sessionId: session.sessionId,
    command: '/bin/sleep',
    args: ['2'],
    cwd: tempCwd(),
  });

  exit.resolve({ code: 1, signal: null });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    client.ensureStarted(),
    /Previous Kimi runtime terminal cleanup failed/,
  );
  assert.equal(starts(), 1, 'a failed cleanup must never start a new runtime');
  await client.stop().catch(() => undefined);
});

// ---------------------------------------------------------------------------
// TerminalService deterministic races (tests 7-10) with the spawn seam.
// ---------------------------------------------------------------------------

interface ScriptedGroup {
  alive: boolean;
  termWorks: boolean;
  killWorks: boolean;
  signals: string[];
}

function makeSeamedService(options: {
  groups: Map<number, ScriptedGroup>;
  groupExists?: (pgid: number) => boolean;
  spawnGate?: () => Promise<void>;
}) {
  const adapter: TerminalProcessGroupAdapter = {
    signalGroup(pgid, signal) {
      if (signal === 0) return;
      const group = options.groups.get(pgid);
      if (!group) return;
      group.signals.push(signal);
      if (signal === 'SIGTERM' && group.termWorks) group.alive = false;
      if (signal === 'SIGKILL' && group.killWorks) group.alive = false;
    },
    groupExists(pgid) {
      if (options.groupExists) return options.groupExists(pgid);
      return options.groups.get(pgid)?.alive ?? false;
    },
  };
  const service = new KimiTerminalService({
    processGroupAdapter: adapter,
    termGraceMs: 40,
    groupVerifyMs: 40,
    groupPollMs: 4,
    exitSettleMs: 1_000,
    delay,
    ...(options.spawnGate ? { spawnSeam: options.spawnGate } : {}),
  });
  service.bindSession('native-race', tempCwd());
  return service;
}

test('spawn TOCTOU: a create that loses the drain race is reaped and rejected', async () => {
  const groups = new Map<number, ScriptedGroup>();
  let releaseSpawn!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSpawn = resolve;
  });
  const service = makeSeamedService({ groups, spawnGate: () => gate });

  const creating = service.create(
    { sessionId: 'native-race', command: '/bin/sleep', args: ['30'] },
    { env: BASE_ENV },
  );
  await waitFor(() => service.pendingCreateCount() === 1, 'create never entered the spawn window');
  const pgid = service.pendingCreatePidForTest('native-race');
  assert.ok(pgid, 'pending create must expose its pid for the race assertions');
  groups.set(pgid, { alive: true, termWorks: true, killWorks: true, signals: [] });

  const lease = service.beginSessionDrain('native-race');
  assert.equal(service.isSessionDraining('native-race'), true);
  releaseSpawn();

  await assert.rejects(creating, /cancelled by a cleanup barrier/);
  await lease.drain();
  assert.equal(groups.get(pgid)!.alive, false, 'the raced child group must be reaped');
  assert.equal(service.activeCount, 0, 'the raced create must not consume quota');
  lease.releaseForNextTurn();
  assert.equal(service.isSessionDraining('native-race'), false);
  const next = await service.create(
    { sessionId: 'native-race', command: '/bin/pwd' },
    { env: BASE_ENV },
  );
  await service.release({ sessionId: 'native-race', terminalId: next.terminalId });
});

test('runtime fence TOCTOU: a fenced generation cannot register its in-flight spawn', async () => {
  const groups = new Map<number, ScriptedGroup>();
  let releaseSpawn!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSpawn = resolve;
  });
  const service = makeSeamedService({ groups, spawnGate: () => gate });

  const creating = service.create(
    { sessionId: 'native-race', command: '/bin/sleep', args: ['30'] },
    { env: BASE_ENV },
  );
  await waitFor(() => service.pendingCreateCount() === 1, 'create never entered the spawn window');
  const fenced = service.fenceRuntime();
  assert.equal(service.isGenerationFenced(fenced.generation), true);
  releaseSpawn();

  await assert.rejects(creating, /cancelled by a cleanup barrier/);
  assert.equal(service.activeCount, 0);
  await service.drainRuntime(fenced.generation);

  // The old generation's child can never escape into the new generation.
  service.advanceGeneration();
  await assert.rejects(
    service.create({ sessionId: 'native-race', command: '/bin/pwd' }, { env: BASE_ENV }),
    TerminalOwnershipError,
  );
});

test('overlapping drains: only the last successful release unlocks; permanent wins', async () => {
  const groups = new Map<number, ScriptedGroup>();
  const service = makeSeamedService({ groups });
  const turnLease = service.beginSessionDrain('native-race');
  const interruptLease = service.beginSessionDrain('native-race');
  const closeLease = service.beginSessionDrain('native-race', { permanent: true });

  await turnLease.drain();
  turnLease.releaseForNextTurn();
  assert.equal(service.isSessionDraining('native-race'), true, 'interrupt lease still holds');
  await interruptLease.drain();
  interruptLease.releaseForNextTurn();
  assert.equal(
    service.isSessionDraining('native-race'),
    true,
    'permanent close still owns the session',
  );
  await assert.rejects(
    service.create({ sessionId: 'native-race', command: '/bin/pwd' }, { env: BASE_ENV }),
    /blocked/,
  );

  await closeLease.drain();
  closeLease.releaseForNextTurn();
  await assert.rejects(
    service.create({ sessionId: 'native-race', command: '/bin/pwd' }, { env: BASE_ENV }),
    TerminalOwnershipError,
    'a permanently closed session never reopens',
  );
});

test('a raced create whose group cannot be reaped stays diagnosable and blocked', async () => {
  const groups = new Map<number, ScriptedGroup>();
  let releaseSpawn!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSpawn = resolve;
  });
  const service = makeSeamedService({ groups, spawnGate: () => gate });

  const creating = service.create(
    { sessionId: 'native-race', command: '/bin/sleep', args: ['2'] },
    { env: BASE_ENV },
  );
  await waitFor(() => service.pendingCreateCount() === 1, 'create never entered the spawn window');
  const pgid = service.pendingCreatePidForTest('native-race');
  assert.ok(pgid);
  groups.set(pgid, { alive: true, termWorks: false, killWorks: false, signals: [] });

  const lease = service.beginSessionDrain('native-race');
  releaseSpawn();
  await assert.rejects(creating, TerminalCleanupError);
  assert.equal(service.activeCount, 0, 'no record may be registered for a rejected raced create');
  assert.ok(
    service.orphanedGroupsForTest().some((entry) => entry.pgid === pgid),
    'the unreapable orphan must be diagnosable with its PGID',
  );
  // The barrier stays: the next create is still refused until a clean drain.
  await assert.rejects(
    service.create({ sessionId: 'native-race', command: '/bin/pwd' }, { env: BASE_ENV }),
    /blocked/,
  );
  await assert.rejects(lease.drain(), TerminalCleanupError);
  lease.keepBlocked();
  killRealGroup(pgid);
});
