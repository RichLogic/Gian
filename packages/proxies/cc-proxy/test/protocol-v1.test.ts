import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  PROTOCOL_NAME,
  PROTOCOL_V1,
  ProxyProtocolError,
  parseProxyRequest,
  proxyNotificationSchema,
  type ProxyNotification,
} from '@gian/proxy-protocol';
import { CcProxyService } from '../src/core/service.js';
import { ClaudeProtocolV1Adapter } from '../src/protocol/v1-adapter.js';
import type { ModelCapabilities } from '../src/core/types.js';
import type { ClaudeRuntime, ClaudeRuntimeEvents } from '../src/runtime/types.js';

class FakeRuntime extends EventEmitter<ClaudeRuntimeEvents> implements ClaudeRuntime {
  readonly messages: Array<{
    sessionId: string;
    content: string;
    model: string | null;
    displayName?: string | null;
  }> = [];
  readonly permissionResponses: Array<{ requestId: string; behavior: 'allow' | 'deny' }> = [];
  readonly spawns: Array<Parameters<ClaudeRuntime['spawnSession']>[0]> = [];
  readonly modelUpdates: Array<{ sessionId: string; model: string | null }> = [];
  private readonly alive = new Set<string>();
  private readonly modelBySession = new Map<string, string | null>();

  constructor(private readonly models: ModelCapabilities[] = [{
    id: 'default',
    model: '',
    displayName: 'Default',
    description: '',
    hidden: false,
    isDefault: true,
    defaultEffort: null,
    supportedEfforts: [],
  }]) {
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
      ...(options?.displayName !== undefined ? { displayName: options.displayName } : {}),
    });
  }
  resetClaudeSessionId(): void {}
  async respondPermission(
    _sessionId: string,
    requestId: string,
    behavior: 'allow' | 'deny',
  ): Promise<void> {
    this.permissionResponses.push({ requestId, behavior });
  }
  killSession(sessionId: string): void { this.alive.delete(sessionId); }
  isSessionAlive(sessionId: string): boolean { return this.alive.has(sessionId); }
  getDetectedModelId(): string | null { return null; }
  async stop(): Promise<void> { this.alive.clear(); }
  getModels(): ModelCapabilities[] {
    return this.models;
  }
  async awaitModelDiscovery(): Promise<void> {}
}

function request(id: number, method: string, params: unknown) {
  return parseProxyRequest({ id, method, params });
}

async function setup() {
  const runtime = new FakeRuntime();
  const service = new CcProxyService({ runtime });
  await service.initialize();
  const notifications: ProxyNotification[] = [];
  const adapter = new ClaudeProtocolV1Adapter(service, '0.1.0', notification => {
    notifications.push(proxyNotificationSchema.parse(notification));
  });
  await adapter.handle(request(1, 'initialize', {
    protocol: { name: PROTOCOL_NAME, versions: [PROTOCOL_V1] },
    host: { name: 'test', version: '9.9.9' },
  }));
  const created = await adapter.handle(request(2, 'session.create', {
    sessionId: 'host-session',
    cwd: '/tmp',
    workspaceRoots: ['/tmp'],
    config: {},
  })) as { session: { streamId: string; nativeSession: { id: string } } };
  return { runtime, service, adapter, notifications, streamId: created.session.streamId };
}

test('Claude gian.proxy/1 keeps Host ids and rejects conflicting or concurrent turns', async () => {
  const { runtime, service, adapter, notifications, streamId } = await setup();
  try {
    await adapter.handle(request(3, 'session.rename', {
      sessionId: 'host-session',
      streamId,
      name: 'Host-owned name',
    }));
    const params = {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
      input: [{ type: 'text', text: 'hello' }],
      policy: { workspaceRoots: ['/tmp'], approval: 'relay', network: 'ask' },
      config: { mode: 'ask', native: {} },
    };
    await adapter.handle(request(4, 'turn.start', params));
    assert.equal(runtime.messages[0]?.displayName, 'Host-owned name');
    await adapter.handle(request(5, 'turn.start', params));
    assert.equal(runtime.messages.length, 1);
    await assert.rejects(
      adapter.handle(request(6, 'turn.start', {
        ...params,
        input: [{ type: 'text', text: 'different' }],
      })),
      (error: unknown) => error instanceof ProxyProtocolError && error.code === 'CONFLICT',
    );
    await assert.rejects(
      adapter.handle(request(7, 'turn.start', {
        ...params,
        turnId: 'host-turn-2',
      })),
      (error: unknown) => error instanceof ProxyProtocolError && error.code === 'SESSION_BUSY',
    );
    await assert.doesNotReject(adapter.handle(request(8, 'turn.interrupt', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
    })));
    const started = notifications.find(item => item.method === 'turn.started');
    assert.equal('turnId' in started!.params ? started!.params.turnId : null, 'host-turn');
  } finally {
    await service.close();
  }
});

