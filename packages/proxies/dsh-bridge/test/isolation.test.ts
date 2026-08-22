import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { BridgeServer } from '../src/server.js';
import { BridgeWriter } from '../src/jsonrpc.js';
import { FakeDshRuntime } from '../src/fake-host.js';

function harness() {
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const runtime = new FakeDshRuntime({ script: 'interrupt' });
  const writer = new BridgeWriter(new Writable({
    write(chunk, _enc, cb) {
      const line = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (line.trim() === '') return cb();
      const value = JSON.parse(line.trim());
      if (value.method !== undefined && value.id === undefined) {
        notifications.push({ method: value.method, params: value.params });
      }
      cb();
    },
  }));
  const server = new BridgeServer({ host: runtime, writer });
  return { runtime, server, notifications };
}

async function call(server: BridgeServer, method: string, params: Record<string, unknown> = {}) {
  return server.handle({ id: `r-${method}`, method, params });
}

test('interrupt a turn in one root session leaves another root running', async () => {
  const { server, runtime, notifications } = harness();
  await call(server, 'initialize', { protocol: { versions: ['1.0'] } });
  await call(server, 'session.create', { sessionId: 'a', workspace: { cwd: '/a', roots: ['/a'] }, config: {} });
  await call(server, 'session.create', { sessionId: 'b', workspace: { cwd: '/b', roots: ['/b'] }, config: {} });
  await call(server, 'turn.start', {
    sessionId: 'a', turnId: 't1', input: [{ type: 'text', text: 'hello' }], config: {},
  });
  await call(server, 'turn.start', {
    sessionId: 'b', turnId: 't2', input: [{ type: 'text', text: 'world' }], config: {},
  });
  const interrupt = await call(server, 'turn.interrupt', { sessionId: 'a', turnId: 't1' });
  assert.equal((interrupt as { accepted: boolean }).accepted, true);
  assert.equal(runtime.sessions.get('a')?.closed, false);
  assert.equal(runtime.sessions.get('b')?.closed, false);
  // The interrupted session must still receive its native agent.status echo.
  assert.ok(notifications.some((n) => n.method === 'agent.status'));
});

test('subagent lifecycle notifications are visible on the bridge wire', async () => {
  const { server, notifications, runtime } = harness();
  await call(server, 'initialize', { protocol: { versions: ['1.0'] } });
  await call(server, 'session.create', { sessionId: 'root', workspace: { cwd: '/r', roots: ['/r'] }, config: {} });
  const started = await call(server, 'turn.start', {
    sessionId: 'root', turnId: 't1', input: [{ type: 'text', text: 'ask child' }], config: {},
  });
  assert.equal((started as { accepted: boolean }).accepted, true);
  // The fake host does not auto-run subagents for the interrupt script; the
  // bridge must still relay whatever subagent events arrive.
  const before = notifications.filter((n) => n.method.startsWith('subagent.')).length;
  runtime.emitForTest({ method: 'subagent.started', params: { sessionId: 'root', agentId: 'child-1' } });
  runtime.emitForTest({ method: 'subagent.finished', params: { sessionId: 'root', agentId: 'child-1', state: 'completed' } });
  assert.equal(notifications.filter((n) => n.method.startsWith('subagent.')).length, before + 2);
});
