import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { proxyNotificationSchema, replayEventSchemaUnion, resultSchemas } from '@gian/proxy-protocol';

import { GrokProxyService } from '../src/core/service.js';
import { NativeTurnIdentityStore } from '../src/protocol/replay-identity.js';
import { GrokProtocolV2Adapter, type WireRequest } from '../src/protocol/v2-adapter.js';
import type { GrokAcpClient, GrokAcpStopOptions } from '../src/runtime/grok-acp-client.js';

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
    async interject(params: unknown) {
      runtime.calls.push('x.ai/interject');
      runtime.prompts.push(params);
      return { status: 'queued' };
    },
    async closeSession() { runtime.calls.push('session/close'); },
    async stop() { runtime.calls.push('stop'); },
    ...overrides,
  });
  return runtime;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

test('catalog inspection force-stops its temporary runtime and waits for cleanup', async () => {
  let beginStop!: () => void;
  const stopping = new Promise<void>(resolve => { beginStop = resolve; });
  let finishStop!: () => void;
  const cleanup = new Promise<void>(resolve => { finishStop = resolve; });
  let stopOptions: GrokAcpStopOptions | undefined;
  const runtime = fakeRuntime({
    async stop(options?: GrokAcpStopOptions) {
      stopOptions = options;
      beginStop();
      await cleanup;
    },
  });
  const service = new GrokProxyService({ binaryPath: '/managed/grok', createRuntime: () => runtime });
  let settled = false;
  const pending = service.listCapabilities().then(value => { settled = true; return value; });
  await stopping;
  try {
    assert.deepEqual(stopOptions, { force: true });
    assert.equal(settled, false, 'the owned inspection child must be reaped before returning');
    assert.deepEqual(runtime.calls, ['initialize']);
  } finally {
    finishStop();
    await pending;
  }
});

test('concurrent and repeated catalog queries share one process-local inspection', async () => {
  let releaseInitialize!: () => void;
  const ready = new Promise<void>(resolve => { releaseInitialize = resolve; });
  const runtime = fakeRuntime({
    async ensureStarted() {
      runtime.calls.push('initialize');
      await ready;
      return initializeMeta();
    },
  });
  let created = 0;
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => { created += 1; return runtime; },
  });
  const first = service.listCapabilities();
  const second = service.listCapabilities();
  releaseInitialize();
  const [a, b] = await Promise.all([first, second]);
  service.setPermissionMode('always_approve');
  const c = await service.listCapabilities();
  assert.deepEqual(a.models, b.models);
  assert.deepEqual(a.models, c.models);
  assert.equal(created, 1);
  assert.deepEqual(runtime.calls, ['initialize', 'stop']);
  assert.equal(c.sessionOptions.find(option => option.id === 'permission_mode')?.currentValue, 'always_approve');
});

test('failed catalog inspections clean up and remain retryable', async () => {
  const stopOptions: Array<GrokAcpStopOptions | undefined> = [];
  const failing = fakeRuntime({
    async ensureStarted() { throw new Error('AUTH_REQUIRED: please login'); },
    async stop(options?: GrokAcpStopOptions) { stopOptions.push(options); },
  });
  const healthy = fakeRuntime({
    async stop(options?: GrokAcpStopOptions) { stopOptions.push(options); },
  });
  let created = 0;
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => ++created === 1 ? failing : healthy,
  });
  await assert.rejects(service.listCapabilities(), /Workbench Terminal/);
  assert.equal((await service.listCapabilities()).models[0]?.id, 'grok-4.6');
  assert.equal(created, 2);
  assert.deepEqual(stopOptions, [{ force: true }, { force: true }]);
});

test('a catalog cleanup failure does not poison later inspections', async () => {
  const failing = fakeRuntime({ async stop() { throw new Error('inspection cleanup failed'); } });
  const healthy = fakeRuntime();
  let created = 0;
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => ++created === 1 ? failing : healthy,
  });
  await assert.rejects(service.listCapabilities(), /inspection cleanup failed/);
  assert.equal((await service.listCapabilities()).models[0]?.id, 'grok-4.6');
  assert.equal(created, 2);
});

test('empty model metadata remains refreshable instead of becoming a sticky catalog', async () => {
  const empty = fakeRuntime({
    async ensureStarted() {
      return { ...initializeMeta(), _meta: { modelState: { availableModels: [] } } };
    },
  });
  const healthy = fakeRuntime();
  let created = 0;
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => ++created === 1 ? empty : healthy,
  });
  assert.deepEqual((await service.listCapabilities()).models, []);
  assert.equal((await service.listCapabilities()).models[0]?.id, 'grok-4.6');
  assert.equal(created, 2);
});

test('catalog metadata is not shared between service instances', async () => {
  const a = new GrokProxyService({ binaryPath: '/managed/grok', createRuntime: () => fakeRuntime() });
  const b = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => fakeRuntime({
      async ensureStarted() {
        return { ...initializeMeta(), _meta: { modelState: {
          currentModelId: 'grok-other',
          availableModels: [{ modelId: 'grok-other', name: 'Other profile model' }],
        } } };
      },
    }),
  });
  assert.equal((await a.listCapabilities()).models[0]?.id, 'grok-4.6');
  assert.equal((await b.listCapabilities()).models[0]?.id, 'grok-other');
  assert.equal((await a.listCapabilities()).models[0]?.id, 'grok-4.6');
});

test('catalog fast cleanup does not change live session shutdown', async () => {
  const inspectionStops: Array<GrokAcpStopOptions | undefined> = [];
  const sessionStops: Array<GrokAcpStopOptions | undefined> = [];
  const inspection = fakeRuntime({
    async stop(options?: GrokAcpStopOptions) { inspectionStops.push(options); },
  });
  const session = fakeRuntime({
    async stop(options?: GrokAcpStopOptions) { sessionStops.push(options); },
  });
  let created = 0;
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => ++created === 1 ? inspection : session,
  });
  await service.listCapabilities();
  const attached = await service.createSession({ cwd: '/workspace' });
  await service.closeSession({ sessionId: attached.session.id });
  assert.deepEqual(inspectionStops, [{ force: true }]);
  assert.deepEqual(sessionStops, [undefined]);
  assert.ok(session.calls.includes('session/close'));
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

