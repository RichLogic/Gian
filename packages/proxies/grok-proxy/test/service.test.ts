import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { proxyNotificationSchema, type ProxyNotification } from '@gian/proxy-protocol';

import { GrokProxyService } from '../src/core/service.js';
import { GrokProtocolV1Adapter } from '../src/protocol/v1-adapter.js';
import type { GrokAcpClient } from '../src/runtime/grok-acp-client.js';

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
  const notifications: ProxyNotification[] = [];
  const adapter = new GrokProtocolV1Adapter(service, '0.2.2', (notification) => {
    notifications.push(notification);
  });
  await adapter.handle({
    id: 1,
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['1.0'] },
      host: { name: 'Gian', version: '0.0.0' },
    },
  });
  const created = await adapter.handle({
    id: 2,
    method: 'session.create',
    params: {
      sessionId: 'host-sess',
      cwd: '/workspace',
      workspaceRoots: ['/workspace'],
      config: {},
    },
  }) as { session: { streamId: string } };
  await adapter.handle({
    id: 3,
    method: 'turn.start',
    params: {
      sessionId: 'host-sess',
      streamId: created.session.streamId,
      turnId: 'host-turn',
      input: [{ type: 'text', text: 'edit the file' }],
      policy: {
        workspaceRoots: ['/workspace'],
        approval: 'relay',
        network: 'allow',
      },
      config: { native: {} },
    },
  });

  for (const notification of notifications) {
    const parsed = proxyNotificationSchema.safeParse(notification);
    assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.format()));
  }
  const sequences = notifications.map((notification) => {
    const params = notification.params as { sequence?: number };
    assert.equal(typeof params.sequence, 'number');
    return params.sequence;
  });
  assert.deepEqual(sequences, sequences.map((_, index) => index + 1));
  const diff = notifications.find(notification => notification.method === 'diff.updated');
  assert.ok(diff, 'edit tool_call_update must emit diff.updated');
  assert.equal('path' in diff.params.data, false);
  assert.equal(
    (diff.params.data as { files?: Array<{ path?: string }> }).files?.[0]?.path,
    '/workspace/docs/a.md',
  );
  await adapter.handle({
    id: 4,
    method: 'session.close',
    params: { sessionId: 'host-sess', streamId: created.session.streamId },
  });
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
