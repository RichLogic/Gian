import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { catalogResultSchema, proxyNotificationSchema, sessionSchema } from '@gian/proxy-protocol';
import { CcProxyService } from '../src/core/service.js';
import { ClaudeProtocolError, jsonRpcError, parseRequestLine } from '../src/transport/protocol.js';
import { ClaudeProtocolV2Adapter, type WireRequest } from '../src/protocol/v2-adapter.js';
import type { ModelCapabilities } from '../src/core/types.js';
import type { ClaudeRuntime, ClaudeRuntimeEvents } from '../src/runtime/types.js';

class FakeRuntime extends EventEmitter<ClaudeRuntimeEvents> implements ClaudeRuntime {
  readonly messages: Array<{
    sessionId: string;
    content: string;
    model: string | null;
    permissionMode?: string | null;
    effort?: string | null;
    displayName?: string | null;
  }> = [];
  readonly permissionResponses: Array<{
    requestId: string;
    behavior: 'allow' | 'deny';
    answers?: Record<string, string | string[]>;
  }> = [];
  readonly spawns: Array<Parameters<ClaudeRuntime['spawnSession']>[0]> = [];
  readonly modelUpdates: Array<{ sessionId: string; model: string | null }> = [];
  failInterrupt = false;
  private readonly alive = new Set<string>();
  private readonly modelBySession = new Map<string, string | null>();

  constructor(
    private readonly models: ModelCapabilities[] = [{
      id: 'claude-default',
      model: '',
      displayName: 'Default',
      description: '',
      hidden: false,
      isDefault: true,
      defaultEffort: null,
      supportedEfforts: ['low', 'medium', 'high'],
    }],
    private readonly permissionModes: string[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
  ) {
    super();
  }

  async start(): Promise<number> { return 0; }
  async spawnSession(options: Parameters<ClaudeRuntime['spawnSession']>[0]): Promise<void> {
    this.spawns.push(options);
    this.alive.add(options.sessionId);
    this.modelBySession.set(options.sessionId, options.model ?? null);
  }
  setSessionModel(sessionId: string, model: string | null): void {
    this.modelUpdates.push({ sessionId, model });
    this.modelBySession.set(sessionId, model);
  }
  async sendMessage(
    sessionId: string,
    content: string,
    options?: Parameters<ClaudeRuntime['sendMessage']>[2],
  ): Promise<void> {
    this.messages.push({
      sessionId,
      content,
      model: this.modelBySession.get(sessionId) ?? null,
      ...(options?.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
      ...(options?.effort !== undefined ? { effort: options.effort } : {}),
      ...(options?.displayName !== undefined ? { displayName: options.displayName } : {}),
    });
  }
  resetClaudeSessionId(): void {}
  async respondPermission(
    _sessionId: string,
    requestId: string,
    behavior: 'allow' | 'deny',
    extra?: { updatedInput?: Record<string, unknown>; message?: string },
  ): Promise<void> {
    this.permissionResponses.push({
      requestId,
      behavior,
      ...(extra?.message ? { answers: { message: extra.message } } : {}),
    });
  }
  killSession(sessionId: string): void {
    if (this.failInterrupt) throw new Error('fake interrupt failed');
    this.alive.delete(sessionId);
  }
  isSessionAlive(sessionId: string): boolean { return this.alive.has(sessionId); }
  getDetectedModelId(): string | null { return null; }
  async stop(): Promise<void> { this.alive.clear(); }
  getModels(): ModelCapabilities[] { return this.models; }
  getPermissionModes(): string[] { return this.permissionModes; }
  async awaitModelDiscovery(): Promise<void> {}
}

function request(id: string, method: string, params: Record<string, unknown> = {}): WireRequest {
  return { id, method, params };
}

type Emitted = { method: string; params: Record<string, unknown> };

async function setup(permissionModes?: string[]) {
  const runtime = new FakeRuntime([
    {
      id: 'claude-default',
      model: '',
      displayName: 'Default',
      description: 'Uses configured default.',
      hidden: false,
      isDefault: true,
      defaultEffort: 'medium',
      supportedEfforts: ['low', 'medium', 'high'],
    },
    {
      id: 'claude-alias-opus',
      model: 'opus',
      displayName: 'Opus',
      description: '',
      hidden: false,
      isDefault: false,
      defaultEffort: 'high',
      supportedEfforts: ['low', 'high', 'max'],
    },
  ], permissionModes);
  const service = new CcProxyService({ runtime });
  await service.initialize();
  const notifications: Emitted[] = [];
  const adapter = new ClaudeProtocolV2Adapter(service, '0.2.0', (method, params) => {
    notifications.push({ method, params });
  });
  await adapter.handle(request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'test', version: '9.9.9' },
  }));
  const created = await adapter.handle(request('2', 'session.create', {
    sessionId: 'host-session',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    config: {},
  })) as { session: { streamId: string; nativeSession: { id: string }; state: string; sessionConfig: Record<string, unknown> } };
  assert.doesNotThrow(() => sessionSchema.parse(created.session));
  // Let optional async catalog.changed/slash discovery settle before tests
  // start asserting notification ordering.
  await new Promise((resolve) => setImmediate(resolve));
  notifications.length = 0;
  return { runtime, service, adapter, notifications, streamId: created.session.streamId };
}

