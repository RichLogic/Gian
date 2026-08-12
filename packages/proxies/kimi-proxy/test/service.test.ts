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
  type PromptResponse,
} from '@agentclientprotocol/sdk';

import { KimiProxyService, parseKimiConversationUsage } from '../src/core/service.js';
import { KimiProtocolV1Adapter } from '../src/protocol/v1-adapter.js';
import {
  PROTOCOL_NAME,
  PROTOCOL_V1,
  parseProxyRequest,
  proxyNotificationSchema,
  type ProxyNotification,
} from '@gian/proxy-protocol';
import {
  KimiAcpClient,
  type KimiAcpExit,
  type KimiAcpTransportFactory,
} from '../src/runtime/kimi-acp-client.js';
import {
  ACP_MALFORMED_V0_23_PROMPT_USAGE,
  ACP_UNKNOWN_PROMPT_USAGE,
  ACP_V0_23_COMPACTION,
  ACP_V0_23_PROMPT_USAGE,
} from './fixtures/acp-v0-23-usage.js';

test('versioned ACP prompt usage parses known fields and rejects unknown shapes', () => {
  assert.deepEqual(parseKimiConversationUsage(ACP_V0_23_PROMPT_USAGE.usage), {
    mode: 'absolute',
    inputTokens: 1_100_000,
    outputTokens: 14_000,
    cachedInputTokens: 910_000,
    totalTokens: 1_114_000,
  });
  assert.equal(parseKimiConversationUsage(ACP_UNKNOWN_PROMPT_USAGE.usage), null);
  assert.equal(parseKimiConversationUsage(ACP_MALFORMED_V0_23_PROMPT_USAGE.usage), null);
  assert.equal(parseKimiConversationUsage({ inputTokens: '1100000' }), null);
  assert.equal(parseKimiConversationUsage({
    inputTokens: 0.5,
    outputTokens: 0,
    totalTokens: 0,
  }), null);
  assert.equal(parseKimiConversationUsage({
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    thoughtTokens: '1',
  }), null);
});

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

function initializeResponse(): InitializeResponse {
  return {
    protocolVersion: 1,
    agentCapabilities: {
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

test('captures pre-response command updates and load replay without emitting provisional events', async () => {
  let remote!: AgentSideConnection;
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const agent = {
    initialize: async () => initializeResponse(),
    newSession: async () => {
      await remote.sessionUpdate({
        sessionId: 'native-new',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{
            name: 'skill:review',
            description: 'Review code',
            input: { hint: 'path' },
          }],
        },
      });
      return { sessionId: 'native-new' };
    },
    loadSession: async (params: { sessionId: string }) => {
      await remote.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'old question' },
        },
      });
      await remote.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'old answer' },
        },
      });
      setTimeout(() => {
        void remote.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{
              name: 'help',
              description: 'Show help',
            }],
          },
        });
      }, 10);
      return {};
    },
  } as unknown as Agent;
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory((client) => {
      remote = client;
      return agent;
    }),
  });
  const service = new KimiProxyService({
    runtime,
    emitEvent(method, params) {
      events.push({ method, params });
    },
  });

  const created = await service.createSession({
    cwd: '/workspace/new',
  });
  const loaded = await service.createSession({
    cwd: '/workspace/loaded',
    nativeSessionId: 'native-loaded',
    resumeMode: 'load',
  });

  assert.equal(created.replayUpdates.length, 1);
  assert.equal((await service.listSlashCommands({
    sessionId: created.session.id,
  })).commands[0]?.name, 'skill:review');
  assert.equal((await service.listSlashCommands({
    sessionId: loaded.session.id,
  })).commands[0]?.name, 'help');
  assert.deepEqual(
    loaded.replayUpdates.map((notification) => notification.update.sessionUpdate),
    ['user_message_chunk', 'agent_message_chunk'],
  );
  assert.equal(
    events.some((event) => {
      if (event.method !== 'acp.sessionUpdate') return false;
      const data = event.params.data as { update?: { sessionUpdate?: unknown } } | undefined;
      return data?.update?.sessionUpdate === 'user_message_chunk'
        || data?.update?.sessionUpdate === 'agent_message_chunk';
    }),
    false,
    'provisional history must be returned to the host transaction, not emitted early',
  );

  await service.close();
});

