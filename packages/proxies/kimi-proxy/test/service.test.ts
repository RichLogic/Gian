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
import { KimiProtocolV2Adapter, type WireRequest } from '../src/protocol/v2-adapter.js';
import { proxyNotificationSchema, replayEventSchemaUnion } from '@gian/proxy-protocol';
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
    defaultThinking: 'medium',
    supportedThinking: ['low', 'medium', 'high'],
  });
  assert.deepEqual(capabilities.models[1], {
    ...capabilities.models[0],
    id: 'kimi-model-kimi-k2-thinking',
    model: 'kimi-k2-thinking',
    displayName: 'Kimi K2 Thinking',
    isDefault: false,
    defaultThinking: null,
    // No setSessionConfigOption on this probe — other models stay unknown.
    supportedThinking: [],
  });
  await service.close();
});

const PER_MODEL_THINKING: Record<string, string[]> = {
  'kimi-code/kimi-for-coding': ['on'],
  'kimi-code/k3': ['low', 'high', 'max'],
};

function configOptionsForModel(modelId: string) {
  const thinking = PER_MODEL_THINKING[modelId] ?? ['on'];
  return [
    {
      type: 'select' as const,
      category: 'model',
      id: 'model',
      name: 'Model',
      currentValue: modelId,
      options: Object.keys(PER_MODEL_THINKING).map((value) => ({ value, name: value })),
    },
    {
      type: 'select' as const,
      category: 'thought_level',
      id: 'thinking',
      name: 'Thinking',
      currentValue: thinking[0]!,
      options: thinking.map((value) => ({
        value,
        name: `${value[0]!.toUpperCase()}${value.slice(1)}`,
      })),
    },
    ...MODE_CONFIG_OPTIONS,
  ];
}

function effortValues(options: Array<{ role?: string; choices?: Array<{ value: unknown }> }>) {
  return options
    .find((option) => option.role === 'effort')
    ?.choices
    ?.map((choice) => choice.value);
}

test('capabilities probes per-model thinking on a throwaway session', async () => {
  const setConfigCalls: Array<{ sessionId: string; configId: string; value: unknown }> = [];
  let newSessionCalls = 0;
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory(() => ({
      initialize: async () => initializeResponse(),
      newSession: async () => {
        newSessionCalls += 1;
        return {
          sessionId: `native-probe-${newSessionCalls}`,
          configOptions: configOptionsForModel('kimi-code/kimi-for-coding'),
        };
      },
      setSessionConfigOption: async (params: {
        sessionId: string;
        configId: string;
        value: unknown;
      }) => {
        setConfigCalls.push(params);
        if (params.configId !== 'model' || typeof params.value !== 'string') {
          throw new Error(`unexpected config ${params.configId}`);
        }
        return { configOptions: configOptionsForModel(params.value) };
      },
      cancel: async () => undefined,
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });

  const capabilities = await service.listCapabilities();

  assert.equal(newSessionCalls, 1);
  assert.deepEqual(
    setConfigCalls.map((call) => ({ configId: call.configId, value: call.value })),
    [{ configId: 'model', value: 'kimi-code/k3' }],
  );
  assert.deepEqual(
    capabilities.models.map((model: { model: string; supportedThinking: string[]; defaultThinking: string | null }) => ({
      model: model.model,
      supportedThinking: model.supportedThinking,
      defaultThinking: model.defaultThinking,
    })),
    [
      {
        model: 'kimi-code/kimi-for-coding',
        supportedThinking: ['on'],
        defaultThinking: 'on',
      },
      {
        model: 'kimi-code/k3',
        supportedThinking: ['low', 'high', 'max'],
        defaultThinking: 'low',
      },
    ],
  );
  await service.close();
});

test('capabilities never mutates a live session while probing other models', async () => {
  const setConfigCalls: Array<{ sessionId: string; configId: string; value: unknown }> = [];
  let newSessionCalls = 0;
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory(() => ({
      initialize: async () => initializeResponse(),
      newSession: async () => {
        newSessionCalls += 1;
        return {
          sessionId: newSessionCalls === 1 ? 'native-live' : `native-probe-${newSessionCalls}`,
          configOptions: configOptionsForModel('kimi-code/kimi-for-coding'),
        };
      },
      setSessionConfigOption: async (params: {
        sessionId: string;
        configId: string;
        value: unknown;
      }) => {
        setConfigCalls.push(params);
        if (params.configId !== 'model' || typeof params.value !== 'string') {
          throw new Error(`unexpected config ${params.configId}`);
        }
        return { configOptions: configOptionsForModel(params.value) };
      },
      cancel: async () => undefined,
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });
  await service.createSession({ cwd: '/workspace/live' });
  assert.equal(newSessionCalls, 1);

  const capabilities = await service.listCapabilities();

  assert.equal(newSessionCalls, 2, 'other models must be probed on a throwaway session');
  assert.deepEqual(setConfigCalls.map((call) => call.sessionId), ['native-probe-2']);
  assert.deepEqual(
    capabilities.models.find((model: { model: string }) => model.model === 'kimi-code/k3')
      ?.supportedThinking,
    ['low', 'high', 'max'],
  );
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

function v2Request(id: string, method: string, params: Record<string, unknown>): WireRequest {
  return { id, method, params };
}

test('Kimi gian.proxy/2 translates ACP text, tools, usage, and Host ids', async () => {
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
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new KimiProtocolV2Adapter(service, '0.2.0', (method, params) => {
    notifications.push({ method, params });
    proxyNotificationSchema.parse({ jsonrpc: '2.0', method, params });
  });
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '9.9.9' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-kimi-session',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    config: {},
  })) as { session: { streamId: string; nativeSession: { id: string }; state: string } };
  await adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 'host-kimi-session',
    streamId: created.session.streamId,
    turnId: 'host-kimi-turn',
    input: [{ type: 'text', text: 'go' }],
    config: {},
  }));
  await waitFor(
    () => notifications.some(item => item.method === 'turn.completed'),
    'standard Kimi turn did not complete',
  );
  assert.equal(created.session.nativeSession.id, 'native-v1');
  assert.equal(created.session.state, 'idle');
  assert.deepEqual(notifications.map(item => item.method), [
    'turn.started',
    'content.delta',
    'activity.updated',
    'activity.updated',
    'usage.updated',
    'content.completed',
    'turn.completed',
  ]);
  const completedContent = notifications.find(item => item.method === 'content.completed');
  assert.equal((completedContent?.params.data as { format?: unknown } | undefined)?.format, 'plain');
  for (const notification of notifications) {
    if ('turnId' in notification.params) {
      assert.equal(notification.params.turnId, 'host-kimi-turn');
      const sourceTurnId = notification.params.sourceTurnId;
      assert.equal(typeof sourceTurnId, 'string');
      assert.ok(
        (sourceTurnId as string).startsWith('kimi-turn-'),
        'sourceTurnId must be a Proxy-owned stable ID, not the Host turnId',
      );
      assert.notEqual(sourceTurnId, 'host-kimi-turn');
    }
  }

  const compactStart = notifications.length;
  await adapter.handle(v2Request('4', 'turn.start', {
    sessionId: 'host-kimi-session',
    streamId: created.session.streamId,
    turnId: 'host-kimi-compact',
    input: [{ type: 'text', text: '/compact' }],
    config: {},
  }));
  await waitFor(
    () => notifications.slice(compactStart).some(item => item.method === 'turn.completed'),
    'compact Kimi turn did not complete',
  );
  assert.deepEqual(
    notifications.slice(compactStart, compactStart + 2).map(item => item.method),
    ['turn.started', 'usage.updated'],
  );
  await service.close();
});