test('Claude gian.proxy/1 lazily resolves catalog ids and updates each turn runtime model', async () => {
  const runtime = new FakeRuntime([
    {
      id: 'claude-default',
      model: '',
      displayName: 'Default',
      description: '',
      hidden: false,
      isDefault: true,
      defaultEffort: null,
      supportedEfforts: [],
    },
    {
      id: 'claude-alias-opus',
      model: 'opus',
      displayName: 'Opus',
      description: '',
      hidden: false,
      isDefault: false,
      defaultEffort: null,
      supportedEfforts: [],
    },
    {
      id: 'claude-settings-router-kimi',
      model: 'claude-router-kimi-k3[1m]',
      displayName: 'claude-router-kimi-k3[1m]',
      description: '',
      hidden: false,
      isDefault: false,
      defaultEffort: null,
      supportedEfforts: [],
    },
  ]);
  const service = new CcProxyService({ runtime });
  await service.initialize();
  const adapter = new ClaudeProtocolV1Adapter(service, '0.1.0', () => undefined);
  try {
    await adapter.handle(request(1, 'initialize', {
      protocol: { name: PROTOCOL_NAME, versions: [PROTOCOL_V1] },
      host: { name: 'test', version: '9.9.9' },
    }));
    // Deliberately create before catalog.list. Session creation must lazily
    // load the catalog mapping instead of forwarding the opaque id to Claude.
    const created = await adapter.handle(request(2, 'session.create', {
      sessionId: 'model-session',
      cwd: '/tmp',
      workspaceRoots: ['/tmp'],
      model: 'claude-alias-opus',
      config: {},
    })) as { session: { streamId: string; model: string | null } };
    assert.equal(created.session.model, 'claude-alias-opus');

    const catalog = await adapter.handle(request(3, 'catalog.list', {})) as {
      models: Array<{ id: string }>;
    };
    assert.deepEqual(catalog.models.map(model => model.id), [
      'claude-default',
      'claude-alias-opus',
      'claude-settings-router-kimi',
    ]);

    await adapter.handle(request(4, 'turn.start', {
      sessionId: 'model-session',
      streamId: created.session.streamId,
      turnId: 'alias-turn',
      input: [{ type: 'text', text: 'hello' }],
      policy: { workspaceRoots: ['/tmp'], approval: 'relay', network: 'ask' },
      config: { native: {} },
    }));
    assert.equal(runtime.spawns[0]?.model, 'opus');
    assert.equal(runtime.messages[0]?.model, 'opus');
    runtime.emit('channelReply', runtime.messages[0]!.sessionId, 'alias done');

    await adapter.handle(request(5, 'turn.start', {
      sessionId: 'model-session',
      streamId: created.session.streamId,
      turnId: 'custom-turn',
      input: [{ type: 'text', text: 'hello again' }],
      policy: { workspaceRoots: ['/tmp'], approval: 'relay', network: 'ask' },
      config: { model: 'claude-settings-router-kimi', native: {} },
    }));
    assert.equal(runtime.spawns.length, 1, 'registered native session is reused');
    assert.equal(runtime.messages[1]?.model, 'claude-router-kimi-k3[1m]');
    runtime.emit('channelReply', runtime.messages[1]!.sessionId, 'custom done');

    await adapter.handle(request(6, 'turn.start', {
      sessionId: 'model-session',
      streamId: created.session.streamId,
      turnId: 'default-turn',
      input: [{ type: 'text', text: 'back to default' }],
      policy: { workspaceRoots: ['/tmp'], approval: 'relay', network: 'ask' },
      config: { model: 'claude-default', native: {} },
    }));
    assert.equal(runtime.messages[2]?.model, null);
    assert.deepEqual(runtime.modelUpdates.map(update => update.model), [
      'opus',
      'claude-router-kimi-k3[1m]',
      null,
    ]);
    const current = await adapter.handle(request(7, 'session.get', {
      sessionId: 'model-session',
    })) as { session: { model: string | null } };
    assert.equal(current.session.model, 'claude-default');
  } finally {
    await service.close();
  }
});