test('a failed native load leaves no attached proxy row', async () => {
  let attempts = 0;
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory(() => ({
      initialize: async () => initializeResponse(),
      loadSession: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('load failed');
        return {};
      },
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });

  await assert.rejects(
    service.createSession({
      cwd: '/workspace/load',
      nativeSessionId: 'native-load',
      resumeMode: 'load',
    }),
  );
  const adopted = await service.createSession({
    cwd: '/workspace/load',
    nativeSessionId: 'native-load',
    resumeMode: 'load',
  });

  assert.equal(adopted.session.nativeSessionId, 'native-load');
  await service.close();
});

test('maps ACP auth_required to the stable proxy AUTH_REQUIRED code', async () => {
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory(() => ({
      initialize: async () => initializeResponse(),
      newSession: async () => {
        throw RequestError.authRequired();
      },
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });

  await assert.rejects(
    service.createSession({ cwd: '/workspace/auth' }),
    (error: unknown) => (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'AUTH_REQUIRED'
      && 'message' in error
      && String(error.message).includes("'/managed/kimi' login")
    ),
  );

  await service.close();
});

test('allows concurrent prompts across sessions but rejects a second prompt in one session', async () => {
  let nextSession = 0;
  const turns = new Map<string, Deferred<PromptResponse>>();
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory((remote) => ({
      initialize: async () => initializeResponse(),
      newSession: async () => {
        nextSession += 1;
        return { sessionId: `native-${nextSession}` };
      },
      prompt: async (params: { sessionId: string }) => {
        await remote.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: params.sessionId },
          },
        });
        const turn = deferred<PromptResponse>();
        turns.set(params.sessionId, turn);
        return turn.promise;
      },
      cancel: async () => undefined,
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({
    runtime,
    emitEvent(method, params) {
      events.push({ method, params });
    },
  });
  const first = await service.createSession({ cwd: '/workspace/one' });
  const second = await service.createSession({ cwd: '/workspace/two' });

  await service.startTurn({
    sessionId: first.session.id,
    input: [{ type: 'text', text: 'first' }],
  });
  await service.startTurn({
    sessionId: second.session.id,
    input: [{ type: 'text', text: 'second' }],
  });
  await assert.rejects(
    service.startTurn({
      sessionId: first.session.id,
      input: [{ type: 'text', text: 'busy' }],
    }),
    (error: unknown) => (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'SESSION_BUSY'
    ),
  );

  await waitFor(() => turns.size === 2, 'both native prompts did not start');
  turns.get('native-1')?.resolve({ stopReason: 'end_turn' });
  turns.get('native-2')?.resolve({ stopReason: 'end_turn' });
  await waitFor(
    () => events.filter((event) => event.method === 'turn.completed').length === 2,
    'both turns did not complete',
  );

  const routedSessionIds = events
    .filter((event) => event.method === 'acp.sessionUpdate')
    .map((event) => event.params.sessionId);
  assert.deepEqual(
    new Set(routedSessionIds),
    new Set([first.session.id, second.session.id]),
  );

  await service.close();
});