test('Kimi gian.proxy/2 projects TodoList tools as one deduplicated plan snapshot', async () => {
  let remote!: AgentSideConnection;
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory((client) => {
      remote = client;
      return {
        initialize: async () => initializeResponse(),
        newSession: async () => ({ sessionId: 'native-todo-plan' }),
        prompt: async (params: { sessionId: string }) => {
          const todos = [
            { title: 'Inspect', status: 'done' },
            { title: 'Implement', status: 'in_progress' },
          ];
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'todo-call-1',
              title: 'TodoList',
              kind: 'other',
              status: 'pending',
            } as never,
          });
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'todo-call-1',
              title: 'Updating todo list',
              kind: 'other',
              status: 'in_progress',
              rawInput: { todos },
            } as never,
          });
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'todo-call-1',
              status: 'completed',
            } as never,
          });
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'plan',
              entries: [
                { content: 'Inspect', priority: 'medium', status: 'completed' },
                { content: 'Implement', priority: 'medium', status: 'in_progress' },
              ],
            } as never,
          });
          return { stopReason: 'end_turn' };
        },
      } as unknown as Agent;
    }),
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new KimiProtocolV2Adapter(service, '0.2.0', (method, params) => {
    notifications.push({ method, params });
    proxyNotificationSchema.parse({ jsonrpc: '2.0', method, params });
  });
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '9.9.9' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-todo-plan',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    config: {},
  })) as { session: { streamId: string } };
  await adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 'host-todo-plan',
    streamId: created.session.streamId,
    turnId: 'host-todo-plan-turn',
    input: [{ type: 'text', text: 'make a plan' }],
    config: {},
  }));
  await waitFor(
    () => notifications.some(item => item.method === 'turn.completed'),
    'TodoList plan turn did not complete',
  );

  const plans = notifications.filter(item => item.method === 'plan.updated');
  assert.equal(plans.length, 1, 'TodoList and native plan facts must deduplicate');
  const plan = plans[0]?.params.data as {
    planId: string;
    title: string;
    steps: Array<{ id: string; text: string; status: string }>;
  };
  assert.match(plan.planId, /^plan:kimi-turn-/);
  assert.deepEqual({ title: plan.title, steps: plan.steps }, {
    title: 'Plan',
    steps: [
      { id: 'step-1', text: 'Inspect', status: 'completed' },
      { id: 'step-2', text: 'Implement', status: 'in_progress' },
    ],
  });
  assert.equal(
    notifications.some(item => (
      item.method === 'activity.updated'
      && (item.params.data as { activityId?: unknown }).activityId === 'todo-call-1'
    )),
    false,
    'a structured TodoList plan must not also render as a generic tool activity',
  );
  await service.close();
});

test('Kimi config updates cannot emit Turn activity before turn.started', async () => {
  let remote!: AgentSideConnection;
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory((client) => {
      remote = client;
      return {
        initialize: async () => initializeResponse(),
        newSession: async () => ({ sessionId: 'native-pre-turn', configOptions: MODE_CONFIG_OPTIONS }),
        setSessionConfigOption: async () => {
          await remote.sessionUpdate({
            sessionId: 'native-pre-turn',
            update: {
              sessionUpdate: 'current_mode_update',
              currentModeId: 'auto',
            } as never,
          });
          return { configOptions: MODE_CONFIG_OPTIONS };
        },
        prompt: async () => ({ stopReason: 'end_turn' }),
        cancel: async () => undefined,
      } as unknown as Agent;
    }),
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new KimiProtocolV2Adapter(
    service,
    '0.2.0',
    (method, params) => notifications.push({ method, params }),
  );
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '9.9.9' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-pre-turn',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    config: {},
  })) as { session: { streamId: string } };
  await adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 'host-pre-turn',
    streamId: created.session.streamId,
    turnId: 'turn-pre-turn',
    input: [{ type: 'text', text: 'hello' }],
    config: { mode: 'auto' },
  }));
  await waitFor(
    () => notifications.some(item => item.method === 'turn.completed'),
    'Kimi pre-turn config scenario did not complete',
  );
  const turnScoped = notifications.filter(item => 'turnId' in item.params);
  assert.equal(turnScoped[0]?.method, 'turn.started');
  assert.equal(
    turnScoped.some(item => (
      item.method === 'activity.updated'
      && (item.params.data as { kind?: unknown }).kind === 'current_mode_update'
    )),
    false,
  );
  await service.close();
});

