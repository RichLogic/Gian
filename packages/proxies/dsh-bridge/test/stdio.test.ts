import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { BridgeWriter, runBridgeInput } from '../src/jsonrpc.js';
import { FakeDshRuntime } from '../src/fake-host.js';
import { BridgeServer } from '../src/server.js';

test('stdio round-trip: initialize over a pipe', async () => {
  const input = new PassThrough();
  const chunks: Buffer[] = [];
  const output = new PassThrough();
  output.on('data', (chunk: Buffer) => chunks.push(chunk));

  const runtime = new FakeDshRuntime();
  const writer = new BridgeWriter(output);
  const server = new BridgeServer({ host: runtime, writer });

  input.write('{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocol":{"versions":["1.0"]}}}\n');
  input.write('{"jsonrpc":"2.0","id":"cat","method":"catalog.list","params":{}}\n');
  input.end();

  await runBridgeInput(input, (request) => server.handle(request), writer);

  const lines = Buffer.concat(chunks).toString('utf8').trim().split('\n');
  assert.ok(lines.length >= 2);
  const init = JSON.parse(lines[0] ?? '');
  assert.equal(init.id, 'init');
  assert.equal(init.result.protocol.name, 'gian.dsh.bridge');
  const cat = JSON.parse(lines[1] ?? '');
  assert.equal(cat.id, 'cat');
  assert.equal(typeof cat.result.catalogRevision, 'string');
});