test('Claude gian.proxy/1 keeps approvals pending when session.close is rejected', async () => {
  const { runtime, service, adapter, notifications, streamId } = await setup();
  try {
    await adapter.handle(request(3, 'turn.start', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
      input: [{ type: 'text', text: 'run' }],
      policy: { workspaceRoots: ['/tmp'], approval: 'relay', network: 'ask' },
      config: { native: {} },
    }));
    const serviceSessionId = runtime.messages[0]!.sessionId;
    runtime.emit('permissionRequest', serviceSessionId, 'native-approval', 'Bash', 'Run command', 'pwd');
    const requested = notifications.find(item => item.method === 'approval.requested');
    assert.ok(requested);

    await assert.rejects(
      adapter.handle(request(4, 'session.close', {
        sessionId: 'host-session',
        streamId,
      })),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'SESSION_BUSY',
    );
    assert.equal(notifications.some(item => item.method === 'approval.resolved'), false);

    await assert.doesNotReject(adapter.handle(request(5, 'approval.respond', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
      approvalId: requested.params.data.approvalId,
      optionId: 'allow_once',
    })));
  } finally {
    await service.close();
  }
});

test('Claude gian.proxy/1 pairs native tool results before turn completion', async () => {
  const { runtime, service, adapter, notifications, streamId } = await setup();
  try {
    await adapter.handle(request(3, 'turn.start', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
      input: [{ type: 'text', text: 'run' }],
      policy: { workspaceRoots: ['/tmp'], approval: 'relay', network: 'ask' },
      config: { native: {} },
    }));
    const serviceSessionId = runtime.messages[0]!.sessionId;
    runtime.emit('toolUse', serviceSessionId, 'Bash', { command: 'pwd' }, 'tool-1');
    runtime.emit('toolResult', serviceSessionId, 'tool-1', '/tmp', false);
    runtime.emit('channelReply', serviceSessionId, 'done');
    assert.deepEqual(
      notifications.map(item => item.method),
      ['turn.started', 'tool.started', 'tool.completed', 'content.completed', 'turn.completed'],
    );
  } finally {
    await service.close();
  }
});

test('Claude gian.proxy/1 resolves approval and tool before interrupted turn', async () => {
  const { runtime, service, adapter, notifications, streamId } = await setup();
  try {
    await adapter.handle(request(3, 'turn.start', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
      input: [{ type: 'text', text: 'run' }],
      policy: { workspaceRoots: ['/tmp'], approval: 'relay', network: 'ask' },
      config: { native: {} },
    }));
    const serviceSessionId = runtime.messages[0]!.sessionId;
    runtime.emit('toolUse', serviceSessionId, 'Bash', { command: 'sleep 10' }, 'tool-1');
    runtime.emit('permissionRequest', serviceSessionId, 'native-approval', 'Bash', 'Run command', 'sleep 10');
    await adapter.handle(request(4, 'turn.interrupt', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
    }));
    const methods = notifications.map(item => item.method);
    assert.ok(methods.indexOf('approval.resolved') < methods.lastIndexOf('turn.completed'));
    assert.ok(methods.indexOf('tool.completed') < methods.lastIndexOf('turn.completed'));
    const terminal = notifications.at(-1)!;
    assert.equal(terminal.method, 'turn.completed');
    assert.equal((terminal.params.data as { stopReason: string }).stopReason, 'interrupted');
  } finally {
    await service.close();
  }
});