test('Claude gian.proxy/2 initializes once and exposes catalog.resolve capability', async () => {
  const { service, adapter } = await setup();
  try {
    const initialized = await adapter.handle(request('9', 'initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'test', version: '9.9.9' },
    })).catch((error: unknown) => error);
    assert.ok(initialized instanceof ClaudeProtocolError);
    assert.equal((initialized as ClaudeProtocolError).domainCode, 'ALREADY_INITIALIZED');

    const catalog = await adapter.handle(request('3', 'catalog.list', {})) as {
      catalogRevision: string;
      configOptions: Array<{ id: string; choices?: Array<{ value: unknown }> }>;
    };
    assert.doesNotThrow(() => catalogResultSchema.parse(catalog));
    assert.ok(catalog.catalogRevision.length > 0);
    const permission = catalog.configOptions.find((option) => option.id === 'permission_mode');
    assert.ok(permission);
    // The configured Runtime still reports plan, but this Proxy build does
    // not support plan mode (ExitPlanMode would require a Proxy-initiated
    // mode change that gian.proxy/2.0 cannot express).
    assert.deepEqual(permission.choices?.map((choice) => choice.value), [
      'default',
      'acceptEdits',
      'bypassPermissions',
    ]);
  } finally {
    await service.close();
  }
});

test('Claude catalog falls back to current safe native permission modes', async () => {
  const { service, adapter } = await setup([]);
  try {
    const catalog = await adapter.handle(request('fallback-catalog', 'catalog.list', {})) as {
      configOptions: Array<{
        id: string;
        defaultValue: unknown;
        choices?: Array<{ value: unknown }>;
      }>;
    };
    const permission = catalog.configOptions.find((option) => option.id === 'permission_mode');
    assert.equal(permission?.defaultValue, 'manual');
    assert.deepEqual(permission?.choices?.map((choice) => choice.value), [
      'manual',
      'acceptEdits',
      'bypassPermissions',
    ]);
  } finally {
    await service.close();
  }
});

test('Claude gian.proxy/2 rejects turn-bound session config and idempotently creates sessions', async () => {
  const { service, adapter } = await setup();
  try {
    await assert.rejects(
      adapter.handle(request('3', 'session.create', {
        sessionId: 'bound-session',
        workspace: { cwd: '/tmp', roots: ['/tmp'] },
        config: { model: 'claude-default' },
      })),
      (error: unknown) => error instanceof ClaudeProtocolError
        && error.domainCode === 'CONFIG_BINDING_INVALID',
    );

    const params = {
      sessionId: 'same-session',
      workspace: { cwd: '/tmp', roots: ['/tmp'] },
      config: {},
    };
    const first = await adapter.handle(request('4', 'session.create', params)) as { session: { streamId: string } };
    const second = await adapter.handle(request('5', 'session.create', params)) as { session: { streamId: string } };
    assert.equal(second.session.streamId, first.session.streamId);

    await assert.rejects(
      adapter.handle(request('6', 'session.create', {
        ...params,
        workspace: { cwd: '/tmp', roots: ['/other'] },
      })),
      (error: unknown) => error instanceof ClaudeProtocolError && error.domainCode === 'CONFLICT',
    );
  } finally {
    await service.close();
  }
});

