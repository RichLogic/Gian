import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProxyNotification } from '@gian/proxy-protocol';
import { projectNotification } from '../src/event/project-notification.js';
import { ProxyManager } from '../src/proxy/manager.js';

const timestamp = '2026-08-10T00:00:00.000Z';

function jsonRpcSource(
  pluginId: string,
  processScope: 'shared' | 'session',
  extra = '',
): string {
  return `
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const timestamp = '${timestamp}';
function write(payload) {
  process.stdout.write(JSON.stringify(payload) + '\\n');
}
function result(id, value) {
  write({ jsonrpc: '2.0', id, result: value });
}
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    result(request.id, {
      protocol: { name: 'gian.proxy', version: '2.0' },
      plugin: { id: '${pluginId}', name: 'Protocol fixture', version: '0.2.0' },
      process: { scope: '${processScope}' },
      capabilities: { 'session.replay': 1, 'session.native.list': 1, interaction: 1 },
    });
    continue;
  }
  if (request.method === 'catalog.list') {
    result(request.id, {
      catalogRevision: '${pluginId}-fixture-1',
      input: [{ type: 'text' }],
      configOptions: ${pluginId === 'kimi' ? `[{
        id: 'mode', displayName: 'Mode', binding: 'session', role: 'approval_mode',
        control: 'select', required: false, defaultValue: 'ask',
        choices: [
          { value: 'ask', displayName: 'Ask' },
          { value: 'auto', displayName: 'Auto' },
        ],
      }]` : '[]'},
      slashCommands: ${pluginId === 'kimi'
        ? `[{ name: '/status', description: 'Status', source: 'builtin', argHints: [] }]`
        : '[]'},
    });
    continue;
  }
  if (request.method === 'session.create') {
    result(request.id, { session: {
      id: request.params.sessionId,
      nativeSession: { id: request.params.nativeSession?.id ?? 'native-${pluginId}-1' },
      streamId: 'stream-1',
      state: 'idle',
      sessionConfig: request.params.config ?? {},
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    } });
    continue;
  }
  if (request.method === 'session.native.list') {
    result(request.id, {
      sessions: [{ id: 'native-existing', displayName: 'Existing', cwd: '/tmp/project', updatedAt: timestamp }],
      nextCursor: null,
    });
    continue;
  }
  if (request.method === 'session.replay') {
    result(request.id, { replayStreamId: 'replay-1', events: [], nextCursor: null });
    continue;
  }
  if (request.method === 'turn.start') {
    const base = {
      sessionId: request.params.sessionId,
      streamId: request.params.streamId,
      turnId: request.params.turnId,
      sourceTurnId: request.params.turnId,
      emittedAt: timestamp,
    };
    result(request.id, { accepted: true, turnId: request.params.turnId });
    for (const notification of [
      { method: 'turn.started', params: { ...base, eventId: 'event-1', sequence: 1, data: {} } },
      { method: 'content.delta', params: { ...base, eventId: 'event-2', sequence: 2, data: {
        contentId: 'message-1', kind: 'text', delta: 'hello from standard protocol',
      } } },
      { method: 'content.completed', params: { ...base, eventId: 'event-3', sequence: 3, data: {
        contentId: 'message-1', kind: 'text', content: 'hello from standard protocol',
      } } },
      { method: 'turn.completed', params: { ...base, eventId: 'event-4', sequence: 4, data: {
        stopReason: 'completed',
      } } },
    ]) write({ jsonrpc: '2.0', ...notification });
    continue;
  }
  if (request.method === 'session.close' || request.method === 'shutdown') {
    result(request.id, { ok: true });
    if (request.method === 'shutdown') {
      input.close();
      process.stdin.pause();
      break;
    }
    continue;
  }
  ${extra}
  write({
    jsonrpc: '2.0',
    id: request.id,
    error: {
      code: -32601,
      message: request.method,
      data: { domainCode: 'METHOD_NOT_FOUND', retryable: false, details: {} },
    },
  });
}
`;
}

