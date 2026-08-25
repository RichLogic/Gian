import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { proxyNotificationSchema, replayEventSchemaUnion, resultSchemas } from '@gian/proxy-protocol';

import { GrokProxyService } from '../src/core/service.js';
import { NativeTurnIdentityStore } from '../src/protocol/replay-identity.js';
import { GrokProtocolV2Adapter, type WireRequest } from '../src/protocol/v2-adapter.js';
import type { GrokAcpClient } from '../src/runtime/grok-acp-client.js';

function v2Request(id: string, method: string, params: Record<string, unknown>): WireRequest {
  return { id, method, params };
}

function initializeMeta() {
  return {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, close: {} },
    },
    _meta: {
      modelState: {
        currentModelId: 'grok-4.6',
        availableModels: [{
          modelId: 'grok-4.6',
          name: 'Grok 4.6',
          _meta: {
            reasoningEffort: 'high',
            reasoningEfforts: [
              { id: 'high', value: 'high', label: 'High', default: true },
              { id: 'low', value: 'low', label: 'Low' },
            ],
          },
        }],
      },
      availableCommands: [{ name: 'compact' }, { name: 'fork' }],
    },
  };
}

function fakeRuntime(overrides: Record<string, unknown> = {}) {
  const runtime = new EventEmitter() as EventEmitter & GrokAcpClient & {
    calls: string[];
    prompts: unknown[];
  };
  runtime.calls = [];
  runtime.prompts = [];
  Object.assign(runtime, {
    binaryPath: '/managed/grok',
    cwd: '/workspace',
    negotiated: initializeMeta(),
    async ensureStarted() {
      runtime.calls.push('initialize');
      return initializeMeta();
    },
    setPermissionHandler() {},
    async newSession() {
      runtime.calls.push('session/new');
      return { sessionId: 'native-1' };
    },
    async loadSession() {
      runtime.calls.push('session/load');
      return { sessionId: 'native-load' };
    },
    async resumeSession() {
      runtime.calls.push('session/resume');
      return {};
    },
    async listSessions() {
      runtime.calls.push('session/list');
      return { sessions: [{ sessionId: 'listed' }] };
    },
    async prompt(params: unknown) {
      runtime.calls.push('session/prompt');
      runtime.prompts.push(params);
      return { stopReason: 'end_turn', _meta: { inputTokens: 3, outputTokens: 2, totalTokens: 10 } };
    },
    async cancel() { runtime.calls.push('session/cancel'); },
    async setSessionModel(params: unknown) {
      runtime.calls.push('session/set_model');
      runtime.prompts.push(params);
      return {};
    },
    async notifyPermissionMode() { runtime.calls.push('x.ai/yolo_mode_changed'); },
    async renameSession() { runtime.calls.push('x.ai/session/rename'); },
    async deleteSession() { runtime.calls.push('x.ai/session/delete'); },
    async interject() { runtime.calls.push('x.ai/interject'); },
    async closeSession() { runtime.calls.push('session/close'); },
    async stop() { runtime.calls.push('stop'); },
    ...overrides,
  });
  return runtime;
}

test('catalog comes from initialize metadata and never creates a session', async () => {
  const runtime = fakeRuntime();
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const catalog = await service.listCapabilities();
  assert.equal(catalog.models[0]?.id, 'grok-4.6');
  assert.deepEqual(catalog.modes.map(mode => mode.id), ['default', 'auto', 'always_approve']);
  assert.equal(catalog.sessionOptions.find(option => option.category === 'reasoning_effort')?.id, 'reasoning_effort');
  assert.equal(catalog.sessionOptions.find(option => option.id === 'permission_mode')?.category, 'mode');
  assert.ok(!runtime.calls.includes('session/new'));
  assert.ok(runtime.calls.includes('stop'));
});