test('Claude gian.proxy/2 keeps Host ids, stable provider sourceTurnId, and response-before-notification', async () => {
  const { runtime, service, adapter, notifications, streamId } = await setup();
  try {
    await adapter.handle(request('3', 'session.rename', {
      sessionId: 'host-session',
      streamId,
      name: 'Host-owned name',
    }));
    const params = {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
      input: [{ type: 'text', text: 'hello' }],
      config: {},
    };
    const beforeHandle = notifications.length;
    await adapter.handle(request('4', 'turn.start', params));
    // turn.started is produced inside handle() and must stay queued until the
    // CLI writes the turn.start Response.
    assert.equal(notifications.length, beforeHandle);
    adapter.flushDeferredNotifications();
    const started = notifications.find((item) => item.method === 'turn.started');
    assert.equal(started?.params.turnId, 'host-turn');
    assert.ok(typeof started?.params.sourceTurnId === 'string');
    assert.notEqual(started?.params.sourceTurnId, 'host-turn');

    await adapter.handle(request('5', 'turn.start', params));
    assert.equal(runtime.messages.length, 1, 'duplicate turn.start is idempotent');
    await assert.rejects(
      adapter.handle(request('6', 'turn.start', {
        ...params,
        input: [{ type: 'text', text: 'different' }],
      })),
      (error: unknown) => error instanceof ClaudeProtocolError && error.domainCode === 'CONFLICT',
    );
    await assert.rejects(
      adapter.handle(request('7', 'turn.start', {
        ...params,
        turnId: 'host-turn-2',
      })),
      (error: unknown) => error instanceof ClaudeProtocolError && error.domainCode === 'SESSION_BUSY',
    );
    await adapter.handle(request('8', 'turn.interrupt', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
    }));
    adapter.flushDeferredNotifications();
    const terminal = notifications.filter((item) => item.method === 'turn.completed').at(-1);
    assert.equal((terminal?.params.data as { stopReason: string }).stopReason, 'interrupted');
    assert.equal(terminal?.params.turnId, 'host-turn');
  } finally {
    await service.close();
  }
});

test('Claude gian.proxy/2 separates reasoning and text that share a native item id', async () => {
  const { runtime, service, adapter, notifications, streamId } = await setup();
  try {
    await adapter.handle(request('3', 'turn.start', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-shared-item-turn',
      input: [{ type: 'text', text: 'think and answer' }],
      config: {},
    }));
    const serviceSessionId = runtime.messages[0]!.sessionId;
    runtime.emit('assistantReasoning', serviceSessionId, 'thinking', 'native-item-1');
    runtime.emit('assistantText', serviceSessionId, 'answer', 'native-item-1');
    runtime.emit('channelReply', serviceSessionId, '');
    adapter.flushDeferredNotifications();

    const deltas = notifications.filter(item => item.method === 'content.delta');
    assert.deepEqual(
      deltas.map(item => (item.params.data as { contentId: string }).contentId),
      ['reasoning:native-item-1', 'text:native-item-1'],
    );
  } finally {
    await service.close();
  }
});

test('Claude gian.proxy/2 emits compact turn.started before its turn-scoped usage reset', async () => {
  const { service, adapter, notifications, streamId } = await setup();
  try {
    await adapter.handle(request('3', 'turn.start', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-compact-turn',
      input: [{ type: 'text', text: '/compact' }],
      config: {},
    }));
    adapter.flushDeferredNotifications();

    assert.deepEqual(
      notifications.map(item => item.method),
      ['turn.started', 'usage.updated'],
    );
    for (const item of notifications) {
      proxyNotificationSchema.parse({ jsonrpc: '2.0', method: item.method, params: item.params });
    }
  } finally {
    await service.close();
  }
});