test('rename surfaces method-not-found honestly instead of faking success', async () => {
  const runtime = fakeRuntime({
    async renameSession() {
      runtime.calls.push('x.ai/session/rename');
      const error = new Error('Method not found: x.ai/session/rename');
      (error as { code?: number }).code = -32601;
      throw error;
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const created = await service.createSession({ cwd: '/workspace' });
  await assert.rejects(
    service.renameSession({
      sessionId: created.session.id,
      name: 'New conversation',
    }),
    (error: unknown) => (error as { code?: string }).code === 'CAPABILITY_NOT_SUPPORTED',
  );
  await service.closeSession({ sessionId: created.session.id });
});

test('permission draft changes on the next turn and does not notify immediately', async () => {
  const notices: Array<Record<string, unknown>> = [];
  let audience = '';
  const runtime = fakeRuntime({
    async newSession(params: { _meta?: { clientIdentifier?: string } }) {
      runtime.calls.push('session/new');
      audience = params._meta?.clientIdentifier ?? '';
      return { sessionId: 'native-1' };
    },
    async notifyPermissionMode(params: Record<string, unknown>) {
      runtime.calls.push('x.ai/yolo_mode_changed');
      notices.push(params);
    },
  });
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
  assert.ok(!runtime.calls.includes('x.ai/yolo_mode_changed'));
  assert.ok(!runtime.calls.includes('session/set_mode'));
  await service.startTurn({
    sessionId: created.session.id,
    input: [{ type: 'text', text: 'hello' }],
  });
  assert.match(audience, /^gian-grok-proxy:aud_/);
  assert.deepEqual(notices, [{
    sessionId: 'native-1',
    clientIdentifier: audience,
    permission_mode: 'always-approve',
    yolo_mode: true,
    auto_mode: false,
  }]);
  const notifyAt = runtime.calls.indexOf('x.ai/yolo_mode_changed');
  const promptAt = runtime.calls.indexOf('session/prompt');
  assert.ok(notifyAt >= 0 && notifyAt < promptAt);
  await service.closeSession({ sessionId: created.session.id });
});

/**
 * grok-build `apply_yolo_mode_to_matching_sessions`: an omitted sender matches
 * every resident session, and a sender matches only `origin_client.product`.
 * `sessionId` is not part of that match. Session `_meta.clientIdentifier` is
 * the product.
 */
function nativeYoloMatches(sender: string | undefined, origin: string): boolean {
  return sender == null || origin === sender;
}

test('native fork permission changes do not match the other session origin', async () => {
  const notices: Array<Record<string, unknown>> = [];
  const releases: Array<() => void> = [];
  const origins: { parent: string | undefined; child: string | undefined } = {
    parent: undefined,
    child: undefined,
  };
  const runtime = fakeRuntime({
    extensions: {
      supports: (method: string) => method === 'x.ai/session/fork',
    },
    async newSession(params: { _meta?: { clientIdentifier?: string } }) {
      runtime.calls.push('session/new');
      origins.parent = params._meta?.clientIdentifier;
      return { sessionId: 'native-parent' };
    },
    async resumeSession(params: { sessionId: string; _meta?: { clientIdentifier?: string } }) {
      runtime.calls.push('session/resume');
      origins.child = params._meta?.clientIdentifier;
      return { sessionId: params.sessionId };
    },
    async nativeForkSession() {
      runtime.calls.push('x.ai/session/fork');
      return { newSessionId: 'native-child' };
    },
    async notifyPermissionMode(params: Record<string, unknown>) {
      runtime.calls.push('x.ai/yolo_mode_changed');
      notices.push(params);
    },
    async prompt() {
      runtime.calls.push('session/prompt');
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      return { stopReason: 'end_turn' };
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const parent = await service.createSession({ cwd: '/workspace' });
  const child = await service.forkSession({ sessionId: parent.session.id });
  await service.setConfigOption({
    sessionId: child.session.id,
    configId: 'permission_mode',
    value: 'always_approve',
  });
  const parentTurn = service.startTurn({
    sessionId: parent.session.id,
    input: [{ type: 'text', text: 'parent' }],
  });
  const childTurn = service.startTurn({
    sessionId: child.session.id,
    input: [{ type: 'text', text: 'child' }],
  });
  await waitFor(() => notices.length === 2 && releases.length === 2, 'both permission notices');
  assert.match(origins.parent ?? '', /^gian-grok-proxy:aud_/);
  assert.match(origins.child ?? '', /^gian-grok-proxy:aud_/);
  assert.notEqual(origins.parent, origins.child);
  const parentNotice = notices.find((notice) => notice.clientIdentifier === origins.parent);
  const childNotice = notices.find((notice) => notice.clientIdentifier === origins.child);
  assert.equal(parentNotice?.permission_mode, 'default');
  assert.equal(parentNotice?.yolo_mode, false);
  assert.equal(parentNotice?.sessionId, 'native-parent');
  assert.equal(childNotice?.permission_mode, 'always-approve');
  assert.equal(childNotice?.yolo_mode, true);
  assert.equal(childNotice?.sessionId, 'native-child');
  assert.equal(nativeYoloMatches(undefined, origins.parent ?? ''), true);
  assert.equal(nativeYoloMatches(childNotice?.clientIdentifier as string, origins.parent ?? ''), false);
  assert.equal(nativeYoloMatches(parentNotice?.clientIdentifier as string, origins.child ?? ''), false);
  assert.equal(service.getSession({ sessionId: parent.session.id }).session.mode, 'default');
  assert.equal(service.getSession({ sessionId: child.session.id }).session.mode, 'always_approve');
  for (const release of releases) release();
  await parentTurn;
  await childTurn;
  await service.close();
});

test('a standard ACP fork refuses a permission mode the shared origin would broadcast', async () => {
  const notices: Array<Record<string, unknown>> = [];
  let audience = '';
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
  const runtime = fakeRuntime({
    negotiated: forkMeta,
    async ensureStarted() {
      runtime.calls.push('initialize');
      return forkMeta;
    },
    async newSession(params: { _meta?: { clientIdentifier?: string } }) {
      runtime.calls.push('session/new');
      audience = params._meta?.clientIdentifier ?? '';
      return { sessionId: 'native-parent' };
    },
    async forkSession() {
      runtime.calls.push('session/fork');
      return { sessionId: 'native-child', configOptions: [] };
    },
    async notifyPermissionMode(params: Record<string, unknown>) {
      runtime.calls.push('x.ai/yolo_mode_changed');
      notices.push(params);
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const parent = await service.createSession({ cwd: '/workspace' });
  const child = await service.forkSession({ sessionId: parent.session.id });
  await service.setConfigOption({
    sessionId: child.session.id,
    configId: 'permission_mode',
    value: 'always_approve',
  });
  await assert.rejects(
    service.startTurn({
      sessionId: child.session.id,
      input: [{ type: 'text', text: 'child' }],
    }),
    (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
  );
  assert.equal(notices.length, 0);
  assert.equal(runtime.calls.filter((call) => call === 'session/prompt').length, 0);
  assert.equal(service.getSession({ sessionId: parent.session.id }).session.mode, 'default');
  assert.equal(service.getSession({ sessionId: child.session.id }).session.status, 'idle');
  await service.startTurn({
    sessionId: parent.session.id,
    input: [{ type: 'text', text: 'parent' }],
  });
  assert.deepEqual(notices, [{
    sessionId: 'native-parent',
    clientIdentifier: audience,
    permission_mode: 'default',
    yolo_mode: false,
    auto_mode: false,
  }]);
  await service.close();
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
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
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
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
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

  const admittedRuntime = fakeRuntime({
    async mcpList() {
      admittedRuntime.calls.push('x.ai/mcp/list');
      return {
        sessionMcpResolved: true,
        servers: [{
          name: 'gian-tools',
          type: 'http',
          url: 'http://127.0.0.1:9',
          sourceLabel: 'client',
          session: { enabled: true, status: 'ready' },
        }],
      };
    },
  });
  const boundaries: Array<{ disallowMetaTools: boolean; spawnDenyRules: readonly string[] }> = [];
  const fresh = new GrokProtocolV2Adapter(new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: (_cwd, boundary) => {
      boundaries.push(boundary);
      return admittedRuntime;
    },
  }), '0.3.0', () => undefined);
  await fresh.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  await assert.rejects(
    fresh.handle(v2Request('2', 'session.create', {
      sessionId: 'host-mcp-stdio',
      workspace: { cwd: '/workspace', roots: ['/workspace'] },
      config: {},
      hostServices: [{
        id: 'local-tool',
        protocol: 'mcp',
        transport: { type: 'stdio', command: 'evil-binary' },
      }],
    })),
    /streamable-http/,
  );
  const admitted = await fresh.handle(v2Request('3', 'session.create', {
    sessionId: 'host-mcp-http',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    config: {},
    hostServices: [{
      id: 'gian-tools',
      protocol: 'mcp',
      transport: { type: 'streamable-http', url: 'http://127.0.0.1:9' },
    }],
  }));
  assert.ok(admitted);
  assert.equal(boundaries.at(-1)?.disallowMetaTools, false);
  assert.ok(!boundaries.at(-1)?.spawnDenyRules.includes('MCPTool(*)'));
  assert.ok(admittedRuntime.calls.includes('x.ai/mcp/list'));
});

test('Grok gian.proxy/2 returns an empty Replay Event page before native history exists', async () => {
  const runtime = fakeRuntime();
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const adapter = new GrokProtocolV2Adapter(service, '0.3.0', () => undefined);
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
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

test('Grok gian.proxy/2 applies turn-bound model and thinking on turn.start', async () => {
  const runtime = fakeRuntime();
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const adapter = new GrokProtocolV2Adapter(service, '0.3.0', () => undefined);
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-bind',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    config: {},
  })) as { session: { streamId: string } };
  await assert.rejects(
    adapter.handle(v2Request('3', 'turn.start', {
      sessionId: 'host-bind',
      streamId: created.session.streamId,
      turnId: 'host-turn-bind',
      input: [{ type: 'text', text: 'hello' }],
      config: { sandbox_profile: 'workspace' },
    })),
    (error: unknown) => error instanceof Error
      && 'domainCode' in error
      && (error as { domainCode: string }).domainCode === 'CONFIG_BINDING_INVALID',
  );
  assert.equal(runtime.calls.filter(call => call === 'session/set_model').length, 0);
  assert.ok(!runtime.calls.includes('x.ai/yolo_mode_changed'));
  await assert.rejects(
    adapter.handle(v2Request('4', 'turn.start', {
      sessionId: 'host-bind',
      streamId: created.session.streamId,
      turnId: 'host-turn-invalid-model',
      input: [{ type: 'text', text: 'hello' }],
      config: { model: 'not-a-model' },
    })),
    (error: unknown) => error instanceof Error
      && 'domainCode' in error
      && (error as { domainCode: string }).domainCode === 'CONFIG_VALUE_INVALID',
  );
  assert.equal(runtime.calls.filter(call => call === 'session/set_model').length, 0);
  const started = await adapter.handle(v2Request('5', 'turn.start', {
    sessionId: 'host-bind',
    streamId: created.session.streamId,
    turnId: 'host-turn-model',
    input: [{ type: 'text', text: 'hello' }],
    config: { model: 'grok-4.6', reasoning_effort: 'low' },
  })) as { accepted?: boolean };
  assert.equal(started.accepted, true);
  assert.deepEqual(
    runtime.prompts.filter((item) => (
      Boolean(item) && typeof item === 'object' && 'modelId' in (item as object)
    )),
    [
      { sessionId: 'native-1', modelId: 'grok-4.6' },
      { sessionId: 'native-1', modelId: 'grok-4.6', _meta: { reasoningEffort: 'low' } },
    ],
  );
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
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  await adapter.handle(v2Request('2', 'catalog.list', {}));
  await assert.rejects(
    adapter.handle(v2Request('3', 'session.create', {
      sessionId: 'host-turn-model',
      workspace: { cwd: '/workspace', roots: ['/workspace'] },
      config: { model: 'grok-4.6' },
    })),
    (error: unknown) => error instanceof Error
      && 'domainCode' in error
      && (error as { domainCode: string }).domainCode === 'CONFIG_BINDING_INVALID',
  );
  await assert.rejects(
    adapter.handle(v2Request('4', 'session.create', {
      sessionId: 'host-invalid',
      workspace: { cwd: '/workspace', roots: ['/workspace'] },
      config: { permission_mode: 'not-a-mode' },
    })),
    (error: unknown) => error instanceof Error
      && 'domainCode' in error
      && (error as { domainCode: string }).domainCode === 'CONFIG_VALUE_INVALID',
  );
  assert.ok(!runtime.calls.includes('session/new'));
  await service.close();
});

test('session.create accepts the Host attachment directory beside the session cwd', async () => {
  const runtime = fakeRuntime();
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const adapter = new GrokProtocolV2Adapter(service, '0.3.0', () => undefined);
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  await assert.rejects(
    adapter.handle(v2Request('2', 'session.create', {
      sessionId: 'host-missing-cwd',
      workspace: { cwd: '/workspace', roots: ['/elsewhere'] },
      config: {},
    })),
    (error: unknown) => error instanceof Error
      && 'domainCode' in error
      && (error as { domainCode: string }).domainCode === 'CONFIG_VALUE_INVALID',
  );
  const created = await adapter.handle(v2Request('3', 'session.create', {
    sessionId: 'host-attachment-root',
    workspace: {
      cwd: '/workspace',
      roots: ['/workspace', '/tmp/gian-attachments/host-attachment-root'],
    },
    config: { permission_mode: 'default' },
  })) as { session: { state: string; sessionConfig: Record<string, unknown> } };
  assert.equal(created.session.state, 'idle');
  assert.equal(created.session.sessionConfig.permission_mode, undefined);
  assert.equal(created.session.sessionConfig.sandbox_profile, 'workspace');
  assert.equal(created.session.sessionConfig.model, undefined);
  assert.ok(runtime.calls.includes('session/new'));
  await service.close();
});

test('catalog.resolve keeps the full model list and returns both default maps', async () => {
  const meta = initializeMeta();
  const models = meta._meta.modelState.availableModels as Array<{
    modelId: string;
    name?: string;
  }>;
  models.push({ modelId: 'grok-fast', name: 'Grok Fast' });
  const runtime = fakeRuntime({
    negotiated: meta,
    async ensureStarted() {
      runtime.calls.push('initialize');
      return meta;
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const adapter = new GrokProtocolV2Adapter(service, '0.3.0', () => undefined);
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const resolved = resultSchemas['catalog.resolve'].parse(await adapter.handle(v2Request('2', 'catalog.resolve', {
    catalogRevision: 'rev-1',
    sessionConfig: {},
    turnConfig: { model: 'grok-4.6' },
  })));
  const model = resolved.configOptions.find((option) => option.id === 'model');
  assert.equal(model?.binding, 'turn');
  assert.deepEqual(model?.choices?.map((choice) => choice.value), ['grok-4.6', 'grok-fast']);
  assert.equal(model?.defaultValue, 'grok-4.6');
  const effort = resolved.configOptions.find((option) => option.id === 'reasoning_effort');
  assert.equal(effort?.binding, 'turn');
  assert.deepEqual(effort?.choices?.map((choice) => choice.value), ['high', 'low']);
  assert.equal(resolved.resolvedDefaults.turnConfig.model, 'grok-4.6');
  assert.equal(resolved.resolvedDefaults.turnConfig.reasoning_effort, 'high');
  assert.equal(resolved.resolvedDefaults.turnConfig.permission_mode, 'default');
  assert.equal(resolved.resolvedDefaults.sessionConfig.permission_mode, undefined);
  assert.equal(resolved.resolvedDefaults.sessionConfig.sandbox_profile, 'workspace');
  assert.equal(resolved.resolvedDefaults.sessionConfig.model, undefined);
  const dropped = resultSchemas['catalog.resolve'].parse(await adapter.handle(v2Request('3', 'catalog.resolve', {
    catalogRevision: 'rev-1',
    sessionConfig: {},
    turnConfig: { model: 'grok-fast', reasoning_effort: 'high' },
  })));
  assert.equal(dropped.configOptions.some((option) => option.id === 'reasoning_effort'), false);
  assert.equal(dropped.specialCatalogs?.thinking, undefined);
  assert.equal(dropped.resolvedDefaults.turnConfig.model, 'grok-fast');
  assert.equal(dropped.resolvedDefaults.turnConfig.reasoning_effort, undefined);
  const lifted = resultSchemas['catalog.resolve'].parse(await adapter.handle(v2Request('4', 'catalog.resolve', {
    catalogRevision: 'rev-1',
    sessionConfig: { model: 'grok-4.6' },
    turnConfig: {},
  })));
  assert.equal(lifted.configOptions.find((option) => option.id === 'model')?.binding, 'turn');
  assert.equal(lifted.resolvedDefaults.turnConfig.model, 'grok-4.6');
  assert.equal(lifted.resolvedDefaults.turnConfig.reasoning_effort, 'high');
  assert.equal(lifted.resolvedDefaults.sessionConfig.model, undefined);
  assert.equal(lifted.resolvedDefaults.sessionConfig.reasoning_effort, undefined);
  assert.equal(lifted.resolvedDefaults.turnConfig.permission_mode, 'default');
  assert.equal(lifted.resolvedDefaults.sessionConfig.permission_mode, undefined);
  const stalePage = resultSchemas['catalog.resolve'].parse(await adapter.handle(v2Request('4b', 'catalog.resolve', {
    catalogRevision: 'rev-1',
    sessionConfig: {
      model: 'grok-4.6',
      reasoning_effort: 'low',
      permission_mode: 'default',
    },
    turnConfig: {},
  })));
  assert.equal(stalePage.resolvedDefaults.turnConfig.model, 'grok-4.6');
  assert.equal(stalePage.resolvedDefaults.sessionConfig.model, undefined);
  assert.equal(stalePage.resolvedDefaults.sessionConfig.reasoning_effort, undefined);
  assert.equal(stalePage.resolvedDefaults.sessionConfig.permission_mode, undefined);
  assert.equal(stalePage.resolvedDefaults.turnConfig.permission_mode, 'default');
  assert.deepEqual(
    stalePage.configOptions.find((option) => option.id === 'reasoning_effort')?.choices?.map((choice) => choice.value),
    ['high', 'low'],
  );
  const turnWins = resultSchemas['catalog.resolve'].parse(await adapter.handle(v2Request('7', 'catalog.resolve', {
    catalogRevision: 'rev-1',
    sessionConfig: { model: 'grok-fast', reasoning_effort: 'low' },
    turnConfig: { model: 'grok-4.6', reasoning_effort: 'high' },
  })));
  assert.equal(turnWins.resolvedDefaults.turnConfig.model, 'grok-4.6');
  assert.equal(turnWins.resolvedDefaults.sessionConfig.model, undefined);
  assert.equal(turnWins.resolvedDefaults.sessionConfig.reasoning_effort, undefined);
  assert.deepEqual(
    turnWins.configOptions.find((option) => option.id === 'reasoning_effort')?.choices?.map((choice) => choice.value),
    ['high', 'low'],
  );
  await assert.rejects(
    adapter.handle(v2Request('5', 'catalog.resolve', {
      catalogRevision: 'rev-1',
      sessionConfig: {},
      turnConfig: { sandbox_profile: 'workspace' },
    })),
    (error: unknown) => error instanceof Error
      && 'domainCode' in error
      && (error as { domainCode: string }).domainCode === 'CONFIG_BINDING_INVALID',
  );
  await assert.rejects(
    adapter.handle(v2Request('6', 'catalog.resolve', {
      catalogRevision: 'rev-1',
      sessionConfig: {},
      turnConfig: { model: 'not-a-model' },
    })),
    (error: unknown) => error instanceof Error
      && 'domainCode' in error
      && (error as { domainCode: string }).domainCode === 'CONFIG_VALUE_INVALID',
  );
  assert.ok(!runtime.calls.includes('session/new'));
  assert.ok(!runtime.calls.includes('session/prompt'));
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
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
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
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
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
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
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
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
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

test('turn config notices stay behind turn.started and usage deltas keep a turn', async () => {
  const runtime = fakeRuntime({
    async setSessionModel(params: unknown) {
      runtime.calls.push('session/set_model');
      runtime.prompts.push(params);
      runtime.emit('extensionNotification', 'x.ai/model_changed', {
        sessionId: 'native-1',
        modelId: 'grok-4.6',
      });
      return {};
    },
    async prompt() {
      runtime.calls.push('session/prompt');
      return {
        stopReason: 'end_turn',
        _meta: { inputTokens: 3, outputTokens: 2, totalTokens: 10 },
      };
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
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-model-turn',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    config: {},
  })) as { session: { streamId: string } };
  adapter.beginRequest();
  await adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 'host-model-turn',
    streamId: created.session.streamId,
    turnId: 'host-turn-model',
    input: [{ type: 'text', text: 'hi' }],
    config: { model: 'grok-4.6', reasoning_effort: 'low' },
  }));
  adapter.flushNotifications();
  for (let attempt = 0; attempt < 50 && !notifications.some(notification => notification.method === 'turn.completed'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const turnNotes = notifications.filter(notification => notification.params.turnId === 'host-turn-model');
  assert.equal(turnNotes[0]?.method, 'turn.started');
  assert.ok(turnNotes.some(notification => (
    notification.method === 'activity.updated'
    && (notification.params.data as { title?: string }).title === 'Grok model changed'
  )));
  const usage = notifications.find(notification => (
    notification.method === 'usage.updated'
    && (notification.params.data as { conversation?: { mode?: string } }).conversation?.mode === 'delta'
  ));
  assert.equal(usage?.params.turnId, 'host-turn-model');
  assert.equal(usage?.params.sourceTurnId, 'host-turn-model');
  for (const notification of notifications) {
    proxyNotificationSchema.parse({ jsonrpc: '2.0', method: notification.method, params: notification.params });
  }
  const sequenced = notifications.filter(notification => typeof notification.params.sequence === 'number');
  assert.deepEqual(
    sequenced.map(notification => notification.params.sequence),
    sequenced.map((_notification, index) => index + 1),
  );
  await service.close();
});

test('conversation usage after the turn ends is not a session-scoped delta', async () => {
  const runtime = fakeRuntime({
    async prompt() {
      runtime.calls.push('session/prompt');
      runtime.emit('extensionNotification', 'x.ai/turn_completed', {
        sessionId: 'native-1',
        stopReason: 'completed',
      });
      return {
        stopReason: 'end_turn',
        _meta: { inputTokens: 4, outputTokens: 1, totalTokens: 8 },
      };
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
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-usage-after',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    config: {},
  })) as { session: { streamId: string } };
  await adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 'host-usage-after',
    streamId: created.session.streamId,
    turnId: 'host-turn-usage',
    input: [{ type: 'text', text: 'hi' }],
    config: {},
  }));
  for (let attempt = 0; attempt < 50 && !notifications.some(notification => notification.method === 'turn.completed'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(notifications.some(notification => notification.method === 'turn.completed'));
  for (const notification of notifications) {
    proxyNotificationSchema.parse({ jsonrpc: '2.0', method: notification.method, params: notification.params });
    const conversation = (notification.params.data as { conversation?: { mode?: string } } | undefined)?.conversation;
    if (notification.method === 'usage.updated' && conversation?.mode === 'delta') {
      assert.equal(notification.params.turnId, 'host-turn-usage');
      assert.equal(notification.params.sourceTurnId, 'host-turn-usage');
    }
  }
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
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
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
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
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
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
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
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
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
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
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
  store.recordLive('native-prune', 'host-old', [{ type: 'text', text: 'Old secret prompt' }], 0);
  now += 1;
  store.recordLive('native-prune', 'host-recent', [{ type: 'text', text: 'Recent secret prompt' }], 1);
  now += 1;
  store.recordLive('native-prune', 'host-old', [{ type: 'text', text: 'Old secret prompt' }], 0);
  now += 1;
  store.recordLive('native-prune', 'host-new', [{ type: 'text', text: 'New secret prompt' }], 2);

  const persisted = await readFile(join(dataDir, 'grok-native-turn-identities.json'), 'utf8');
  const identities = JSON.parse(persisted) as Array<{ sourceTurnId: string }>;
  assert.deepEqual(identities.map((entry) => entry.sourceTurnId), ['host-old', 'host-new']);
  assert.doesNotMatch(persisted, /secret prompt/i);

  const restarted = new NativeTurnIdentityStore(dataDir, { maxEntries: 2, now: () => now });
  assert.equal(
    restarted.resolveReplay('native-prune', 0, [{ type: 'text', text: 'Old secret prompt' }], 'fallback-old').sourceTurnId,
    'host-old',
  );
  assert.equal(
    restarted.resolveReplay('native-prune', 1, [{ type: 'text', text: 'Recent secret prompt' }], 'fallback-evicted').sourceTurnId,
    'fallback-evicted',
  );
});

test('replay identity is positional: repeated text never steals another turn', () => {
  const store = new NativeTurnIdentityStore(undefined);
  const sameText = [{ type: 'text', text: '继续' }];
  store.recordLive('native-dup', 'host-turn-first', sameText, 0);
  store.recordLive('native-dup', 'host-turn-second', sameText, 1);

  // Each ordinal binds its own live id; identical text cannot cross them.
  assert.deepEqual(
    store.resolveReplay('native-dup', 0, sameText, 'fallback-0'),
    { sourceTurnId: 'host-turn-first', consistent: true },
  );
  assert.deepEqual(
    store.resolveReplay('native-dup', 1, sameText, 'fallback-1'),
    { sourceTurnId: 'host-turn-second', consistent: true },
  );

  // A live turn without a proven ordinal never binds a replay position.
  store.recordLive('native-dup', 'host-turn-unproven', sameText);
  assert.deepEqual(
    store.resolveReplay('native-dup', 2, sameText, 'fallback-2'),
    { sourceTurnId: 'fallback-2', consistent: null },
  );

  // A bound ordinal whose native text moved (compact/rewind) reports the
  // divergence instead of binding the stale id.
  assert.deepEqual(
    store.resolveReplay('native-dup', 1, [{ type: 'text', text: 'changed elsewhere' }], 'fallback-x'),
    { sourceTurnId: 'fallback-x', consistent: false },
  );

  // Multi-block and attachment-only inputs hash by text blocks only, so they
  // can verify a positional binding but never create one.
  assert.deepEqual(
    store.resolveReplay('native-dup', 0, [
      { type: 'text', text: '继续' },
      { type: 'localFile', path: '/tmp/a.png' },
    ], 'fallback-multi'),
    { sourceTurnId: 'host-turn-first', consistent: true },
  );
});

test('legacy hash-guessed identity records lose their ordinal binding on load', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-grok-identity-legacy-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const filePath = join(dataDir, 'grok-native-turn-identities.json');
  // Pre-marker format: replayIndex was guessed from the text hash, so a
  // repeated prompt could have bound the wrong position.
  await writeFile(filePath, `${JSON.stringify([{
    nativeSessionId: 'native-legacy',
    sourceTurnId: 'host-turn-legacy',
    inputHash: createHash('sha256').update(JSON.stringify(['same text'])).digest('hex').slice(0, 32),
    replayIndex: 0,
    lastUsedAt: 1,
  }])}\n`, { mode: 0o600 });

  const loaded = new NativeTurnIdentityStore(dataDir);
  // The binding is gone: the entry survives for cross-reference but no longer
  // claims ordinal 0.
  assert.deepEqual(
    loaded.resolveReplay('native-legacy', 0, [{ type: 'text', text: 'same text' }], 'fallback-legacy'),
    { sourceTurnId: 'fallback-legacy', consistent: null },
  );

  // A fresh proven record round-trips with its binding intact.
  loaded.recordLive('native-legacy', 'host-turn-proven', [{ type: 'text', text: 'same text' }], 0);
  const reloaded = new NativeTurnIdentityStore(dataDir);
  assert.deepEqual(
    reloaded.resolveReplay('native-legacy', 0, [{ type: 'text', text: 'same text' }], 'fallback-new'),
    { sourceTurnId: 'host-turn-proven', consistent: true },
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
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.0.0' },
  })));
  // This double has no interject probe, so steer stays undeclared.
  // Static Fork capabilities permit routing; catalog actions carry the
  // live support guard. Exact-turn support below remains unavailable.
  assert.equal(initialized.capabilities['turn.steer'], undefined);
  assert.equal(initialized.capabilities.sidechat, 1);
  assert.equal(initialized.capabilities['session.fork'], 1);
  assert.equal(initialized.capabilities['session.fork.atTurn'], 1);
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

test('a failed permission notification does not start the turn', async () => {
  const runtime = fakeRuntime({
    async notifyPermissionMode() {
      throw new Error('notify failed');
    },
  });
  const events: string[] = [];
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
    emitEvent: (method) => { events.push(method); },
  });
  const created = await service.createSession({ cwd: '/workspace' });
  await assert.rejects(
    service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'hello' }],
    }),
    /notify failed/,
  );
  assert.ok(!events.includes('turn.started'));
  assert.equal(service.getSession({ sessionId: created.session.id }).session.activeTurnId, null);
  assert.ok(!runtime.calls.includes('session/prompt'));
  await service.closeSession({ sessionId: created.session.id });
});

test('steer keeps every text block and does not accept a file or a non-queued result', async () => {
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
  const created = await service.createSession({ cwd: '/workspace' });
  const pending = service.startTurn({
    sessionId: created.session.id,
    input: [{ type: 'text', text: 'go' }],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(
    service.steerTurn({
      sessionId: created.session.id,
      input: [{ type: 'localFile', path: 'notes.txt' }],
    }),
    /File attachments are rejected/,
  );
  assert.equal(runtime.calls.filter((call) => call === 'x.ai/interject').length, 0);
  const steered = await service.steerTurn({
    sessionId: created.session.id,
    input: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }],
  });
  assert.equal(steered.ok, true);
  const payload = runtime.prompts.find((item) => (
    Boolean(item) && typeof item === 'object' && 'interjectionId' in (item as object)
  )) as { text?: string; content?: Array<{ text?: string }> };
  assert.equal(payload.text, 'one\ntwo');
  assert.deepEqual(payload.content?.map((block) => block.text), ['one', 'two']);
  releasePrompt?.();
  await pending;
  await service.close();
});

test('steer does not report accepted when Grok does not queue it', async () => {
  let releasePrompt: (() => void) | undefined;
  const runtime = fakeRuntime({
    async prompt() {
      runtime.calls.push('session/prompt');
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      return { stopReason: 'end_turn' };
    },
    async interject() {
      runtime.calls.push('x.ai/interject');
      return { status: 'dropped' };
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const created = await service.createSession({ cwd: '/workspace' });
  const pending = service.startTurn({
    sessionId: created.session.id,
    input: [{ type: 'text', text: 'go' }],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(
    service.steerTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'more' }],
    }),
    /did not queue/,
  );
  releasePrompt?.();
  await pending;
  await service.close();
});

test('sandbox profile is chosen before the child starts and cannot be widened later', async () => {
  const boundaries: Array<{ sandboxProfile: string; disallowMetaTools: boolean }> = [];
  const runtime = fakeRuntime();
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: (_cwd, boundary) => {
      boundaries.push(boundary);
      return runtime;
    },
  });
  const created = await service.createSession({ cwd: '/workspace', sandboxProfile: 'read-only' });
  assert.equal(boundaries.at(-1)?.sandboxProfile, 'read-only');
  assert.equal(boundaries.at(-1)?.disallowMetaTools, true);
  assert.equal(created.session.sandboxProfile, 'read-only');
  await assert.rejects(
    service.setConfigOption({
      sessionId: created.session.id,
      configId: 'sandbox_profile',
      value: 'off',
    }),
    (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
  );
  const same = await service.setConfigOption({
    sessionId: created.session.id,
    configId: 'sandbox_profile',
    value: 'read-only',
  });
  assert.equal(same.session.sandboxProfile, 'read-only');
  await service.closeSession({ sessionId: created.session.id });
});

test('Host MCP that is not the admitted HTTP set fails closed before the session exists', async () => {
  const runtime = fakeRuntime({
    async mcpList() {
      runtime.calls.push('x.ai/mcp/list');
      return {
        sessionMcpResolved: true,
        servers: [{
          name: 'plugin-tool',
          type: 'stdio',
          sourceLabel: 'plugin:extra',
          session: { enabled: true, status: 'ready' },
        }],
      };
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  service.setHostMcpServices([{
    id: 'gian-tools',
    protocol: 'mcp',
    transport: { type: 'streamable-http', url: 'http://127.0.0.1:9' },
  }]);
  await assert.rejects(
    service.createSession({ cwd: '/workspace' }),
    (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
  );
  assert.ok(runtime.calls.includes('stop'));
});

test('Host MCP catalog retries while initializing and then admits the matching server', async () => {
  let attempts = 0;
  const runtime = fakeRuntime({
    async mcpList() {
      attempts += 1;
      runtime.calls.push('x.ai/mcp/list');
      if (attempts < 3) return { sessionMcpResolved: false, servers: [] };
      return {
        sessionMcpResolved: true,
        servers: [{
          name: 'gian-tools',
          type: 'http',
          url: 'http://127.0.0.1:9',
          sourceLabel: 'client',
          session: { enabled: true, status: 'ready' },
        }],
      };
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  service.setHostMcpServices([{
    id: 'gian-tools',
    protocol: 'mcp',
    transport: { type: 'streamable-http', url: 'http://127.0.0.1:9' },
  }]);
  const created = await service.createSession({ cwd: '/workspace' });
  assert.equal(attempts, 3);
  assert.equal(created.session.status, 'idle');
  await service.closeSession({ sessionId: created.session.id });
});

test('a process-local MCP catalog notification is re-listed and does not block a matching session', async () => {
  let releasePrompt: (() => void) | undefined;
  let stops = 0;
  const admitted = {
    name: 'gian-tools',
    type: 'http',
    url: 'http://127.0.0.1:9',
    sourceLabel: 'client',
    session: { enabled: true, status: 'ready' },
  };
  const disabledExtra = {
    name: 'plugin-off',
    type: 'stdio',
    sourceLabel: 'plugin:extra',
    session: { enabled: false, status: 'disabled' },
  };
  let servers: Array<Record<string, unknown>> = [admitted, disabledExtra];
  let listCalls = 0;
  const runtime = fakeRuntime({
    async mcpList() {
      listCalls += 1;
      runtime.calls.push('x.ai/mcp/list');
      return { sessionMcpResolved: true, servers };
    },
    async prompt() {
      runtime.calls.push('session/prompt');
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      return { stopReason: 'end_turn' };
    },
    async cancel() {
      runtime.calls.push('session/cancel');
      releasePrompt?.();
    },
    async stop() {
      stops += 1;
      runtime.calls.push('stop');
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  service.setHostMcpServices([{
    id: 'gian-tools',
    protocol: 'mcp',
    transport: { type: 'streamable-http', url: 'http://127.0.0.1:9' },
  }]);
  const created = await service.createSession({ cwd: '/workspace' });
  const listedAtCreate = listCalls;
  const pending = service.startTurn({
    sessionId: created.session.id,
    input: [{ type: 'text', text: 'go' }],
  });
  await waitFor(() => releasePrompt != null, 'prompt to start');
  runtime.emit('extensionNotification', 'x.ai/mcp/servers_updated', { mcpServers: [] });
  await waitFor(() => listCalls > listedAtCreate, 'session mcp/list after servers_updated');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(service.getSession({ sessionId: created.session.id }).session.status, 'running');
  assert.equal(stops, 0);

  servers = [{
    name: 'other',
    type: 'http',
    url: 'http://127.0.0.1:1',
    sourceLabel: 'user',
    session: { enabled: true, status: 'ready' },
  }];
  runtime.emit('extensionNotification', 'x.ai/mcp/tools_changed', {
    sessionId: 'native-1',
    serverName: 'gian-tools',
    tools: [],
  });
  await waitFor(
    () => service.getSession({ sessionId: created.session.id }).session.status === 'error',
    'turn to fail after the real catalog mismatch',
  );
  assert.equal(stops, 0);
  await pending;
  await assert.rejects(
    service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'again' }],
    }),
    (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
  );
  await service.close();
});

test('MCP boundary cancel failure kills the child before the turn is failed', async () => {
  let releasePrompt: (() => void) | undefined;
  let stops = 0;
  let statusAtStop = '';
  let failedBeforeStop = false;
  const events: string[] = [];
  const admitted = {
    name: 'gian-tools',
    type: 'http',
    url: 'http://127.0.0.1:9',
    sourceLabel: 'client',
    session: { enabled: true, status: 'ready' },
  };
  let servers = [admitted];
  let service!: GrokProxyService;
  let created!: { session: { id: string } };
  const runtime = fakeRuntime({
    async mcpList() {
      runtime.calls.push('x.ai/mcp/list');
      return { sessionMcpResolved: true, servers };
    },
    async prompt() {
      runtime.calls.push('session/prompt');
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      return { stopReason: 'end_turn' };
    },
    async cancel() {
      runtime.calls.push('session/cancel');
      throw new Error('cancel failed');
    },
    async stop() {
      stops += 1;
      statusAtStop = service.getSession({ sessionId: created.session.id }).session.status;
      failedBeforeStop = events.includes('turn.failed');
      setTimeout(() => releasePrompt?.(), 0);
      runtime.calls.push('stop');
    },
  });
  service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
    emitEvent: (method) => { events.push(method); },
    turnStopDeadlineMs: 20,
  });
  service.setHostMcpServices([{
    id: 'gian-tools',
    protocol: 'mcp',
    transport: { type: 'streamable-http', url: 'http://127.0.0.1:9' },
  }]);
  created = await service.createSession({ cwd: '/workspace' });
  const pending = service.startTurn({
    sessionId: created.session.id,
    input: [{ type: 'text', text: 'go' }],
  });
  await waitFor(() => releasePrompt != null, 'prompt to start');
  servers = [{
    name: 'other',
    type: 'http',
    url: 'http://127.0.0.1:1',
    sourceLabel: 'user',
    session: { enabled: true, status: 'ready' },
  }];
  runtime.emit('extensionNotification', 'x.ai/mcp/servers_updated', { mcpServers: [] });
  await waitFor(() => stops === 1, 'child stop after cancel failure');
  assert.equal(statusAtStop, 'running');
  assert.equal(failedBeforeStop, false);
  await waitFor(() => events.includes('turn.failed'), 'turn.failed after the child stops');
  await pending;
  await assert.rejects(
    service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'again' }],
    }),
    (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
  );
  await service.close();
});

test('a hung MCP boundary cancel kills the child and reports a failed stop', async () => {
  let releasePrompt: (() => void) | undefined;
  let stops = 0;
  let statusAtStop = '';
  let failedBeforeStop = false;
  const events: Array<{ method: string; message?: string }> = [];
  const admitted = {
    name: 'gian-tools',
    type: 'http',
    url: 'http://127.0.0.1:9',
    sourceLabel: 'client',
    session: { enabled: true, status: 'ready' },
  };
  const unexpected = {
    name: 'other',
    type: 'http',
    url: 'http://127.0.0.1:1',
    sourceLabel: 'user',
    session: { enabled: true, status: 'ready' },
  };
  let servers = [admitted];
  let service!: GrokProxyService;
  let created!: { session: { id: string } };
  const runtime = fakeRuntime({
    async mcpList() {
      runtime.calls.push('x.ai/mcp/list');
      return { sessionMcpResolved: true, servers };
    },
    async prompt() {
      runtime.calls.push('session/prompt');
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      return { stopReason: 'end_turn' };
    },
    async cancel() {
      runtime.calls.push('session/cancel');
      await new Promise(() => undefined);
    },
    async stop() {
      stops += 1;
      statusAtStop = service.getSession({ sessionId: created.session.id }).session.status;
      failedBeforeStop = events.some((event) => event.method === 'turn.failed');
      setTimeout(() => releasePrompt?.(), 0);
      runtime.calls.push('stop');
      throw new Error('stop failed');
    },
  });
  service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
    emitEvent: (method, params) => {
      const data = params.data;
      const message = data && typeof data === 'object' && 'message' in data
        ? String((data as { message?: unknown }).message ?? '')
        : undefined;
      events.push({ method, ...(message ? { message } : {}) });
    },
    turnStopDeadlineMs: 20,
  });
  service.setHostMcpServices([{
    id: 'gian-tools',
    protocol: 'mcp',
    transport: { type: 'streamable-http', url: 'http://127.0.0.1:9' },
  }]);
  created = await service.createSession({ cwd: '/workspace' });
  const pending = service.startTurn({
    sessionId: created.session.id,
    input: [{ type: 'text', text: 'go' }],
  });
  await waitFor(() => releasePrompt != null, 'prompt to start');
  servers = [unexpected];
  runtime.emit('extensionNotification', 'x.ai/mcp/servers_updated', { mcpServers: [] });
  await waitFor(() => stops === 1, 'child stop after cancel hang');
  assert.equal(statusAtStop, 'running');
  assert.equal(failedBeforeStop, false);
  await waitFor(
    () => events.some((event) => event.method === 'turn.failed' && event.message?.includes('could not be stopped')),
    'turn.failed after the stop failure',
  );
  await pending;
  await assert.rejects(
    service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'again' }],
    }),
    (error: unknown) => (error as { code?: string }).code === 'CONFLICT'
      && (error as { message?: string }).message?.includes('could not be stopped') === true,
  );
  await service.close();
});