test('Kimi gian.proxy/2 rejects session-bound config before any native session exists', async () => {
  let newSessionCalls = 0;
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory(() => ({
      initialize: async () => initializeResponse(),
      newSession: async () => {
        newSessionCalls += 1;
        return {
          sessionId: 'native-config-failure',
          configOptions: MODE_CONFIG_OPTIONS,
        };
      },
      cancel: async () => undefined,
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const adapter = new KimiProtocolV2Adapter(service, '0.2.0', () => undefined);
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '9.9.9' },
  }));

  // Kimi options are turn-bound, so a session.create config snapshot is a
  // binding violation and must fail before any Provider side effect.
  await assert.rejects(
    adapter.handle(v2Request('2', 'session.create', {
      sessionId: 'host-config-failure',
      workspace: { cwd: '/tmp', roots: ['/tmp'] },
      config: { mode: 'auto' },
    })),
    (error: unknown) => (
      error instanceof Error
      && 'domainCode' in error
      && (error as { domainCode?: string }).domainCode === 'CONFIG_BINDING_INVALID'
    ),
  );
  assert.equal(newSessionCalls, 0, 'invalid config must not create a native session');
  await service.close();
});

test('Kimi gian.proxy/2 returns Replay Events on one synthetic stream', async () => {
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
  const adapter = new KimiProtocolV2Adapter(service, '0.2.0', () => undefined);
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '9.9.9' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-replay',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    nativeSession: { id: 'native-replay', history: 'replay' },
    config: {},
  })) as { session: { streamId: string } };
  const replay = await adapter.handle(v2Request('3', 'session.replay', {
    sessionId: 'host-replay',
    streamId: created.session.streamId,
    cursor: null,
    limit: 100,
  })) as { replayStreamId: string; events: Array<{ method: string; sequence: number; replayStreamId: string }>; nextCursor: string | null };
  for (const event of replay.events) replayEventSchemaUnion.parse(event);
  assert.deepEqual(replay.events.map(item => item.method), [
    'turn.started',
    'input.recorded',
    'content.delta',
    'content.completed',
    'turn.completed',
  ]);
  assert.deepEqual(replay.events.map(item => item.sequence), [1, 2, 3, 4, 5]);
  assert.ok(replay.events.every(item => item.replayStreamId === replay.replayStreamId));
  assert.equal(replay.nextCursor, null);
  await service.close();
});

test('Kimi gian.proxy/2 validates turn config before touching the runtime', async () => {
  const configCalls: Array<{ configId: string; value: unknown }> = [];
  let promptCalls = 0;
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory(() => ({
      initialize: async () => initializeResponse(),
      newSession: async () => ({ sessionId: 'native-cfg', configOptions: MODE_CONFIG_OPTIONS }),
      setSessionConfigOption: async (params: { configId: string; value: unknown }) => {
        configCalls.push(params);
        return { configOptions: MODE_CONFIG_OPTIONS };
      },
      prompt: async () => {
        promptCalls += 1;
        return { stopReason: 'end_turn' };
      },
      cancel: async () => undefined,
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const adapter = new KimiProtocolV2Adapter(service, '0.2.0', () => undefined);
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '9.9.9' },
  }));

  const catalog = await adapter.handle(v2Request('cat', 'catalog.list', {})) as {
    configOptions: Array<{ id: string; binding: string }>;
  };
  assert.equal(
    catalog.configOptions.find((option) => option.id === 'mode')?.binding,
    'turn',
    'Kimi applies ACP config between prompts, so the binding must be honest',
  );

  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 's-cfg',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    config: {},
  })) as {
    session: {
      streamId: string;
      sessionConfig: Record<string, unknown>;
      turnConfigOptions?: Array<{ id: string; binding: string }>;
      turnConfigRevision?: string;
    };
  };
  assert.deepEqual(created.session.sessionConfig, {});
  assert.equal(created.session.turnConfigOptions?.[0]?.binding, 'turn');
  assert.ok(created.session.turnConfigRevision);

  const baseTurn = {
    sessionId: 's-cfg',
    streamId: created.session.streamId,
    turnId: 't-cfg',
    input: [{ type: 'text', text: 'go' }],
  };
  const domainCode = (error: unknown) => (error as { domainCode?: string }).domainCode;
  await assert.rejects(
    adapter.handle(v2Request('3', 'turn.start', { ...baseTurn, config: { unknown_option: 'x' } })),
    (error: unknown) => domainCode(error) === 'CONFIG_VALUE_INVALID',
  );
  await assert.rejects(
    adapter.handle(v2Request('4', 'turn.start', { ...baseTurn, config: { mode: 'bogus' } })),
    (error: unknown) => domainCode(error) === 'CONFIG_VALUE_INVALID',
  );
  assert.equal(configCalls.length, 0, 'invalid config reached the runtime');
  assert.equal(promptCalls, 0, 'invalid config started a turn');

  const accepted = await adapter.handle(
    v2Request('5', 'turn.start', { ...baseTurn, config: { mode: 'auto' } }),
  );
  assert.deepEqual(accepted, { accepted: true, turnId: 't-cfg' });
  await waitFor(() => promptCalls === 1, 'prompt did not start');
  assert.deepEqual(configCalls, [{ sessionId: 'native-cfg', configId: 'mode', value: 'auto' }]);

  const duplicate = await adapter.handle(
    v2Request('6', 'turn.start', { ...baseTurn, config: { mode: 'auto' } }),
  );
  assert.deepEqual(duplicate, { accepted: true, turnId: 't-cfg' });
  assert.equal(promptCalls, 1, 'an idempotent duplicate must not start another prompt');
  await service.close();
});

