/**
 * Full wire contract run through `@gian/proxy-protocol`'s HostProtocolValidator.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { HostProtocolValidator } from '@gian/proxy-protocol';
import { DshV2Adapter } from '../src/protocol/v2-adapter.js';
import { PLUGIN_ID } from '../src/core/service.js';

interface FakeBridgeEvent {
  method: string;
  params: Record<string, unknown>;
}

interface NativeRecord {
  type: string;
  data: Record<string, unknown>;
}

const SINGLE_STEP_TURN: NativeRecord[] = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'request/header', data: { turn: 1, step: 1, reason: 'initial', header: { config: { provider: 'deepseek', model: 'deepseek-chat' } } } },
  { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'ok' } } },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, usage: { inputTokens: 4, outputTokens: 1 } } },
  { type: 'step/end', data: { turn: 1, step: 1 } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
];

/** Production `dsh test` shape: step 1 writes then tools, step 2 writes again. */
const MULTI_STEP_TURN: NativeRecord[] = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'request/header', data: { turn: 1, step: 1, reason: 'initial', header: { config: { provider: 'deepseek', model: 'deepseek-chat' } } } },
  { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'thinking' } } },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] }, usage: { inputTokens: 8, outputTokens: 2 } } },
  { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call_00', name: 'bash', arguments: '{"command":"pwd"}' } },
  { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', callId: 'call_00', content: [{ type: 'text', text: '/tmp' }] } } },
  { type: 'step/end', data: { turn: 1, step: 1 } },
  { type: 'step/start', data: { turn: 1, step: 2 } },
  { type: 'request/header', data: { turn: 1, step: 2, reason: 'continuation', header: { config: { provider: 'deepseek', model: 'deepseek-chat' } } } },
  { type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'text-delta', text: 'done' } } },
  { type: 'assistant/message', data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, usage: { inputTokens: 12, outputTokens: 1 } } },
  { type: 'step/end', data: { turn: 1, step: 2 } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
];

/**
 * Production `dsh test2` shape: leftover open activities plus turn/end.
 * Two unmatched tools and two title facts must not share one finalize eventId.
 */
const OPEN_ACTIVITIES_THEN_END: NativeRecord[] = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'session/title', data: { turn: 1, title: 'one' } },
  { type: 'session/title-llm-request', data: { turn: 1 } },
  { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'hi' } } },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } } },
  { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
  { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c2', name: 'grep', arguments: '{}' } },
  { type: 'step/end', data: { turn: 1, step: 1 } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
];

/** Step 2 streams but never completes; turn/end must finalize without changing identity. */
const OPEN_CONTENT_THEN_END: NativeRecord[] = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'partial' } } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
];

