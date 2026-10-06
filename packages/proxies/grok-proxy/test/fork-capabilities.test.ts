import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { resultSchemas } from '@gian/proxy-protocol';

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
    async notifyPermissionMode() { runtime.calls.push('x.ai/yolo_mode_changed'); },
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
  const resolved = resultSchemas['catalog.resolve'].parse(await adapter.handle(v2Request('c1', 'catalog.resolve', {
    catalogRevision: 'rev-1',
    sessionId: session.id,
    streamId: session.streamId,
    sessionConfig: {},
    turnConfig: { model: 'grok-4.6' },
  })));
  assert.equal(resolved.specialCatalogs?.model, 'model');
  assert.equal(resolved.specialCatalogs?.thinking, 'reasoning_effort');
  assert.equal(resolved.specialCatalogs?.approvalMode, 'permission_mode');
  const thinking = resolved.configOptions.find((option) => option.id === 'reasoning_effort');
  assert.equal(thinking?.defaultValue, 'high');
  assert.equal(thinking?.binding, 'turn');
  assert.equal(resolved.resolvedDefaults.turnConfig.model, 'grok-4.6');
  assert.equal(resolved.resolvedDefaults.turnConfig.reasoning_effort, 'high');
  assert.equal(resolved.resolvedDefaults.turnConfig.permission_mode, 'default');
  assert.equal(resolved.resolvedDefaults.sessionConfig.permission_mode, undefined);
  assert.equal(resolved.resolvedDefaults.sessionConfig.sandbox_profile, 'workspace');
  assert.equal(resolved.resolvedDefaults.sessionConfig.model, undefined);
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

test('catalog offers fork while native fork is attemptable and drops it once refuted', async () => {
  let forkState: 'attemptable' | 'refuted' = 'attemptable';
  const runtime = fakeRuntime({
    extensions: {
      supports: () => false,
      mayAttempt: (method: string) => forkState === 'attemptable' && method === 'x.ai/session/fork',
      unsupportedReason: (method: string) => `${method} unsupported in fake`,
    },
  });
  const service = new GrokProxyService({ binaryPath: '/managed/grok', createRuntime: () => runtime });
  const { adapter } = wire(service);
  await attachSession(adapter, service);

  const catalogActions = async () => {
    const catalog = await adapter.handle(v2Request(`c-${forkState}`, 'catalog.list', {})) as {
      actions: Array<{ id: string; supported: boolean; reason?: string }>;
    };
    return new Map(catalog.actions.map((action) => [action.id, action]));
  };

  // Unconfirmed but attemptable: the first user-requested head fork doubles
  // as the confirming call, so the action must be offered — the Host would
  // otherwise intercept it and fork could never confirm itself.
  let actions = await catalogActions();
  assert.equal(actions.get('session.fork')?.supported, true);
  assert.equal(actions.get('sidechat.create')?.supported, true);
  // Exact-turn forks stay confirmation-gated: they need a proven boundary.
  assert.equal(actions.get('session.fork.atTurn')?.supported, false);

  forkState = 'refuted';
  actions = await catalogActions();
  assert.equal(actions.get('session.fork')?.supported, false);
  assert.ok(actions.get('session.fork')?.reason);
  assert.equal(actions.get('sidechat.create')?.supported, false);
  await service.close();
});

test('session-scoped catalog.resolve defaults to the session model, not the process default', async () => {
  const twoModels = {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, close: {} },
    },
    _meta: {
      grokShell: true,
      agentVersion: '1.0.41',
      modelState: {
        currentModelId: 'grok-a',
        availableModels: [
          {
            modelId: 'grok-a',
            name: 'Grok A',
            _meta: { reasoningEfforts: [{ id: 'lo', value: 'lo', label: 'Lo', default: true }] },
          },
          {
            modelId: 'grok-b',
            name: 'Grok B',
            _meta: { reasoningEfforts: [{ id: 'max', value: 'max', label: 'Max', default: true }] },
          },
        ],
      },
      availableCommands: [],
    },
  };
  const runtime = fakeRuntime({
    negotiated: twoModels,
    async ensureStarted() {
      runtime.calls.push('initialize');
      return twoModels;
    },
    async setSessionModel() {
      runtime.calls.push('session/set_model');
      return {};
    },
  });
  const service = new GrokProxyService({ binaryPath: '/managed/grok', createRuntime: () => runtime });
  const { adapter, events } = wire(service);
  const session = await attachSession(adapter, service);

  // The session picks model B through a turn-bound config.
  await adapter.handle(v2Request('t1', 'turn.start', {
    sessionId: session.id,
    streamId: session.streamId,
    turnId: 'turn-model-b',
    input: [{ type: 'text', text: 'hi' }],
    config: { model: 'grok-b' },
  }));
  await waitForTerminalTurn(events, 'turn-model-b');

  // A session-scoped resolve without an explicit model follows the session.
  const resolved = resultSchemas['catalog.resolve'].parse(await adapter.handle(v2Request('c1', 'catalog.resolve', {
    catalogRevision: 'rev-1',
    sessionId: session.id,
    streamId: session.streamId,
    sessionConfig: {},
    turnConfig: {},
  })));
  assert.equal(resolved.resolvedDefaults.turnConfig.model, 'grok-b');
  assert.equal(resolved.resolvedDefaults.turnConfig.reasoning_effort, 'max');
  await service.close();
});

