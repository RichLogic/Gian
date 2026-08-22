import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { BridgeProtocolError, BridgeWriter, parseBridgeLine } from '../src/jsonrpc.js';

test('parseBridgeLine accepts a valid object', () => {
  const value = parseBridgeLine('{"jsonrpc":"2.0","id":"1","method":"initialize","params":{}}');
  assert.equal((value as { id: string }).id, '1');
});

test('parseBridgeLine rejects batch arrays', () => {
  assert.throws(
    () => parseBridgeLine('[{"jsonrpc":"2.0","id":"1"},{"jsonrpc":"2.0","id":"2"}]'),
    (error: unknown) => error instanceof BridgeProtocolError && error.code === -32600,
  );
});

test('parseBridgeLine rejects malformed JSON', () => {
  assert.throws(
    () => parseBridgeLine('{not json'),
    (error: unknown) => error instanceof BridgeProtocolError && error.code === -32700,
  );
});

test('BridgeWriter emits one NDJSON line per message', () => {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  const writer = new BridgeWriter(sink);
  writer.result('r1', { ok: true });
  writer.notification('agent.status', { sessionId: 's1', status: 'idle' });
  const text = Buffer.concat(chunks).toString('utf8');
  assert.equal(text.trim().split('\n').length, 2);
  assert.deepEqual(JSON.parse(text.trim().split('\n')[0] ?? ''), {
    jsonrpc: '2.0',
    id: 'r1',
    result: { ok: true },
  });
});