test('suppresses hidden /status output and refreshes context after compact', async () => {
  let remote!: AgentSideConnection;
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory((client) => {
      remote = client;
      return {
        initialize: async () => initializeResponse(),
        newSession: async () => {
          await remote.sessionUpdate({
            sessionId: 'native-usage',
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [
                { name: 'status', description: 'Show status' },
                { name: 'compact', description: 'Compact context' },
              ],
            },
          });
          return { sessionId: 'native-usage' };
        },
        prompt: async (params: {
          sessionId: string;
          prompt: Array<{ type: string; text?: string }>;
        }) => {
          const text = params.prompt.find(block => block.type === 'text')?.text ?? '';
          if (text === '/status') {
            for (const update of ACP_V0_23_COMPACTION.postBoundaryStatusChunks) {
              await remote.sessionUpdate({ sessionId: params.sessionId, update });
            }
            return { stopReason: 'end_turn' };
          }
          if (text === ACP_V0_23_COMPACTION.compactCommand) {
            await remote.sessionUpdate({
              sessionId: params.sessionId,
              update: ACP_V0_23_COMPACTION.summarizationUsageUpdate,
            });
          }
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: text === ACP_V0_23_COMPACTION.compactCommand
              ? ACP_V0_23_COMPACTION.summarizationMessage
              : {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Normal answer.' },
                },
          });
          return {
            stopReason: 'end_turn',
            usage: ACP_V0_23_COMPACTION.promptUsage,
          };
        },
      } as unknown as Agent;
    }),
  });
  const service = new KimiProxyService({
    runtime,
    emitEvent(method, params) {
      events.push({ method, params });
    },
  });
  const created = await service.createSession({ cwd: '/workspace/usage' });

  await service.startTurn({
    sessionId: created.session.id,
    input: [{ type: 'text', text: 'hello' }],
  });
  await waitFor(
    () => events.some(event => event.method === 'turn.completed'),
    'usage turn did not complete',
  );

  const visibleText = events
    .filter(event => event.method === 'acp.sessionUpdate')
    .map(event => (
      event.params.data as { update: { content?: { text?: string } } }
    ).update.content?.text ?? '')
    .join('');
  assert.equal(visibleText, 'Normal answer.');
  assert.ok(!visibleText.includes('Context:'), 'hidden status text leaked into transcript');

  const usageEvents = events
    .filter(event => event.method === 'token_usage.updated')
    .map(event => event.params.data as Record<string, unknown>);
  assert.deepEqual(
    usageEvents.find(data => data.conversation)?.conversation,
    {
      mode: 'absolute',
      inputTokens: 1_100_000,
      outputTokens: 14_000,
      cachedInputTokens: 910_000,
      totalTokens: 1_114_000,
    },
  );
  assert.deepEqual(
    usageEvents.find(data => data.context)?.context,
    { used: 86_397, window: 1_048_576 },
  );

  const futureStart = events.length;
  await service.startTurn({
    sessionId: created.session.id,
    input: [{ type: 'text', text: ACP_V0_23_COMPACTION.futureCommand }],
  });
  await waitFor(
    () => events.slice(futureStart).some(event => event.method === 'turn.completed'),
    'future command turn did not complete',
  );
  assert.ok(
    !events.slice(futureStart).some(event => (
      event.method === 'token_usage.updated'
      && (event.params.data as { context?: unknown }).context === null
    )),
    'an unknown command discriminator must not invalidate current context',
  );

  const compactStart = events.length;
  await service.startTurn({
    sessionId: created.session.id,
    input: [{ type: 'text', text: ACP_V0_23_COMPACTION.compactCommand }],
  });
  await waitFor(
    () => events.slice(compactStart).some(event => event.method === 'turn.completed'),
    'compact turn did not complete',
  );
  const compactEvents = events.slice(compactStart);
  const invalidationIndex = compactEvents.findIndex(event => (
    event.method === 'token_usage.updated'
    && (event.params.data as { context?: unknown }).context === null
  ));
  const startedIndex = compactEvents.findIndex(event => event.method === 'turn.started');
  assert.ok(invalidationIndex >= 0);
  assert.ok(invalidationIndex < startedIndex, 'compact must invalidate context before turn.started');
  assert.ok(
    compactEvents.some(event => (
      event.method === 'token_usage.updated'
      && (event.params.data as { context?: { used?: number } }).context?.used === 86_397
    )),
    'post-compact status did not replace the invalidated context',
  );
  assert.ok(
    !compactEvents.some(event => (
      event.method === 'acp.sessionUpdate'
      && (event.params.data as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === 'usage_update'
    )),
    'the compact request usage sample leaked through as post-compact context',
  );

  await service.close();
});