test('Claude gian.proxy/2 lazily resolves model ids and applies turn-bound effort', async () => {
  const { runtime, service, adapter } = await setup();
  try {
    const created = await adapter.handle(request('2', 'session.create', {
      sessionId: 'model-session',
      workspace: { cwd: '/tmp', roots: ['/tmp'] },
      config: {},
    })) as { session: { streamId: string; sessionConfig: Record<string, unknown> } };
    assert.deepEqual(created.session.sessionConfig, {});

    const catalog = await adapter.handle(request('3', 'catalog.list', {})) as {
      catalogRevision: string;
      configOptions: Array<{ id: string; choices?: Array<{ value: unknown }> }>;
    };
    const modelOption = catalog.configOptions.find((option) => option.id === 'model');
    assert.deepEqual(modelOption?.choices?.map((choice) => choice.value), [
      'claude-default',
      'claude-alias-opus',
    ]);

    await adapter.handle(request('4', 'turn.start', {
      sessionId: 'model-session',
      streamId: created.session.streamId,
      turnId: 'opus-turn',
      input: [{ type: 'text', text: 'hello' }],
      config: { model: 'claude-alias-opus', effort: 'high' },
    }));
    adapter.flushDeferredNotifications();
    assert.equal(runtime.spawns[0]?.model, 'opus');
    assert.equal(runtime.messages[0]?.model, 'opus');
    assert.equal(runtime.messages[0]?.effort, 'high');
    runtime.emit('channelReply', runtime.messages[0]!.sessionId, 'done');

    const resolved = await adapter.handle(request('5', 'catalog.resolve', {
      catalogRevision: (catalog as { catalogRevision: string }).catalogRevision,
      turnConfig: { model: 'claude-alias-opus' },
      sessionConfig: {},
    })) as {
      catalogRevision: string;
      configOptions: Array<{ id: string; choices?: Array<{ value: unknown }>; defaultValue?: unknown }>;
      resolvedDefaults: { turnConfig: Record<string, unknown> };
    };
    const effort = resolved.configOptions.find((option) => option.id === 'effort');
    assert.deepEqual(effort?.choices?.map((choice) => choice.value), ['low', 'high', 'max']);
    assert.equal(effort?.defaultValue, 'high');
    assert.equal(resolved.resolvedDefaults.turnConfig.effort, 'high');
  } finally {
    await service.close();
  }
});

test('Claude gian.proxy/2 closes sessions idempotently and resolves pending interactions first', async () => {
  const { runtime, service, adapter, notifications, streamId } = await setup();
  try {
    await adapter.handle(request('3', 'turn.start', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
      input: [{ type: 'text', text: 'run' }],
      config: {},
    }));
    const serviceSessionId = runtime.messages[0]!.sessionId;
    runtime.emit('permissionRequest', serviceSessionId, 'native-approval', 'Bash', 'Run command', 'pwd');
    const requested = notifications.find((item) => item.method === 'interaction.requested');
    assert.ok(requested);

    await adapter.handle(request('4', 'session.close', {
      sessionId: 'host-session',
      streamId,
    }));
    adapter.flushDeferredNotifications();
    const resolved = notifications.filter((item) => item.method === 'interaction.resolved').at(-1);
    assert.equal((resolved?.params.data as { outcome?: string }).outcome, 'turn_ended');
    const terminal = notifications.filter((item) => item.method === 'turn.completed').at(-1);
    assert.equal((terminal?.params.data as { stopReason?: string }).stopReason, 'cancelled');

    // Repeated close for the same attach generation is idempotent.
    await assert.doesNotReject(adapter.handle(request('5', 'session.close', {
      sessionId: 'host-session',
      streamId,
    })));

    await assert.rejects(
      adapter.handle(request('6', 'session.get', { sessionId: 'host-session' })),
      (error: unknown) => error instanceof ClaudeProtocolError && error.domainCode === 'SESSION_CLOSED',
    );
    await assert.rejects(
      adapter.handle(request('7', 'turn.start', {
        sessionId: 'host-session',
        streamId,
        turnId: 'after-close',
        input: [{ type: 'text', text: 'x' }],
        config: {},
      })),
      (error: unknown) => error instanceof ClaudeProtocolError && error.domainCode === 'SESSION_CLOSED',
    );
  } finally {
    await service.close();
  }

test('Claude gian.proxy/2 failed interrupt keeps pending interaction and succeeds on retry', async () => {
  const { runtime, service, adapter, notifications, streamId } = await setup();
  try {
    await adapter.handle(request('3', 'turn.start', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
      input: [{ type: 'text', text: 'run' }],
      config: {},
    }));
    adapter.flushDeferredNotifications();
    const serviceSessionId = runtime.messages[0]!.sessionId;
    runtime.emit('permissionRequest', serviceSessionId, 'native-approval', 'Bash', 'Run command', 'pwd');
    assert.ok(notifications.some((item) => item.method === 'interaction.requested'));

    runtime.failInterrupt = true;
    await assert.rejects(
      adapter.handle(request('4', 'turn.interrupt', {
        sessionId: 'host-session',
        streamId,
        turnId: 'host-turn',
      })),
      (error: unknown) => error instanceof ClaudeProtocolError && error.domainCode === 'INTERNAL',
    );
    // The failure Response path must flush, not discard, queued notifications.
    // More importantly, the pending interaction must not have been resolved or
    // deleted before the Runtime accepted the interrupt.
    adapter.flushDeferredNotifications();
    assert.ok(!notifications.some((item) => item.method === 'interaction.resolved'));

    runtime.failInterrupt = false;
    await adapter.handle(request('5', 'turn.interrupt', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
    }));
    adapter.flushDeferredNotifications();
    const resolvedIndex = notifications.findIndex((item) => item.method === 'interaction.resolved');
    const terminalIndex = notifications.findLastIndex((item) => item.method === 'turn.completed');
    assert.ok(resolvedIndex >= 0);
    assert.ok(resolvedIndex < terminalIndex);
    assert.equal(
      (notifications[resolvedIndex]?.params.data as { outcome: string }).outcome,
      'cancelled',
    );
    assert.equal(
      (notifications[terminalIndex]?.params.data as { stopReason: string }).stopReason,
      'interrupted',
    );
  } finally {
    await service.close();
  }
});

