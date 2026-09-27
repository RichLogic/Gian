import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { GrokProxyService } from '../src/core/service.js';
import { GrokProtocolV2Adapter } from '../src/protocol/v2-adapter.js';
import type { GrokAcpClient } from '../src/runtime/grok-acp-client.js';

interface RecordedEvent {
  method: string;
  params: Record<string, unknown>;
}

function fakeRuntime(overrides: Record<string, unknown> = {}) {
  const runtime = new EventEmitter() as EventEmitter & GrokAcpClient & {
    calls: string[];
    nativeForkRequests: unknown[];
    nativeForkCounter: number;
  };
  runtime.calls = [];
  runtime.nativeForkRequests = [];
  runtime.nativeForkCounter = 0;
  Object.assign(runtime, {
    binaryPath: '/managed/grok',
    cwd: '/workspace',
    negotiated: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
      _meta: {
        grokShell: true,
        agentVersion: '1.0.41',
        modelState: {
          currentModelId: 'grok-4.6',
          availableModels: [{
            modelId: 'grok-4.6',
            name: 'Grok 4.6',
            _meta: {
              reasoningEffort: 'high',
              reasoningEfforts: [{ id: 'high', value: 'high', label: 'High', default: true }],
            },
          }],
        },
        availableCommands: [],
      },
    },
    extensions: {
      supports: (method: string) => method === 'x.ai/session/fork',
      unsupportedReason: (method: string) => `${method} unsupported in fake`,
    },
    async ensureStarted() {
      runtime.calls.push('initialize');
      return (runtime as unknown as { negotiated: unknown }).negotiated;
    },
    setPermissionHandler() {},
    setExtMethodHandler() {},
    async newSession() {
      runtime.calls.push('session/new');
      return { sessionId: 'native-1' };
    },
    async loadSession() {
      runtime.calls.push('session/load');
      return { sessionId: 'native-load' };
    },
    async resumeSession(params: { sessionId: string }) {
      runtime.calls.push('session/resume');
      return { sessionId: params.sessionId };
    },
    async listSessions() {
      runtime.calls.push('session/list');
      return { sessions: [{ sessionId: 'listed' }] };
    },
    async prompt() {
      runtime.calls.push('session/prompt');
      return { stopReason: 'end_turn', _meta: { inputTokens: 3, outputTokens: 2, totalTokens: 10 } };
    },
    async cancel() { runtime.calls.push('session/cancel'); },
    async closeSession() { runtime.calls.push('session/close'); },
    async nativeForkSession(params: unknown) {
      runtime.calls.push('x.ai/session/fork');
      runtime.nativeForkRequests.push(params);
      runtime.nativeForkCounter = (runtime.nativeForkCounter ?? 0) + 1;
      return {
        newSessionId: `native-forked-${runtime.nativeForkCounter}`,
        chatMessagesCopied: 2,
        updatesCopied: 3,
        planStateCopied: false,
        parentSessionId: 'native-1',
      };
    },
    async forkSession() {
      runtime.calls.push('session/fork');
      return { sessionId: 'native-standard-fork' };
    },
    async renameSession() { runtime.calls.push('x.ai/session/rename'); return { success: true }; },
    async deleteSession() { runtime.calls.push('x.ai/session/delete'); return { success: true }; },
    async stop() { runtime.calls.push('stop'); },
    async mcpList() { return { servers: [] }; },
    async skillsList() { return { skills: [] }; },
    async hooksList() { return { hooks: [] }; },
  }, overrides);
  return runtime;
}

