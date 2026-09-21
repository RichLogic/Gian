import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const isolatedKimiHome = mkdtempSync(join(tmpdir(), 'gian-kimi-rpc-deadline-home-'));
mkdirSync(join(isolatedKimiHome, '.kimi-code'), { recursive: true });
process.env.HOME = isolatedKimiHome;
process.env.KIMI_CODE_HOME = join(isolatedKimiHome, '.kimi-code');

const fakeKimiCli = join(
  fileURLToPath(new URL('../..', import.meta.url)),
  'test',
  'fixtures',
  'fake-kimi-cli.mjs',
);
chmodSync(fakeKimiCli, 0o755);

import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Agent,
  type Client,
  type InitializeResponse,
  type PromptResponse,
} from '@agentclientprotocol/sdk';

import { KimiProxyService } from '../src/core/service.js';
import { createTaskQueue } from '../src/core/task-queue.js';
import { KimiProtocolV2Adapter, type WireRequest } from '../src/protocol/v2-adapter.js';
import {
  KimiAcpClient,
  KimiAcpRpcTimeoutError,
  type KimiAcpExit,
  type KimiAcpRuntimeStoppedEvent,
  type KimiAcpTransportFactory,
} from '../src/runtime/kimi-acp-client.js';

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

/** A fake agent method that never answers: the wedged-runtime condition. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function transportFactory(agentFactory: (client: AgentSideConnection) => Agent) {
  const factory: KimiAcpTransportFactory = async (client: Client) => {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);
    const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
    const exit = deferred<KimiAcpExit>();
    new AgentSideConnection(agentFactory, agentStream);
    return {
      connection: new ClientSideConnection(() => client, clientStream),
      exit: exit.promise,
      async stop() {
        exit.resolve({ code: 0, signal: null });
      },
    };
  };
  return factory;
}

function initializeResponse(capabilities?: InitializeResponse['agentCapabilities']): InitializeResponse {
  return {
    protocolVersion: 1,
    agentCapabilities: capabilities ?? {
      loadSession: true,
      sessionCapabilities: {
        list: {},
        resume: {},
      },
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function v2Request(id: string, method: string, params: Record<string, unknown>): WireRequest {
  return { id, method, params };
}

test('session RPCs reject at their per-operation deadline and a wedged generation is fenced and replaced', async () => {
  let factoryCalls = 0;
  const stoppedEvents: KimiAcpRuntimeStoppedEvent[] = [];
  const client = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    rpcDeadlines: { sessionMs: 60, controlMs: 40, sessionLoadMs: 80 },
    transportFactory: transportFactory(() => {
      factoryCalls += 1;
      return {
        initialize: async () => initializeResponse({
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {}, close: {} },
        }),
        newSession: async () => ({ sessionId: `native-gen-${factoryCalls}` }),
        listSessions: async () => ({ sessions: [] }),
        resumeSession: async () => ({}),
        loadSession: async () => neverSettles(),
        closeSession: async () => neverSettles(),
        setSessionConfigOption: async () => neverSettles(),
        cancel: async () => undefined,
      } as unknown as Agent;
    }),
  });
  client.on('runtimeStopped', (event) => {
    stoppedEvents.push(event);
  });

  await client.newSession({ cwd: '/workspace/one', mcpServers: [] });
  assert.equal(factoryCalls, 1);

  await assert.rejects(
    client.setSessionConfigOption({ sessionId: 'native-gen-1', configId: 'mode', value: 'auto' }),
    (error: unknown) => (
      error instanceof KimiAcpRpcTimeoutError
      && error.code === 'RPC_TIMEOUT'
      && error.message.includes('session/set_config_option')
      && error.message.includes('60')
    ),
    'a wedged set_config_option must reject at the sessionMs deadline',
  );
  await waitFor(() => stoppedEvents.length === 1, 'wedged runtime was not retired');
  assert.equal(stoppedEvents[0]!.expected, true, 'a deadline retirement is proxy-initiated');

  // The next request lazily starts a fresh generation instead of queueing
  // behind the wedged one.
  await client.listSessions();
  assert.equal(factoryCalls, 2);

  await assert.rejects(
    client.closeSession({ sessionId: 'native-gen-2' }),
    (error: unknown) => (
      error instanceof KimiAcpRpcTimeoutError
      && error.message.includes('session/close')
      && error.message.includes('40')
    ),
    'a wedged close must reject at the controlMs deadline',
  );
  await waitFor(() => stoppedEvents.length === 2, 'second wedged runtime was not retired');
  await client.listSessions();
  assert.equal(factoryCalls, 3);

  await assert.rejects(
    client.loadSession({ sessionId: 'native-load', cwd: '/workspace/load', mcpServers: [] }),
    (error: unknown) => (
      error instanceof KimiAcpRpcTimeoutError
      && error.message.includes('session/load')
      && error.message.includes('80')
    ),
    'a wedged load must reject at the sessionLoadMs deadline',
  );
  await waitFor(() => stoppedEvents.length === 3, 'third wedged runtime was not retired');
  await client.resumeSession({ sessionId: 'native-resume', cwd: '/workspace/resume', mcpServers: [] });
  assert.equal(factoryCalls, 4);

  await client.stop();
});

test('an interrupt the wedged runtime never honors fails only that turn; other sessions recover on the fresh runtime', async () => {
  let generation = 0;
  let nextNativeId = 0;
  const resumeCalls: string[] = [];
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const runtime = new KimiAcpClient({
    binaryPath: fakeKimiCli,
    transportFactory: transportFactory(() => {
      generation += 1;
      const wedged = generation === 1;
      return {
        initialize: async () => initializeResponse(),
        newSession: async () => {
          nextNativeId += 1;
          return { sessionId: `native-${nextNativeId}` };
        },
        resumeSession: async (params: { sessionId: string }) => {
          resumeCalls.push(params.sessionId);
          return {};
        },
        prompt: async (): Promise<PromptResponse> => (
          // Generation 1 never finishes the prompt; generation 2 completes.
          wedged ? neverSettles() : { stopReason: 'end_turn' }
        ),
        // The cancel notification is written fine; the wedged runtime simply
        // never ends the turn.
        cancel: async () => undefined,
      } as unknown as Agent;
    }),
  });
  const service = new KimiProxyService({
    runtime,
    interruptSettleMs: 50,
    emitEvent(method, params) {
      events.push({ method, params });
    },
  });
  const first = await service.createSession({ cwd: '/workspace/wedged-turn' });
  const second = await service.createSession({ cwd: '/workspace/healthy' });

  const started = await service.startTurn({
    sessionId: first.session.id,
    input: [{ type: 'text', text: 'work' }],
  });
  const turnId = started.turn.id;

  // The cancel notification is accepted on the wire; the runtime then proves
  // wedged by never ending the turn.
  const interrupt = await service.interruptTurn({ sessionId: first.session.id });
  assert.equal(interrupt.ok, true);

  await waitFor(
    () => events.some((event) => event.method === 'runtime.stopped'),
    'runtime.stopped was not emitted after the wedged runtime was fenced',
  );
  const failed = events.find((event) => (
    event.method === 'turn.failed' && event.params.turnId === turnId
  ));
  assert.ok(failed, 'the affected session\'s turn must fail');
  assert.equal((failed.params.data as { code?: unknown }).code, 'RUNTIME_STOPPED');

  // The unaffected session lazily rebinds to the fresh runtime and completes.
  const recovered = await service.startTurn({
    sessionId: second.session.id,
    input: [{ type: 'text', text: 'continue' }],
  });
  await waitFor(
    () => events.some((event) => (
      event.method === 'turn.completed' && event.params.turnId === recovered.turn.id
    )),
    'the healthy session did not recover on the fresh runtime',
  );
  assert.equal(generation, 2);
  assert.deepEqual(resumeCalls, [second.session.nativeSessionId]);
  await service.close();
});

test('the serialized session queue drains after a fenced wedged session.create', async () => {
  let factoryCalls = 0;
  const runtime = new KimiAcpClient({
    binaryPath: fakeKimiCli,
    rpcDeadlines: { sessionMs: 50 },
    transportFactory: transportFactory(() => {
      factoryCalls += 1;
      const wedged = factoryCalls === 1;
      return {
        initialize: async () => initializeResponse(),
        newSession: async () => (wedged ? neverSettles() : { sessionId: 'native-recovered' }),
      } as unknown as Agent;
    }),
  });
  const service = new KimiProxyService({ runtime });
  // Same wiring as spawn.ts: session traffic is strictly serialized.
  const queue = createTaskQueue('kimi-proxy-test');
  const outcomes: Array<{ ok: boolean; sessionId?: string; code?: unknown }> = [];
  const enqueueCreate = (cwd: string) => {
    queue.enqueueSession(async () => {
      try {
        const created = await service.createSession({ cwd });
        outcomes.push({ ok: true, sessionId: created.session.nativeSessionId });
      } catch (error) {
        outcomes.push({ ok: false, code: (error as { code?: unknown }).code });
      }
    });
  };
  enqueueCreate('/workspace/wedged');
  enqueueCreate('/workspace/recovered');

  await queue.drain();

  assert.equal(outcomes.length, 2, 'the queued requests must both settle');
  assert.equal(outcomes[0]!.ok, false);
  assert.equal(outcomes[0]!.code, 'RPC_TIMEOUT');
  assert.equal(outcomes[1]!.ok, true, 'the next queued request must run on the fresh runtime');
  assert.equal(outcomes[1]!.sessionId, 'native-recovered');
  assert.equal(factoryCalls, 2);
  await service.close();
});

test('reattaching a native session whose owner went stale replaces the dead binding once', async () => {
  let generation = 0;
  const resumeCalls: string[] = [];
  const runtime = new KimiAcpClient({
    binaryPath: fakeKimiCli,
    transportFactory: transportFactory(() => {
      generation += 1;
      return {
        initialize: async () => initializeResponse(),
        resumeSession: async (params: { sessionId: string }) => {
          resumeCalls.push(params.sessionId);
          return {};
        },
      } as unknown as Agent;
    }),
  });
  const service = new KimiProxyService({ runtime });
  const first = await service.createSession({
    cwd: '/workspace/reattach',
    nativeSessionId: 'native-reattach',
    resumeMode: 'resume',
  });
  assert.equal(first.session.attached, true);

  await runtime.stop();
  await waitFor(
    () => service.getSession({ sessionId: first.session.id }).session.status === 'stale',
    'the owner session did not go stale after the runtime stop',
  );

  const second = await service.createSession({
    cwd: '/workspace/reattach',
    nativeSessionId: 'native-reattach',
    resumeMode: 'resume',
  });

  assert.notEqual(second.session.id, first.session.id);
  assert.equal(second.session.nativeSessionId, 'native-reattach');
  assert.equal(second.session.attached, true);
  assert.deepEqual(resumeCalls, ['native-reattach', 'native-reattach']);
  assert.equal(generation, 2);
  assert.throws(
    () => service.getSession({ sessionId: first.session.id }),
    (error: unknown) => (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'SESSION_NOT_FOUND'
    ),
    'the stale owner binding must be replaced, not kept alongside',
  );
  await service.close();
});

test('a live native attach conflict still fails closed', async () => {
  const resumeCalls: string[] = [];
  const runtime = new KimiAcpClient({
    binaryPath: fakeKimiCli,
    transportFactory: transportFactory(() => ({
      initialize: async () => initializeResponse(),
      resumeSession: async (params: { sessionId: string }) => {
        resumeCalls.push(params.sessionId);
        return {};
      },
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });
  const first = await service.createSession({
    cwd: '/workspace/live',
    nativeSessionId: 'native-live',
    resumeMode: 'resume',
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      service.createSession({
        cwd: '/workspace/live',
        nativeSessionId: 'native-live',
        resumeMode: 'resume',
      }),
      (error: unknown) => (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'NATIVE_SESSION_ATTACHED'
      ),
      'a live binding must keep failing closed',
    );
  }

  // The conflict rejects before any retry RPC reaches the runtime.
  assert.deepEqual(resumeCalls, ['native-live']);
  assert.equal(
    service.getSession({ sessionId: first.session.id }).session.attached,
    true,
    'the live owner binding must survive the rejected reattach',
  );
  await service.close();
});

test('a native session owned by a live Side Chat cannot be adopted, even after a runtime crash', async () => {
  const exits: Array<(exit: KimiAcpExit) => void> = [];
  let generation = 0;
  let nextNativeId = 0;
  const resumeCalls: string[] = [];
  // A mode-only option set lets the capabilities probe reuse the parent's
  // baseline instead of spending a throwaway session (and its native id).
  const modeOptions = [{
    type: 'select' as const,
    category: 'mode',
    id: 'mode',
    name: 'Mode',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'auto', name: 'Auto' },
    ],
  }];
  const crashFactory: KimiAcpTransportFactory = async (client) => {
    generation += 1;
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);
    const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
    const exit = deferred<KimiAcpExit>();
    exits.push(exit.resolve);
    new AgentSideConnection(() => ({
      initialize: async () => initializeResponse({
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {}, close: {}, fork: {} },
      }),
      newSession: async () => {
        nextNativeId += 1;
        return { sessionId: `native-${nextNativeId}`, configOptions: modeOptions };
      },
      unstable_forkSession: async () => {
        nextNativeId += 1;
        return { sessionId: `native-${nextNativeId}`, configOptions: [] };
      },
      resumeSession: async (params: { sessionId: string }) => {
        resumeCalls.push(params.sessionId);
        return {};
      },
      closeSession: async () => undefined,
      prompt: async () => ({ stopReason: 'end_turn' }),
      cancel: async () => undefined,
    } as unknown as Agent), agentStream);
    return {
      connection: new ClientSideConnection(() => client, clientStream),
      exit: exit.promise,
      async stop() {
        exit.resolve({ code: 0, signal: null });
      },
    };
  };
  const runtime = new KimiAcpClient({
    binaryPath: fakeKimiCli,
    transportFactory: crashFactory,
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new KimiProtocolV2Adapter(service, '0.3.1', (method, params) => {
    notifications.push({ method, params });
  });
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '9.9.9' },
  }));
  const parent = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 'parent',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    config: {},
  })) as { session: { streamId: string; nativeSession: { id: string } } };
  assert.equal(parent.session.nativeSession.id, 'native-1');
  await adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 'parent',
    streamId: parent.session.streamId,
    turnId: 'host-turn-1',
    input: [{ type: 'text', text: 'establish a boundary' }],
    config: {},
  }));
  await waitFor(
    () => notifications.some((event) => event.method === 'turn.completed'),
    'parent turn did not complete',
  );
  await adapter.handle(v2Request('4', 'sidechat.create', {
    parentSessionId: 'parent',
    parentStreamId: parent.session.streamId,
    sidechatId: 'side-1',
  }));

  // The shared runtime crashes: every binding (parent and Side Chat) goes
  // stale, and the Side Chat would be stealable by the stale-binding recovery
  // if the adopt path did not refuse it first.
  exits[0]?.({ code: 1, signal: null });
  await waitFor(
    () => notifications.some((event) => event.method === 'runtime.error'),
    'runtime.error was not emitted after the crash',
  );

  const domainCode = (error: unknown) => (error as { domainCode?: string }).domainCode;
  await assert.rejects(
    adapter.handle(v2Request('5', 'session.create', {
      sessionId: 'adopt-side',
      workspace: { cwd: '/tmp', roots: ['/tmp'] },
      nativeSession: { id: 'native-2' },
      config: {},
    })),
    (error: unknown) => (
      domainCode(error) === 'CONFLICT'
      && String((error as Error).message).includes('Side Chat')
    ),
    'adopting a native session owned by a live Side Chat must be refused',
  );

  // An ordinary stale binding still recovers: the same request adopts the
  // crashed parent native session on the fresh runtime.
  const adopted = await adapter.handle(v2Request('6', 'session.create', {
    sessionId: 'adopt-parent',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    nativeSession: { id: 'native-1' },
    config: {},
  })) as { session: { nativeSession: { id: string } } };
  assert.equal(adopted.session.nativeSession.id, 'native-1');
  assert.equal(generation, 2);
  assert.deepEqual(resumeCalls, ['native-1']);
  await service.close();
});

test('a wedged turn-bound config RPC maps to a retryable RUNTIME_ERROR and the next turn recovers', async () => {
  let factoryCalls = 0;
  const modeOptions = [{
    type: 'select' as const,
    category: 'mode',
    id: 'mode',
    name: 'Mode',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'auto', name: 'Auto' },
    ],
  }];
  const runtime = new KimiAcpClient({
    binaryPath: fakeKimiCli,
    rpcDeadlines: { sessionMs: 50 },
    transportFactory: transportFactory(() => {
      factoryCalls += 1;
      const wedged = factoryCalls === 1;
      return {
        initialize: async () => initializeResponse(),
        newSession: async () => ({ sessionId: 'native-cfg-wedge', configOptions: modeOptions }),
        resumeSession: async () => ({}),
        setSessionConfigOption: async () => (
          wedged ? neverSettles() : { configOptions: modeOptions }
        ),
        prompt: async () => ({ stopReason: 'end_turn' }),
        cancel: async () => undefined,
      } as unknown as Agent;
    }),
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new KimiProtocolV2Adapter(service, '0.3.1', (method, params) => {
    notifications.push({ method, params });
  });
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '9.9.9' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 's-cfg-wedge',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    config: {},
  })) as { session: { streamId: string } };

  await assert.rejects(
    adapter.handle(v2Request('3', 'turn.start', {
      sessionId: 's-cfg-wedge',
      streamId: created.session.streamId,
      turnId: 't-wedged-config',
      input: [{ type: 'text', text: 'go' }],
      config: { mode: 'auto' },
    })),
    (error: unknown) => (
      (error as { domainCode?: string }).domainCode === 'RUNTIME_ERROR'
      && (error as { retryable?: boolean }).retryable === true
      && String((error as Error).message).includes('session/set_config_option')
    ),
    'a wedged config RPC must surface as a retryable RUNTIME_ERROR',
  );

  const recovered = await adapter.handle(v2Request('4', 'turn.start', {
    sessionId: 's-cfg-wedge',
    streamId: created.session.streamId,
    turnId: 't-recovered',
    input: [{ type: 'text', text: 'go' }],
    config: {},
  }));
  assert.deepEqual(recovered, { accepted: true, turnId: 't-recovered' });
  await waitFor(
    () => notifications.some((event) => (
      event.method === 'turn.completed' && event.params.turnId === 't-recovered'
    )),
    'the next turn did not complete on the fresh runtime',
  );
  assert.equal(factoryCalls, 2);
  await service.close();
});
