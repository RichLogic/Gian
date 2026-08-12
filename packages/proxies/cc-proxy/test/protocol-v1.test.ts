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
  readonly messages: Array<{ sessionId: string; content: string; displayName?: string | null }> = [];
  readonly permissionResponses: Array<{ requestId: string; behavior: 'allow' | 'deny' }> = [];
  private readonly alive = new Set<string>();

  async start(): Promise<number> { return 0; }
  async spawnSession(options: { sessionId: string }): Promise<void> {
    this.alive.add(options.sessionId);
  }
  async sendMessage(
    sessionId: string,
    content: string,
    options?: Parameters<ClaudeRuntime['sendMessage']>[2],
  ): Promise<void> {
    this.messages.push({
      sessionId,
      content,
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
    return [{
      id: 'default',
      model: '',
      displayName: 'Default',
      description: '',
      hidden: false,
      isDefault: true,
      defaultEffort: null,
      supportedEfforts: [],
    }];
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