test('rejects a second attached session and non-empty MCP', async () => {
  const runtime = fakeRuntime();
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const first = await service.createSession({ cwd: '/workspace' });
  await assert.rejects(
    service.createSession({ cwd: '/workspace' }),
    /already has an attached session/,
  );
  await assert.rejects(
    new GrokProxyService({
      binaryPath: '/managed/grok',
      createRuntime: () => fakeRuntime(),
    }).createSession({ cwd: '/workspace', mcpServers: [{ name: 'x' } as never] }),
    /MCP/,
  );
  await service.closeSession({ sessionId: first.session.id });
});

test('model and reasoning effort use session/set_model, never set_config_option', async () => {
  const runtime = fakeRuntime();
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  await service.listCapabilities();
  const created = await service.createSession({ cwd: '/workspace' });
  await service.setConfigOption({
    sessionId: created.session.id,
    configId: 'model',
    value: 'grok-4.6',
  });
  await service.setConfigOption({
    sessionId: created.session.id,
    configId: 'reasoning_effort',
    value: 'low',
  });
  assert.ok(runtime.calls.includes('session/set_model'));
  assert.ok(!runtime.calls.includes('session/set_config_option'));
  assert.ok(!runtime.calls.includes('session/set_mode'));
  await service.closeSession({ sessionId: created.session.id });
});

test('turn prompt is agent-only and blocked slash commands are rejected', async () => {
  const runtime = fakeRuntime();
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const created = await service.createSession({ cwd: '/workspace' });
  await service.startTurn({
    sessionId: created.session.id,
    input: [{ type: 'text', text: 'hello' }],
  });
  assert.equal((runtime.prompts[0] as { _meta?: { mode?: string } })._meta?.mode, 'agent');
  await assert.rejects(
    service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: '/fork now' }],
    }),
    /not available/,
  );
  await service.closeSession({ sessionId: created.session.id });
});

test('rename succeeds when Grok agent does not implement session/rename', async () => {
  const runtime = fakeRuntime({
    async renameSession() {
      runtime.calls.push('x.ai/session/rename');
      throw new Error('Method not found');
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const created = await service.createSession({ cwd: '/workspace' });
  assert.deepEqual(await service.renameSession({
    sessionId: created.session.id,
    name: 'New conversation',
  }), { ok: true });
  await service.closeSession({ sessionId: created.session.id });
});

test('permission runtime updates use yolo_mode_changed and never set_mode', async () => {
  const runtime = fakeRuntime();
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const created = await service.createSession({ cwd: '/workspace' });
  await service.setConfigOption({
    sessionId: created.session.id,
    configId: 'permission_mode',
    value: 'always_approve',
  });
  assert.ok(runtime.calls.includes('x.ai/yolo_mode_changed'));
  assert.ok(!runtime.calls.includes('session/set_mode'));
  await service.closeSession({ sessionId: created.session.id });
});

test('edit tool_call_update diffs emit schema-valid consecutive notifications', async () => {
  const runtime = fakeRuntime({
    async prompt() {
      runtime.calls.push('session/prompt');
      runtime.emit('sessionUpdate', {
        sessionId: 'native-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-edit-1',
          title: 'search_replace',
          rawInput: { file_path: '/workspace/docs/a.md' },
        },
      });
      runtime.emit('sessionUpdate', {
        sessionId: 'native-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-edit-1',
          kind: 'edit',
          status: 'in_progress',
          title: 'Edit `/workspace/docs/a.md`',
          content: [{
            type: 'diff',
            path: '/workspace/docs/a.md',
            diff: '@@ -1 +1 @@\n-old\n+new\n',
          }],
        },
      });
      runtime.emit('sessionUpdate', {
        sessionId: 'native-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'edited' },
        },
      });
      return { stopReason: 'end_turn' };
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new GrokProtocolV2Adapter(service, '0.3.0', (method, params) => {
    notifications.push({ method, params });
    proxyNotificationSchema.parse({ jsonrpc: '2.0', method, params });
  });
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-sess',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    config: {},
  })) as { session: { streamId: string; state: string; sessionConfig: Record<string, unknown> } };
  assert.equal(created.session.state, 'idle');
  assert.equal(Object.prototype.hasOwnProperty.call(created.session, 'model'), false);
  await adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 'host-sess',
    streamId: created.session.streamId,
    turnId: 'host-turn',
    input: [{ type: 'text', text: 'edit the file' }],
    config: {},
  }));
  for (let attempt = 0; attempt < 3_000; attempt += 1) {
    if (notifications.some(notification => notification.method === 'turn.completed')) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(notifications.some(notification => notification.method === 'turn.completed'));

  const sequenced = notifications.filter(notification => typeof notification.params.sequence === 'number');
  const sequences = sequenced.map((notification) => notification.params.sequence);
  assert.deepEqual(sequences, sequences.map((_, index) => index + 1));
  for (const notification of notifications) {
    if ('turnId' in notification.params) {
      assert.equal(notification.params.turnId, 'host-turn');
      assert.equal(notification.params.sourceTurnId, 'host-turn');
    }
  }
  assert.ok(notifications.some(notification => notification.method === 'activity.updated'));
  const diff = notifications.find(notification => notification.method === 'diff.updated');
  assert.ok(diff, 'edit tool_call_update must emit diff.updated');
  const data = diff.params.data as {
    path?: unknown;
    diffId?: string;
    truncated?: boolean;
    files?: Array<{ path?: string }>;
  };
  assert.equal('path' in data, false);
  assert.equal(typeof data.diffId, 'string');
  assert.equal(data.truncated, false);
  assert.equal(data.files?.[0]?.path, '/workspace/docs/a.md');
  const contentCompleted = notifications.find(notification => notification.method === 'content.completed');
  if ((contentCompleted?.params.data as { format?: unknown } | undefined)?.format !== 'plain') {
    throw new Error(`content completion lost format: ${JSON.stringify(contentCompleted)}`);
  }

  const replay = await adapter.handle(v2Request('4', 'session.replay', {
    sessionId: 'host-sess',
    streamId: created.session.streamId,
    cursor: null,
    limit: 100,
  })) as { events: Array<{ method: string; streamId?: unknown; turnId?: unknown }> };
  for (const event of replay.events) {
    replayEventSchemaUnion.parse(event);
    assert.equal('streamId' in event, false);
    assert.equal('turnId' in event, false);
  }
  await adapter.handle(v2Request('5', 'session.close', {
    sessionId: 'host-sess',
    streamId: created.session.streamId,
  }));
});

