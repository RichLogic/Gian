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

function fakeBridge() {
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
        const records = [
          { type: 'turn/start', data: { turn: 0 } },
          { type: 'step/start', data: { turn: 0, step: 0 } },
          { type: 'request/header', data: { turn: 0, step: 0, reason: 'initial', header: { config: { provider: 'deepseek', model: 'deepseek-chat' } } } },
          { type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'text-delta', text: 'ok' } } },
          { type: 'assistant/message', data: { turn: 0, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, usage: { inputTokens: 4, outputTokens: 1 } } },
          { type: 'step/end', data: { turn: 0, step: 0 } },
          { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
        ];
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
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
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
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
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
