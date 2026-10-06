import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  RequestError,
  type Agent,
  type Client,
  type InitializeResponse,
} from '@agentclientprotocol/sdk';

import {
  GrokAcpClient,
  GrokExtMethodUnsupportedError,
} from '../src/runtime/grok-acp-client.js';

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

class ExtRecordingAgent {
  readonly extRequests: Array<{ method: string; params: unknown }> = [];
  private clientRef: Client | null = null;

  constructor(
    private readonly meta: Record<string, unknown> = {},
    /** Methods the fake runtime does NOT register — they answer with the
     *  real binary's "Method not found" wire error. */
    private readonly unregistered: readonly string[] = [],
  ) {}

  /** Bind the live client so tests can fire reverse requests at it. */
  bind(client: Client): void {
    this.clientRef = client;
  }

  /** Fire a reverse ext request at the bound client callbacks. */
  async sendReverse(method: string, params: unknown): Promise<unknown> {
    const raw = this.clientRef?.extMethod as
      | ((method: string, params: unknown) => Promise<unknown>)
      | undefined;
    if (!raw) throw new Error('client extMethod callbacks are not bound');
    return await raw.call(this.clientRef, method, params);
  }

  agent(): Agent {
    return {
      initialize: async (): Promise<InitializeResponse> => ({
        protocolVersion: 1,
        agentInfo: { name: 'fake-ext-grok', version: '1.0.41-test' },
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {}, close: {} },
        },
        _meta: { grokShell: true, agentVersion: '1.0.41', ...this.meta },
      }),
      newSession: async () => ({ sessionId: 'native-new' }),
      resumeSession: async ({ sessionId }: { sessionId: string }) => ({ sessionId }),
      loadSession: async ({ sessionId }: { sessionId: string }) => ({ sessionId }),
      prompt: async () => ({ stopReason: 'end_turn' }),
      extMethod: async (method: string, params: unknown) => {
        this.extRequests.push({ method, params });
        if (!method.startsWith('_x.ai/')) {
          throw RequestError.methodNotFound(method);
        }
        const logical = method.slice(1);
        if (this.unregistered.includes(logical)) {
          throw RequestError.methodNotFound(method);
        }
        if (logical === 'x.ai/session/fork') {
          return {
            newSessionId: 'native-forked',
            chatMessagesCopied: 4,
            updatesCopied: 9,
            planStateCopied: true,
            newCwd: '/repo',
            parentSessionId: 'native-new',
          };
        }
        if (logical === 'x.ai/session/rename') return { success: true };
        if (logical === 'x.ai/session/delete') return { success: true };
        if (logical === 'x.ai/mcp/list') return { servers: [] };
        if (logical === 'x.ai/skills/list') return { skills: [] };
        if (logical === 'x.ai/hooks/list') return { hooks: [] };
        if (logical === 'x.ai/session/usage') return { usage: {} };
        if (logical === 'x.ai/session/update_mcp_servers') return { ok: true };
        if (logical === 'x.ai/interject') {
          const sessionId = params && typeof params === 'object'
            ? String((params as { sessionId?: unknown }).sessionId ?? '')
            : '';
          if (sessionId === 'gian-probe-missing-session') {
            throw RequestError.invalidParams(`session not found: ${sessionId}`);
          }
          return { result: { status: 'queued' } };
        }
        throw RequestError.methodNotFound(method);
      },
      extNotification: async () => undefined,
    } as unknown as Agent;
  }
}

async function withExtClient(
  options: { meta?: Record<string, unknown>; unregistered?: readonly string[] },
  run: (client: GrokAcpClient, agent: ExtRecordingAgent) => Promise<void>,
): Promise<void> {
  const agent = new ExtRecordingAgent(options.meta ?? {}, options.unregistered ?? []);
  const grokClient = new GrokAcpClient({
    binaryPath: '/usr/bin/true',
    cwd: '/repo',
    transportFactory: async (client) => {
      agent.bind(client);
      const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
      const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
      const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);
      const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
      const exit = deferred<{ code: number | null; signal: null }>();
      new AgentSideConnection(() => agent.agent(), agentStream);
      return {
        connection: new ClientSideConnection(() => client, clientStream),
        exit: exit.promise as never,
        async stop() {
          exit.resolve({ code: 0, signal: null });
        },
      } as never;
    },
  });
  try {
    await grokClient.ensureStarted();
    await run(grokClient, agent);
  } finally {
    await grokClient.stop();
  }
}