test('Grok gian.proxy/2 rejects a second attached session and hostServices', async () => {
  const runtime = fakeRuntime();
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const adapter = new GrokProtocolV2Adapter(service, '0.3.0', () => undefined);
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-one',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    config: {},
  }));
  await assert.rejects(
    adapter.handle(v2Request('3', 'session.create', {
      sessionId: 'host-two',
      workspace: { cwd: '/workspace', roots: ['/workspace'] },
      config: {},
    })),
    /already has an attached session/,
  );
  await service.close();

  const fresh = new GrokProtocolV2Adapter(new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => fakeRuntime(),
  }), '0.3.0', () => undefined);
  await fresh.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  await assert.rejects(
    fresh.handle(v2Request('2', 'session.create', {
      sessionId: 'host-mcp',
      workspace: { cwd: '/workspace', roots: ['/workspace'] },
      config: {},
      hostServices: [{
        id: 'gian-tools',
        protocol: 'mcp',
        transport: { type: 'streamable-http', url: 'http://127.0.0.1:9' },
      }],
    })),
    /does not advertise integration.mcp.streamableHttp/,
  );
});

test('Grok gian.proxy/2 returns an empty Replay Event page before native history exists', async () => {
  const runtime = fakeRuntime();
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const adapter = new GrokProtocolV2Adapter(service, '0.3.0', () => undefined);
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-replay',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    nativeSession: { id: 'native-load', history: 'replay' },
    config: {},
  })) as { session: { streamId: string } };
  const replay = await adapter.handle(v2Request('3', 'session.replay', {
    sessionId: 'host-replay',
    streamId: created.session.streamId,
    cursor: null,
    limit: 100,
  })) as { events: unknown[]; nextCursor: string | null };
  assert.deepEqual(replay.events, []);
  assert.equal(replay.nextCursor, null);
  await service.close();
});