function fakeBridge(records: NativeRecord[] = SINGLE_STEP_TURN) {
  const listeners = new Set<(n: FakeBridgeEvent) => void>();
  return {
    request: async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const sid = params.sessionId as string | undefined;
      if (method === 'initialize') {
        return { protocol: { name: 'gian.dsh.bridge', version: '1.0' } };
      }
      if (method === 'catalog.list') {
        return {
          catalogRevision: 'fake-1',
          models: [{ id: 'deepseek-chat', provider: 'deepseek', label: 'DeepSeek Chat' }],
        };
      }
      if (method === 'catalog.resolve') {
        return { catalogRevision: 'fake-1', models: [], resolvedDefaults: { sessionConfig: {}, turnConfig: params.turnConfig ?? {} } };
      }
      if (method === 'session.create') {
        return {};
      }
      if (method === 'session.close') return { ok: true };
      if (method === 'turn.start') {
        records.forEach((r, index) => {
          for (const listener of listeners) {
            listener({ method: 'session.event', params: { sessionId: sid, nativeSeq: index, type: r.type, data: r.data } });
          }
        });
        return { accepted: true };
      }
      if (method === 'interaction.respond') return { accepted: true };
      if (method === 'turn.interrupt') return { accepted: true };
      if (method === 'shutdown') return { ok: true };
      throw new Error(`unexpected ${method}`);
    },
    onNotification(listener: (n: FakeBridgeEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function wire(adapter: DshV2Adapter, validator: HostProtocolValidator) {
  adapter.setEmitSink((method, params) => {
    validator.acceptLine(JSON.stringify({ jsonrpc: '2.0', method, params }));
  });
}

async function drive(
  validator: HostProtocolValidator,
  adapter: DshV2Adapter,
  id: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const request = { jsonrpc: '2.0', id, method, params };
  validator.registerRequest(request);
  const outcome = await adapter.dispatch({ id, method, params });
  const envelope = outcome.ok
    ? { jsonrpc: '2.0', id, result: outcome.result }
    : { jsonrpc: '2.0', id, error: outcome.error };
  validator.acceptLine(JSON.stringify(envelope));
  for (const notification of outcome.notifications) {
    validator.acceptLine(JSON.stringify({ jsonrpc: '2.0', method: notification.method, params: notification.params }));
  }
  return outcome;
}

test('HostProtocolValidator accepts a full initialize→catalog→create→turn lifecycle', async () => {
  const validator = new HostProtocolValidator({ pluginId: PLUGIN_ID });
  const adapter = new DshV2Adapter(fakeBridge() as never, { pluginVersion: '0.1.0' });
  wire(adapter, validator);

  await drive(validator, adapter, 'init', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.5.0' },
  });

  const catalog = await drive(validator, adapter, 'cat', 'catalog.list', {});
  const catalogResult = catalog as { result: { configOptions: Array<{ id: string; binding: string }> } };
  assert.equal(catalogResult.result.configOptions.some((o) => o.id === 'model' && o.binding === 'turn'), true);

  const create = await drive(validator, adapter, 'create', 'session.create', {
    sessionId: 's_1',
    workspace: { cwd: '/tmp/p', roots: ['/tmp/p'] },
    config: {},
  });
  const streamId = (create as { result: { session: { streamId: string } } }).result.session.streamId;

  await drive(validator, adapter, 'start', 'turn.start', {
    sessionId: 's_1',
    streamId,
    turnId: 't_1',
    input: [{ type: 'text', text: 'hello' }],
    config: { model: 'deepseek-chat' },
  });

  await drive(validator, adapter, 'close', 'session.close', { sessionId: 's_1', streamId });
});

test('HostProtocolValidator rejects hostServices for a proxy without MCP capability', async () => {
  const validator = new HostProtocolValidator({ pluginId: PLUGIN_ID });
  const adapter = new DshV2Adapter(fakeBridge() as never, { pluginVersion: '0.1.0' });
  wire(adapter, validator);

  await drive(validator, adapter, 'init', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.5.0' },
  });
  assert.throws(() => validator.registerRequest({
    jsonrpc: '2.0',
    id: 'create',
    method: 'session.create',
    params: {
      sessionId: 's_2',
      workspace: { cwd: '/tmp/p', roots: ['/tmp/p'] },
      config: {},
      hostServices: [{ id: 'gian.tools', protocol: 'mcp', transport: { type: 'streamable-http', url: 'http://127.0.0.1:1/mcp' } }],
    },
  }), /streamableHttp|hostServices/);
});

async function runTurn(sessionId: string, turnId: string, records: NativeRecord[]) {
  const validator = new HostProtocolValidator({ pluginId: PLUGIN_ID });
  const adapter = new DshV2Adapter(fakeBridge(records) as never);
  wire(adapter, validator);
  await drive(validator, adapter, 'init', 'initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.5.0' },
  });
  await drive(validator, adapter, 'cat', 'catalog.list', {});
  const create = await drive(validator, adapter, 'create', 'session.create', {
    sessionId,
    workspace: { cwd: '/tmp/p', roots: ['/tmp/p'] },
    config: {},
  }) as { result: { session: { streamId: string } }; notifications: Array<{ method: string; params: Record<string, unknown> }> };
  const started = await drive(validator, adapter, 'start', 'turn.start', {
    sessionId,
    streamId: create.result.session.streamId,
    turnId,
    input: [{ type: 'text', text: 'hello' }],
    config: { model: 'deepseek-chat' },
  }) as { notifications: Array<{ method: string; params: { data?: Record<string, unknown> } }> };
  return started.notifications;
}

test('HostProtocolValidator accepts a tool-using turn that writes again on step 2', async () => {
  const notifications = await runTurn('s_multi', 't_multi', MULTI_STEP_TURN);
  const content = notifications.filter((n) => (
    n.method === 'content.delta' || n.method === 'content.completed'
  ));
  const ids = [...new Set(content.map((n) => String(n.params.data?.contentId ?? '')))];
  assert.deepEqual(ids, [
    'assistant-s_multi:turn:1:step:1',
    'assistant-s_multi:turn:1:step:2',
  ]);
  for (const event of content) {
    const contentId = String(event.params.data?.contentId ?? '');
    const stepId = String(event.params.data?.stepId ?? '');
    const format = event.params.data?.format;
    assert.equal(event.params.data?.kind, 'text');
    assert.equal(format, 'markdown');
    assert.equal(contentId, `assistant-${stepId}`);
  }
  assert.equal(notifications.some((n) => n.method === 'turn.completed'), true);
});

test('HostProtocolValidator accepts turn-end finalizing an open content stream', async () => {
  const notifications = await runTurn('s_open', 't_open', OPEN_CONTENT_THEN_END);
  const completed = notifications.filter((n) => n.method === 'content.completed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.params.data?.contentId, 'assistant-s_open:turn:1:step:1');
  assert.equal(completed[0]?.params.data?.kind, 'text');
  assert.equal(completed[0]?.params.data?.format, 'markdown');
  assert.equal(completed[0]?.params.data?.stepId, 's_open:turn:1:step:1');
});

test('HostProtocolValidator accepts turn-end with multiple leftover activities', async () => {
  const notifications = await runTurn('s_acts', 't_acts', OPEN_ACTIVITIES_THEN_END);
  const activities = notifications.filter((n) => n.method === 'activity.updated');
  const eventIds = activities.map((n) => String((n.params as { eventId?: string }).eventId ?? ''));
  assert.equal(new Set(eventIds).size, eventIds.length, 'each activity snapshot needs its own eventId');
  assert.equal(notifications.some((n) => n.method === 'turn.completed'), true);
});