test('native fork sends the x.ai/session/fork wire shape', async () => {
  await withExtClient({}, async (client, agent) => {
    const response = await client.nativeForkSession({
      sourceSessionId: 'native-new',
      sourceCwd: '/repo',
      newCwd: '/repo',
      targetPromptIndex: 2,
    });
    assert.equal(response.newSessionId, 'native-forked');
    assert.equal(response.parentSessionId, 'native-new');
    const request = agent.extRequests.find((item) => item.method === '_x.ai/session/fork');
    assert.ok(request);
    assert.deepEqual(request.params, {
      sourceSessionId: 'native-new',
      sourceCwd: '/repo',
      newCwd: '/repo',
      targetPromptIndex: 2,
    });
  });
});

test('rename sends {sessionId,title,cwd}; an unregistered method refutes the attach honestly', async () => {
  await withExtClient({}, async (client, agent) => {
    await client.renameSession('native-new', 'New title', '/repo');
    const request = agent.extRequests.find((item) => item.method === '_x.ai/session/rename');
    assert.deepEqual(request?.params, {
      sessionId: 'native-new',
      title: 'New title',
      cwd: '/repo',
    });
  });
  // Live 1.0.41 boundary: the fake's version is satisfied but the method is
  // NOT registered. The first real attempt surfaces an honest unsupported
  // error, and the refutation is remembered — a retry fails fast without
  // touching the runtime again.
  await withExtClient({ unregistered: ['x.ai/session/rename'] }, async (client, agent) => {
    await assert.rejects(
      () => client.renameSession('native-new', 't'),
      (error: unknown) => error instanceof GrokExtMethodUnsupportedError,
    );
    await assert.rejects(
      () => client.renameSession('native-new', 't2'),
      (error: unknown) => error instanceof GrokExtMethodUnsupportedError,
    );
    assert.equal(
      agent.extRequests.filter((item) => item.method === '_x.ai/session/rename').length,
      1,
      'a refuted method must fail fast instead of repeating the live misreport',
    );
  });
});

test('delete sends cwd scoping; update_mcp_servers sends the admitted list', async () => {
  await withExtClient({}, async (client, agent) => {
    await client.deleteSession('native-old', '/repo');
    await client.updateSessionMcpServers('native-new', [
      { type: 'http', name: 'hosted', url: 'https://hosted.example.com/mcp' },
    ] as never);
    const del = agent.extRequests.find((item) => item.method === '_x.ai/session/delete');
    assert.deepEqual(del?.params, { sessionId: 'native-old', cwd: '/repo' });
    const update = agent.extRequests.find((item) => item.method === '_x.ai/session/update_mcp_servers');
    assert.deepEqual(update?.params, {
      sessionId: 'native-new',
      mcpServers: [{ type: 'http', name: 'hosted', url: 'https://hosted.example.com/mcp' }],
    });
  });
});

test('interject probe confirms a missing session and refutes a missing method', async () => {
  await withExtClient({}, async (client, agent) => {
    assert.equal(await client.probeInterjectRegistered(), 'confirmed');
    const request = agent.extRequests.find((item) => item.method === '_x.ai/interject');
    assert.equal((request?.params as { sessionId?: string } | undefined)?.sessionId, 'gian-probe-missing-session');
  });
  await withExtClient({ unregistered: ['x.ai/interject'] }, async (client) => {
    assert.equal(await client.probeInterjectRegistered(), 'refuted');
    assert.equal(await client.probeInterjectRegistered(), 'refuted');
  });
});