test('Grok gian.proxy/2 rejects session-bound config on turn.start', async () => {
  const runtime = fakeRuntime();
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const adapter = new GrokProtocolV2Adapter(service, '0.3.0', () => undefined);
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-bind',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    config: { model: 'grok-4.6' },
  })) as { session: { streamId: string } };
  await assert.rejects(
    adapter.handle(v2Request('3', 'turn.start', {
      sessionId: 'host-bind',
      streamId: created.session.streamId,
      turnId: 'host-turn-bind',
      input: [{ type: 'text', text: 'hello' }],
      config: { model: 'grok-4.6' },
    })),
    (error: unknown) => error instanceof Error
      && 'domainCode' in error
      && (error as { domainCode: string }).domainCode === 'CONFIG_BINDING_INVALID',
  );
  assert.equal(runtime.calls.filter(call => call === 'session/set_model').length, 1);
  await service.close();
});

test('Grok gian.proxy/2 validates session config before creating a native session', async () => {
  const runtime = fakeRuntime();
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const adapter = new GrokProtocolV2Adapter(service, '0.3.0', () => undefined);
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  await adapter.handle(v2Request('2', 'catalog.list', {}));
  await assert.rejects(
    adapter.handle(v2Request('3', 'session.create', {
      sessionId: 'host-invalid',
      workspace: { cwd: '/workspace', roots: ['/workspace'] },
      config: { model: 'not-a-model' },
    })),
    (error: unknown) => error instanceof Error
      && 'domainCode' in error
      && (error as { domainCode: string }).domainCode === 'CONFIG_VALUE_INVALID',
  );
  assert.ok(!runtime.calls.includes('session/new'));
  await service.close();
});

