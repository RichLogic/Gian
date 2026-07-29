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

import { KimiProxyService } from '../src/core/service.js';
import {
  KimiAcpClient,
  type KimiAcpExit,
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
            await remote.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Context: 86,397 / ' },
              },
            });
            await remote.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: '1,048,576 (8.2%)' },
              },
            });
            return { stopReason: 'end_turn' };
          }
          if (text === '/compact') {
            await remote.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'usage_update',
                used: 999_999,
                size: 1_048_576,
              },
            });
          }
          await remote.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: text === '/compact' ? 'Compacted.' : 'Normal answer.' },
            },
          });
          return {
            stopReason: 'end_turn',
            usage: {
              inputTokens: 1_100_000,
              outputTokens: 14_000,
              cachedReadTokens: 900_000,
              cachedWriteTokens: 10_000,
              totalTokens: 1_114_000,
            },
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

  const compactStart = events.length;
  await service.startTurn({
    sessionId: created.session.id,
    input: [{ type: 'text', text: '/compact' }],
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
