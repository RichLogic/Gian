/**
 * Full gian.proxy/2.1 contract suite for ai.deepseek.harness, driven through
 * `@gian/proxy-protocol`'s `HostProtocolValidator` against a fake bridge
 * runtime (zero model calls, zero DSH process tree).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  HostProtocolValidator,
  signNativeSessionHostBinding,
  type ProxyNotification,
} from '@gian/proxy-protocol';

import { DshV2Adapter } from '../src/protocol/v2-adapter.js';
import { DshProxyService } from '../src/core/service.js';

test('DSH transient stream chunk identities are separate from durable sequence numbers', () => {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const service = new DshProxyService({ emit: event => events.push(event), pluginVersion: '0.3.2' });
  service.attach({ sessionId: 's-live', nativeSessionId: 'native-live', cwd: '/tmp', roots: ['/tmp'], sessionConfig: {}, createFingerprint: 'fixture' });
  service.prepareTurn('s-live', 'turn-live');
  for (const [type, data, nativeSeq] of [
    ['turn/start', { turn: 0 }, 0], ['step/start', { turn: 0, step: 0 }, 1],
  ] as const) {
    service.handleBridgeNotification({ method: 'session.event', params: { sessionId: 's-live', type, data, nativeSeq } });
  }
  for (const index of [0, 1]) {
    service.handleBridgeNotification({ method: 'session.event', params: {
      sessionId: 's-live', type: 'assistant/chunk', data: {
        turn: 0, step: 0, liveAttemptId: 'attempt-a', liveChunkIndex: index,
        chunk: { type: 'text-delta', index: 0, text: 'ha' },
      },
    } });
  }
  const chunks = events.filter(event => event.method === 'content.delta');
  assert.equal(chunks.length, 2);
  assert.notEqual(chunks[0]?.params.eventId, chunks[1]?.params.eventId);
  assert.deepEqual(chunks.map(event => (event.params.data as { delta: string }).delta), ['ha', 'ha']);
});
import { PLUGIN_ID } from '../src/core/service.js';

interface FakeBridge {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  onNotification(listener: (n: { method: string; params: Record<string, unknown> }) => void): () => void;
  push(method: string, params: Record<string, unknown>): void;
}

function fakeBridge(
  turnNumber = 0,
  catalogState: { revision: string } = { revision: 'fake-1' },
): FakeBridge {
  const listeners = new Set<(n: { method: string; params: Record<string, unknown> }) => void>();
  let session = 0;
  const sessions = new Map<string, { events: Array<{ type: string; data: Record<string, unknown>; seq: number }> }>();
  const models = [
    {
      id: 'deepseek-chat',
      provider: 'deepseek',
      label: 'DeepSeek Chat',
      reasoning: {
        efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }],
        defaultEffort: 'high',
      },
    },
    {
      id: 'deepseek-reasoner',
      provider: 'deepseek',
      label: 'DeepSeek Reasoner',
      reasoning: {
        efforts: [{ id: 'off', label: 'Off' }, { id: 'max', label: 'Max' }],
        defaultEffort: 'max',
      },
    },
  ];
  return {
    request: async (method, params) => {
      const sid = params.sessionId as string | undefined;
      switch (method) {
        case 'initialize':
          return {
            protocol: { name: 'gian.dsh.bridge', version: '1.0' },
            plugin: { id: 'ai.deepseek.harness', bundle: '@gian/dsh-bridge', version: '0.1.0' },
            runtime: { id: 'deepseek-harness', package: '@deepseek-ai/dsh', version: '0.1.0-rc.7', sessionFormatVersion: 0 },
            capabilities: { 'session.resume': 1, 'session.events.read': 1, 'turn.interrupt': 1, interaction: 1, 'event.step': 1, 'event.request': 1, 'event.usage': 1 },
          };
        case 'catalog.list':
          return {
            catalogRevision: catalogState.revision,
            providers: [{ id: 'deepseek', label: 'DeepSeek' }],
            defaultSelection: { provider: 'deepseek', model: 'deepseek-chat' },
            models,
            permissionPresets: [
              { id: 'workspace-write', label: 'Workspace Write', approvalPolicy: 'ask' },
              { id: 'danger-full-access', label: 'Full access', approvalPolicy: 'never' },
            ],
            defaultPermissionPreset: 'workspace-write',
            agentPresets: [
              { id: 'standard', label: 'Standard' },
              { id: 'code', label: 'PTC' },
            ],
            defaultAgentPreset: 'standard',
          };
        case 'catalog.resolve':
          return {
            catalogRevision: catalogState.revision,
            providers: [{ id: 'deepseek', label: 'DeepSeek' }],
            defaultSelection: { provider: 'deepseek', model: 'deepseek-chat' },
            models,
            permissionPresets: [
              { id: 'workspace-write', label: 'Workspace Write', approvalPolicy: 'ask' },
              { id: 'danger-full-access', label: 'Full access', approvalPolicy: 'never' },
            ],
            defaultPermissionPreset: 'workspace-write',
            agentPresets: [
              { id: 'standard', label: 'Standard' },
              { id: 'code', label: 'PTC' },
            ],
            defaultAgentPreset: 'standard',
            resolvedDefaults: { sessionConfig: {}, turnConfig: (params.turnConfig ?? {}) },
          };
        case 'session.create':
          session += 1;
          sessions.set(sid ?? '', { events: [] });
          return {
            session: {
              id: sid,
              nativeId: (params.nativeSession as { id?: string } | undefined)?.id ?? `native-${session}`,
              cwd: (params.workspace as { cwd: string }).cwd,
              state: 'idle',
            },
          };
        case 'session.get':
          return { session: { id: sid, nativeId: 'native-1', state: 'idle' } };
        case 'session.close':
          return { ok: true };
        case 'session.events.read': {
          const list = sessions.get(sid ?? '')?.events ?? [];
          const cursor = params.cursor === null || params.cursor === undefined ? 0 : Number(params.cursor);
          const limit = typeof params.limit === 'number' ? params.limit : 500;
          const events = list.slice(cursor, cursor + limit);
          return { formatVersion: 0, events, cursor: cursor + events.length < list.length ? String(cursor + events.length) : null };
        }
        case 'turn.start': {
          const seq = [
            { type: 'turn/start', data: { turn: turnNumber } },
            { type: 'step/start', data: { turn: turnNumber, step: 0 } },
            { type: 'request/header', data: { turn: turnNumber, step: 0, reason: 'initial', header: { config: { provider: 'deepseek', model: 'deepseek-chat' }, system: 'sys', tools: [{ name: 'read_file' }] } } },
            { type: 'assistant/chunk', data: { turn: turnNumber, step: 0, chunk: { type: 'text-delta', text: 'hello' } } },
            { type: 'assistant/message', data: { turn: turnNumber, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }, usage: { inputTokens: 12, outputTokens: 3 } } },
            { type: 'step/end', data: { turn: turnNumber, step: 0 } },
            { type: 'turn/end', data: { turn: turnNumber, reason: { kind: 'completed' } } },
          ];
          seq.forEach((record, index) => {
            for (const listener of listeners) {
              listener({ method: 'session.event', params: { sessionId: sid, nativeSeq: index, type: record.type, data: record.data } });
            }
          });
          return { accepted: true };
        }
        case 'turn.interrupt':
          return { accepted: true };
        case 'turn.steer':
          return { accepted: true };
        case 'interaction.respond':
          return { accepted: true };
        case 'shutdown':
          return { ok: true };
        default:
          throw new Error(`fake bridge unknown method ${method}`);
      }
    },
    onNotification(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push(method, params) {
      for (const listener of listeners) listener({ method, params });
    },
  };
}

function adapterWith(bridge: FakeBridge, hostBindingKey?: string) {
  const adapter = new DshV2Adapter(bridge as never, {
    pluginVersion: '0.1.3',
    ...(hostBindingKey ? { hostBindingKey } : {}),
  });
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  adapter.setEmitSink((method, params) => notifications.push({ method, params }));
  return { adapter, notifications };
}

interface Outcome {
  result: unknown;
  error: { code: number; data?: { domainCode?: string } } | null;
  notifications: Array<{ method: string; params: Record<string, unknown> }>;
}

async function call(
  adapter: DshV2Adapter,
  method: string,
  params: Record<string, unknown>,
): Promise<Outcome> {
  const outcome = await adapter.dispatch({ id: `r-${method}`, method, params });
  return {
    result: outcome.result,
    error: (outcome.error as { code: number; data?: { domainCode?: string } } | undefined) ?? null,
    notifications: outcome.notifications,
  };
}

test('initialize: only accepts gian.proxy 2.1 and returns exact identity', async () => {
  const { adapter } = adapterWith(fakeBridge());
  const init = await call(adapter, 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.5.0' },
  });
  assert.equal(init.error, null);
  const result = init.result as {
    protocol: { version: string };
    plugin: { id: string; version: string };
    process: { scope: string };
    capabilities: Record<string, number>;
  };
  assert.equal(result.protocol.version, '2.1');
  assert.equal(result.plugin.id, PLUGIN_ID);
  assert.equal(result.plugin.version, '0.1.3');
  assert.equal(result.process.scope, 'shared');
  assert.equal(result.capabilities['input.localFile'], undefined);
  assert.equal(result.capabilities['input.localImage'], undefined);
  assert.equal(result.capabilities.interaction, 1);
  assert.equal(result.capabilities['event.diff'], undefined);
  assert.equal(result.capabilities['turn.interrupt'], undefined);
  assert.equal(result.capabilities['event.step'], 1);
  assert.equal(result.capabilities['event.request'], 1);
  assert.equal(result.capabilities['session.create.hostBindingProof'], 1);
});

test('session.close is idempotent without re-closing a removed native session', async () => {
  const bridge = fakeBridge();
  const original = bridge.request.bind(bridge);
  let closes = 0;
  bridge.request = async (method, params) => {
    if (method === 'session.close' && ++closes > 1) throw new Error('Native session already removed');
    return original(method, params);
  };
  const { adapter } = adapterWith(bridge);
  await call(adapter, 'initialize', { protocol: { name: 'gian.proxy', versions: ['2.1'] }, host: { name: 'fixture', version: '1' } });
  const created = await call(adapter, 'session.create', { sessionId: 'repeat-close', workspace: { cwd: '/tmp', roots: ['/tmp'] }, config: {} });
  assert.equal(created.error, null);
  const session = (created.result as { session: { id: string; streamId: string } }).session;
  const params = { sessionId: session.id, streamId: session.streamId };
  assert.equal((await call(adapter, 'session.close', params)).error, null);
  assert.equal((await call(adapter, 'session.close', params)).error, null);
  assert.equal(closes, 1);
  assert.equal((await call(adapter, 'session.close', { ...params, streamId: 'stale' })).error?.data?.domainCode, 'SESSION_STALE');
});

test('initialize rejects non-2.1 versions', async () => {
  const { adapter } = adapterWith(fakeBridge());
  const init = await call(adapter, 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['1.0'] },
  });
  assert.ok(init.error);
  assert.equal(init.error.data?.domainCode, 'INCOMPATIBLE_PROTOCOL');
});

test('session.create accepts only an authenticated Host-owned no-replay reattach', async () => {
  const hostBindingKey = 'test-host-binding-key';
  const { adapter } = adapterWith(fakeBridge(), hostBindingKey);
  await call(adapter, 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.5.0' },
  });
  const created = await call(adapter, 'session.create', {
    sessionId: 's_1',
    workspace: { cwd: '/tmp/p', roots: ['/tmp/p'] },
    config: {},
  });
  assert.equal(created.error, null);
  const session = (created.result as { session: { id: string; state: string; nativeSession?: unknown } }).session;
  assert.equal(session.id, 's_1');
  assert.equal(session.state, 'idle');
  assert.deepEqual(session.nativeSession, { id: 'native-1' });

  const blocked = await call(adapter, 'session.create', {
    sessionId: 's_2',
    workspace: { cwd: '/tmp/p', roots: ['/tmp/p'] },
    config: {},
    hostServices: [{ id: 'gian.tools', protocol: 'mcp', transport: { type: 'streamable-http', url: 'http://127.0.0.1:1/mcp' } }],
  });
  assert.equal(blocked.error?.data?.domainCode, 'CAPABILITY_NOT_SUPPORTED');

  const attach = await call(adapter, 'session.create', {
    sessionId: 's_3',
    workspace: { cwd: '/tmp/p', roots: ['/tmp/p'] },
    config: {},
    nativeSession: {
      id: 'ext-1',
      history: 'none',
      hostBindingProof: signNativeSessionHostBinding(hostBindingKey, {
        pluginId: PLUGIN_ID,
        sessionId: 's_3',
        nativeSessionId: 'ext-1',
        cwd: '/tmp/p',
      }),
    },
  });
  assert.equal(attach.error, null);
  assert.deepEqual(
    (attach.result as { session: { nativeSession?: unknown } }).session.nativeSession,
    { id: 'ext-1' },
  );

  const foreign = await call(adapter, 'session.create', {
    sessionId: 's_4',
    workspace: { cwd: '/tmp/p', roots: ['/tmp/p'] },
    config: {},
    nativeSession: {
      id: 'foreign',
      history: 'none',
      hostBindingProof: signNativeSessionHostBinding(hostBindingKey, {
        pluginId: PLUGIN_ID,
        sessionId: 's_4',
        nativeSessionId: 'different-native-id',
        cwd: '/tmp/p',
      }),
    },
  });
  assert.equal(foreign.error?.data?.domainCode, 'RUNTIME_UNAVAILABLE');

  const adoption = await call(adapter, 'session.create', {
    sessionId: 's_5',
    workspace: { cwd: '/tmp/p', roots: ['/tmp/p'] },
    config: {},
    nativeSession: {
      id: 'ext-2',
      history: 'replay',
      hostBindingProof: signNativeSessionHostBinding(hostBindingKey, {
        pluginId: PLUGIN_ID,
        sessionId: 's_5',
        nativeSessionId: 'ext-2',
        cwd: '/tmp/p',
      }),
    },
  });
  assert.equal(adoption.error?.data?.domainCode, 'RUNTIME_UNAVAILABLE');
});

test('failed native resume rolls back the attachment so Host can create a safe replacement', async () => {
  const hostBindingKey = 'test-host-binding-key';
  const base = fakeBridge();
  let failResume = true;
  const bridge: FakeBridge = {
    ...base,
    async request(method, params) {
      if (method === 'session.create' && params.nativeSession !== undefined && failResume) {
        failResume = false;
        const error = new Error('DSH native session was not found.') as Error & { domainCode: string };
        error.domainCode = 'NATIVE_SESSION_NOT_FOUND';
        throw error;
      }
      return base.request(method, params);
    },
  };
  const { adapter } = adapterWith(bridge, hostBindingKey);
  await call(adapter, 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.5.0' },
  });
  const binding = {
    pluginId: PLUGIN_ID,
    sessionId: 's_replacement',
    nativeSessionId: 'native-missing',
    cwd: '/tmp/p',
  };
  const failed = await call(adapter, 'session.create', {
    sessionId: binding.sessionId,
    workspace: { cwd: binding.cwd, roots: [binding.cwd] },
    config: {},
    nativeSession: {
      id: binding.nativeSessionId,
      history: 'none',
      hostBindingProof: signNativeSessionHostBinding(hostBindingKey, binding),
    },
  });
  assert.equal(failed.error?.data?.domainCode, 'NATIVE_SESSION_NOT_FOUND');

  const replacement = await call(adapter, 'session.create', {
    sessionId: binding.sessionId,
    workspace: { cwd: binding.cwd, roots: [binding.cwd] },
    config: {},
  });
  assert.equal(replacement.error, null);
  assert.deepEqual(
    (replacement.result as { session: { nativeSession?: unknown } }).session.nativeSession,
    { id: 'native-1' },
  );
});

test('turn.start emits accepted then turn.started and a single terminal event', async () => {
  const { adapter } = adapterWith(fakeBridge());
  await call(adapter, 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.5.0' },
  });
  const created = await call(adapter, 'session.create', {
    sessionId: 's_1',
    workspace: { cwd: '/tmp/p', roots: ['/tmp/p'] },
    config: {},
  });
  const streamId = (created.result as { session: { streamId: string } }).session.streamId;
  const started = await call(adapter, 'turn.start', {
    sessionId: 's_1',
    streamId,
    turnId: 't_1',
    input: [{ type: 'text', text: 'hello' }],
    config: { model: 'deepseek-chat' },
  });
  assert.equal(started.error, null);
  const methods = started.notifications.map((n) => n.method);
  assert.ok(methods.includes('turn.started'), 'turn.started must follow accepted turn');
  assert.ok(methods.includes('turn.completed'), 'turn.completed must be the terminal event');
  assert.equal(methods.filter((m) => m === 'turn.completed' || m === 'turn.failed').length, 1);
  // step/request/usage must be present for the claimed capabilities.
  assert.ok(methods.includes('step.updated'));
  assert.ok(methods.includes('request.updated'));
  assert.ok(methods.includes('usage.updated'));
  const last = methods[methods.length - 1];
  assert.equal(last === 'turn.completed' || last === 'session.updated', true);
});

test('turn.start correlates pending Gian turn ids FIFO for native turn ordinals', async () => {
  const { adapter } = adapterWith(fakeBridge(1));
  await call(adapter, 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.5.0' },
  });
  const created = await call(adapter, 'session.create', {
    sessionId: 's_1',
    workspace: { cwd: '/tmp/p', roots: ['/tmp/p'] },
    config: {},
  });
  const streamId = (created.result as { session: { streamId: string } }).session.streamId;
  const started = await call(adapter, 'turn.start', {
    sessionId: 's_1',
    streamId,
    turnId: 't_user_1',
    input: [{ type: 'text', text: 'hello' }],
    config: { model: 'deepseek-chat' },
  });
  assert.equal(started.error, null);
  const turnStarted = started.notifications.find((n) => n.method === 'turn.started');
  assert.equal(turnStarted?.params.turnId, 't_user_1');
  assert.equal(turnStarted?.params.sourceTurnId, 'native-1:turn:1');
  const terminal = started.notifications.find((n) => n.method === 'turn.completed');
  assert.equal(terminal?.params.turnId, 't_user_1');
});

test('catalog exposes DSH page permission modes and session-bound Agent presets', async () => {
  const bridge = fakeBridge();
  const { adapter } = adapterWith(bridge);
  await call(adapter, 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.5.0' },
  });
  const catalog = await call(adapter, 'catalog.list', {});
  const result = catalog.result as {
    input: Array<{ type: string }>;
    configOptions: Array<{ id: string; binding: string }>;
    specialCatalogs: Record<string, string>;
  };
  assert.deepEqual(result.input, [{ type: 'text' }]);
  assert.equal(result.configOptions.some((o) => o.id === 'model'), true);
  assert.equal(result.configOptions.some((o) => o.id === 'permission_preset'), true);
  assert.equal(
    result.configOptions.find((o) => o.id === 'agent_preset')?.binding,
    'session',
  );
  assert.equal(result.specialCatalogs.approvalMode, 'permission_preset');
  const approval = (catalog.result as {
    configOptions: Array<{ id: string; choices?: Array<{ value: unknown; displayName: string }> }>;
  }).configOptions.find(option => option.id === 'permission_preset');
  assert.deepEqual(approval?.choices, [
    { value: 'workspace-write', displayName: 'Workspace Write' },
    { value: 'danger-full-access', displayName: 'Full access' },
  ]);
});

test('approval-backed modes and interaction.respond stay unavailable without an answerer', async () => {
  const base = fakeBridge();
  const bridge: FakeBridge = {
    ...base,
    request: async (method, params) => {
      if (method === 'initialize') {
        const initialized = await base.request(method, params);
        return { ...initialized, capabilities: { 'session.events.read': 1 } };
      }
      return base.request(method, params);
    },
  };
  const { adapter } = adapterWith(bridge);
  const initialized = await call(adapter, 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.5.0' },
  });
  const capabilities = (initialized.result as { capabilities: Record<string, number> }).capabilities;
  assert.equal(capabilities.interaction, undefined);

  const catalog = await call(adapter, 'catalog.list', {});
  const approval = (catalog.result as {
    configOptions: Array<{ id: string; choices?: Array<{ value: unknown }> }>;
  }).configOptions.find(option => option.id === 'permission_preset');
  assert.equal(approval, undefined, 'must not silently default to Full access');

  const response = await call(adapter, 'interaction.respond', {});
  assert.equal(response.error?.data?.domainCode, 'CAPABILITY_NOT_SUPPORTED');
});

test('interaction.respond forwards one advertised DSH approval decision', async () => {
  const bridge = fakeBridge();
  const { adapter, notifications } = adapterWith(bridge);
  await call(adapter, 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.5.0' },
  });
  const created = await call(adapter, 'session.create', {
    sessionId: 's_interaction',
    workspace: { cwd: '/tmp/p', roots: ['/tmp/p'] },
    config: { agent_preset: 'standard' },
  });
  const streamId = (created.result as { session: { streamId: string } }).session.streamId;
  bridge.push('session.event', {
    sessionId: 's_interaction',
    nativeSeq: 1,
    type: 'turn/start',
    data: { turn: 1 },
  });
  bridge.push('interaction.requested', {
    sessionId: 's_interaction',
    interactionId: 'approval-1',
    kind: 'approval',
    title: 'Approve bash',
    inputs: [],
    actions: [
      { id: 'allow-once', label: 'Allow once', style: 'primary' },
      { id: 'reject', label: 'Reject', style: 'danger' },
    ],
  });
  assert.ok(notifications.some(notification => notification.method === 'interaction.requested'));

  const response = await call(adapter, 'interaction.respond', {
    sessionId: 's_interaction',
    streamId,
    turnId: 't-1',
    interactionId: 'approval-1',
    responseId: 'response-1',
    actionId: 'allow-once',
    values: {},
  });
  assert.equal(response.error, null);
  assert.equal((response.result as { accepted: boolean }).accepted, true);
});

test('catalog.resolve rebuilds effort choices for the selected latest DSH model', async () => {
  const { adapter } = adapterWith(fakeBridge());
  await call(adapter, 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.5.0' },
  });
  const resolved = await call(adapter, 'catalog.resolve', {
    catalogRevision: 'dsh-catalog-0.1.3',
    sessionConfig: {},
    turnConfig: { model: 'deepseek-reasoner' },
  });
  const result = resolved.result as {
    configOptions: Array<{
      id: string;
      defaultValue: unknown;
      choices?: Array<{ value: unknown }>;
    }>;
    resolvedDefaults: { turnConfig: Record<string, unknown> };
  };
  const effort = result.configOptions.find(option => option.id === 'effort');
  assert.deepEqual(effort?.choices?.map(choice => choice.value), ['off', 'max']);
  assert.equal(effort?.defaultValue, 'max');
  assert.deepEqual(result.resolvedDefaults.turnConfig, {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    effort: 'max',
    permission_preset: 'workspace-write',
  });
});

test('catalog.list refreshes the revision after a late DSH Provider change', async () => {
  const state = { revision: 'fake-before' };
  const { adapter } = adapterWith(fakeBridge(0, state));
  await call(adapter, 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.5.0' },
  });
  const before = await call(adapter, 'catalog.list', {});
  state.revision = 'fake-after';
  const after = await call(adapter, 'catalog.list', {});
  assert.notEqual(
    (before.result as { catalogRevision: string }).catalogRevision,
    (after.result as { catalogRevision: string }).catalogRevision,
  );
});


test('native reattach preserves immutable session identity and rejects changed or foreign bindings', async () => {
  const key = 'reattach-test-key';
  const { adapter } = adapterWith(fakeBridge(), key);
  await call(adapter, 'initialize', { protocol: { name: 'gian.proxy', versions: ['2.1'] }, host: { name: 'test', version: '0.5.5' } });
  const base = { sessionId: 'reattach', workspace: { cwd: '/tmp/p', roots: ['/tmp/p'] }, config: {} };
  assert.equal((await call(adapter, 'session.create', base)).error, null);
  const bound = (id = 'native-1', cwd = '/tmp/p') => ({ id, history: 'none', hostBindingProof: signNativeSessionHostBinding(key, {
    pluginId: PLUGIN_ID, sessionId: base.sessionId, nativeSessionId: id, cwd,
  }) });
  assert.equal((await call(adapter, 'session.create', { ...base, nativeSession: bound() })).error, null);
  assert.equal((await call(adapter, 'session.create', base)).error, null, 'original create retry remains idempotent');
  for (const mutation of [
    { nativeSession: bound('foreign') },
    { workspace: { cwd: '/tmp/elsewhere', roots: ['/tmp/elsewhere'] }, nativeSession: bound('native-1', '/tmp/elsewhere') },
    { workspace: { cwd: '/tmp/p', roots: ['/tmp/p', '/tmp/other'] } },
    { config: { agent_preset: 'standard' } },
  ]) {
    const result = await call(adapter, 'session.create', { ...base, ...mutation });
    assert.ok(result.error, JSON.stringify(mutation));
    assert.equal(result.error.data?.domainCode, 'CONFLICT');
  }
  assert.equal((await call(adapter, 'session.create', { ...base, nativeSession: { ...bound(), hostBindingProof: 'invalid' } })).error?.data?.domainCode, 'RUNTIME_UNAVAILABLE');
});

test('native terminal evidence survives a late start RPC failure and retains the idempotency receipt', async () => {
  const base = fakeBridge();
  let starts = 0;
  const { adapter, notifications } = adapterWith({ ...base, async request(method, params) {
    const result = await base.request(method, params);
    if (method === 'turn.start') { starts += 1; throw new Error('late bridge transport failure'); }
    return result;
  } });
  await call(adapter, 'initialize', { protocol: { name: 'gian.proxy', versions: ['2.1'] }, host: { name: 'test', version: '0.5.5' } });
  await call(adapter, 'catalog.list', {});
  const created = await call(adapter, 'session.create', { sessionId: 'late-reply', workspace: { cwd: '/tmp/p', roots: ['/tmp/p'] }, config: {} });
  const streamId = (created.result as { session: { streamId: string } }).session.streamId;
  const params = { sessionId: 'late-reply', streamId, turnId: 'turn', input: [{ type: 'text', text: 'hello' }], config: { model: 'deepseek-chat' } };
  const first = await call(adapter, 'turn.start', params);
  assert.equal(first.error, null);
  assert.equal((await call(adapter, 'turn.start', params)).error, null);
  assert.equal(starts, 1);
  assert.equal([...first.notifications, ...notifications].filter(n => n.method === 'turn.completed').length, 1);
  assert.equal(notifications.filter(n => n.method === 'turn.failed').length, 0);
});