test('Grok gian.proxy/2 maps Host interrupt and native cancel to distinct stopReasons', async () => {
  let releasePrompt: (() => void) | undefined;
  const runtime = fakeRuntime({
    async prompt() {
      runtime.calls.push('session/prompt');
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      return { stopReason: 'cancelled' };
    },
    async cancel() {
      runtime.calls.push('session/cancel');
      releasePrompt?.();
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new GrokProtocolV2Adapter(service, '0.3.0', (method, params) => {
    notifications.push({ method, params });
  });
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-interrupt',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    config: {},
  })) as { session: { streamId: string } };
  await adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 'host-interrupt',
    streamId: created.session.streamId,
    turnId: 'host-turn-interrupt',
    input: [{ type: 'text', text: 'hello' }],
    config: {},
  }));
  await adapter.handle(v2Request('4', 'turn.interrupt', {
    sessionId: 'host-interrupt',
    streamId: created.session.streamId,
    turnId: 'host-turn-interrupt',
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const completed = notifications.find(notification => notification.method === 'turn.completed');
  assert.equal((completed?.params.data as { stopReason?: string })?.stopReason, 'interrupted');
  await service.close();

  const cancelledNotes: Array<{ method: string; params: Record<string, unknown> }> = [];
  const cancelledRuntime = fakeRuntime({
    async prompt() {
      cancelledRuntime.calls.push('session/prompt');
      return { stopReason: 'cancelled' };
    },
  });
  const cancelledService = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => cancelledRuntime,
  });
  const cancelledAdapter = new GrokProtocolV2Adapter(
    cancelledService,
    '0.3.0',
    (method, params) => cancelledNotes.push({ method, params }),
  );
  await cancelledAdapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const cancelledSession = await cancelledAdapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-cancel',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    config: {},
  })) as { session: { streamId: string } };
  await cancelledAdapter.handle(v2Request('3', 'turn.start', {
    sessionId: 'host-cancel',
    streamId: cancelledSession.session.streamId,
    turnId: 'host-turn-cancel',
    input: [{ type: 'text', text: 'hello' }],
    config: {},
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cancelled = cancelledNotes.find(notification => notification.method === 'turn.completed');
  assert.equal((cancelled?.params.data as { stopReason?: string })?.stopReason, 'cancelled');
  await cancelledService.close();
});

test('Grok gian.proxy/2 keeps live and replay eventIds stable and imports native history', async () => {
  const runtime = fakeRuntime({
    async loadSession() {
      runtime.calls.push('session/load');
      runtime.emit('sessionUpdate', {
        sessionId: 'native-load',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'old question' },
        },
      });
      runtime.emit('sessionUpdate', {
        sessionId: 'native-load',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'old answer' },
        },
      });
      return { sessionId: 'native-load' };
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new GrokProtocolV2Adapter(service, '0.3.0', (method, params) => {
    notifications.push({ method, params });
  });
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-history',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    nativeSession: { id: 'native-load', history: 'replay' },
    config: {},
  })) as { session: { streamId: string } };
  const imported = await adapter.handle(v2Request('3', 'session.replay', {
    sessionId: 'host-history',
    streamId: created.session.streamId,
    cursor: null,
    limit: 100,
  })) as { events: Array<{ method: string; eventId: string; data: Record<string, unknown> }> };
  assert.ok(imported.events.some(event => event.method === 'input.recorded'));
  assert.ok(imported.events.some(event => (
    event.method === 'content.delta' && event.data.delta === 'old answer'
  )));

  await adapter.handle(v2Request('4', 'turn.start', {
    sessionId: 'host-history',
    streamId: created.session.streamId,
    turnId: 'host-turn-stable',
    input: [{ type: 'text', text: 'next' }],
    config: {},
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const live = notifications.filter(notification => (
    notification.params.turnId === 'host-turn-stable'
    && typeof notification.params.eventId === 'string'
  ));
  const replayed = await adapter.handle(v2Request('5', 'session.replay', {
    sessionId: 'host-history',
    streamId: created.session.streamId,
    cursor: null,
    limit: 100,
  })) as { events: Array<{ method: string; eventId: string; sourceTurnId: string }> };
  for (const notification of live) {
    const match = replayed.events.find(event => (
      event.method === notification.method
      && event.sourceTurnId === 'host-turn-stable'
      && event.eventId === notification.params.eventId
    ));
    if (['turn.started', 'content.delta', 'turn.completed'].includes(notification.method)) {
      assert.ok(match, `replay missing stable ${notification.method}`);
    }
  }
  await service.close();
});

test('unknown ACP session updates become diagnostic activities and late events are fenced', async () => {
  const runtime = fakeRuntime({
    async prompt() {
      runtime.calls.push('session/prompt');
      runtime.emit('extensionNotification', 'x.ai/models/update', {
        model: 'grok-4.6',
      });
      runtime.emit('extensionNotification', 'x.ai/models/update', {
        model: 'grok-4.6',
      });
      runtime.emit('sessionUpdate', {
        sessionId: 'native-1',
        update: { sessionUpdate: 'future_kind', hello: 'world' },
      });
      return { stopReason: 'end_turn' };
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new GrokProtocolV2Adapter(service, '0.3.0', (method, params) => {
    notifications.push({ method, params });
  });
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-unknown',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    config: {},
  })) as { session: { streamId: string } };
  await adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 'host-unknown',
    streamId: created.session.streamId,
    turnId: 'host-turn-unknown',
    input: [{ type: 'text', text: 'hello' }],
    config: {},
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(notifications.some(notification => (
    notification.method === 'activity.updated'
    && String((notification.params.data as { activityId?: string }).activityId ?? '').startsWith('grok-session-update-future_kind-')
  )));
  assert.equal(
    notifications.filter(notification => (
      notification.method === 'activity.updated'
      && (notification.params.data as { title?: unknown }).title === 'Grok model changed'
    )).length,
    1,
    'identical Grok extension facts must be suppressed before they consume sequence',
  );
  const sequenced = notifications.filter(notification => typeof notification.params.sequence === 'number');
  assert.deepEqual(
    sequenced.map(notification => notification.params.sequence),
    sequenced.map((_notification, index) => index + 1),
  );
  const before = notifications.length;
  runtime.emit('sessionUpdate', {
    sessionId: 'native-1',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'late' },
    },
  });
  assert.equal(notifications.length, before);
  await service.close();
});