test('turn.steer is advertised only when the interject probe confirms', async () => {
  const silent = fakeRuntime();
  const silentAdapter = new GrokProtocolV2Adapter(new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => silent,
  }), '0.3.0', () => undefined);
  const silentInit = resultSchemas.initialize.parse(await silentAdapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.0.0' },
  })));
  assert.equal(silentInit.capabilities['turn.steer'], undefined);
  await assert.rejects(
    silentAdapter.handle(v2Request('2', 'turn.steer', {
      sessionId: 'missing',
      streamId: 'missing',
      turnId: 'missing',
      input: [{ type: 'text', text: 'later' }],
    })),
    (error: unknown) => error instanceof Error
      && 'domainCode' in error
      && (error as { domainCode: string }).domainCode === 'CAPABILITY_NOT_SUPPORTED',
  );

  const live = fakeRuntime({
    async probeInterjectRegistered() {
      return 'confirmed';
    },
  });
  const liveAdapter = new GrokProtocolV2Adapter(new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => live,
  }), '0.3.0', () => undefined);
  const liveInit = resultSchemas.initialize.parse(await liveAdapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.0.0' },
  })));
  assert.equal(liveInit.capabilities['turn.steer'], 1);
});

interface InteractionHarness {
  adapter: GrokProtocolV2Adapter;
  service: GrokProxyService;
  runtime: ReturnType<typeof fakeRuntime>;
  notifications: Array<{ method: string; params: Record<string, unknown> }>;
  reverse: Array<{ method: string; response: unknown }>;
  askExt(method: string, params: unknown): Promise<unknown>;
  askPermission(request: unknown): Promise<unknown>;
}

