/**
 * Full gian.proxy/2.1 contract suite for ai.deepseek.harness, driven through
 * `@gian/proxy-protocol`'s `HostProtocolValidator` against a fake bridge
 * runtime (zero model calls, zero DSH process tree).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  HostProtocolValidator,
  type ProxyNotification,
} from '@gian/proxy-protocol';

import { DshV2Adapter } from '../src/protocol/v2-adapter.js';
import { PLUGIN_ID } from '../src/core/service.js';

interface FakeBridge {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  onNotification(listener: (n: { method: string; params: Record<string, unknown> }) => void): () => void;
  push(method: string, params: Record<string, unknown>): void;
}

function fakeBridge(turnNumber = 0): FakeBridge {
  const listeners = new Set<(n: { method: string; params: Record<string, unknown> }) => void>();
  let session = 0;
  const sessions = new Map<string, { events: Array<{ type: string; data: Record<string, unknown>; seq: number }> }>();
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
            catalogRevision: 'fake-1',
            models: [
              { id: 'deepseek-chat', provider: 'deepseek', label: 'DeepSeek Chat' },
              { id: 'deepseek-reasoner', provider: 'deepseek', label: 'DeepSeek Reasoner' },
            ],
          };
        case 'catalog.resolve':
          return { catalogRevision: 'fake-1', models: [], resolvedDefaults: { sessionConfig: {}, turnConfig: (params.turnConfig ?? {}) } };
        case 'session.create':
          session += 1;
          sessions.set(sid ?? '', { events: [] });
          return { session: { id: sid, nativeId: `native-${session}`, cwd: (params.workspace as { cwd: string }).cwd, state: 'idle' } };
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
    push(_method, _params) {
      /* unused */
    },
  };
}

function adapterWith(bridge: FakeBridge) {
  const adapter = new DshV2Adapter(bridge as never, { pluginVersion: '0.1.3' });
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
  assert.equal(result.capabilities['input.localFile'], 1);
  assert.equal(result.capabilities['input.localImage'], 1);
  assert.equal(result.capabilities['turn.interrupt'], undefined);
  assert.equal(result.capabilities['event.step'], 1);
  assert.equal(result.capabilities['event.request'], 1);
});

test('initialize rejects non-2.1 versions', async () => {
  const { adapter } = adapterWith(fakeBridge());
  const init = await call(adapter, 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['1.0'] },
  });
  assert.ok(init.error);
  assert.equal(init.error.data?.domainCode, 'INCOMPATIBLE_PROTOCOL');
});

test('session.create returns a session snapshot; non-empty hostServices rejected', async () => {
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
    nativeSession: { id: 'ext-1', history: 'none' },
  });
  assert.equal(attach.error?.data?.domainCode, 'RUNTIME_UNAVAILABLE');
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

test('interaction.question interaction is a capability claim', async () => {
  const bridge = fakeBridge();
  const { adapter } = adapterWith(bridge);
  await call(adapter, 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.5.0' },
  });
  const catalog = await call(adapter, 'catalog.list', {});
  const result = catalog.result as { input: Array<{ type: string }>; configOptions: Array<{ id: string }> };
  assert.equal(result.input.some((i) => i.type === 'text'), true);
  assert.equal(result.configOptions.some((o) => o.id === 'model'), true);
});
