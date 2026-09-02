import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { BridgeServer } from '../src/server.js';
import { BridgeWriter } from '../src/jsonrpc.js';
import { FakeDshRuntime } from '../src/fake-host.js';
import { signHostBinding } from '../src/host-binding.js';

interface Output {
  notifications: Array<{ method: string; params: Record<string, unknown> }>;
  results: Array<Record<string, unknown>>;
}

function makeHarness(options: {
  script?: 'success' | 'approval' | 'question' | 'interrupt' | 'error' | 'multi-step';
  hostBindingKey?: string;
} = {}) {
  const runtime = new FakeDshRuntime(options);
  const notifications: Output['notifications'] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      const line = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (line.trim() === '') return cb();
      const value = JSON.parse(line.trim());
      if ('method' in value && value.id === undefined) notifications.push({ method: value.method, params: value.params });
      cb();
    },
  });
  const writer = new BridgeWriter(out);
  const server = new BridgeServer({ host: runtime, writer });
  return { runtime, server, notifications };
}

async function request(server: BridgeServer, method: string, params: Record<string, unknown>) {
  return server.handle({ id: `r-${method}`, method, params });
}

test('initialize must precede every other request', async () => {
  const { server } = makeHarness();
  await assert.rejects(
    () => request(server, 'catalog.list', {}),
    (error: unknown) => (
      typeof error === 'object'
      && error !== null
      && (error as { domainCode?: string }).domainCode === 'NOT_INITIALIZED'
    ),
  );
});

test('initialize returns frozen bridge identity and capabilities', async () => {
  const { server } = makeHarness();
  const result = await request(server, 'initialize', { protocol: { versions: ['1.0'] } });
  const typed = result as {
    protocol: { name: string; version: string };
    plugin: { id: string; bundle: string };
    runtime: { package: string; version: string; sessionFormatVersion: number };
    capabilities: Record<string, number>;
  };
  assert.equal(typed.protocol.name, 'gian.dsh.bridge');
  assert.equal(typed.protocol.version, '1.0');
  assert.equal(typed.plugin.id, 'ai.deepseek.harness');
  assert.equal(typed.plugin.bundle, '@gian/dsh-bridge');
  assert.equal(typed.runtime.package, '@deepseek-ai/dsh');
  assert.equal(typed.runtime.version, '0.1.1-rc.2');
  assert.equal(typed.runtime.sessionFormatVersion, 0);
  assert.equal(typed.capabilities['session.resume'], 1);
  assert.equal(typed.capabilities.interaction, 1);
  assert.equal(typed.capabilities['event.step'], 1);
  assert.equal(typed.capabilities['event.request'], 1);
  assert.equal(typed.capabilities['event.usage'], 1);
});

test('two root sessions keep their event streams isolated', async () => {
  const { server } = makeHarness();
  await request(server, 'initialize', { protocol: { versions: ['1.0'] } });
  await request(server, 'session.create', {
    sessionId: 'g1',
    workspace: { cwd: '/a', roots: ['/a'] },
    config: {},
  });
  await request(server, 'session.create', {
    sessionId: 'g2',
    workspace: { cwd: '/b', roots: ['/b'] },
    config: {},
  });

  const a = await request(server, 'turn.start', {
    sessionId: 'g1',
    turnId: 't1',
    input: [{ type: 'text', text: 'hello a' }],
    config: {},
  });
  const b = await request(server, 'turn.start', {
    sessionId: 'g2',
    turnId: 't2',
    input: [{ type: 'text', text: 'hello b' }],
    config: {},
  });
  assert.equal((a as { accepted: boolean }).accepted, true);
  assert.equal((b as { accepted: boolean }).accepted, true);

  const g1Events = await request(server, 'session.events.read', { sessionId: 'g1', cursor: null, limit: 500 });
  const g2Events = await request(server, 'session.events.read', { sessionId: 'g2', cursor: null, limit: 500 });
  const g1 = g1Events as { events: Array<{ type: string; data: { turn?: number } }> };
  const g2 = g2Events as { events: Array<{ type: string; data: { turn?: number } }> };
  assert.equal(g1.events.filter((e) => e.type === 'turn/start').length, 1);
  assert.equal(g2.events.filter((e) => e.type === 'turn/start').length, 1);
  const g1Text = JSON.stringify(g1.events);
  const g2Text = JSON.stringify(g2.events);
  assert.ok(g1Text.includes('hello a') || g1.events.some((e) => JSON.stringify(e).includes('hello a')));
  assert.equal(g2Text.includes('hello a'), false);
});