test('identical session.create is idempotent and native list/delete stay consistent', async () => {
  const runtime = fakeRuntime({
    async deleteSession() {
      runtime.calls.push('x.ai/session/delete');
      throw new Error('session not found');
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const adapter = new GrokProtocolV2Adapter(service, '0.3.0', () => undefined);
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const params = {
    sessionId: 'host-idem',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    config: {},
  };
  const first = await adapter.handle(v2Request('2', 'session.create', params)) as {
    session: { streamId: string };
  };
  const second = await adapter.handle(v2Request('3', 'session.create', params)) as {
    session: { streamId: string };
  };
  assert.equal(second.session.streamId, first.session.streamId);
  const listed = await adapter.handle(v2Request('4', 'session.native.list', {
    cwd: '/workspace',
  })) as { sessions: Array<{ id: string }> };
  assert.equal(listed.sessions[0]?.id, 'listed');
  await assert.rejects(
    adapter.handle(v2Request('5', 'session.native.delete', {
      nativeSessionId: 'missing-native',
    })),
    (error: unknown) => error instanceof Error
      && 'domainCode' in error
      && (error as { domainCode: string }).domainCode === 'NATIVE_SESSION_NOT_FOUND',
  );
  await service.close();
});

test('a failed request flushes held turn notifications instead of dropping them', async () => {
  let releasePrompt: (() => void) | undefined;
  const runtime = fakeRuntime({
    async prompt() {
      runtime.calls.push('session/prompt');
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      return { stopReason: 'end_turn' };
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new GrokProtocolV2Adapter(service, '0.3.0', (method, params) => {
    notifications.push({ method, params });
  });
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-hold',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    config: {},
  })) as { session: { streamId: string } };
  adapter.beginRequest();
  await adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 'host-hold',
    streamId: created.session.streamId,
    turnId: 'host-turn-hold',
    input: [{ type: 'text', text: 'hello' }],
    config: {},
  }));
  adapter.flushNotifications();
  adapter.beginRequest();
  runtime.emit('sessionUpdate', {
    sessionId: 'native-1',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'streamed-while-held' },
    },
  });
  await assert.rejects(adapter.handle(v2Request('4', 'catalog.resolve', {})));
  adapter.flushNotifications();
  assert.ok(notifications.some(notification => (
    notification.method === 'content.delta'
    && (notification.params.data as { delta?: string }).delta === 'streamed-while-held'
  )));
  releasePrompt?.();
  await service.close();
});

test('identical content deltas in one turn keep distinct eventIds', async () => {
  const runtime = fakeRuntime({
    async prompt() {
      runtime.calls.push('session/prompt');
      runtime.emit('sessionUpdate', {
        sessionId: 'native-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\n' } },
      });
      runtime.emit('sessionUpdate', {
        sessionId: 'native-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\n' } },
      });
      return { stopReason: 'end_turn' };
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new GrokProtocolV2Adapter(service, '0.3.0', (method, params) => {
    notifications.push({ method, params });
  });
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-dup-delta',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    config: {},
  })) as { session: { streamId: string } };
  await adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 'host-dup-delta',
    streamId: created.session.streamId,
    turnId: 'host-turn-dup',
    input: [{ type: 'text', text: 'hello' }],
    config: {},
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const deltas = notifications.filter(notification => (
    notification.method === 'content.delta'
    && (notification.params.data as { delta?: string }).delta === '\n\n'
  ));
  assert.equal(deltas.length, 2);
  assert.notEqual(deltas[0]?.params.eventId, deltas[1]?.params.eventId);
  await service.close();
});