test('Claude gian.proxy/2 maps real OAuth expiry to RUNTIME_AUTH_REQUIRED', async () => {
  const { runtime, service, adapter, notifications, streamId } = await setup();
  try {
    await adapter.handle(request('auth-turn', 'turn.start', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-auth-turn',
      input: [{ type: 'text', text: 'hello' }],
      config: {},
    }));
    adapter.flushDeferredNotifications();
    const serviceSessionId = runtime.messages[0]!.sessionId;
    runtime.emit(
      'processExited',
      serviceSessionId,
      2,
      null,
      'Failed to authenticate: OAuth session expired and could not be refreshed',
    );
    const failed = notifications.find((item) => item.method === 'turn.failed');
    assert.equal(
      (failed?.params.data as { error?: { domainCode?: unknown } } | undefined)?.error?.domainCode,
      'RUNTIME_AUTH_REQUIRED',
    );
  } finally {
    await service.close();
  }
});
});

test('Claude gian.proxy/2 pairs tool results and content completion before turn terminal', async () => {
  const { runtime, service, adapter, notifications, streamId } = await setup();
  try {
    await adapter.handle(request('3', 'turn.start', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
      input: [{ type: 'text', text: 'run' }],
      config: {},
    }));
    adapter.flushDeferredNotifications();
    const serviceSessionId = runtime.messages[0]!.sessionId;
    runtime.emit('toolUse', serviceSessionId, 'Bash', { command: 'pwd' }, 'tool-1');
    runtime.emit('assistantText', serviceSessionId, 'working', 'block-1');
    runtime.emit('toolResult', serviceSessionId, 'tool-1', '/tmp', false);
    runtime.emit('channelReply', serviceSessionId, '');
    const methods = notifications.map((item) => item.method);
    assert.deepEqual(methods, [
      'turn.started',
      'activity.updated',
      'content.delta',
      'activity.updated',
      'content.completed',
      'turn.completed',
    ]);
    const content = notifications.find((item) => item.method === 'content.completed')!;
    assert.equal((content.params.data as { content: string }).content, 'working');
    assert.equal((content.params.data as { format?: string }).format, 'plain');
    const terminalIndex = methods.lastIndexOf('turn.completed');
    assert.ok(methods.indexOf('content.completed') < terminalIndex);
    assert.ok(methods.indexOf('activity.updated') < terminalIndex);
    for (const item of notifications) {
      if (item.params.turnId !== undefined) assert.equal(item.params.turnId, 'host-turn');
    }
  } finally {
    await service.close();
  }
});