async function waitForTerminalTurn(events: RecordedEvent[], turnId: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const terminal = events.find((event) => (
      (event.method === 'turn.completed' || event.method === 'turn.failed')
      && event.params.turnId === turnId
    ));
    if (terminal) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${turnId} to terminate; saw ${events.map((item) => item.method).join(',')}`);
}

test('a turn after imported history forks at its absolute native prompt index', async () => {
  const runtime = fakeRuntime({
    async loadSession() {
      runtime.calls.push('session/load');
      // Two historical prompts replay as user/agent update pairs.
      for (const text of ['history one', 'history two']) {
        runtime.emit('sessionUpdate', {
          sessionId: 'native-load',
          update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } },
        });
        runtime.emit('sessionUpdate', {
          sessionId: 'native-load',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
        });
      }
      return { sessionId: 'native-load' };
    },
  });
  const service = new GrokProxyService({ binaryPath: '/managed/grok', createRuntime: () => runtime });
  const { adapter, events } = wire(service);
  await adapter.handle(v2Request('i1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.3'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const created = await adapter.handle(v2Request('s1', 'session.create', {
    sessionId: 'host-loaded',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    nativeSession: { id: 'native-load', history: 'replay' },
    config: {},
  })) as { session: { id: string; streamId: string } };

  await adapter.handle(v2Request('t1', 'turn.start', {
    sessionId: created.session.id,
    streamId: created.session.streamId,
    turnId: 'turn-new',
    input: [{ type: 'text', text: 'fresh question' }],
  }));
  await waitForTerminalTurn(events, 'turn-new');

  // R4: the new turn is the THIRD native prompt; an attach-local index of 0
  // would fork at the wrong boundary.
  await adapter.handle(v2Request('f1', 'session.fork', {
    sourceSessionId: created.session.id,
    sourceStreamId: created.session.streamId,
    sessionId: 'host-fork-abs',
    anchor: { type: 'turn', turnId: 'turn-new' },
  }));
  const nativeRequest = runtime.nativeForkRequests.at(-1) as Record<string, unknown>;
  assert.equal(nativeRequest.targetPromptIndex, 2);
  await service.close();
});

test('a history:none resume cannot prove positions and refuses exact-turn forks', async () => {
  const runtime = fakeRuntime();
  const service = new GrokProxyService({ binaryPath: '/managed/grok', createRuntime: () => runtime });
  const { adapter, events } = wire(service);
  await adapter.handle(v2Request('i1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.3'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const created = await adapter.handle(v2Request('s1', 'session.create', {
    sessionId: 'host-resumed',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    nativeSession: { id: 'native-load', history: 'none' },
    config: {},
  })) as { session: { id: string; streamId: string } };
  await adapter.handle(v2Request('t1', 'turn.start', {
    sessionId: created.session.id,
    streamId: created.session.streamId,
    turnId: 'turn-after-resume',
    input: [{ type: 'text', text: 'hello' }],
  }));
  await waitForTerminalTurn(events, 'turn-after-resume');
  await assert.rejects(
    adapter.handle(v2Request('f1', 'session.fork', {
      sourceSessionId: created.session.id,
      sourceStreamId: created.session.streamId,
      sessionId: 'host-fork-unproven',
      anchor: { type: 'turn', turnId: 'turn-after-resume' },
    })),
    (error: unknown) => (error as { domainCode?: string }).domainCode === 'FORK_BOUNDARY_UNAVAILABLE'
      && /no proven native prompt position/.test((error as Error).message),
  );
  // The fork never reached the runtime.
  assert.equal(runtime.nativeForkRequests.length, 0);
  await service.close();
});

test('a locally failed turn never consumes a native prompt index', async () => {
  const runtime = fakeRuntime();
  const service = new GrokProxyService({ binaryPath: '/managed/grok', createRuntime: () => runtime });
  const { adapter, events } = wire(service);
  const session = await attachSession(adapter, service);

  // A missing image fails before the native prompt is dispatched: turn.start
  // rejects and the failure must not mint a prompt slot.
  await assert.rejects(
    adapter.handle(v2Request('t0', 'turn.start', {
      sessionId: session.id,
      streamId: session.streamId,
      turnId: 'turn-bad-image',
      input: [{ type: 'localImage', path: '/workspace/does-not-exist.png' }],
    })),
    (error: unknown) => (error as { domainCode?: string }).domainCode === 'RUNTIME_ERROR'
      && /Could not read local image/.test((error as Error).message),
  );
  assert.equal(runtime.calls.filter((call) => call === 'session/prompt').length, 0);

  await adapter.handle(v2Request('t1', 'turn.start', {
    sessionId: session.id,
    streamId: session.streamId,
    turnId: 'turn-good',
    input: [{ type: 'text', text: 'hello' }],
  }));
  await waitForTerminalTurn(events, 'turn-good');

  // The successful turn is provably native prompt 0 — not 1.
  await adapter.handle(v2Request('f1', 'session.fork', {
    sourceSessionId: session.id,
    sourceStreamId: session.streamId,
    sessionId: 'host-fork-after-failure',
    anchor: { type: 'turn', turnId: 'turn-good' },
  }));
  const nativeRequest = runtime.nativeForkRequests.at(-1) as Record<string, unknown>;
  assert.equal(nativeRequest.targetPromptIndex, 0);
  await service.close();
});

test('a replay with merged user runs cannot prove ordinals and refuses exact-turn forks', async () => {
  const runtime = fakeRuntime({
    async loadSession() {
      runtime.calls.push('session/load');
      // A cancelled prompt with no assistant output, immediately followed by
      // the next prompt: two native prompts replay as one merged group, so
      // the group count cannot seed absolute ordinals.
      runtime.emit('sessionUpdate', {
        sessionId: 'native-load',
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'cancelled prompt' } },
      });
      runtime.emit('sessionUpdate', {
        sessionId: 'native-load',
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'next prompt' } },
      });
      runtime.emit('sessionUpdate', {
        sessionId: 'native-load',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
      });
      return { sessionId: 'native-load' };
    },
  });
  const service = new GrokProxyService({ binaryPath: '/managed/grok', createRuntime: () => runtime });
  const { adapter, events } = wire(service);
  await adapter.handle(v2Request('i1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.3'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const created = await adapter.handle(v2Request('s1', 'session.create', {
    sessionId: 'host-merged',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    nativeSession: { id: 'native-load', history: 'replay' },
    config: {},
  })) as { session: { id: string; streamId: string } };

  await adapter.handle(v2Request('t1', 'turn.start', {
    sessionId: created.session.id,
    streamId: created.session.streamId,
    turnId: 'turn-after-merge',
    input: [{ type: 'text', text: 'fresh question' }],
  }));
  await waitForTerminalTurn(events, 'turn-after-merge');

  // Head forks stay available; only the exact-turn boundary is unproven.
  await adapter.handle(v2Request('f1', 'session.fork', {
    sourceSessionId: created.session.id,
    sourceStreamId: created.session.streamId,
    sessionId: 'host-fork-head-ok',
    anchor: { type: 'head' },
  }));
  assert.equal(runtime.nativeForkRequests.length, 1);

  await assert.rejects(
    adapter.handle(v2Request('f2', 'session.fork', {
      sourceSessionId: created.session.id,
      sourceStreamId: created.session.streamId,
      sessionId: 'host-fork-merged',
      anchor: { type: 'turn', turnId: 'turn-after-merge' },
    })),
    (error: unknown) => (error as { domainCode?: string }).domainCode === 'FORK_BOUNDARY_UNAVAILABLE'
      && /no proven native prompt position/.test((error as Error).message),
  );
  assert.equal(runtime.nativeForkRequests.length, 1);
  await service.close();
});

test('a fork child with inherited history continues the absolute index when forked again', async () => {
  const runtime = fakeRuntime();
  const service = new GrokProxyService({ binaryPath: '/managed/grok', createRuntime: () => runtime });
  const { adapter, events } = wire(service);
  const parent = await attachSession(adapter, service);
  for (const [index, text] of [['a', 'one'], ['b', 'two']] as const) {
    await adapter.handle(v2Request(`t-${index}`, 'turn.start', {
      sessionId: parent.id,
      streamId: parent.streamId,
      turnId: `turn-${index}`,
      input: [{ type: 'text', text }],
    }));
    await waitForTerminalTurn(events, `turn-${index}`);
  }
  // Head fork: the child provably starts past the parent's two prompts.
  const forked = await adapter.handle(v2Request('f1', 'session.fork', {
    sourceSessionId: parent.id,
    sourceStreamId: parent.streamId,
    sessionId: 'host-child',
    anchor: { type: 'head' },
  })) as { session: { id: string; streamId: string } };
  // The child's replay ends at the parent's head; no phantom turns.
  const childReplay = await adapter.handle(v2Request('r1', 'session.replay', {
    sessionId: forked.session.id,
    streamId: forked.session.streamId,
    cursor: null,
    limit: 100,
  })) as { events: Array<{ method: string; sourceTurnId: string }> };
  assert.ok(childReplay.events.length > 0);
  assert.ok(childReplay.events.every((event) => ['turn-a', 'turn-b'].includes(event.sourceTurnId)));

  await adapter.handle(v2Request('t-c', 'turn.start', {
    sessionId: forked.session.id,
    streamId: forked.session.streamId,
    turnId: 'turn-child',
    input: [{ type: 'text', text: 'child question' }],
  }));
  await waitForTerminalTurn(events, 'turn-child');

  await adapter.handle(v2Request('f2', 'session.fork', {
    sourceSessionId: forked.session.id,
    sourceStreamId: forked.session.streamId,
    sessionId: 'host-grandchild',
    anchor: { type: 'turn', turnId: 'turn-child' },
  }));
  const nativeRequest = runtime.nativeForkRequests.at(-1) as Record<string, unknown>;
  // Two inherited prompts plus the child's own turn -> index 2.
  assert.equal(nativeRequest.targetPromptIndex, 2);
  await service.close();
});


test('live sparse tool updates and turn-end closure retain native activity identity', async (t) => {
  const runtime = fakeRuntime();
  Object.assign(runtime, {
    async prompt() {
      const send = (update: Record<string, unknown>) => runtime.emit('sessionUpdate', {
        sessionId: 'native-1', update,
      });
      send({ sessionUpdate: 'tool_call', toolCallId: 'exec-1', title: 'Execute synthetic task', kind: 'execute' });
      send({ sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', status: 'completed' });
      send({ sessionUpdate: 'tool_call', toolCallId: 'open-1', title: 'Read synthetic note', kind: 'read' });
      send({ sessionUpdate: 'subagent_spawned', subagentId: 'child-1', description: 'Inspect synthetic fixture' });
      return { stopReason: 'end_turn' };
    },
  });
  const service = new GrokProxyService({ binaryPath: '/managed/grok', createRuntime: () => runtime });
  t.after(() => service.close());
  const { adapter, events, waitForTurnCompleted } = wire(service);
  const session = await attachSession(adapter, service);
  await adapter.handle(v2Request('t-identity', 'turn.start', {
    sessionId: session.id, streamId: session.streamId, turnId: 'turn-identity',
    input: [{ type: 'text', text: 'synthetic' }],
  }));
  await waitForTurnCompleted();
  const activities = events.filter(event => event.method === 'activity.updated')
    .map(event => event.params.data as Record<string, unknown>);
  const exec = activities.filter(data => data.activityId === 'exec-1');
  assert.equal(exec.length, 2);
  assert.ok(exec.every(data => data.title === 'Execute synthetic task'));
  assert.deepEqual(exec[1]?.presentation, { type: 'tool', data: { name: 'execute' } });
  const read = activities.filter(data => data.activityId === 'open-1').at(-1);
  assert.equal(read?.status, 'succeeded');
  assert.equal(read?.title, 'Read synthetic note');
  assert.deepEqual(read?.presentation, { type: 'tool', data: { name: 'read' } });
  const child = activities.filter(data => data.activityId === 'grok-subagent-child-1').at(-1);
  assert.equal(child?.kind, 'agent');
  assert.equal(child?.title, 'Inspect synthetic fixture');
  assert.equal((child?.presentation as { type: string }).type, 'agent');
});
