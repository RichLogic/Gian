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
        if (this.unregistered.includes(method)) {
          throw RequestError.methodNotFound(method);
        }
        if (method === 'x.ai/session/fork') {
          return {
            newSessionId: 'native-forked',
            chatMessagesCopied: 4,
            updatesCopied: 9,
            planStateCopied: true,
            newCwd: '/repo',
            parentSessionId: 'native-new',
          };
        }
        if (method === 'x.ai/session/rename') return { success: true };
        if (method === 'x.ai/session/delete') return { success: true };
        if (method === 'x.ai/mcp/list') return { servers: [] };
        if (method === 'x.ai/skills/list') return { skills: [] };
        if (method === 'x.ai/hooks/list') return { hooks: [] };
        if (method === 'x.ai/session/usage') return { usage: {} };
        if (method === 'x.ai/session/update_mcp_servers') return { ok: true };
        throw RequestError.methodNotFound(method);
      },
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
    const request = agent.extRequests.find((item) => item.method === 'x.ai/session/fork');
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
    const request = agent.extRequests.find((item) => item.method === 'x.ai/session/rename');
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
      agent.extRequests.filter((item) => item.method === 'x.ai/session/rename').length,
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
    const del = agent.extRequests.find((item) => item.method === 'x.ai/session/delete');
    assert.deepEqual(del?.params, { sessionId: 'native-old', cwd: '/repo' });
    const update = agent.extRequests.find((item) => item.method === 'x.ai/session/update_mcp_servers');
    assert.deepEqual(update?.params, {
      sessionId: 'native-new',
      mcpServers: [{ type: 'http', name: 'hosted', url: 'https://hosted.example.com/mcp' }],
    });
  });
});

test('extMethod reverse requests route to the registered handler and default to honest failure', async () => {
  await withExtClient({}, async (client, agent) => {
    await assert.rejects(
      () => agent.sendReverse('x.ai/ask_user_question', { sessionId: 's', questions: [] }),
      /Method not found/,
    );
    const seen: string[] = [];
    client.setExtMethodHandler(async (method) => {
      seen.push(method);
      return { outcome: 'cancelled' };
    });
    const result = await agent.sendReverse('x.ai/ask_user_question', {
      sessionId: 's',
      questions: [],
    }) as Record<string, unknown>;
    assert.deepEqual(result, { outcome: 'cancelled' });
    assert.deepEqual(seen, ['x.ai/ask_user_question']);
  });
});