test('ProxyManager routes a Codex session through the generic gian.proxy/2 client', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-protocol-v2-routing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'proxy.mjs');
  await writeFile(entry, jsonRpcSource('codex', 'shared'));
  const manager = new ProxyManager({
    dataDir: join(root, 'data'),
    ccProxyEntry: entry,
    codexProxyEntry: entry,
    codexProxy: { pluginVersion: '0.2.0', processScope: 'shared' },
  });
  t.after(() => manager.closeAll().catch(() => undefined));

  const client = await manager.getOrCreate('host-session-1', 'codex');
  assert.equal((await client.initialize()).protocol.version, '2.0');
  const catalog = await client.catalog();
  assert.equal(catalog.catalogRevision, 'codex-fixture-1');

  const created = await client.createSession({ cwd: '/tmp/project' });
  assert.equal(created.session.id, 'host-session-1');
  assert.equal(created.nativeSessionId, 'native-codex-1');

  const notifications: ProxyNotification[] = [];
  let resolveCompleted!: () => void;
  const completed = new Promise<void>(resolve => { resolveCompleted = resolve; });
  client.onNotification(notification => {
    notifications.push(notification);
    if (notification.method === 'turn.completed') resolveCompleted();
  });
  const started = await client.startTurn({
    sessionId: created.session.id,
    turnId: 'host-turn-1',
    input: [{ type: 'text', text: 'hello' }],
    config: {},
  });
  assert.equal(started.turn.id, 'host-turn-1');
  assert.equal(started.session.state, 'running');
  await completed;
  assert.deepEqual(notifications.map(value => value.method), [
    'turn.started',
    'content.delta',
    'content.completed',
    'turn.completed',
  ]);
  await assert.rejects(client.interruptTurn(), /no active turn/);

  const projected = projectNotification('codex', notifications[1]!, 'host-session-1', 1);
  assert.equal(projected[0]?.display?.type, 'message');
  assert.deepEqual(projected[0]?.display?.data, {
    text: 'hello from standard protocol',
    delta: true,
    itemId: 'message-1',
  });

  await client.shutdown();
  await manager.closeAll();
});

test('ProxyManager routes a Claude session through a session-scoped generic client', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-protocol-v2-claude-routing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'proxy.mjs');
  await writeFile(entry, jsonRpcSource('claude', 'session'));
  const manager = new ProxyManager({
    dataDir: join(root, 'data'),
    hostVersion: '4.5.6',
    ccProxyEntry: entry,
    claudeProxy: { pluginVersion: '0.2.0', processScope: 'session' },
  });
  t.after(() => manager.closeAll().catch(() => undefined));

  const client = await manager.getOrCreate('host-claude-session', 'claude');
  assert.equal((await client.initialize()).protocol.version, '2.0');
  const created = await client.createSession({ cwd: '/tmp/project' });
  assert.equal(created.session.id, 'host-claude-session');
  assert.equal(created.nativeSessionId, 'native-claude-1');

  const notifications: ProxyNotification[] = [];
  let resolveCompleted!: () => void;
  const completed = new Promise<void>(resolve => { resolveCompleted = resolve; });
  client.onNotification(notification => {
    notifications.push(notification);
    if (notification.method === 'turn.completed') resolveCompleted();
  });
  const started = await client.startTurn({
    sessionId: created.session.id,
    turnId: 'host-claude-turn',
    input: [{ type: 'text', text: 'hello' }],
    config: {},
  });
  assert.equal(started.turn.id, 'host-claude-turn');
  assert.equal(started.session.state, 'running');
  await completed;
  assert.deepEqual(notifications.map(value => value.method), [
    'turn.started',
    'content.delta',
    'content.completed',
    'turn.completed',
  ]);
  await assert.rejects(client.interruptTurn(), /no active turn/);

  await client.shutdown();
  await manager.closeAll();
});