test('enriches sparse ACP tool updates with the original tool metadata', async () => {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory((remote) => ({
      initialize: async () => initializeResponse(),
      newSession: async () => ({ sessionId: 'native-tools' }),
      prompt: async (params: { sessionId: string }) => {
        await remote.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'read-1',
            title: 'Read package.json',
            kind: 'read',
            status: 'in_progress',
            locations: [{ path: '/workspace/package.json' }],
            rawInput: { path: '/workspace/package.json' },
          },
        });
        await remote.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'read-1',
            status: 'completed',
            rawOutput: { text: '{}' },
          },
        });
        return { stopReason: 'end_turn' };
      },
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({
    runtime,
    emitEvent(method, params) {
      events.push({ method, params });
    },
  });
  const created = await service.createSession({ cwd: '/workspace' });
  await service.startTurn({
    sessionId: created.session.id,
    input: [{ type: 'text', text: 'read it' }],
  });
  await waitFor(
    () => events.some((event) => event.method === 'turn.completed'),
    'turn did not complete',
  );

  const updates = events
    .filter((event) => event.method === 'acp.sessionUpdate')
    .map((event) => (
      event.params.data as { update: Record<string, unknown> }
    ).update);
  assert.equal(updates.length, 2);
  assert.equal(updates[1]?.sessionUpdate, 'tool_call_update');
  assert.equal(updates[1]?.title, 'Read package.json');
  assert.equal(updates[1]?.kind, 'read');
  assert.deepEqual(updates[1]?.locations, [{ path: '/workspace/package.json' }]);
  assert.deepEqual(updates[1]?.rawInput, { path: '/workspace/package.json' });
  assert.equal(updates[1]?.status, 'completed');

  await service.close();
});