test('extMethod reverse requests route to the registered handler and default to honest failure', async () => {
  await withExtClient({}, async (client, agent) => {
    await assert.rejects(
      () => agent.sendReverse('x.ai/ask_user_question', { sessionId: 's', questions: [] }),
      /Method not found/,
    );
    await assert.rejects(
      () => agent.sendReverse('__x.ai/ask_user_question', { sessionId: 's' }),
      /Method not found: __x\.ai\/ask_user_question/,
    );
    const seen: string[] = [];
    client.setExtMethodHandler(async (method) => {
      seen.push(method);
      return { outcome: 'cancelled' };
    });
    const result = await agent.sendReverse('_x.ai/ask_user_question', {
      sessionId: 's',
      questions: [],
    }) as Record<string, unknown>;
    assert.deepEqual(result, { outcome: 'cancelled' });
    assert.deepEqual(seen, ['x.ai/ask_user_question']);
  });
});

// --- Full-path capability evidence: real GrokAcpClient + ACP wire fake,
// through GrokProxyService and GrokProtocolV2Adapter. The fake advertises no
// `x.ai/extMethods` metadata; fork is confirmed only by a real user-requested
// call, and the Proxy must never probe the method speculatively. ---

import { GrokProxyService } from '../src/core/service.js';
import { GrokProtocolV2Adapter } from '../src/protocol/v2-adapter.js';

interface ForkStack {
  adapter: GrokProtocolV2Adapter;
  service: GrokProxyService;
  agents: ExtRecordingAgent[];
  events: Array<{ method: string; params: Record<string, unknown> }>;
}

async function forkStack(options: { unregistered?: readonly string[] } = {}): Promise<ForkStack> {
  const agents: ExtRecordingAgent[] = [];
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: (cwd) => {
      const agent = new ExtRecordingAgent({}, options.unregistered ?? []);
      agents.push(agent);
      return new GrokAcpClient({
        binaryPath: '/usr/bin/true',
        cwd,
        transportFactory: async (client) => {
          agent.bind(client);
          const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
          const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
          const exit = deferred<{ code: number | null; signal: null }>();
          new AgentSideConnection(() => agent.agent(), ndJsonStream(agentToClient.writable, clientToAgent.readable));
          return {
            connection: new ClientSideConnection(() => client, ndJsonStream(clientToAgent.writable, agentToClient.readable)),
            exit: exit.promise as never,
            async stop() {
              exit.resolve({ code: 0, signal: null });
            },
          } as never;
        },
      });
    },
  });
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new GrokProtocolV2Adapter(service, '0.3.8-test', (method, params) => {
    events.push({ method, params: params as Record<string, unknown> });
  });
  await adapter.handle({ id: 'i1', method: 'initialize', params: {
    protocol: { name: 'gian.proxy', versions: ['2.3'] },
    host: { name: 'Gian', version: '0.0.0' },
  } });
  return { adapter, service, agents, events };
}

function v2(id: string, method: string, params: Record<string, unknown>) {
  return { id, method, params };
}