test('ProxyManager routes a Kimi session through the shared generic client', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-protocol-v2-kimi-routing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'proxy.mjs');
  await writeFile(entry, jsonRpcSource('kimi', 'shared'));
  const runtimeManager = {
    acquire: async () => ({
      cli: 'kimi',
      binaryPath: '/unused/kimi',
      version: 'fixture',
      source: 'override',
      env: {},
      release: async () => undefined,
    }),
  } as never;
  const manager = new ProxyManager({
    dataDir: join(root, 'data'),
    hostVersion: '4.5.6',
    ccProxyEntry: entry,
    kimiProxyEntry: entry,
    kimiProxy: { pluginVersion: '0.2.0', processScope: 'shared' },
    runtimeManager,
  });
  t.after(() => manager.closeAll().catch(() => undefined));

  const client = await manager.getOrCreate('host-kimi-session', 'kimi');
  assert.equal((await client.initialize()).protocol.version, '2.0');
  assert.equal((await client.catalog()).configOptions[0]?.id, 'mode');
  const native = await client.listNativeSessions?.({ cwd: '/tmp/project' }) as {
    sessions: Array<{ id: string }>;
  };
  assert.equal(native.sessions[0]?.id, 'native-existing');

  const created = await client.createSession({
    cwd: '/tmp/project',
    nativeSessionId: 'native-existing',
    history: 'replay',
  });
  assert.equal(created.session.id, 'host-kimi-session');
  assert.equal(created.nativeSessionId, 'native-existing');
  assert.equal(created.replayEvents?.length, 0);
  assert.equal((await client.catalog()).slashCommands[0]?.name, '/status');

  let resolveCompleted!: () => void;
  const completed = new Promise<void>(resolve => { resolveCompleted = resolve; });
  client.onNotification(notification => {
    if (notification.method === 'turn.completed') resolveCompleted();
  });
  const started = await client.startTurn({
    sessionId: created.session.id,
    turnId: 'host-kimi-turn',
    input: [{ type: 'text', text: 'hello' }],
    config: {},
  });
  assert.equal(started.turn.id, 'host-kimi-turn');
  assert.equal(started.session.state, 'running');
  await completed;
  await assert.rejects(client.interruptTurn(), /no active turn/);

  await client.shutdown();
  await manager.closeAll();
});

test('ProxyManager routes a Grok session through the session-scoped generic client', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-protocol-v2-grok-routing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'proxy.mjs');
  await writeFile(entry, jsonRpcSource('grok', 'session'));
  const runtimeManager = {
    acquire: async () => ({
      cli: 'grok',
      binaryPath: '/unused/grok',
      version: 'fixture',
      source: 'override',
      env: {},
      release: async () => undefined,
    }),
  } as never;
  const manager = new ProxyManager({
    dataDir: join(root, 'data'),
    hostVersion: '4.5.6',
    ccProxyEntry: entry,
    grokProxyEntry: entry,
    grokProxy: { pluginVersion: '0.2.0', processScope: 'session' },
    runtimeManager,
  });
  t.after(() => manager.closeAll().catch(() => undefined));

  const client = await manager.getOrCreate('host-grok-session', 'grok');
  assert.equal((await client.initialize()).protocol.version, '2.0');
  const created = await client.createSession({ cwd: '/tmp/project' });
  assert.equal(created.session.id, 'host-grok-session');
  assert.equal(created.nativeSessionId, 'native-grok-1');

  const notifications: ProxyNotification[] = [];
  let resolveCompleted!: () => void;
  const completed = new Promise<void>(resolve => { resolveCompleted = resolve; });
  client.onNotification(notification => {
    notifications.push(notification);
    if (notification.method === 'turn.completed') resolveCompleted();
  });
  await client.startTurn({
    sessionId: created.session.id,
    turnId: 'host-grok-turn',
    input: [{ type: 'text', text: 'hello' }],
    config: {},
  });
  await completed;
  assert.deepEqual(notifications.map(value => value.method), [
    'turn.started',
    'content.delta',
    'content.completed',
    'turn.completed',
  ]);

  await client.shutdown();
  await manager.closeAll();
});