test('round-trips the exact opaque permission option', async () => {
  let permissionResponse: unknown;
  const permissionIssued = deferred<void>();
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory((remote) => ({
      initialize: async () => initializeResponse(),
      newSession: async () => ({ sessionId: 'native-approval' }),
      prompt: async (params: { sessionId: string }) => {
        const response = remote.requestPermission({
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: 'tool-approval',
            title: 'Run deployment',
            kind: 'execute',
          },
          options: [
            { optionId: 'kimi-once-42', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'kimi-no-42', name: 'Reject', kind: 'reject_once' },
          ],
        });
        permissionIssued.resolve();
        permissionResponse = await response;
        return { stopReason: 'end_turn' };
      },
      cancel: async () => undefined,
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({
    runtime,
    emitEvent(method, params) {
      events.push({ method, params });
    },
  });
  const created = await service.createSession({ cwd: '/workspace/approval' });
  await service.startTurn({
    sessionId: created.session.id,
    input: [{ type: 'text', text: 'deploy' }],
  });
  await permissionIssued.promise;
  await waitFor(
    () => events.some((event) => event.method === 'approval.requested'),
    'approval event was not emitted',
  );

  const approval = events.find((event) => event.method === 'approval.requested');
  assert.deepEqual(
    (
      approval?.params.data as {
        nativeOptions: Array<{ optionId: string }>;
      }
    ).nativeOptions.map((option) => option.optionId),
    ['kimi-once-42', 'kimi-no-42'],
  );
  await service.respondApproval({
    sessionId: created.session.id,
    approvalId: (
      approval?.params.data as { approvalId: string }
    ).approvalId,
    nativeOptionId: 'kimi-once-42',
  });
  await waitFor(() => permissionResponse !== undefined, 'permission response was not delivered');

  assert.deepEqual(permissionResponse, {
    outcome: {
      outcome: 'selected',
      optionId: 'kimi-once-42',
    },
  });

  await service.close();
});

test('surfaces the AskUserQuestion text from the toolCall content block', async () => {
  const permissionIssued = deferred<void>();
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory((remote) => ({
      initialize: async () => initializeResponse(),
      newSession: async () => ({ sessionId: 'native-question' }),
      prompt: async (params: { sessionId: string }) => {
        // Mirror the real ACP adapter shape: title is the bare tool name and
        // the question text lives in a toolCall content block.
        const response = remote.requestPermission({
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: 'ask-user-1',
            title: 'AskUserQuestion',
            content: [
              { type: 'content', content: { type: 'text', text: 'Which approach do you prefer?' } },
            ],
          },
          options: [
            { optionId: 'q0_opt_0', name: 'Option A', kind: 'allow_once' },
            { optionId: 'q0_opt_1', name: 'Option B', kind: 'allow_once' },
            { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' },
          ],
        });
        permissionIssued.resolve();
        await response;
        return { stopReason: 'end_turn' };
      },
      cancel: async () => undefined,
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({
    runtime,
    emitEvent(method, params) {
      events.push({ method, params });
    },
  });
  const created = await service.createSession({ cwd: '/workspace/question' });
  await service.startTurn({
    sessionId: created.session.id,
    input: [{ type: 'text', text: 'ask me' }],
  });
  await permissionIssued.promise;
  await waitFor(
    () => events.some((event) => event.method === 'approval.requested'),
    'approval event was not emitted',
  );

  const approval = events.find((event) => event.method === 'approval.requested');
  const data = approval?.params.data as { title: string; reason: string };
  assert.equal(data.title, 'AskUserQuestion');
  assert.equal(data.reason, 'Which approach do you prefer?');

  await service.close();
});

test('resumes the same native session after the shared ACP process restarts', async () => {
  let generation = 0;
  let resumeCount = 0;
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory(() => {
      generation += 1;
      return {
        initialize: async () => initializeResponse(),
        newSession: async () => ({ sessionId: 'native-stable' }),
        resumeSession: async (params: { sessionId: string }) => {
          assert.equal(params.sessionId, 'native-stable');
          resumeCount += 1;
          return {};
        },
        prompt: async () => ({ stopReason: 'end_turn' }),
      } as unknown as Agent;
    }),
  });
  const service = new KimiProxyService({ runtime });
  const created = await service.createSession({ cwd: '/workspace/stable' });

  await runtime.stop();
  await waitFor(
    () => service.getSession({ sessionId: created.session.id }).session.status === 'stale',
    'session did not become stale after runtime stop',
  );
  const turn = await service.startTurn({
    sessionId: created.session.id,
    input: [{ type: 'text', text: 'continue' }],
  });

  assert.equal(generation, 2);
  assert.equal(resumeCount, 1);
  assert.equal(turn.session.nativeSessionId, 'native-stable');
  await service.close();
});

test('close reports detach when the negotiated agent has no session/close capability', async () => {
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory(() => ({
      initialize: async () => initializeResponse(),
      newSession: async () => ({ sessionId: 'native-detached' }),
      cancel: async () => undefined,
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });
  const created = await service.createSession({ cwd: '/workspace/detach' });

  const closed = await service.closeSession({ sessionId: created.session.id });

  assert.deepEqual(closed, {
    ok: true,
    nativeClosed: false,
    detached: true,
  });
  assert.throws(
    () => service.getSession({ sessionId: created.session.id }),
    (error: unknown) => (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'SESSION_NOT_FOUND'
    ),
  );
  await service.close();
});


const MODE_CONFIG_OPTIONS = [
  {
    type: 'select',
    category: 'mode',
    id: 'mode',
    name: 'Mode',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'plan', name: 'Plan' },
      { value: 'auto', name: 'Auto' },
      { value: 'yolo', name: 'Yolo' },
    ],
  },
];

test('capabilities probes a throwaway session to advertise mode choices (cached)', async () => {
  let newSessionCalls = 0;
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory(() => ({
      initialize: async () => initializeResponse(),
      newSession: async () => {
        newSessionCalls += 1;
        return { sessionId: 'native-probe', configOptions: MODE_CONFIG_OPTIONS };
      },
      cancel: async () => undefined,
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });

  const first = await service.listCapabilities();
  const second = await service.listCapabilities();

  assert.deepEqual(
    first.modes.map((mode: { id: string }) => mode.id),
    ['default', 'plan', 'auto', 'yolo'],
  );
  assert.deepEqual(
    first.modes.find((mode: { id: string }) => mode.id === 'default'),
    { id: 'default', label: 'Default', description: '', isDefault: true },
  );
  assert.equal(second.modes.length, 4);
  // Probe ran exactly once — the second call is served from the cache.
  assert.equal(newSessionCalls, 1);
  await service.close();
});

test('capabilities reuses an attached session\'s configOptions instead of probing', async () => {
  let newSessionCalls = 0;
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory(() => ({
      initialize: async () => initializeResponse(),
      newSession: async () => {
        newSessionCalls += 1;
        return { sessionId: 'native-live', configOptions: MODE_CONFIG_OPTIONS };
      },
      cancel: async () => undefined,
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });

  await service.createSession({ cwd: '/workspace/live' });
  assert.equal(newSessionCalls, 1);
  const capabilities = await service.listCapabilities();

  assert.deepEqual(
    capabilities.modes.map((mode: { id: string }) => mode.id),
    ['default', 'plan', 'auto', 'yolo'],
  );
  // No extra probe session was created — the live session's options were used.
  assert.equal(newSessionCalls, 1);
  await service.close();
});


const FULL_CONFIG_OPTIONS = [
  {
    type: 'select',
    category: 'model',
    id: 'model',
    name: 'Model',
    description: 'Model to use for this session',
    currentValue: 'kimi-k2',
    options: [
      { value: 'kimi-k2', name: 'Kimi K2' },
      { value: 'kimi-k2-thinking', name: 'Kimi K2 Thinking' },
    ],
  },
  {
    type: 'select',
    category: 'thought_level',
    id: 'thinking',
    name: 'Thinking',
    currentValue: 'medium',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
  ...MODE_CONFIG_OPTIONS,
];

test('capabilities probes model and thinking choices from configOptions', async () => {
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory(() => ({
      initialize: async () => initializeResponse(),
      newSession: async () => ({ sessionId: 'native-probe', configOptions: FULL_CONFIG_OPTIONS }),
      cancel: async () => undefined,
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });

  const capabilities = await service.listCapabilities();

  assert.deepEqual(
    capabilities.modes.map((mode: { id: string }) => mode.id),
    ['default', 'plan', 'auto', 'yolo'],
  );
  assert.equal(capabilities.models.length, 2);
  assert.deepEqual(capabilities.models[0], {
    id: 'kimi-model-kimi-k2',
    model: 'kimi-k2',
    displayName: 'Kimi K2',
    description: 'Model to use for this session',
    hidden: false,
    isDefault: true,
    defaultThinking: null,
    // Session-global thinking levels are attached to every model.
    supportedThinking: ['low', 'medium', 'high'],
  });
  assert.deepEqual(capabilities.models[1], {
    ...capabilities.models[0],
    id: 'kimi-model-kimi-k2-thinking',
    model: 'kimi-k2-thinking',
    displayName: 'Kimi K2 Thinking',
    isDefault: false,
  });
  await service.close();
});

test('capabilities reports no models when configOptions have no model option', async () => {
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory(() => ({
      initialize: async () => initializeResponse(),
      newSession: async () => ({ sessionId: 'native-probe', configOptions: MODE_CONFIG_OPTIONS }),
      cancel: async () => undefined,
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });

  const capabilities = await service.listCapabilities();

  assert.deepEqual(capabilities.models, []);
  assert.equal(capabilities.modes.length, 4);
  await service.close();
});

test('capabilities reports empty modes and models when the probe session fails', async () => {
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory(() => ({
      initialize: async () => initializeResponse(),
      newSession: async () => {
        throw new Error('not logged in');
      },
      cancel: async () => undefined,
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });

  const capabilities = await service.listCapabilities();

  assert.deepEqual(capabilities.modes, []);
  assert.deepEqual(capabilities.models, []);
  await service.close();
});

function v1Request(id: number, method: string, params: unknown) {
  return parseProxyRequest({ id, method, params });
}

test('Kimi gian.proxy/1 translates ACP text, tools, usage, and Host ids', async () => {
  let remote!: AgentSideConnection;
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory((client) => {
      remote = client;
      return {
        initialize: async () => initializeResponse(),
        newSession: async () => ({ sessionId: 'native-v1' }),
        prompt: async (params: { sessionId: string }) => {
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'hello' },
            },
          });
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tool-1',
              title: 'Read file',
              kind: 'read',
              status: 'in_progress',
              rawInput: { path: '/tmp/a' },
            },
          });
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tool-1',
              status: 'completed',
              rawOutput: { text: 'ok' },
            },
          });
          return {
            stopReason: 'end_turn',
            usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          };
        },
      } as unknown as Agent;
    }),
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const notifications: ProxyNotification[] = [];
  const adapter = new KimiProtocolV1Adapter(service, '0.1.0', notification => {
    notifications.push(proxyNotificationSchema.parse(notification));
  });
  await adapter.handle(v1Request(1, 'initialize', {
    protocol: { name: PROTOCOL_NAME, versions: [PROTOCOL_V1] },
    host: { name: 'Gian', version: '9.9.9' },
  }));
  const created = await adapter.handle(v1Request(2, 'session.create', {
    sessionId: 'host-kimi-session',
    cwd: '/tmp',
    workspaceRoots: ['/tmp'],
    config: {},
  })) as { session: { streamId: string; nativeSession: { id: string } } };
  await adapter.handle(v1Request(3, 'turn.start', {
    sessionId: 'host-kimi-session',
    streamId: created.session.streamId,
    turnId: 'host-kimi-turn',
    input: [{ type: 'text', text: 'go' }],
    policy: { workspaceRoots: ['/tmp'], approval: 'relay', network: 'ask' },
    config: { native: {} },
  }));
  await waitFor(
    () => notifications.some(item => item.method === 'turn.completed'),
    'standard Kimi turn did not complete',
  );
  assert.equal(created.session.nativeSession.id, 'native-v1');
  assert.deepEqual(notifications.map(item => item.method), [
    'turn.started',
    'content.delta',
    'tool.started',
    'tool.completed',
    'usage.updated',
    'turn.completed',
  ]);
  for (const notification of notifications) {
    if ('turnId' in notification.params) {
      assert.equal(notification.params.turnId, 'host-kimi-turn');
    }
  }
  await service.close();
});