test('Kimi gian.proxy/2 advertises catalog.resolve and rebuilds thinking per model', async () => {
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory(() => ({
      initialize: async () => initializeResponse(),
      newSession: async () => ({
        sessionId: 'native-catalog',
        configOptions: configOptionsForModel('kimi-code/kimi-for-coding'),
      }),
      setSessionConfigOption: async (params: { configId: string; value: unknown }) => {
        if (params.configId !== 'model' || typeof params.value !== 'string') {
          throw new Error(`unexpected config ${params.configId}`);
        }
        return { configOptions: configOptionsForModel(params.value) };
      },
      cancel: async () => undefined,
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const adapter = new KimiProtocolV2Adapter(service, '0.2.0', () => undefined);
  const initialized = await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '9.9.9' },
  })) as { capabilities: Record<string, unknown> };
  assert.equal(initialized.capabilities['catalog.resolve'], 1);

  const catalog = await adapter.handle(v2Request('cat', 'catalog.list', {})) as {
    catalogRevision: string;
    configOptions: Array<{ role?: string; choices?: Array<{ value: unknown }> }>;
  };
  assert.deepEqual(effortValues(catalog.configOptions), ['on']);

  const resolved = await adapter.handle(v2Request('res', 'catalog.resolve', {
    catalogRevision: catalog.catalogRevision,
    sessionConfig: {},
    turnConfig: { model: 'kimi-code/k3' },
  })) as {
    configOptions: Array<{ role?: string; defaultValue?: unknown; choices?: Array<{ value: unknown }> }>;
    resolvedDefaults: { turnConfig: Record<string, unknown> };
  };
  assert.deepEqual(effortValues(resolved.configOptions), ['low', 'high', 'max']);
  assert.deepEqual(
    resolved.configOptions.find((option) => option.role === 'model')?.choices?.map((choice) => choice.value),
    ['kimi-code/kimi-for-coding', 'kimi-code/k3'],
  );
  assert.equal(
    resolved.configOptions.find((option) => option.role === 'effort')?.defaultValue,
    'low',
  );
  assert.equal(resolved.resolvedDefaults.turnConfig.thinking, 'low');
  await service.close();
});

test('Kimi gian.proxy/2 validates thinking against the requested model', async () => {
  const configCalls: Array<{ configId: string; value: unknown }> = [];
  let promptCalls = 0;
  let newSessionCalls = 0;
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory(() => ({
      initialize: async () => initializeResponse(),
      newSession: async () => {
        newSessionCalls += 1;
        return {
          sessionId: newSessionCalls === 1 ? 'native-turn-model' : `native-probe-${newSessionCalls}`,
          configOptions: configOptionsForModel('kimi-code/kimi-for-coding'),
        };
      },
      setSessionConfigOption: async (params: {
        sessionId: string;
        configId: string;
        value: unknown;
      }) => {
        if (params.sessionId === 'native-turn-model') {
          configCalls.push({ configId: params.configId, value: params.value });
        }
        if (params.configId === 'model' && typeof params.value === 'string') {
          return { configOptions: configOptionsForModel(params.value) };
        }
        return { configOptions: configOptionsForModel('kimi-code/k3') };
      },
      prompt: async () => {
        promptCalls += 1;
        return { stopReason: 'end_turn' };
      },
      cancel: async () => undefined,
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const adapter = new KimiProtocolV2Adapter(service, '0.2.0', () => undefined);
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '9.9.9' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 's-model-thinking',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    config: {},
  })) as { session: { streamId: string } };

  const domainCode = (error: unknown) => (error as { domainCode?: string }).domainCode;
  await assert.rejects(
    adapter.handle(v2Request('3', 'turn.start', {
      sessionId: 's-model-thinking',
      streamId: created.session.streamId,
      turnId: 't-invalid',
      input: [{ type: 'text', text: 'go' }],
      config: { model: 'kimi-code/kimi-for-coding', thinking: 'low' },
    })),
    (error: unknown) => domainCode(error) === 'CONFIG_VALUE_INVALID',
  );
  assert.equal(configCalls.length, 0, 'invalid thinking must not reach the runtime');
  assert.equal(promptCalls, 0);

  const accepted = await adapter.handle(v2Request('4', 'turn.start', {
    sessionId: 's-model-thinking',
    streamId: created.session.streamId,
    turnId: 't-valid',
    input: [{ type: 'text', text: 'go' }],
    config: { model: 'kimi-code/k3', thinking: 'high' },
  }));
  assert.deepEqual(accepted, { accepted: true, turnId: 't-valid' });
  await waitFor(() => promptCalls === 1, 'prompt did not start');
  assert.deepEqual(configCalls.map((call) => call.configId), ['model', 'thinking']);
  assert.deepEqual(configCalls.map((call) => call.value), ['kimi-code/k3', 'high']);
  await service.close();
});

test('Kimi gian.proxy/2 session.create is idempotent and conflicts on different payloads', async () => {
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory(() => ({
      initialize: async () => initializeResponse(),
      newSession: async () => ({ sessionId: 'native-idem' }),
      cancel: async () => undefined,
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const adapter = new KimiProtocolV2Adapter(service, '0.2.0', () => undefined);
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '9.9.9' },
  }));

  const params = {
    sessionId: 's-idem',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    config: {},
  };
  const first = await adapter.handle(v2Request('2', 'session.create', params)) as {
    session: { streamId: string };
  };
  const second = await adapter.handle(v2Request('3', 'session.create', params)) as {
    session: { streamId: string };
  };
  assert.equal(second.session.streamId, first.session.streamId);

  const domainCode = (error: unknown) => (error as { domainCode?: string }).domainCode;
  await assert.rejects(
    adapter.handle(v2Request('4', 'session.create', {
      ...params,
      workspace: { cwd: '/tmp', roots: ['/tmp', '/other'] },
    })),
    (error: unknown) => domainCode(error) === 'CONFLICT',
  );
  await assert.rejects(
    adapter.handle(v2Request('5', 'session.create', {
      ...params,
      nativeSession: { id: 'native-other' },
    })),
    (error: unknown) => domainCode(error) === 'CONFLICT',
  );
  await service.close();
});

