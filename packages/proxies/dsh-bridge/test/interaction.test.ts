import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BridgeServer } from '../src/server.js';
import { BridgeWriter } from '../src/jsonrpc.js';
import { FakeDshRuntime } from '../src/fake-host.js';
import { Writable } from 'node:stream';

/**
 * The bridge never adds its own timeout to the early approval/question
 * correlation window (plan §6.4). The host owns the native pending promise;
 * the projected interaction stays buffered until correlation resolves — here
 * the fake runtime emits it immediately after the turn boundary, so the server
 * must not have applied any deadline or dropped it.
 */
test('early interactions are buffered without a bridge-side timeout', async () => {
  const notifications: Array<{ method: string }> = [];
  const runtime = new FakeDshRuntime({ script: 'question' });
  const writer = new BridgeWriter(new Writable({
    write(chunk, _enc, cb) {
      const line = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (line.trim() === '') return cb();
      const value = JSON.parse(line.trim());
      if (value.method !== undefined && value.id === undefined) notifications.push({ method: value.method });
      cb();
    },
  }));
  const server = new BridgeServer({ host: runtime, writer });
  await server.handle({ id: 'init', method: 'initialize', params: { protocol: { versions: ['1.0'] } } });
  await server.handle({
    id: 'create',
    method: 'session.create',
    params: { sessionId: 's1', workspace: { cwd: '/a', roots: ['/a'] }, config: {} },
  });
  await server.handle({
    id: 'turn',
    method: 'turn.start',
    params: { sessionId: 's1', turnId: 't1', input: [{ type: 'text', text: 'ask me' }], config: {} },
  });
  assert.equal(notifications.filter((n) => n.method === 'interaction.requested').length, 1);
});