/** Adapter+service pair whose fake agent parks its prompt in a reverse call. */
async function interactionHarness(
  reverseCall: (
    askExt: (method: string, params: unknown) => Promise<unknown>,
    askPermission: (request: unknown) => Promise<unknown>,
  ) => Promise<void>,
): Promise<InteractionHarness> {
  let extHandler: ((method: string, params: unknown) => Promise<unknown>) | null = null;
  let permissionHandler: ((request: unknown) => Promise<unknown>) | null = null;
  const reverse: Array<{ method: string; response: unknown }> = [];
  const runtime = fakeRuntime({
    setExtMethodHandler(handler: (method: string, params: unknown) => Promise<unknown>) {
      extHandler = handler;
    },
    setPermissionHandler(handler: (request: unknown) => Promise<unknown>) {
      permissionHandler = handler;
    },
    async prompt() {
      runtime.calls.push('session/prompt');
      await reverseCall(
        async (method, params) => {
          const response = await extHandler?.(method, params);
          reverse.push({ method, response });
          return response;
        },
        async (request) => {
          const response = await permissionHandler?.(request);
          reverse.push({ method: 'session/request_permission', response });
          return response;
        },
      );
      return { stopReason: 'end_turn' };
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new GrokProtocolV2Adapter(service, '0.3.0', (method, params) => {
    // Every notification must survive the strict Host validator.
    proxyNotificationSchema.parse({ jsonrpc: '2.0', method, params });
    notifications.push({ method, params });
  });
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  return {
    adapter,
    service,
    runtime,
    notifications,
    reverse,
    askExt: (method, params) => {
      if (!extHandler) throw new Error('ext handler not registered');
      return extHandler(method, params);
    },
    askPermission: (request) => {
      if (!permissionHandler) throw new Error('permission handler not registered');
      return permissionHandler(request);
    },
  };
}

async function attachInteractionSession(harness: InteractionHarness, sessionId = 'host-ix') {
  const created = await harness.adapter.handle(v2Request('2', 'session.create', {
    sessionId,
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    config: {},
  })) as { session: { streamId: string } };
  return { streamId: created.session.streamId };
}

function notificationData(
  notifications: Array<{ method: string; params: Record<string, unknown> }>,
  method: string,
): Record<string, unknown>[] {
  return notifications
    .filter((notification) => notification.method === method)
    .map((notification) => notification.params.data as Record<string, unknown>);
}

test('question choices satisfy the strict Host schema and settled responses replay idempotently', async () => {
  const harness = await interactionHarness(async (askExt) => {
    await askExt('x.ai/ask_user_question', {
      sessionId: 'native-1',
      toolCallId: 'tc-q1',
      questions: [{
        question: 'Which database?',
        options: [
          { label: 'Redis', description: 'in-memory' },
          { label: 'Postgres', description: 'relational' },
        ],
      }],
    });
    await askExt('x.ai/ask_user_question', {
      sessionId: 'native-1',
      toolCallId: 'tc-q2',
      questions: [{ question: 'Again?' }],
    });
  });
  const { streamId } = await attachInteractionSession(harness);
  await harness.adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 'host-ix',
    streamId,
    turnId: 'turn-q',
    input: [{ type: 'text', text: 'ask' }],
    config: {},
  }));
  await waitFor(
    () => notificationData(harness.notifications, 'interaction.requested').length === 1,
    'first question card',
  );
  const requested = notificationData(harness.notifications, 'interaction.requested')[0]!;
  const inputs = requested.inputs as Array<Record<string, unknown>>;
  assert.equal(inputs.length, 1);
  const choices = inputs[0]!.choices as Array<Record<string, unknown>>;
  // R1: choices carry only value/displayName; option notes moved to the
  // input description, which the strict schema allows.
  for (const choice of choices) {
    assert.equal('description' in choice, false);
  }
  assert.match(String(inputs[0]!.description ?? ''), /Redis — in-memory/);
  assert.match(String(inputs[0]!.description ?? ''), /Postgres — relational/);

  const interactionId = String(requested.interactionId);
  const respond = (responseId: string, values: Record<string, unknown>, id = '10') => harness.adapter.handle(v2Request(id, 'interaction.respond', {
    sessionId: 'host-ix',
    streamId,
    turnId: 'turn-q',
    interactionId,
    responseId,
    actionId: 'submit',
    values,
  }));
  const accepted = await respond('r1', { 'Which database?': 'Redis' }) as { accepted?: boolean };
  assert.equal(accepted.accepted, true);
  // Identical retry while the interaction is still pending: accepted once.
  assert.equal((await respond('r1', { 'Which database?': 'Redis' }, '11') as { accepted?: boolean }).accepted, true);
  await assert.rejects(
    respond('r1', { 'Which database?': 'Postgres' }, '12'),
    (error: unknown) => (error as { domainCode?: string }).domainCode === 'CONFLICT',
  );

  // Second question in the same turn: a settled responseId must not move.
  await waitFor(
    () => notificationData(harness.notifications, 'interaction.requested').length === 2,
    'second question card',
  );
  const second = notificationData(harness.notifications, 'interaction.requested')[1]!;
  await assert.rejects(
    harness.adapter.handle(v2Request('13', 'interaction.respond', {
      sessionId: 'host-ix',
      streamId,
      turnId: 'turn-q',
      interactionId: String(second.interactionId),
      responseId: 'r1',
      actionId: 'submit',
      values: { 'Again?': 'yes' },
    })),
    (error: unknown) => (error as { domainCode?: string }).domainCode === 'CONFLICT',
  );
  await harness.adapter.handle(v2Request('14', 'interaction.respond', {
    sessionId: 'host-ix',
    streamId,
    turnId: 'turn-q',
    interactionId: String(second.interactionId),
    responseId: 'r2',
    actionId: 'submit',
    values: { 'Again?': 'yes' },
  }));
  await waitFor(
    () => notificationData(harness.notifications, 'turn.completed').length === 1,
    'turn completion',
  );
  assert.equal(harness.reverse.length, 2);
  assert.deepEqual(harness.reverse[0]!.response, {
    outcome: 'accepted',
    answers: { 'Which database?': ['Redis'] },
  });

  // After the turn ended, the identical settled response still replays as
  // accepted without re-executing anything natively; a different payload
  // conflicts; a fresh responseId cannot re-answer the finished interaction.
  assert.equal((await respond('r1', { 'Which database?': 'Redis' }, '15') as { accepted?: boolean }).accepted, true);
  await assert.rejects(
    respond('r1', { 'Which database?': 'Postgres' }, '16'),
    (error: unknown) => (error as { domainCode?: string }).domainCode === 'CONFLICT',
  );
  await assert.rejects(
    respond('r3', { 'Which database?': 'Redis' }, '17'),
    (error: unknown) => (error as { domainCode?: string }).domainCode === 'TURN_NOT_FOUND',
  );
  assert.equal(harness.reverse.length, 2);
  assert.equal(harness.runtime.calls.filter((call) => call === 'session/prompt').length, 1);
  await harness.service.close();
});