async function attachAndRunTurn(stack: ForkStack) {
  const created = await stack.adapter.handle(v2('s1', 'session.create', {
    sessionId: 'host-fork-full',
    workspace: { cwd: '/repo', roots: ['/repo'] },
    config: {},
  })) as { session: { id: string; streamId: string } };
  await stack.adapter.handle(v2('t1', 'turn.start', {
    sessionId: created.session.id,
    streamId: created.session.streamId,
    turnId: 'turn-full',
    input: [{ type: 'text', text: 'work' }],
  }));
  const deadline = Date.now() + 5_000;
  while (!stack.events.some((event) => event.method === 'turn.completed')) {
    if (Date.now() >= deadline) throw new Error('turn never completed');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return created.session;
}

function forkWireCalls(stack: ForkStack) {
  return stack.agents.flatMap((agent) => agent.extRequests)
    .filter((request) => request.method === '_x.ai/session/fork');
}

test('a head fork confirms the native method with one real call, never a probe', async () => {
  const stack = await forkStack();
  const session = await attachAndRunTurn(stack);

  // Not advertised before confirmation — and initialize/catalog never sent a
  // speculative fork call to prove it.
  const before = await stack.adapter.handle(v2('c1', 'catalog.list', {})) as {
    actions: Array<{ id: string; supported: boolean; reason?: string }>;
  };
  const forkAction = before.actions.find((action) => action.id === 'session.fork');
  assert.equal(forkAction?.supported, false);
  assert.match(forkAction?.reason ?? '', /not confirmed/);
  assert.equal(forkWireCalls(stack).length, 0);

  // The user's real fork request doubles as the confirming call.
  const forked = await stack.adapter.handle(v2('f1', 'session.fork', {
    sourceSessionId: session.id,
    sourceStreamId: session.streamId,
    sessionId: 'host-forked-full',
    anchor: { type: 'head' },
  })) as { session: { id: string } };
  assert.equal(forked.session.id, 'host-forked-full');
  assert.equal(forkWireCalls(stack).length, 1);

  // Confirmed now: the catalog opens fork actions, and an exact-turn fork
  // runs natively with its absolute prompt index.
  const after = await stack.adapter.handle(v2('c2', 'catalog.list', {})) as {
    actions: Array<{ id: string; supported: boolean }>;
  };
  assert.equal(after.actions.find((action) => action.id === 'session.fork')?.supported, true);
  assert.equal(after.actions.find((action) => action.id === 'session.fork.atTurn')?.supported, true);
  await stack.adapter.handle(v2('f2', 'session.fork', {
    sourceSessionId: session.id,
    sourceStreamId: session.streamId,
    sessionId: 'host-forked-at-turn',
    anchor: { type: 'turn', turnId: 'turn-full' },
  }));
  const atTurn = forkWireCalls(stack).at(-1);
  assert.deepEqual(atTurn?.params, {
    sourceSessionId: 'native-new',
    sourceCwd: '/repo',
    newCwd: '/repo',
    targetPromptIndex: 0,
  });
  await stack.service.close();
});

test('an unregistered native fork refutes on the first real call and fails fast after', async () => {
  const stack = await forkStack({ unregistered: ['x.ai/session/fork'] });
  const session = await attachAndRunTurn(stack);
  await assert.rejects(
    stack.adapter.handle(v2('f1', 'session.fork', {
      sourceSessionId: session.id,
      sourceStreamId: session.streamId,
      sessionId: 'host-fork-refuted',
      anchor: { type: 'head' },
    })),
    (error: unknown) => (error as { domainCode?: string }).domainCode === 'CAPABILITY_NOT_SUPPORTED',
  );
  assert.equal(forkWireCalls(stack).length, 1, 'the confirming call reached the wire once');
  // Refuted sticks to this attach: a retry is refused locally, no new call.
  await assert.rejects(
    stack.adapter.handle(v2('f2', 'session.fork', {
      sourceSessionId: session.id,
      sourceStreamId: session.streamId,
      sessionId: 'host-fork-refuted-2',
      anchor: { type: 'head' },
    })),
    (error: unknown) => (error as { domainCode?: string }).domainCode === 'CAPABILITY_NOT_SUPPORTED',
  );
  assert.equal(forkWireCalls(stack).length, 1);
  await stack.service.close();
});

test('an exact-turn fork never becomes the confirming call', async () => {
  const stack = await forkStack();
  const session = await attachAndRunTurn(stack);
  await assert.rejects(
    stack.adapter.handle(v2('f1', 'session.fork', {
      sourceSessionId: session.id,
      sourceStreamId: session.streamId,
      sessionId: 'host-fork-unconfirmed',
      anchor: { type: 'turn', turnId: 'turn-full' },
    })),
    (error: unknown) => (error as { domainCode?: string }).domainCode === 'CAPABILITY_NOT_SUPPORTED',
  );
  assert.equal(forkWireCalls(stack).length, 0, 'no wire call before native fork is confirmed');
  await stack.service.close();
});