function wire(service: GrokProxyService) {
  const events: RecordedEvent[] = [];
  const adapter = new GrokProtocolV2Adapter(service, '0.3.4-test', (method, params) => {
    events.push({ method, params: params as Record<string, unknown> });
  });
  const waitForTurnCompleted = async (timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (events.some((event) => event.method === 'turn.completed')) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for turn.completed; saw ${events.map((item) => item.method).join(',')}`);
  };
  return { adapter, events, waitForTurnCompleted };
}

async function attachSession(adapter: GrokProtocolV2Adapter, service: GrokProxyService) {
  await adapter.handle(v2Request('i1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.3'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const created = await adapter.handle(v2Request('s1', 'session.create', {
    sessionId: 'host-s1',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    config: {},
  })) as { session: { id: string; streamId: string } };
  void service;
  return created.session;
}

function v2Request(id: string, method: string, params: Record<string, unknown>) {
  return { id, method, params };
}

test('session.fork with a turn anchor sends the native targetPromptIndex', async () => {
  const runtime = fakeRuntime();
  const service = new GrokProxyService({ binaryPath: '/managed/grok', createRuntime: () => runtime });
  const { adapter, waitForTurnCompleted } = wire(service);
  const session = await attachSession(adapter, service);

  // One completed turn gives the attach generation a terminal boundary.
  await adapter.handle(v2Request('t1', 'turn.start', {
    sessionId: session.id,
    streamId: session.streamId,
    turnId: 'turn-A',
    input: [{ type: 'text', text: 'first' }],
  }));
  await waitForTurnCompleted();
  await adapter.handle(v2Request('t2', 'turn.start', {
    sessionId: session.id,
    streamId: session.streamId,
    turnId: 'turn-B',
    input: [{ type: 'text', text: 'second' }],
  }));
  await waitForTurnCompleted();

  const forked = await adapter.handle(v2Request('f1', 'session.fork', {
    sourceSessionId: session.id,
    sourceStreamId: session.streamId,
    sessionId: 'host-fork',
    anchor: { type: 'turn', turnId: 'turn-A' },
  })) as { origin: { turnId: string }; session: { id: string } };
  assert.equal(forked.origin.turnId, 'turn-A');
  assert.equal(forked.session.id, 'host-fork');
  const nativeRequest = runtime.nativeForkRequests.at(-1) as Record<string, unknown>;
  assert.equal(nativeRequest.targetPromptIndex, 0);

  const headFork = await adapter.handle(v2Request('f2', 'session.fork', {
    sourceSessionId: session.id,
    sourceStreamId: session.streamId,
    sessionId: 'host-fork-head',
    anchor: { type: 'head' },
  })) as { origin: { turnId: string } };
  assert.equal(headFork.origin.turnId, 'turn-B');
  const headRequest = runtime.nativeForkRequests.at(-1) as Record<string, unknown>;
  assert.equal(headRequest.targetPromptIndex, undefined);
  await service.close();
});

test('session.fork rejects anchors outside this attach generation honestly', async () => {
  const runtime = fakeRuntime();
  const service = new GrokProxyService({ binaryPath: '/managed/grok', createRuntime: () => runtime });
  const { adapter, waitForTurnCompleted } = wire(service);
  const session = await attachSession(adapter, service);
  await adapter.handle(v2Request('t1', 'turn.start', {
    sessionId: session.id,
    streamId: session.streamId,
    turnId: 'turn-A',
    input: [{ type: 'text', text: 'first' }],
  }));
  await waitForTurnCompleted();
  await assert.rejects(
    adapter.handle(v2Request('f1', 'session.fork', {
      sourceSessionId: session.id,
      sourceStreamId: session.streamId,
      sessionId: 'host-fork-bad',
      anchor: { type: 'turn', turnId: 'turn-from-imported-history' },
    })),
    (error: unknown) => (error as { domainCode?: string }).domainCode === 'FORK_BOUNDARY_UNAVAILABLE'
      && /imported history cannot be mapped/.test((error as Error).message),
  );
  await service.close();
});

test('session.fork on a busy source session reports SESSION_BUSY before any fork', async () => {
  const runtime = fakeRuntime({
    async prompt() {
      // Never resolves: the turn stays active.
      return await new Promise<{ stopReason: string }>(() => undefined);
    },
  });
  const service = new GrokProxyService({ binaryPath: '/managed/grok', createRuntime: () => runtime });
  const { adapter } = wire(service);
  const session = await attachSession(adapter, service);
  void adapter.handle(v2Request('t1', 'turn.start', {
    sessionId: session.id,
    streamId: session.streamId,
    turnId: 'turn-A',
    input: [{ type: 'text', text: 'long-running' }],
  })).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(
    adapter.handle(v2Request('f1', 'session.fork', {
      sourceSessionId: session.id,
      sourceStreamId: session.streamId,
      sessionId: 'host-fork-busy',
      anchor: { type: 'head' },
    })),
    (error: unknown) => (error as { domainCode?: string }).domainCode === 'SESSION_BUSY',
  );
  const forkCalls = runtime.calls.filter((call) => call === 'x.ai/session/fork');
  assert.equal(forkCalls.length, 0);
  await service.close();
});

test('session.rename rejects names beyond the native 100-scalar limit', async () => {
  const runtime = fakeRuntime();
  const service = new GrokProxyService({ binaryPath: '/managed/grok', createRuntime: () => runtime });
  const { adapter } = wire(service);
  const session = await attachSession(adapter, service);
  await assert.rejects(
    adapter.handle(v2Request('r1', 'session.rename', {
      sessionId: session.id,
      streamId: session.streamId,
      name: 'x'.repeat(101),
    })),
    (error: unknown) => (error as { code?: number }).code === -32602,
  );
  await adapter.handle(v2Request('r2', 'session.rename', {
    sessionId: session.id,
    streamId: session.streamId,
    name: 'fits',
  }));
  assert.ok(runtime.calls.includes('x.ai/session/rename'));
  await service.close();
});

test('catalog.resolve resolves thinking and defaults from model metadata without calling the model', async () => {
  const runtime = fakeRuntime();
  const service = new GrokProxyService({ binaryPath: '/managed/grok', createRuntime: () => runtime });
  const { adapter } = wire(service);
  const session = await attachSession(adapter, service);
  const promptCallsBefore = runtime.calls.filter((call) => call === 'session/prompt').length;
  const resolved = await adapter.handle(v2Request('c1', 'catalog.resolve', {
    catalogRevision: 'rev-1',
    sessionId: session.id,
    streamId: session.streamId,
    sessionConfig: { model: 'grok-4.6' },
  })) as {
    specialCatalogs: Record<string, string>;
    configOptions: Array<{ id: string; defaultValue: unknown; choices?: unknown[] }>;
    resolvedDefaults: { sessionConfig: Record<string, unknown> };
  };
  assert.equal(resolved.specialCatalogs.model, 'model');
  assert.equal(resolved.specialCatalogs.thinking, 'reasoning_effort');
  assert.equal(resolved.specialCatalogs.approvalMode, 'permission_mode');
  const thinking = resolved.configOptions.find((option) => option.id === 'reasoning_effort');
  assert.equal(thinking?.defaultValue, 'high');
  assert.equal(resolved.resolvedDefaults.sessionConfig.model, 'grok-4.6');
  assert.equal(
    runtime.calls.filter((call) => call === 'session/prompt').length,
    promptCallsBefore,
  );
  await assert.rejects(
    adapter.handle(v2Request('c2', 'catalog.resolve', {
      sessionId: session.id,
      streamId: session.streamId,
    })),
    (error: unknown) => (error as { code?: number }).code === -32602,
  );
  await service.close();
});