test('Claude gian.proxy/2 rejects and cancels AskUserQuestion through advertised actions', async () => {
  const { runtime, service, adapter, notifications, streamId } = await setup();
  try {
    await adapter.handle(request('3', 'turn.start', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
      input: [{ type: 'text', text: 'run' }],
      config: {},
    }));
    const serviceSessionId = runtime.messages[0]!.sessionId;
    const questions = [{
      question: 'Pick one',
      header: 'Pick one',
      options: [{ label: 'Option A' }, { label: 'Option B' }],
    }];
    runtime.emit('permissionRequest', serviceSessionId, 'native-q', 'AskUserQuestion', 'Pick one', JSON.stringify({ questions }));

    const requested = notifications.find((item) => item.method === 'interaction.requested')!;
    const data = requested.params.data as {
      interactionId: string;
      presentation: { kind: string };
      inputs: Array<{ id: string; type: string }>;
      actions: Array<{ id: string }>;
    };
    assert.equal(data.presentation.kind, 'question');
    assert.deepEqual(data.inputs.map((input) => input.id), ['Pick one']);
    assert.equal(data.inputs[0]?.type, 'single_select');

    await assert.rejects(
      adapter.handle(request('4', 'interaction.respond', {
        sessionId: 'host-session',
        streamId,
        turnId: 'host-turn',
        interactionId: data.interactionId,
        responseId: 'resp-bad',
        actionId: 'allow_once',
        values: { unknown: 'x' },
      })),
      (error: unknown) => error instanceof ClaudeProtocolError && error.domainCode === 'INVALID_PARAMS',
    );

    const before = notifications.length;
    const responseParams = {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
      interactionId: data.interactionId,
      responseId: 'resp-1',
      actionId: 'reject_once',
      values: {},
    };
    const firstResponse = await adapter.handle(request('5', 'interaction.respond', responseParams));
    const repeatedResponse = await adapter.handle(request('5b', 'interaction.respond', responseParams));
    assert.deepEqual(repeatedResponse, firstResponse);
    assert.equal(runtime.permissionResponses.length, 1, 'same responseId must not reach Claude twice');
    await assert.rejects(
      adapter.handle(request('5c', 'interaction.respond', {
        ...responseParams,
        actionId: 'allow_once',
      })),
      (error: unknown) => error instanceof ClaudeProtocolError && error.domainCode === 'CONFLICT',
    );
    assert.equal(notifications.length, before, 'interaction.resolved is queued behind the Response');
    adapter.flushDeferredNotifications();
    assert.equal(runtime.permissionResponses[0]?.behavior, 'deny');
    const resolved = notifications.find((item) => item.method === 'interaction.resolved')!;
    assert.equal((resolved.params.data as { outcome: string }).outcome, 'submitted');
    assert.equal((resolved.params.data as { actionId: string }).actionId, 'reject_once');
  } finally {
    await service.close();
  }
});

test('Claude gian.proxy/2 degrades unknown visible Claude events to generic activity', async () => {
  const { runtime, service, adapter, notifications, streamId } = await setup();
  try {
    await adapter.handle(request('3', 'turn.start', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
      input: [{ type: 'text', text: 'run' }],
      config: {},
    }));
    const serviceSessionId = runtime.messages[0]!.sessionId;
    runtime.emit('unknownClaudeEvent', serviceSessionId, { type: 'web_search', query: 'docs' });
    const activity = notifications.filter((item) => item.method === 'activity.updated').at(-1);
    assert.ok(activity);
    const data = activity.params.data as {
      presentation: { type: string };
      details?: { event?: { type?: string } };
      title: string;
    };
    assert.equal(data.presentation.type, 'generic');
    assert.match(data.title, /web_search/);
    assert.equal(data.details?.event?.type, 'web_search');
  } finally {
    await service.close();
  }
});

test('Claude gian.proxy/2 drops late events from a completed turn generation', async () => {
  const { runtime, service, adapter, notifications, streamId } = await setup();
  try {
    await adapter.handle(request('3', 'turn.start', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
      input: [{ type: 'text', text: 'run' }],
      config: {},
    }));
    const serviceSessionId = runtime.messages[0]!.sessionId;
    runtime.emit('channelReply', serviceSessionId, 'done');
    const countAfterComplete = notifications.length;
    runtime.emit('assistantText', serviceSessionId, 'late text', 'late-block');
    assert.equal(notifications.length, countAfterComplete);
  } finally {
    await service.close();
  }
});