test('Kimi gian.proxy/2 interaction.respond keeps native IDs and is responseId-idempotent', async () => {
  let remote!: AgentSideConnection;
  const permissionIssued = deferred<void>();
  const endGate = deferred<void>();
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory((client) => {
      remote = client;
      return {
        initialize: async () => initializeResponse(),
        newSession: async () => ({ sessionId: 'native-inter' }),
        prompt: async (params: { sessionId: string }) => {
          const response = remote.requestPermission({
            sessionId: params.sessionId,
            toolCall: {
              toolCallId: 'ask-1',
              title: 'AskUserQuestion',
              content: [
                { type: 'content', content: { type: 'text', text: 'Pick one' } },
              ],
            },
            options: [
              { optionId: 'q_opt_a', name: 'Option A', kind: 'allow_once' },
              { optionId: 'q_opt_b', name: 'Option B', kind: 'allow_once' },
            ],
          });
          permissionIssued.resolve();
          await response;
          // Hold the turn open so idempotent replays can arrive after the
          // interaction resolved but before the terminal event.
          await endGate.promise;
          return { stopReason: 'end_turn' };
        },
        cancel: async () => undefined,
      } as unknown as Agent;
    }),
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new KimiProtocolV2Adapter(service, '0.2.0', (method, params) => {
    notifications.push({ method, params });
    proxyNotificationSchema.parse({ jsonrpc: '2.0', method, params });
  });
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '9.9.9' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 's-inter',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    config: {},
  })) as { session: { streamId: string } };
  await adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 's-inter',
    streamId: created.session.streamId,
    turnId: 't-inter',
    input: [{ type: 'text', text: 'ask' }],
    config: {},
  }));
  await permissionIssued.promise;
  await waitFor(
    () => notifications.some((item) => item.method === 'interaction.requested'),
    'interaction.requested was not emitted',
  );

  const requested = notifications.find((item) => item.method === 'interaction.requested');
  const requestedData = requested?.params.data as {
    interactionId: string;
    description?: string;
    presentation: { kind: string };
    actions: Array<{ id: string }>;
  };
  assert.equal(requestedData.presentation.kind, 'question');
  assert.equal(requestedData.description, 'Pick one');
  assert.deepEqual(
    requestedData.actions.map((action) => action.id),
    ['q_opt_a', 'q_opt_b'],
    'native ACP option IDs must round-trip untouched',
  );

  const respond = (id: string, params: Record<string, unknown>) => adapter.handle(v2Request(
    id,
    'interaction.respond',
    {
      sessionId: 's-inter',
      streamId: created.session.streamId,
      turnId: 't-inter',
      interactionId: requestedData.interactionId,
      values: {},
      ...params,
    },
  ));
  const domainCode = (error: unknown) => (error as { domainCode?: string }).domainCode;
  await assert.rejects(
    respond('r-x', { responseId: 'r-x', actionId: 'q_opt_a', values: { bogus: 'x' } }),
    (error: unknown) => domainCode(error) === 'INVALID_PARAMS',
  );
  await assert.rejects(
    respond('r-y', { responseId: 'r-y', actionId: 'not-advertised' }),
    (error: unknown) => domainCode(error) === 'INTERACTION_ACTION_NOT_FOUND',
  );

  const first = await respond('r-1', { responseId: 'r-1', actionId: 'q_opt_a' });
  assert.deepEqual(first, {
    accepted: true,
    interactionId: requestedData.interactionId,
    responseId: 'r-1',
  });
  await waitFor(
    () => notifications.some((item) => item.method === 'interaction.resolved'),
    'interaction.resolved was not emitted',
  );
  const repeat = await respond('r-2', { responseId: 'r-1', actionId: 'q_opt_a' });
  assert.deepEqual(repeat, first, 'identical responseId replay must return the first result');
  await assert.rejects(
    respond('r-3', { responseId: 'r-1', actionId: 'q_opt_b' }),
    (error: unknown) => domainCode(error) === 'CONFLICT',
  );

  endGate.resolve();
  await waitFor(
    () => notifications.some((item) => item.method === 'turn.completed'),
    'turn did not complete after the interaction resolved',
  );
  const resolved = notifications.find((item) => item.method === 'interaction.resolved');
  assert.deepEqual(resolved?.params.data, {
    interactionId: requestedData.interactionId,
    outcome: 'submitted',
    actionId: 'q_opt_a',
  });
  await service.close();
});

test('Kimi gian.proxy/2 maps native stop reasons to contract stopReasons', async () => {
  const reasons = ['max_tokens', 'max_turn_requests', 'refusal', 'cancelled'];
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory(() => ({
      initialize: async () => initializeResponse(),
      newSession: async () => ({ sessionId: 'native-stops' }),
      prompt: async () => ({ stopReason: reasons.shift() ?? 'end_turn' }),
      cancel: async () => undefined,
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new KimiProtocolV2Adapter(service, '0.2.0', (method, params) => {
    notifications.push({ method, params });
  });
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '9.9.9' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 's-stops',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    config: {},
  })) as { session: { streamId: string } };

  const expected = ['limit_reached', 'limit_reached', 'refused', 'cancelled'];
  for (const [index, stopReason] of expected.entries()) {
    const turnId = `t-stop-${index}`;
    await adapter.handle(v2Request(`turn-${index}`, 'turn.start', {
      sessionId: 's-stops',
      streamId: created.session.streamId,
      turnId,
      input: [{ type: 'text', text: `turn ${index}` }],
      config: {},
    }));
    await waitFor(
      () => notifications.some((item) => (
        item.method === 'turn.completed' && item.params.turnId === turnId
      )),
      `turn ${turnId} did not complete`,
    );
    const terminal = notifications.find((item) => (
      item.method === 'turn.completed' && item.params.turnId === turnId
    ));
    assert.equal((terminal?.params.data as { stopReason?: string }).stopReason, stopReason);
  }
  await service.close();
});