test('Claude gian.proxy/1 resets usage immediately after native session rotation', async () => {
  const { service, adapter, notifications, streamId } = await setup();
  try {
    await adapter.handle(request(3, 'turn.start', {
      sessionId: 'host-session',
      streamId,
      turnId: 'clear-turn',
      input: [{ type: 'text', text: '/clear' }],
      policy: { workspaceRoots: ['/tmp'], approval: 'relay', network: 'ask' },
      config: { native: {} },
    }));
    const rotationIndex = notifications.findIndex(item => (
      item.method === 'session.updated'
      && item.params.data.reason === 'native-session-rotated'
    ));
    assert.ok(rotationIndex >= 0);
    const reset = notifications[rotationIndex + 1];
    assert.equal(reset?.method, 'usage.updated');
    assert.deepEqual(reset?.params.data, {
      context: null,
      conversation: { mode: 'reset' },
      reason: 'session_reset',
    });
  } finally {
    await service.close();
  }
});

test('Claude gian.proxy/1 suppresses generic tool events for approval-bridged tools', async () => {
  const { runtime, service, adapter, notifications, streamId } = await setup();
  try {
    await adapter.handle(request(3, 'turn.start', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
      input: [{ type: 'text', text: 'run' }],
      policy: { workspaceRoots: ['/tmp'], approval: 'relay', network: 'ask' },
      config: { native: {} },
    }));
    const serviceSessionId = runtime.messages[0]!.sessionId;
    // AskUserQuestion / ExitPlanMode always route through the approval bridge;
    // their generic tool cards would duplicate the approval card and render
    // the deny+message answer tunnel as a bogus error.
    runtime.emit('toolUse', serviceSessionId, 'AskUserQuestion', { questions: [] }, 'tool-q');
    runtime.emit('toolResult', serviceSessionId, 'tool-q', 'denied with answers', true);
    runtime.emit('toolUse', serviceSessionId, 'ExitPlanMode', {}, 'tool-p');
    runtime.emit('toolResult', serviceSessionId, 'tool-p', 'Plan approved', false);
    // A regular tool is unaffected.
    runtime.emit('toolUse', serviceSessionId, 'Read', { file_path: '/tmp/x' }, 'tool-r');
    runtime.emit('toolResult', serviceSessionId, 'tool-r', 'data', false);
    runtime.emit('channelReply', serviceSessionId, 'done');
    assert.deepEqual(
      notifications.map(item => item.method),
      ['turn.started', 'tool.started', 'tool.completed', 'content.completed', 'turn.completed'],
    );
    const started = notifications.find(item => item.method === 'tool.started')!;
    assert.equal((started.params.data as { name: string }).name, 'Read');
  } finally {
    await service.close();
  }
});

test('Claude gian.proxy/1 echoes AskUserQuestion answers on approval.resolved', async () => {
  const { runtime, service, adapter, notifications, streamId } = await setup();
  try {
    await adapter.handle(request(3, 'turn.start', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
      input: [{ type: 'text', text: 'run' }],
      policy: { workspaceRoots: ['/tmp'], approval: 'relay', network: 'ask' },
      config: { native: {} },
    }));
    const serviceSessionId = runtime.messages[0]!.sessionId;
    runtime.emit('permissionRequest', serviceSessionId, 'native-q', 'AskUserQuestion', 'Pick one', '{"questions":[]}');
    const requested = notifications.find(item => item.method === 'approval.requested')!;
    assert.ok(requested);

    await adapter.handle(request(4, 'approval.respond', {
      sessionId: 'host-session',
      streamId,
      turnId: 'host-turn',
      approvalId: (requested.params.data as { approvalId: string }).approvalId,
      optionId: 'allow_once',
      answers: { 'Pick one': 'Option A' },
    }));

    // The answers tunnel to claude as a deny+message…
    assert.equal(runtime.permissionResponses[0]?.behavior, 'deny');
    // …but the resolved event still reports the user's pick and carries the
    // answers so the resolved card can show "answered with …" live.
    const resolved = notifications.find(item => item.method === 'approval.resolved')!;
    assert.ok(resolved);
    assert.equal((resolved.params.data as { optionId: string }).optionId, 'allow_once');
    assert.deepEqual((resolved.params.data as { answers?: unknown }).answers, { 'Pick one': 'Option A' });
  } finally {
    await service.close();
  }
});