test('plan approval carries the plan body as context.subject with newlines intact', async () => {
  const plan = '# Plan\n\n- step one\n- step two';
  const harness = await interactionHarness(async (askExt) => {
    await askExt('x.ai/exit_plan_mode', {
      sessionId: 'native-1',
      toolCallId: 'tc-plan',
      planContent: plan,
    });
  });
  const { streamId } = await attachInteractionSession(harness);
  await harness.adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 'host-ix',
    streamId,
    turnId: 'turn-plan',
    input: [{ type: 'text', text: 'plan' }],
    config: {},
  }));
  await waitFor(
    () => notificationData(harness.notifications, 'interaction.requested').length === 1,
    'plan card',
  );
  const requested = notificationData(harness.notifications, 'interaction.requested')[0]!;
  const context = requested.context as Record<string, unknown>;
  // R9: the plan body renders through the subject channel the Host projects.
  assert.equal(context.subject, plan);
  assert.equal(context.plan, plan);
  const actions = requested.actions as Array<{ id: string }>;
  assert.deepEqual(actions.map((action) => action.id), ['approve', 'cancel']);
  await harness.adapter.handle(v2Request('10', 'interaction.respond', {
    sessionId: 'host-ix',
    streamId,
    turnId: 'turn-plan',
    interactionId: String(requested.interactionId),
    responseId: 'r1',
    actionId: 'approve',
    values: {},
  }));
  await waitFor(
    () => notificationData(harness.notifications, 'turn.completed').length === 1,
    'turn completion',
  );
  assert.deepEqual(harness.reverse[0]!.response, { outcome: 'approved' });
  await harness.service.close();
});