test('Kimi gian.proxy/1 detaches a newly-created service session when config fails', async () => {
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory(() => ({
      initialize: async () => initializeResponse(),
      newSession: async () => ({
        sessionId: 'native-config-failure',
        configOptions: MODE_CONFIG_OPTIONS,
      }),
      setSessionConfigOption: async () => {
        throw new Error('config rejected');
      },
      cancel: async () => undefined,
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const originalClose = service.closeSession.bind(service);
  let closeCalls = 0;
  service.closeSession = async params => {
    closeCalls += 1;
    return originalClose(params);
  };
  const adapter = new KimiProtocolV1Adapter(service, '0.1.0', () => undefined);
  await adapter.handle(v1Request(1, 'initialize', {
    protocol: { name: PROTOCOL_NAME, versions: [PROTOCOL_V1] },
    host: { name: 'Gian', version: '9.9.9' },
  }));

  await assert.rejects(
    adapter.handle(v1Request(2, 'session.create', {
      sessionId: 'host-config-failure',
      cwd: '/tmp',
      workspaceRoots: ['/tmp'],
      config: { mode: 'auto' },
    })),
    /Internal error/,
  );
  assert.equal(closeCalls, 1);
  await service.close();
});

test('Kimi gian.proxy/1 returns normalized replay on one synthetic stream', async () => {
  let remote!: AgentSideConnection;
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory((client) => {
      remote = client;
      return {
        initialize: async () => initializeResponse(),
        loadSession: async (params: { sessionId: string }) => {
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'old question' },
            },
          });
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'history' },
            },
          });
          return {};
        },
      } as unknown as Agent;
    }),
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const adapter = new KimiProtocolV1Adapter(service, '0.1.0', () => undefined);
  await adapter.handle(v1Request(1, 'initialize', {
    protocol: { name: PROTOCOL_NAME, versions: [PROTOCOL_V1] },
    host: { name: 'Gian', version: '9.9.9' },
  }));
  const created = await adapter.handle(v1Request(2, 'session.create', {
    sessionId: 'host-replay',
    cwd: '/tmp',
    workspaceRoots: ['/tmp'],
    nativeSession: { id: 'native-replay', mode: 'load' },
    config: {},
  })) as { session: { streamId: string } };
  const replay = await adapter.handle(v1Request(3, 'session.replay', {
    sessionId: 'host-replay',
    streamId: created.session.streamId,
    cursor: null,
    limit: 100,
  })) as { replayStreamId: string; events: ProxyNotification[]; nextCursor: string | null };
  assert.deepEqual(replay.events.map(item => item.method), [
    'turn.started',
    'input.recorded',
    'content.delta',
    'turn.completed',
  ]);
  assert.deepEqual(replay.events.map(item => (
    'sequence' in item.params ? item.params.sequence : null
  )), [1, 2, 3, 4]);
  assert.ok(replay.events.every(item => (
    'streamId' in item.params && item.params.streamId === replay.replayStreamId
  )));
  assert.equal(replay.nextCursor, null);
  await service.close();
});