test('replay after a new adapter process reuses persisted live sourceTurnId and eventId', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-grok-identity-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const liveRuntime = fakeRuntime({
    async prompt() {
      liveRuntime.calls.push('session/prompt');
      liveRuntime.emit('sessionUpdate', {
        sessionId: 'native-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
      });
      return { stopReason: 'end_turn' };
    },
  });
  const liveService = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => liveRuntime,
  });
  const liveNotes: Array<{ method: string; params: Record<string, unknown> }> = [];
  const liveAdapter = new GrokProtocolV2Adapter(
    liveService,
    '0.3.0',
    (method, params) => liveNotes.push({ method, params }),
    new NativeTurnIdentityStore(dataDir),
  );
  await liveAdapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const created = await liveAdapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-persist',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    config: {},
  })) as { session: { streamId: string } };
  await liveAdapter.handle(v2Request('3', 'turn.start', {
    sessionId: 'host-persist',
    streamId: created.session.streamId,
    turnId: 'host-turn-persist',
    input: [{ type: 'text', text: 'old question' }],
    config: {},
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const liveStarted = liveNotes.find(notification => notification.method === 'turn.started');
  const liveDelta = liveNotes.find(notification => notification.method === 'content.delta');
  await liveService.close();

  const replayRuntime = fakeRuntime({
    async loadSession() {
      replayRuntime.calls.push('session/load');
      replayRuntime.emit('sessionUpdate', {
        sessionId: 'native-1',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'old question' },
        },
      });
      replayRuntime.emit('sessionUpdate', {
        sessionId: 'native-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'answer' },
        },
      });
      return { sessionId: 'native-1' };
    },
  });
  const replayService = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => replayRuntime,
  });
  const replayAdapter = new GrokProtocolV2Adapter(
    replayService,
    '0.3.0',
    () => undefined,
    new NativeTurnIdentityStore(dataDir),
  );
  await replayAdapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const adopted = await replayAdapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-persist-restart',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    nativeSession: { id: 'native-1', history: 'replay' },
    config: {},
  })) as { session: { streamId: string } };
  const replayed = await replayAdapter.handle(v2Request('3', 'session.replay', {
    sessionId: 'host-persist-restart',
    streamId: adopted.session.streamId,
    cursor: null,
    limit: 100,
  })) as { events: Array<{ method: string; eventId: string; sourceTurnId: string; data: Record<string, unknown> }> };
  const replayStarted = replayed.events.find(event => event.method === 'turn.started');
  const replayDelta = replayed.events.find(event => (
    event.method === 'content.delta' && event.data.delta === 'answer'
  ));
  assert.equal(replayStarted?.sourceTurnId, 'host-turn-persist');
  assert.equal(replayStarted?.eventId, liveStarted?.params.eventId);
  assert.equal(replayDelta?.eventId, liveDelta?.params.eventId);
  await replayService.close();
});

test('native turn identity persistence is bounded by least-recently-used cleanup', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-grok-identity-prune-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = 1;
  const store = new NativeTurnIdentityStore(dataDir, {
    maxEntries: 2,
    now: () => now,
  });
  store.recordLive('native-prune', 'host-old', [{ type: 'text', text: 'Old secret prompt' }]);
  now += 1;
  store.recordLive('native-prune', 'host-recent', [{ type: 'text', text: 'Recent secret prompt' }]);
  now += 1;
  store.recordLive('native-prune', 'host-old', [{ type: 'text', text: 'Old secret prompt' }]);
  now += 1;
  store.recordLive('native-prune', 'host-new', [{ type: 'text', text: 'New secret prompt' }]);

  const persisted = await readFile(join(dataDir, 'grok-native-turn-identities.json'), 'utf8');
  const identities = JSON.parse(persisted) as Array<{ sourceTurnId: string }>;
  assert.deepEqual(identities.map((entry) => entry.sourceTurnId), ['host-old', 'host-new']);
  assert.doesNotMatch(persisted, /secret prompt/i);

  const restarted = new NativeTurnIdentityStore(dataDir, { maxEntries: 2, now: () => now });
  assert.equal(
    restarted.resolveReplay('native-prune', 0, [{ type: 'text', text: 'Old secret prompt' }], 'fallback-old'),
    'host-old',
  );
  assert.equal(
    restarted.resolveReplay('native-prune', 1, [{ type: 'text', text: 'Recent secret prompt' }], 'fallback-evicted'),
    'fallback-evicted',
  );
});