test('Kimi gian.proxy/2 reports interrupted only after a host-accepted interrupt', async () => {
  const promptGate = deferred<void>();
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory(() => ({
      initialize: async () => initializeResponse(),
      newSession: async () => ({ sessionId: 'native-interrupt' }),
      prompt: async () => {
        await promptGate.promise;
        return { stopReason: 'cancelled' };
      },
      cancel: async () => {
        // Resolve on the next tick so the cancel RPC response reaches the
        // proxy before the prompt settles.
        setTimeout(() => promptGate.resolve(), 0);
      },
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new KimiProtocolV2Adapter(service, '0.2.0', (method, params) => {
    notifications.push({ method, params });
    proxyNotificationSchema.parse({ jsonrpc: '2.0', method, params });
  });
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '9.9.9' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 's-interrupt',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    config: {},
  })) as { session: { streamId: string } };
  await adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 's-interrupt',
    streamId: created.session.streamId,
    turnId: 't-interrupt',
    input: [{ type: 'text', text: 'work' }],
    config: {},
  }));

  const interrupt = await adapter.handle(v2Request('4', 'turn.interrupt', {
    sessionId: 's-interrupt',
    streamId: created.session.streamId,
    turnId: 't-interrupt',
  }));
  assert.deepEqual(interrupt, { accepted: true, turnId: 't-interrupt' });
  await waitFor(
    () => notifications.some((item) => item.method === 'turn.completed'),
    'interrupted turn did not terminate',
  );
  const terminal = notifications.find((item) => item.method === 'turn.completed');
  assert.equal((terminal?.params.data as { stopReason?: string }).stopReason, 'interrupted');

  await assert.rejects(
    adapter.handle(v2Request('5', 'turn.interrupt', {
      sessionId: 's-interrupt',
      streamId: created.session.streamId,
      turnId: 't-interrupt',
    })),
    (error: unknown) => (error as { domainCode?: string }).domainCode === 'TURN_NOT_FOUND',
  );
  await service.close();
});

test('Kimi gian.proxy/2 degrades unknown ACP updates to generic activities', async () => {
  let remote!: AgentSideConnection;
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory((client) => {
      remote = client;
      return {
        initialize: async () => initializeResponse(),
        newSession: async () => ({ sessionId: 'native-unknown' }),
        prompt: async (params: { sessionId: string }) => {
          // SDK-valid but unmapped by this adapter: must degrade to a generic
          // activity instead of disappearing. Sent twice with identical
          // content — each occurrence must keep its own card.
          for (let i = 0; i < 2; i += 1) {
            await remote.sessionUpdate({
              sessionId: params.sessionId,
              update: { sessionUpdate: 'session_info_update', title: 'Renamed session' },
            });
          }
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [{ name: 'help', description: 'Show help' }],
            },
          });
          return { stopReason: 'end_turn' };
        },
        cancel: async () => undefined,
      } as unknown as Agent;
    }),
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new KimiProtocolV2Adapter(service, '0.2.0', (method, params) => {
    notifications.push({ method, params });
    proxyNotificationSchema.parse({ jsonrpc: '2.0', method, params });
  });
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '9.9.9' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 's-unknown',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    config: {},
  })) as { session: { streamId: string } };
  await adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 's-unknown',
    streamId: created.session.streamId,
    turnId: 't-unknown',
    input: [{ type: 'text', text: 'go' }],
    config: {},
  }));
  await waitFor(
    () => notifications.some((item) => item.method === 'turn.completed'),
    'turn did not complete',
  );

  const degraded = notifications.filter((item) => (
    item.method === 'activity.updated'
    && (item.params.data as { kind?: string }).kind === 'session_info_update'
  ));
  assert.equal(degraded.length, 2, 'each unmapped visible update must degrade to its own card');
  assert.notEqual(
    (degraded[0]?.params.data as { activityId: string }).activityId,
    (degraded[1]?.params.data as { activityId: string }).activityId,
    'identical repeated updates must not upsert over each other',
  );
  const data = degraded[0]?.params.data as {
    title: string;
    status: string;
    presentation: { type: string };
    details?: unknown;
  };
  assert.equal(data.presentation.type, 'generic');
  assert.equal(data.status, 'succeeded');
  assert.ok(data.title.includes('session_info_update'));
  assert.deepEqual(data.details, {
    sessionUpdate: 'session_info_update',
    title: 'Renamed session',
  });

  await waitFor(
    () => notifications.some((item) => item.method === 'catalog.changed'),
    'available_commands_update did not surface as a catalog invalidation hint',
  );
  const catalog = await adapter.handle(v2Request('4', 'catalog.list', {})) as {
    catalogRevision: string;
  };
  const catalogChanged = notifications.filter((item) => item.method === 'catalog.changed');
  assert.ok(
    catalogChanged.every((item) => {
      const revision = (item.params.data as { revision?: string }).revision;
      return typeof revision === 'string' && revision !== 'kimi-empty';
    }),
    'catalog.changed must carry a fresh revision, never a stale one',
  );
  assert.equal(
    (catalogChanged.at(-1)?.params.data as { revision?: string }).revision,
    catalog.catalogRevision,
    'catalog.changed revision must match the catalog the Host would refetch',
  );
  assert.ok(
    !notifications.some((item) => (
      item.method === 'activity.updated'
      && (item.params.data as { kind?: string }).kind === 'available_commands_update'
    )),
    'available_commands_update must not degrade into a user-facing activity',
  );
  await service.close();
});

test('Kimi gian.proxy/2 mirrors a shared-runtime crash and resumes on the next turn', async () => {
  const exits: Array<(exit: KimiAcpExit) => void> = [];
  let generation = 0;
  let resumeCount = 0;
  const crashFactory: KimiAcpTransportFactory = async (client) => {
    generation += 1;
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);
    const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
    const exit = deferred<KimiAcpExit>();
    exits.push(exit.resolve);
    new AgentSideConnection(() => ({
      initialize: async () => initializeResponse(),
      newSession: async () => ({ sessionId: 'native-crash' }),
      resumeSession: async () => {
        resumeCount += 1;
        return {};
      },
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
    binaryPath: '/managed/kimi',
    transportFactory: crashFactory,
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new KimiProtocolV2Adapter(service, '0.2.0', (method, params) => {
    notifications.push({ method, params });
    proxyNotificationSchema.parse({ jsonrpc: '2.0', method, params });
  });
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '9.9.9' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 's-crash',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    config: {},
  })) as { session: { streamId: string } };
  assert.equal(generation, 1);

  exits[0]?.({ code: 1, signal: null });
  await waitFor(
    () => notifications.some((item) => item.method === 'runtime.error'),
    'runtime.error was not emitted after the crash',
  );
  assert.ok(
    notifications.some((item) => (
      item.method === 'session.updated'
      && (item.params.data as { state?: string }).state === 'stale'
    )),
    'the crash must mirror every attached session as stale',
  );
  const stale = await adapter.handle(v2Request('3', 'session.get', { sessionId: 's-crash' })) as {
    session: { state: string };
  };
  assert.equal(stale.session.state, 'stale');

  await adapter.handle(v2Request('4', 'turn.start', {
    sessionId: 's-crash',
    streamId: created.session.streamId,
    turnId: 't-crash',
    input: [{ type: 'text', text: 'continue' }],
    config: {},
  }));
  await waitFor(
    () => notifications.some((item) => item.method === 'turn.completed'),
    'resumed turn did not complete',
  );
  assert.equal(generation, 2, 'the runtime did not restart');
  assert.equal(resumeCount, 1, 'the session did not resume its native session');
  const idle = await adapter.handle(v2Request('5', 'session.get', { sessionId: 's-crash' })) as {
    session: { state: string };
  };
  assert.equal(idle.session.state, 'idle');
  await service.close();
});

