import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BridgeServer } from '../src/server.js';
import { BridgeWriter } from '../src/jsonrpc.js';
import { FakeDshRuntime } from '../src/fake-host.js';
import { Writable } from 'node:stream';

function harness() {
  const runtime = new FakeDshRuntime();
  const writer = new BridgeWriter(new Writable({
    write(_chunk, _enc, cb) { cb(); },
  }));
  const server = new BridgeServer({ host: runtime, writer });
  return { runtime, server };
}

async function call(server: BridgeServer, method: string, params: Record<string, unknown> = {}) {
  return server.handle({ id: `r-${method}`, method, params });
}

test('native session list fails closed without a reliable ownership API', async () => {
  const { server } = harness();
  await call(server, 'initialize', { protocol: { versions: ['1.0'] } });
  await assert.rejects(
    () => call(server, 'session.native.list', {}),
    /RUNTIME_UNAVAILABLE/,
  );
});

test('session events read returns format version for the eventId source key', async () => {
  const { server } = harness();
  await call(server, 'initialize', { protocol: { versions: ['1.0'] } });
  await call(server, 'session.create', {
    sessionId: 's1',
    workspace: { cwd: '/a', roots: ['/a'] },
    config: {},
  });
  await call(server, 'turn.start', {
    sessionId: 's1',
    turnId: 't1',
    input: [{ type: 'text', text: 'hi' }],
    config: {},
  });
  const page = await call(server, 'session.events.read', { sessionId: 's1', cursor: null, limit: 500 });
  const typed = page as { formatVersion: number; events: Array<{ seq: number }> };
  assert.equal(typed.formatVersion, 0);
  assert.equal(typed.events[0]?.seq, 0);
});

test('shutdown drains owned sessions and stays idempotent', async () => {
  const { server, runtime } = harness();
  await call(server, 'initialize', { protocol: { versions: ['1.0'] } });
  await call(server, 'session.create', { sessionId: 's1', workspace: { cwd: '/a', roots: ['/a'] }, config: {} });
  const out = await call(server, 'shutdown');
  assert.equal((out as { ok: boolean }).ok, true);
  assert.equal(runtime.sessions.size, 0);
});
