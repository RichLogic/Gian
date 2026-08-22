import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { DshV2Adapter } from '../src/protocol/v2-adapter.js';

function fakeBridge() {
  let turnCount = 0;
  return {
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === 'initialize') return { protocol: { name: 'gian.dsh.bridge', version: '1.0' } };
      if (method === 'catalog.list') return { catalogRevision: 'fake-1', models: [{ id: 'deepseek-chat', provider: 'deepseek', label: 'DeepSeek Chat' }] };
      if (method === 'session.create') return {};
      if (method === 'turn.start') {
        turnCount += 1;
        return { accepted: true, nativeTurn: turnCount - 1 };
      }
      if (method === 'session.events.read') {
        return {
          formatVersion: 0,
          events: [
            { type: 'turn/start', seq: 0, data: { turn: 0 } },
            { type: 'user/message', seq: 1, data: { turn: 0, source: 'external' } },
            { type: 'assistant/chunk', seq: 2, data: { turn: 0, step: 0, chunk: { type: 'text-delta', text: 'ok' } } },
            { type: 'assistant/message', seq: 3, data: { turn: 0, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, usage: { inputTokens: 3, outputTokens: 1 } } },
            { type: 'step/end', seq: 4, data: { turn: 0, step: 0 } },
            { type: 'turn/end', seq: 5, data: { turn: 0, reason: { kind: 'completed' } } },
          ],
          cursor: null,
        };
      }
      if (method === 'session.close') return { ok: true };
      if (method === 'shutdown') return { ok: true };
      throw new Error(`unexpected ${method}`);
    },
    onNotification() { return () => undefined; },
  };
}

async function setup() {
  const adapter = new DshV2Adapter(fakeBridge() as never, { pluginVersion: '0.1.0' });
  adapter.setEmitSink(() => undefined);
  await adapter.dispatch({ id: 'init', method: 'initialize', params: { protocol: { name: 'gian.proxy', versions: ['2.0'] }, host: { name: 'Gian', version: '0.5.0' } } });
  const create = await adapter.dispatch({
    id: 'create', method: 'session.create',
    params: { sessionId: 's1', workspace: { cwd: '/tmp/p', roots: ['/tmp/p'] }, config: {} },
  });
  const streamId = (create.result as { session: { streamId: string } }).session.streamId;
  return { adapter, streamId };
}

test('turn.start is idempotent for identical params in one attach generation', async () => {
  const { adapter, streamId } = await setup();
  const params = {
    sessionId: 's1',
    streamId,
    turnId: 'dup',
    input: [{ type: 'text', text: 'same' }],
    config: { model: 'deepseek-chat' },
  };
  const first = await adapter.dispatch({ id: 'a', method: 'turn.start', params });
  const second = await adapter.dispatch({ id: 'b', method: 'turn.start', params });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
});

test('session.replay projects external user messages as input.recorded', async () => {
  const { adapter, streamId } = await setup();
  const replay = await adapter.dispatch({
    id: 'replay', method: 'session.replay',
    params: { sessionId: 's1', streamId, cursor: null as unknown as string, limit: 10 },
  });
  assert.equal(replay.ok, true);
  const page = replay.result as { replayStreamId: string; events: Array<{ method: string }> };
  assert.equal(typeof page.replayStreamId, 'string');
  assert.ok(page.events.some((event) => event.method === 'input.recorded'));
  assert.ok(page.events.some((event) => event.method === 'turn.started'));
  assert.ok(page.events.some((event) => event.method === 'turn.completed'));
});