test('elicitation requestedSchema becomes protocol inputs and submit rebuilds native content', async () => {
  const harness = await interactionHarness(async (askExt) => {
    await askExt('x.ai/mcp/elicit', {
      sessionId: 'native-1',
      serverName: 'files',
      requestedSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', title: 'Path', minLength: 1, maxLength: 200 },
          level: { type: 'string', enum: ['ro', 'rw'], enumNames: ['Read only', 'Read write'] },
          recursive: { type: 'boolean', description: 'Recurse into subdirectories' },
        },
        required: ['path', 'level'],
      },
    });
  });
  const { streamId } = await attachInteractionSession(harness);
  await harness.adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 'host-ix',
    streamId,
    turnId: 'turn-elicit',
    input: [{ type: 'text', text: 'elicit' }],
    config: {},
  }));
  await waitFor(
    () => notificationData(harness.notifications, 'interaction.requested').length === 1,
    'elicit card',
  );
  const requested = notificationData(harness.notifications, 'interaction.requested')[0]!;
  const inputs = requested.inputs as Array<Record<string, unknown>>;
  assert.deepEqual(inputs.map((input) => [input.id, input.type, input.required]), [
    ['path', 'text', true],
    ['level', 'single_select', true],
    ['recursive', 'single_select', false],
  ]);
  assert.equal(inputs[0]!.minimumLength, 1);
  assert.equal(inputs[0]!.maximumLength, 200);
  assert.deepEqual(inputs[1]!.choices, [
    { value: 'ro', displayName: 'Read only' },
    { value: 'rw', displayName: 'Read write' },
  ]);
  assert.deepEqual(inputs[2]!.choices, [
    { value: 'true', displayName: 'True' },
    { value: 'false', displayName: 'False' },
  ]);
  const respond = (values: Record<string, unknown>, id: string) => harness.adapter.handle(v2Request(id, 'interaction.respond', {
    sessionId: 'host-ix',
    streamId,
    turnId: 'turn-elicit',
    interactionId: String(requested.interactionId),
    responseId: 'r1',
    actionId: 'submit',
    values,
  }));
  // A missing required field rejects without settling the interaction.
  await assert.rejects(
    respond({ level: 'rw' }, '10'),
    (error: unknown) => (error as { code?: number }).code === -32602,
  );
  await assert.rejects(
    respond({ path: '/tmp', level: 'admin' }, '11'),
    (error: unknown) => (error as { code?: number }).code === -32602,
  );
  const accepted = await respond({ path: '/tmp', level: 'rw', recursive: 'true' }, '12') as { accepted?: boolean };
  assert.equal(accepted.accepted, true);
  await waitFor(
    () => notificationData(harness.notifications, 'turn.completed').length === 1,
    'turn completion',
  );
  // R8: the native ElicitResult carries typed content, not a flat string map.
  assert.deepEqual(harness.reverse[0]!.response, {
    action: 'accept',
    content: { path: '/tmp', level: 'rw', recursive: true },
  });
  await harness.service.close();
});