test('bridge session.create preserves an authenticated Host-owned native id', async () => {
  const hostBindingKey = 'test-host-binding-key';
  const { server } = makeHarness({ hostBindingKey });
  await request(server, 'initialize', { protocol: { versions: ['1.0'] } });
  const binding = {
    pluginId: 'ai.deepseek.harness',
    sessionId: 'g1',
    nativeSessionId: 'native-owned',
    cwd: '/a',
  };
  const created = await request(server, 'session.create', {
    sessionId: binding.sessionId,
    workspace: { cwd: binding.cwd, roots: [binding.cwd] },
    config: {},
    nativeSession: {
      id: binding.nativeSessionId,
      history: 'none',
      hostBindingProof: signHostBinding(hostBindingKey, binding),
    },
  }) as { session: { nativeId: string } };
  assert.equal(created.session.nativeId, binding.nativeSessionId);

  await assert.rejects(() => request(server, 'session.create', {
    sessionId: 'g2',
    workspace: { cwd: '/a', roots: ['/a'] },
    config: {},
    nativeSession: {
      id: 'foreign',
      history: 'none',
      hostBindingProof: signHostBinding(hostBindingKey, binding),
    },
  }), /valid Host ownership proof/);

  const adoptionBinding = { ...binding, sessionId: 'g3', nativeSessionId: 'native-history' };
  await assert.rejects(() => request(server, 'session.create', {
    sessionId: adoptionBinding.sessionId,
    workspace: { cwd: adoptionBinding.cwd, roots: [adoptionBinding.cwd] },
    config: {},
    nativeSession: {
      id: adoptionBinding.nativeSessionId,
      history: 'replay',
      hostBindingProof: signHostBinding(hostBindingKey, adoptionBinding),
    },
  }), /native session adoption is not supported/);
});

test('one session close leaves the shared peer running', async () => {
  const { server, runtime } = makeHarness();
  await request(server, 'initialize', { protocol: { versions: ['1.0'] } });
  await request(server, 'session.create', { sessionId: 's1', workspace: { cwd: '/a', roots: ['/a'] }, config: {} });
  await request(server, 'session.create', { sessionId: 's2', workspace: { cwd: '/b', roots: ['/b'] }, config: {} });
  await request(server, 'turn.start', {
    sessionId: 's1',
    turnId: 't1',
    input: [{ type: 'text', text: 'x' }],
    config: {},
  });
  const close = await request(server, 'session.close', { sessionId: 's1' });
  assert.equal((close as { ok: boolean }).ok, true);
  assert.equal(runtime.sessions.get('s1')?.closed, true);
  assert.equal(runtime.sessions.get('s2')?.closed, false);
  const second = await request(server, 'turn.start', {
    sessionId: 's2',
    turnId: 't2',
    input: [{ type: 'text', text: 'y' }],
    config: {},
  });
  assert.equal((second as { accepted: boolean }).accepted, true);
});

test('approval interaction is emitted with pending correlation and resolved on respond', async () => {
  const { server, notifications } = makeHarness({ script: 'approval' });
  await request(server, 'initialize', { protocol: { versions: ['1.0'] } });
  await request(server, 'session.create', { sessionId: 's1', workspace: { cwd: '/a', roots: ['/a'] }, config: {} });
  await request(server, 'turn.start', {
    sessionId: 's1',
    turnId: 't1',
    input: [{ type: 'text', text: 'please approve' }],
    config: {},
  });

  const requested = notifications.find((n) => n.method === 'interaction.requested');
  assert.ok(requested, 'approval interaction must be pushed before turn terminal');
  const interaction = requested.params as unknown as {
    interactionId: string;
    actions: Array<{ id: string }>;
  };
  assert.ok(interaction.actions.some((a) => a.id === 'allow-once'));
  assert.ok(interaction.actions.some((a) => a.id === 'reject'));

  await request(server, 'interaction.respond', {
    sessionId: 's1',
    interactionId: interaction.interactionId,
    actionId: 'allow-once',
    values: {},
  });
  const resolved = notifications.filter((n) => n.method === 'interaction.resolved');
  assert.equal(resolved.length, 1);
  const events = await request(server, 'session.events.read', { sessionId: 's1', cursor: null, limit: 500 });
  const list = (events as { events: Array<{ type: string }> }).events;
  assert.equal(list.filter((e) => e.type === 'turn/end').length, 1);
});