test('Kimi gian.proxy/2 keeps fact-derived IDs stable across noisy live events and replay', async () => {
  let remote!: AgentSideConnection;
  const permissionIssued = deferred<void>();
  const replayUpdates = async (sessionId: string) => {
    await remote.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'hello stable id' },
      },
    });
    await remote.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'old ' },
      },
    });
    await remote.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Inspect code', priority: 'high', status: 'completed' },
          { content: 'Fix code', priority: 'medium', status: 'in_progress' },
        ],
      },
    });
    await remote.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'answer' },
      },
    });
    await remote.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Inspect code', priority: 'high', status: 'completed' },
          { content: 'Fix code', priority: 'medium', status: 'completed' },
        ],
      },
    });
    await remote.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-stable',
        title: 'Read source',
        kind: 'read',
        status: 'in_progress',
        locations: [{ path: '/tmp/source.ts' }],
        rawInput: { path: '/tmp/source.ts' },
      },
    });
    await remote.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-stable',
        status: 'completed',
        rawOutput: { text: 'source' },
      },
    });
  };
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory((client) => {
      remote = client;
      return {
        initialize: async () => initializeResponse(),
        newSession: async () => ({ sessionId: 'native-stable-turn' }),
        loadSession: async (params: { sessionId: string }) => {
          await replayUpdates(params.sessionId);
          return {};
        },
        prompt: async (params: { sessionId: string }) => {
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'old ' },
            },
          });
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'usage_update',
              used: 42,
              size: 1_000,
            },
          });
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'session_info_update',
              title: 'A future ACP update',
            },
          });
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'plan',
              entries: [
                { content: 'Inspect code', priority: 'high', status: 'completed' },
                { content: 'Fix code', priority: 'medium', status: 'in_progress' },
              ],
            },
          });
          const permission = remote.requestPermission({
            sessionId: params.sessionId,
            toolCall: { toolCallId: 'approval-stable', title: 'Run command', kind: 'execute' },
            options: [{ optionId: 'allow-stable', name: 'Allow', kind: 'allow_once' }],
          });
          permissionIssued.resolve();
          await permission;
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'answer' },
            },
          });
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'plan',
              entries: [
                { content: 'Inspect code', priority: 'high', status: 'completed' },
                { content: 'Fix code', priority: 'medium', status: 'completed' },
              ],
            },
          });
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tool-stable',
              title: 'Read source',
              kind: 'read',
              status: 'in_progress',
              locations: [{ path: '/tmp/source.ts' }],
              rawInput: { path: '/tmp/source.ts' },
            },
          });
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tool-stable',
              status: 'completed',
              rawOutput: { text: 'source' },
            },
          });
          return { stopReason: 'end_turn', usage: ACP_V0_23_PROMPT_USAGE.usage };
        },
        cancel: async () => undefined,
      } as unknown as Agent;
    }),
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new KimiProtocolV2Adapter(service, '0.2.0', (method, params) => {
    notifications.push({ method, params });
  });
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '9.9.9' },
  }));
  const live = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 's-live',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    config: {},
  })) as { session: { streamId: string } };
  await adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 's-live',
    streamId: live.session.streamId,
    turnId: 't-live',
    input: [{ type: 'text', text: 'hello stable id' }],
    config: {},
  }));
  await permissionIssued.promise;
  await waitFor(
    () => notifications.some((item) => item.method === 'interaction.requested'),
    'interaction.requested was not emitted',
  );
  const requested = notifications.find((item) => item.method === 'interaction.requested');
  const interactionId = String((requested?.params.data as { interactionId?: string }).interactionId);
  await adapter.handle(v2Request('respond', 'interaction.respond', {
    sessionId: 's-live',
    streamId: live.session.streamId,
    turnId: 't-live',
    interactionId,
    responseId: 'response-stable',
    actionId: 'allow-stable',
    values: {},
  }));
  await waitFor(
    () => notifications.some((item) => item.method === 'turn.completed'),
    'live turn did not complete',
  );
  const liveStarted = notifications.find((item) => item.method === 'turn.started');
  const liveSourceTurnId = liveStarted?.params.sourceTurnId as string;
  assert.ok(liveSourceTurnId.startsWith('kimi-turn-'));
  const liveEvents = notifications.filter((item) => item.params.turnId === 't-live');
  assert.ok(liveEvents.some((item) => item.method === 'usage.updated'));
  assert.ok(liveEvents.some((item) => item.method === 'interaction.resolved'));
  assert.ok(
    liveEvents.some((item) => (
      item.method === 'activity.updated'
      && (item.params.data as { kind?: string }).kind === 'session_info_update'
    )),
    'the degraded live-only event was not emitted',
  );

  await adapter.handle(v2Request('4', 'session.close', {
    sessionId: 's-live',
    streamId: live.session.streamId,
  }));
  const attached = await adapter.handle(v2Request('5', 'session.create', {
    sessionId: 's-replay',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    nativeSession: { id: 'native-stable-turn', history: 'replay' },
    config: {},
  })) as { session: { streamId: string } };
  const replay = await adapter.handle(v2Request('6', 'session.replay', {
    sessionId: 's-replay',
    streamId: attached.session.streamId,
    cursor: null,
    limit: 100,
  })) as {
    events: Array<{
      method: string;
      eventId: string;
      sourceTurnId: string;
      data: Record<string, unknown>;
    }>;
  };
  const replayed = replay.events.find((event) => event.method === 'turn.started');
  assert.equal(
    replayed?.sourceTurnId,
    liveSourceTurnId,
    'the same native turn must keep its sourceTurnId across live and replay',
  );
  const liveIds = (method: string, predicate = (_data: Record<string, unknown>) => true) => (
    liveEvents
      .filter((event) => event.method === method && predicate(event.params.data as Record<string, unknown>))
      .map((event) => event.params.eventId as string)
  );
  const replayIds = (method: string, predicate = (_data: Record<string, unknown>) => true) => (
    replay.events
      .filter((event) => event.method === method && predicate(event.data))
      .map((event) => event.eventId)
  );
  const liveData = (method: string, predicate = (_data: Record<string, unknown>) => true) => (
    liveEvents
      .filter((event) => event.method === method && predicate(event.params.data as Record<string, unknown>))
      .map((event) => event.params.data)
  );
  const replayData = (method: string, predicate = (_data: Record<string, unknown>) => true) => (
    replay.events
      .filter((event) => event.method === method && predicate(event.data))
      .map((event) => event.data)
  );
  assert.deepEqual(replayIds('turn.started'), liveIds('turn.started'));
  assert.deepEqual(replayIds('content.delta'), liveIds('content.delta'));
  assert.deepEqual(replayIds('content.completed'), liveIds('content.completed'));
  assert.deepEqual(replayIds('plan.updated'), liveIds('plan.updated'));
  assert.equal(new Set(replayIds('plan.updated')).size, 2, 'each plan update needs its own eventId');
  const isStableTool = (data: Record<string, unknown>) => data.activityId === 'tool-stable';
  assert.deepEqual(replayIds('activity.updated', isStableTool), liveIds('activity.updated', isStableTool));
  assert.equal(
    new Set(replayIds('activity.updated', isStableTool)).size,
    2,
    'each activity update needs its own eventId',
  );
  assert.deepEqual(replayIds('turn.completed'), liveIds('turn.completed'));
  assert.deepEqual(replayData('content.delta'), liveData('content.delta'));
  assert.deepEqual(replayData('content.completed'), liveData('content.completed'));
  assert.deepEqual(replayData('activity.updated', isStableTool), liveData('activity.updated', isStableTool));
  assert.deepEqual(replayData('turn.completed'), liveData('turn.completed'));

  const livePlans = liveData('plan.updated');
  const replayPlans = replayData('plan.updated');
  assert.deepEqual(replayPlans, livePlans, 'plan data must match live and replay');
  assert.equal(
    (livePlans[0] as { planId?: string }).planId,
    `plan:${liveSourceTurnId}`,
  );
  await service.close();
});