test('an inexpressible elicitation schema declines natively without a ghost card', async () => {
  const harness = await interactionHarness(async (askExt) => {
    await askExt('x.ai/mcp/elicit', {
      sessionId: 'native-1',
      serverName: 'files',
      requestedSchema: {
        type: 'object',
        properties: { retries: { type: 'number' } },
      },
    });
  });
  const { streamId } = await attachInteractionSession(harness);
  await harness.adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 'host-ix',
    streamId,
    turnId: 'turn-elicit-x',
    input: [{ type: 'text', text: 'elicit' }],
    config: {},
  }));
  await waitFor(
    () => notificationData(harness.notifications, 'turn.completed').length === 1,
    'turn completion',
  );
  assert.equal(notificationData(harness.notifications, 'interaction.requested').length, 0);
  assert.deepEqual(harness.reverse[0]!.response, { action: 'decline' });
  await harness.service.close();
});

test('a reverse question with no active turn settles cancelled immediately', async () => {
  const harness = await interactionHarness(async () => undefined);
  await attachInteractionSession(harness);
  const response = await harness.askExt('x.ai/ask_user_question', {
    sessionId: 'native-1',
    toolCallId: 'tc-idle',
    questions: [{ question: 'Nobody is listening?' }],
  });
  assert.deepEqual(response, { outcome: 'cancelled' });
  assert.equal(notificationData(harness.notifications, 'interaction.requested').length, 0);
  await harness.service.close();
});