test('Claude gian.proxy/2 rejects hostServices and wrong-bound config keys', async () => {
  const { service, adapter, streamId } = await setup();
  try {
    await assert.rejects(
      adapter.handle(request('3', 'session.create', {
        sessionId: 'other-session',
        workspace: { cwd: '/tmp', roots: ['/tmp'] },
        config: {},
        hostServices: [{ id: 'gian', protocol: 'mcp' }],
      })),
      (error: unknown) => error instanceof ClaudeProtocolError
        && error.domainCode === 'CAPABILITY_NOT_SUPPORTED',
    );
    await assert.rejects(
      adapter.handle(request('4', 'turn.start', {
        sessionId: 'host-session',
        streamId,
        turnId: 'turn',
        input: [{ type: 'text', text: 'x' }],
        config: { unknown: 'x' },
      })),
      (error: unknown) => error instanceof ClaudeProtocolError
        && error.domainCode === 'CONFIG_VALUE_INVALID',
    );
    await assert.rejects(
      adapter.handle(request('5', 'turn.start', {
        sessionId: 'host-session',
        streamId,
        turnId: 'turn-2',
        input: [{ type: 'text', text: 'x' }],
        config: { model: 'not-a-choice' },
      })),
      (error: unknown) => error instanceof ClaudeProtocolError
        && error.domainCode === 'CONFIG_VALUE_INVALID',
    );
  } finally {
    await service.close();
  }
});

test('Claude gian.proxy/2 notifications satisfy the protocol schema', async () => {
  const { runtime, service, adapter, notifications, streamId } = await setup();
  try {
    await adapter.handle(request('3', 'turn.start', {
      sessionId: 'host-session',
      streamId,
      turnId: 'schema-turn',
      input: [{ type: 'text', text: 'run' }],
      config: {},
    }));
    adapter.flushDeferredNotifications();
    const serviceSessionId = runtime.messages[0]!.sessionId;
    runtime.emit('toolUse', serviceSessionId, 'Bash', { command: 'pwd' }, 'tool-1');
    runtime.emit('assistantText', serviceSessionId, 'working', 'block-1');
    runtime.emit('toolResult', serviceSessionId, 'tool-1', '/tmp', false);
    runtime.emit('unknownClaudeEvent', serviceSessionId, { type: 'future_event', payload: { ok: true } });
    runtime.emit('channelReply', serviceSessionId, '');
    assert.ok(notifications.length > 0);
    for (const notification of notifications) {
      assert.doesNotThrow(() => proxyNotificationSchema.parse({
        jsonrpc: '2.0',
        method: notification.method,
        params: notification.params,
      }));
    }
  } finally {
    await service.close();
  }
});

test('cc-proxy JSON-RPC transport uses standard numeric error codes', () => {
  assert.equal(
    (jsonRpcError(new ClaudeProtocolError('PARSE_ERROR', 'bad json')) as { code: number }).code,
    -32700,
  );
  assert.equal(
    (jsonRpcError(new ClaudeProtocolError('INVALID_REQUEST', 'bad request')) as { code: number }).code,
    -32600,
  );
  assert.equal(
    (jsonRpcError(new ClaudeProtocolError('METHOD_NOT_FOUND', 'unknown')) as { code: number }).code,
    -32601,
  );
  assert.equal(
    (jsonRpcError(new ClaudeProtocolError('INVALID_PARAMS', 'bad params')) as { code: number }).code,
    -32602,
  );
  assert.equal(
    (jsonRpcError(new ClaudeProtocolError('SESSION_NOT_FOUND', 'missing')) as { code: number }).code,
    -32000,
  );
  const domain = jsonRpcError(new ClaudeProtocolError('SESSION_NOT_FOUND', 'missing')) as {
    data: { domainCode: string };
  };
  assert.equal(domain.data.domainCode, 'SESSION_NOT_FOUND');
});

test('cc-proxy parseRequestLine rejects malformed JSON and JSON-RPC batches', () => {
  assert.throws(
    () => parseRequestLine('{not-json'),
    (error: unknown) => error instanceof ClaudeProtocolError && error.domainCode === 'PARSE_ERROR',
  );
  assert.throws(
    () => parseRequestLine('[]'),
    (error: unknown) => error instanceof ClaudeProtocolError && error.domainCode === 'INVALID_REQUEST',
  );
  assert.throws(
    () => parseRequestLine('{"jsonrpc":"2.0","id":"","method":"initialize","params":{}}'),
    (error: unknown) => error instanceof ClaudeProtocolError && error.domainCode === 'INVALID_REQUEST',
  );
});
