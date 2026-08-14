import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { GrokProxyService } from '../src/core/service.js';
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