test('auto-cancels a permission request that carries no options', async () => {
  let permissionResponse: unknown;
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory((remote) => ({
      initialize: async () => initializeResponse(),
      newSession: async () => ({ sessionId: 'native-empty-perm' }),
      prompt: async (params: { sessionId: string }) => {
        permissionResponse = await remote.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'tool-empty', title: 'Odd request', kind: 'other' },
          options: [],
        });
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
  const created = await service.createSession({ cwd: '/workspace/empty-perm' });
  await service.startTurn({
    sessionId: created.session.id,
    input: [{ type: 'text', text: 'go' }],
  });
  await waitFor(
    () => events.some((event) => event.method === 'turn.completed'),
    'turn did not complete',
  );
  assert.deepEqual(permissionResponse, { outcome: { outcome: 'cancelled' } });
  assert.ok(
    !events.some((event) => event.method === 'approval.requested'),
    'an unanswerable permission request must not block on the host',
  );
  await service.close();
});

test('Kimi gian.proxy/2 auto-cancels a permission request whose options have no usable IDs', async () => {
  let permissionResponse: unknown;
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const runtime = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: transportFactory((remote) => ({
      initialize: async () => initializeResponse(),
      newSession: async () => ({ sessionId: 'native-no-ids' }),
      prompt: async (params: { sessionId: string }) => {
        permissionResponse = await remote.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'tool-no-ids', title: 'Odd request', kind: 'other' },
          options: [{ optionId: '', name: 'Nameless option', kind: 'allow_once' }],
        });
        return { stopReason: 'end_turn' };
      },
      cancel: async () => undefined,
    } as unknown as Agent)),
  });
  const service = new KimiProxyService({ runtime });
  await service.initialize();
  const adapter = new KimiProtocolV2Adapter(service, '0.2.0', (method, params) => {
    notifications.push({ method, params });
    proxyNotificationSchema.parse({ jsonrpc: '2.0', method, params });
  });
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '9.9.9' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 's-no-ids',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    config: {},
  })) as { session: { streamId: string } };
  await adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 's-no-ids',
    streamId: created.session.streamId,
    turnId: 't-no-ids',
    input: [{ type: 'text', text: 'go' }],
    config: {},
  }));
  await waitFor(
    () => notifications.some((item) => item.method === 'turn.completed'),
    'turn must not hang on an unusable permission request',
  );

  assert.deepEqual(permissionResponse, { outcome: { outcome: 'cancelled' } });
  assert.ok(
    !notifications.some((item) => item.method === 'interaction.requested'),
    'an interaction without actions must not be emitted',
  );
  const notice = notifications.find((item) => (
    item.method === 'activity.updated'
    && (item.params.data as { kind?: string }).kind === 'permission_unusable'
  ));
  assert.ok(notice, 'the unusable permission request must surface as a diagnosable notice');
  assert.equal(
    (notice?.params.data as { presentation: { type: string } }).presentation.type,
    'notice',
  );
  await service.close();
});