test('interrupt settles a parked permission exactly once on the Host stream', async () => {
  const harness = await interactionHarness(async (_askExt, askPermission) => {
    await askPermission({
      sessionId: 'native-1',
      toolCall: { toolCallId: 'tc-perm', title: 'Run tests', kind: 'execute' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
  });
  const { streamId } = await attachInteractionSession(harness);
  await harness.adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 'host-ix',
    streamId,
    turnId: 'turn-perm',
    input: [{ type: 'text', text: 'perm' }],
    config: {},
  }));
  await waitFor(
    () => notificationData(harness.notifications, 'interaction.requested').length === 1,
    'permission card',
  );
  await harness.adapter.handle(v2Request('4', 'turn.interrupt', {
    sessionId: 'host-ix',
    streamId,
    turnId: 'turn-perm',
  }));
  await waitFor(
    () => notificationData(harness.notifications, 'turn.completed').length === 1,
    'turn completion',
  );
  // R2: the native reverse request settled cancelled, and the Host saw one
  // interaction.resolved plus one terminal turn event.
  assert.deepEqual(harness.reverse[0]!.response, { outcome: { outcome: 'cancelled' } });
  const resolved = notificationData(harness.notifications, 'interaction.resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]!.outcome, 'cancelled');
  const completed = notificationData(harness.notifications, 'turn.completed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0]!.stopReason, 'interrupted');
  // A late permission request after the interrupt settles cancelled without a card.
  const late = await harness.askPermission({
    sessionId: 'native-1',
    toolCall: { toolCallId: 'tc-late', title: 'Late', kind: 'execute' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  });
  assert.deepEqual(late, { outcome: { outcome: 'cancelled' } });
  assert.equal(notificationData(harness.notifications, 'interaction.requested').length, 1);
  await harness.service.close();
});

test('an answered permission replays after settlement without re-executing natively', async () => {
  const harness = await interactionHarness(async (_askExt, askPermission) => {
    await askPermission({
      sessionId: 'native-1',
      toolCall: { toolCallId: 'tc-perm', title: 'Run tests', kind: 'execute' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
  });
  const { streamId } = await attachInteractionSession(harness);
  await harness.adapter.handle(v2Request('3', 'turn.start', {
    sessionId: 'host-ix',
    streamId,
    turnId: 'turn-perm',
    input: [{ type: 'text', text: 'perm' }],
    config: {},
  }));
  await waitFor(
    () => notificationData(harness.notifications, 'interaction.requested').length === 1,
    'permission card',
  );
  const interactionId = String(notificationData(harness.notifications, 'interaction.requested')[0]!.interactionId);
  const respond = (responseId: string, actionId: string, id: string) => harness.adapter.handle(v2Request(id, 'interaction.respond', {
    sessionId: 'host-ix',
    streamId,
    turnId: 'turn-perm',
    interactionId,
    responseId,
    actionId,
    values: {},
  }));
  assert.equal((await respond('r1', 'allow', '10') as { accepted?: boolean }).accepted, true);
  await waitFor(
    () => notificationData(harness.notifications, 'turn.completed').length === 1,
    'turn completion',
  );
  assert.deepEqual(harness.reverse[0]!.response, {
    outcome: { outcome: 'selected', optionId: 'allow' },
  });
  // Same payload replays accepted; a different action on the settled
  // responseId conflicts; the approval operation never ran twice.
  assert.equal((await respond('r1', 'allow', '11') as { accepted?: boolean }).accepted, true);
  await assert.rejects(
    respond('r1', 'deny', '12'),
    (error: unknown) => (error as { domainCode?: string }).domainCode === 'CONFLICT',
  );
  assert.equal(harness.reverse.length, 1);
  await harness.service.close();
});

test('model and effort are per-session: a sibling never leaks into native requests', async () => {
  const modelCalls: Array<Record<string, unknown>> = [];
  const twoModelMeta = {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, close: {} },
    },
    _meta: {
      modelState: {
        currentModelId: 'grok-a',
        availableModels: [
          {
            modelId: 'grok-a',
            name: 'Grok A',
            _meta: {
              reasoningEfforts: [
                { id: 'lo', value: 'lo', label: 'Lo', default: true },
                { id: 'hi', value: 'hi', label: 'Hi' },
              ],
            },
          },
          {
            modelId: 'grok-b',
            name: 'Grok B',
            _meta: {
              reasoningEfforts: [{ id: 'max', value: 'max', label: 'Max', default: true }],
            },
          },
        ],
      },
      availableCommands: [],
    },
  };
  const runtime = fakeRuntime({
    negotiated: twoModelMeta,
    async ensureStarted() {
      runtime.calls.push('initialize');
      return twoModelMeta;
    },
    async resumeSession(params: { sessionId: string }) {
      runtime.calls.push('session/resume');
      return { sessionId: params.sessionId };
    },
    async setSessionModel(params: Record<string, unknown>) {
      runtime.calls.push('session/set_model');
      modelCalls.push(params);
      return {};
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const parent = await service.createSession({ cwd: '/workspace' });
  const child = await service.createSession({
    cwd: '/workspace',
    nativeSessionId: 'native-b',
    resumeMode: 'resume',
    allowAdditional: true,
  });

  // Fresh session evidences the runtime default; the resumed one reports
  // unknown instead of borrowing the process default.
  assert.equal(parent.session.model, 'grok-a');
  assert.equal(child.session.model, null);

  await service.setConfigOption({
    sessionId: parent.session.id,
    configId: 'model',
    value: 'grok-b',
  });
  assert.deepEqual(modelCalls, [{ sessionId: 'native-1', modelId: 'grok-b' }]);

  // The child's model is unknown: adjusting thinking must refuse instead of
  // sending the process default model to the native session.
  await assert.rejects(
    service.setConfigOption({
      sessionId: child.session.id,
      configId: 'reasoning_effort',
      value: 'lo',
    }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_REQUEST'
      && /Select a Grok model/.test((error as Error).message),
  );
  assert.equal(modelCalls.filter((call) => call.sessionId === 'native-b').length, 0);

  // The parent's effort change must not emit a set_model for the child.
  await service.setConfigOption({
    sessionId: parent.session.id,
    configId: 'reasoning_effort',
    value: 'max',
  });
  assert.deepEqual(modelCalls[1], {
    sessionId: 'native-1',
    modelId: 'grok-b',
    _meta: { reasoningEffort: 'max' },
  });
  assert.equal(modelCalls.filter((call) => call.sessionId === 'native-b').length, 0);

  // Once a native update evidences the child's model, thinking applies to it.
  runtime.emit('sessionUpdate', {
    sessionId: 'native-b',
    update: { sessionUpdate: 'current_model_update', currentModelId: 'grok-b' },
  });
  await service.setConfigOption({
    sessionId: child.session.id,
    configId: 'reasoning_effort',
    value: 'max',
  });
  assert.deepEqual(modelCalls[2], {
    sessionId: 'native-b',
    modelId: 'grok-b',
    _meta: { reasoningEffort: 'max' },
  });

  // Native model updates only move the session that emitted them.
  assert.equal(service.getSession({ sessionId: child.session.id }).session.model, 'grok-b');
  assert.equal(service.getSession({ sessionId: parent.session.id }).session.model, 'grok-b');
  runtime.emit('sessionUpdate', {
    sessionId: 'native-b',
    update: { sessionUpdate: 'current_model_update', currentModelId: 'grok-a' },
  });
  assert.equal(service.getSession({ sessionId: child.session.id }).session.model, 'grok-a');
  assert.equal(service.getSession({ sessionId: parent.session.id }).session.model, 'grok-b');
  await service.setConfigOption({
    sessionId: child.session.id,
    configId: 'reasoning_effort',
    value: 'lo',
  });

  // Session-scoped catalogs never cross values; the sessionless catalog keeps
  // the runtime default rather than whichever child changed last.
  const parentCatalog = service.currentCatalog(parent.session.id);
  const childCatalog = service.currentCatalog(child.session.id);
  const defaultCatalog = service.currentCatalog();
  const currentOf = (catalog: ReturnType<GrokProxyService['currentCatalog']>, id: string) => (
    catalog.sessionOptions.find((option) => option.id === id)?.currentValue
  );
  assert.equal(currentOf(parentCatalog, 'model'), 'grok-b');
  assert.equal(currentOf(parentCatalog, 'reasoning_effort'), 'max');
  assert.equal(currentOf(childCatalog, 'model'), 'grok-a');
  assert.equal(currentOf(childCatalog, 'reasoning_effort'), 'lo');
  assert.equal(currentOf(defaultCatalog, 'model'), 'grok-a');
  // models[].isDefault agrees with the session options, so a session-scoped
  // catalog.resolve without an explicit model resolves the session's own
  // model and effort instead of the process default.
  assert.equal(parentCatalog.models.find((entry) => entry.isDefault)?.id, 'grok-b');
  assert.equal(
    parentCatalog.models.find((entry) => entry.id === 'grok-b')?.efforts.find((effort) => effort.isDefault)?.id,
    'max',
  );
  assert.equal(childCatalog.models.find((entry) => entry.isDefault)?.id, 'grok-a');
  assert.equal(
    childCatalog.models.find((entry) => entry.id === 'grok-a')?.efforts.find((effort) => effort.isDefault)?.id,
    'lo',
  );
  assert.equal(defaultCatalog.models.find((entry) => entry.isDefault)?.id, 'grok-a');
  await service.close();
});

test('a fork child inherits the parent model and effort at fork time', async () => {
  const modelCalls: Array<Record<string, unknown>> = [];
  const forkMeta = {
    ...initializeMeta(),
    agentCapabilities: {
      ...initializeMeta().agentCapabilities,
      sessionCapabilities: { list: {}, resume: {}, close: {}, fork: {} },
    },
  };
  const runtime = fakeRuntime({
    negotiated: forkMeta,
    async ensureStarted() {
      runtime.calls.push('initialize');
      return forkMeta;
    },
    async forkSession() {
      runtime.calls.push('session/fork');
      return { sessionId: 'native-child', configOptions: [] };
    },
    async setSessionModel(params: Record<string, unknown>) {
      runtime.calls.push('session/set_model');
      modelCalls.push(params);
      return {};
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const parent = await service.createSession({ cwd: '/workspace' });
  await service.setConfigOption({
    sessionId: parent.session.id,
    configId: 'reasoning_effort',
    value: 'low',
  });
  const forked = await service.forkSession({ sessionId: parent.session.id });
  const childId = forked.session.id;
  assert.equal(service.getSession({ sessionId: childId }).session.model, 'grok-4.6');
  assert.equal(service.getSession({ sessionId: childId }).session.effort, 'low');
  // The child diverges independently afterwards.
  await service.setConfigOption({
    sessionId: childId,
    configId: 'reasoning_effort',
    value: 'high',
  });
  assert.equal(service.getSession({ sessionId: parent.session.id }).session.effort, 'low');
  assert.equal(service.getSession({ sessionId: childId }).session.effort, 'high');
  assert.equal(modelCalls.at(-1)?.sessionId, forked.session.nativeSessionId);
  await service.close();
});

test('native stop reasons map to the protocol stop table', async () => {
  const stopReasons = ['refusal', 'max_turn_requests', 'max_tokens', 'end_turn', 'future-reason'];
  const runtime = fakeRuntime({
    async prompt() {
      runtime.calls.push('session/prompt');
      return { stopReason: stopReasons.shift() ?? 'end_turn' };
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => runtime,
  });
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new GrokProtocolV2Adapter(service, '0.3.0', (method, params) => {
    proxyNotificationSchema.parse({ jsonrpc: '2.0', method, params });
    notifications.push({ method, params });
  });
  await adapter.handle(v2Request('1', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.0.0' },
  }));
  const created = await adapter.handle(v2Request('2', 'session.create', {
    sessionId: 'host-stops',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    config: {},
  })) as { session: { streamId: string } };

  const expected = ['refused', 'limit_reached', 'limit_reached', 'completed', 'other'];
  for (const [index, stopReason] of expected.entries()) {
    const turnId = `turn-stop-${index}`;
    await adapter.handle(v2Request(`t${index}`, 'turn.start', {
      sessionId: 'host-stops',
      streamId: created.session.streamId,
      turnId,
      input: [{ type: 'text', text: `q${index}` }],
      config: {},
    }));
    await waitFor(
      () => notifications.some((notification) => (
        notification.method === 'turn.completed' && notification.params.turnId === turnId
      )),
      `turn.completed for ${turnId}`,
    );
    const completed = notifications.find((notification) => (
      notification.method === 'turn.completed' && notification.params.turnId === turnId
    ));
    assert.equal(
      (completed!.params.data as { stopReason?: string }).stopReason,
      stopReason,
    );
  }
  await service.close();
});