test('Grok gian.proxy/2 maps ACP session/fork to durable Side Chat and head Fork', async () => {
  const baseMeta = initializeMeta();
  const forkMeta = {
    ...baseMeta,
    agentCapabilities: {
      ...baseMeta.agentCapabilities,
      sessionCapabilities: {
        ...baseMeta.agentCapabilities.sessionCapabilities,
        fork: {},
      },
    },
  };
  let nextNativeId = 2;
  const forkCalls: string[] = [];
  const runtime = fakeRuntime({
    negotiated: forkMeta,
    async ensureStarted() {
      runtime.calls.push('initialize');
      return forkMeta;
    },
    async forkSession(params: { sessionId: string }) {
      forkCalls.push(params.sessionId);
      return { sessionId: `native-${nextNativeId++}`, configOptions: [] };
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new GrokProtocolV2Adapter(service, '0.3.0', (method, params) => {
    notifications.push({ method, params });
    proxyNotificationSchema.parse({ jsonrpc: '2.0', method, params });
  });

  const initialized = resultSchemas.initialize.parse(await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Gian', version: '0.0.0' },
  })));
  assert.equal(initialized.capabilities.sidechat, 1);
  assert.equal(initialized.capabilities['session.fork'], 1);
  assert.equal(initialized.capabilities['session.fork.atTurn'], undefined);
  const catalog = resultSchemas['catalog.list'].parse(await adapter.handle(v2Request('2', 'catalog.list', {})));
  assert.equal(catalog.actions?.find((action) => action.id === 'sidechat.create')?.supported, true);
  assert.equal(catalog.actions?.find((action) => action.id === 'session.fork.atTurn')?.supported, false);

  const parent = resultSchemas['session.create'].parse(await adapter.handle(v2Request('3', 'session.create', {
    sessionId: 'parent',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    config: {},
  })));
  await adapter.handle(v2Request('4', 'turn.start', {
    sessionId: 'parent',
    streamId: parent.session.streamId,
    turnId: 'host-turn-1',
    input: [{ type: 'text', text: 'establish a boundary' }],
    config: {},
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(notifications.some((event) => event.method === 'turn.completed'));

  const forked = resultSchemas['session.fork'].parse(await adapter.handle(v2Request('5', 'session.fork', {
    sourceSessionId: 'parent',
    sourceStreamId: parent.session.streamId,
    sessionId: 'fork-1',
    anchor: { type: 'head' },
  })));
  assert.deepEqual(forked.origin, {
    kind: 'fork',
    sessionId: 'parent',
    turnId: 'host-turn-1',
    sourceTurnId: 'host-turn-1',
  });
  assert.ok(forked.session.nativeSession?.id);
  const replay = resultSchemas['session.replay'].parse(await adapter.handle(v2Request('6', 'session.replay', {
    sessionId: 'fork-1',
    streamId: forked.session.streamId,
    cursor: null,
    limit: 100,
  })));
  assert.ok(replay.events.some((event) => event.method === 'turn.completed'));

  const sidechat = resultSchemas['sidechat.create'].parse(await adapter.handle(v2Request('7', 'sidechat.create', {
    parentSessionId: 'parent',
    parentStreamId: parent.session.streamId,
    sidechatId: 'side-1',
  })));
  assert.deepEqual(sidechat.sidechat.anchor, {
    type: 'turn',
    turnId: 'host-turn-1',
    sourceTurnId: 'host-turn-1',
  });
  assert.equal(forkCalls.length, 2);
  assert.deepEqual(
    resultSchemas['sidechat.close'].parse(await adapter.handle(v2Request('8', 'sidechat.close', {
      sidechatId: 'side-1',
      streamId: sidechat.sidechat.streamId,
      resumeRef: sidechat.sidechat.resumeRef,
    }))),
    { ok: true, sidechatId: 'side-1', providerDataDeleted: false },
  );
  await service.close();
});

test('auth failures map to AUTH_REQUIRED', async () => {
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => fakeRuntime({
      async ensureStarted() {
        throw new Error('AUTH_REQUIRED: please login');
      },
    }),
  });
  await assert.rejects(service.listCapabilities(), /Workbench Terminal/);
});
