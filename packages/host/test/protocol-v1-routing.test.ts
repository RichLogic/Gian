import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProxyNotification } from '@gian/shared';
import { projectNotification } from '../src/event/project-notification.js';
import { ProxyManager } from '../src/proxy/manager.js';

const timestamp = '2026-08-10T00:00:00.000Z';

function proxySource(
  pluginId = 'codex',
  processScope: 'shared' | 'session' = 'shared',
): string {
  return `
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const request = JSON.parse(line);
  let result;
  if (request.method === 'initialize') {
    result = {
      protocol: { name: 'gian.proxy', version: '1.0' },
      plugin: { id: '${pluginId}', name: 'Protocol fixture', version: '0.1.0' },
      process: { scope: '${processScope}' },
      capabilities: { 'event.reasoning': 1 },
    };
  } else if (request.method === 'catalog.list') {
    result = {
      models: [{
        id: 'fixture-model', displayName: 'Fixture model', description: '',
        hidden: false, isDefault: true,
        efforts: [{ id: 'medium', displayName: 'Medium', isDefault: true }],
        input: ['text'],
      }],
      modes: [{
        id: 'ask', displayName: 'Ask', description: '', isDefault: true,
        approval: 'relay', workspace: 'workspace-write', network: 'ask',
      }],
      sessionOptions: [],
    };
  } else if (request.method === 'session.create') {
    result = { session: {
      id: request.params.sessionId,
      nativeSession: { id: 'native-${pluginId}-1' },
      streamId: 'stream-1',
      status: 'idle',
      model: request.params.model ?? null,
      createdAt: '${timestamp}',
      updatedAt: '${timestamp}',
    } };
  } else if (request.method === 'turn.start') {
    result = { accepted: true, turnId: request.params.turnId };
  } else if (request.method === 'session.close' || request.method === 'shutdown') {
    result = { ok: true };
  }
  if (request.method === 'turn.start') {
    const base = {
      sessionId: request.params.sessionId,
      streamId: request.params.streamId,
      turnId: request.params.turnId,
      emittedAt: '${timestamp}',
    };
    for (const notification of [
      { method: 'turn.started', params: { ...base, eventId: 'event-1', sequence: 1, data: {} } },
      { method: 'content.delta', params: { ...base, eventId: 'event-2', sequence: 2, data: {
        contentId: 'message-1', kind: 'text', delta: 'hello from standard protocol',
      } } },
      { method: 'turn.completed', params: { ...base, eventId: 'event-3', sequence: 3, data: {
        stopReason: 'completed',
      } } },
    ]) process.stdout.write(JSON.stringify(notification) + '\\n');
  }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
  if (request.method === 'shutdown') {
    input.close();
    process.stdin.pause();
    break;
  }
}
`;
}

function kimiProxySource(): string {
  return `
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const timestamp = '${timestamp}';
const configOptions = [{
  id: 'mode', displayName: 'Mode', type: 'select', scope: 'session',
  currentValue: 'ask',
  choices: [{ value: 'ask', displayName: 'Ask' }, { value: 'auto', displayName: 'Auto' }],
}];
for await (const line of input) {
  const request = JSON.parse(line);
  let result;
  if (request.method === 'initialize') {
    result = {
      protocol: { name: 'gian.proxy', version: '1.0' },
      plugin: { id: 'kimi', name: 'Kimi fixture', version: '0.1.0' },
      process: { scope: 'shared' },
      capabilities: {
        'session.nativeList': 1, 'session.replay': 1, 'session.config': 1,
        'slash.list': 1, 'event.reasoning': 1,
      },
    };
  } else if (request.method === 'catalog.list') {
    result = {
      models: [{
        id: 'kimi-model', displayName: 'Kimi model', description: '',
        hidden: false, isDefault: true,
        efforts: [{ id: 'medium', displayName: 'Medium', isDefault: true }],
        input: ['text'],
      }],
      modes: [{
        id: 'ask', displayName: 'Ask', description: '', isDefault: true,
        approval: 'relay', workspace: 'workspace-write', network: 'ask',
      }],
      sessionOptions: configOptions,
    };
  } else if (request.method === 'session.create' || request.method === 'session.get') {
    const sessionId = request.params.sessionId;
    result = { session: {
      id: sessionId, nativeSession: { id: request.params.nativeSession?.id ?? 'native-kimi-1' },
      streamId: 'stream-kimi-1', status: 'idle', model: 'kimi-model', mode: 'ask',
      configOptions, createdAt: timestamp, updatedAt: timestamp,
    } };
  } else if (request.method === 'session.native.list') {
    result = { sessions: [{ id: 'native-existing', displayName: 'Existing', cwd: '/tmp/project', updatedAt: timestamp }], nextCursor: null };
  } else if (request.method === 'session.replay') {
    result = { replayStreamId: 'replay-kimi-1', events: [], nextCursor: null };
  } else if (request.method === 'session.config.set') {
    result = { session: {
      id: request.params.sessionId, nativeSession: { id: 'native-kimi-1' },
      streamId: request.params.streamId, status: 'idle', model: 'kimi-model', mode: request.params.value,
      configOptions: configOptions.map(option => ({ ...option, currentValue: request.params.value })),
      createdAt: timestamp, updatedAt: timestamp,
    }, configOptions: configOptions.map(option => ({ ...option, currentValue: request.params.value })) };
  } else if (request.method === 'slash.list') {
    result = { commands: [{ name: '/status', description: 'Status', source: 'builtin', argHints: [] }] };
  } else if (request.method === 'turn.start') {
    result = { accepted: true, turnId: request.params.turnId };
  } else if (request.method === 'session.close' || request.method === 'shutdown') {
    result = { ok: true };
  }
  if (request.method === 'turn.start') {
    const base = {
      sessionId: request.params.sessionId, streamId: request.params.streamId,
      turnId: request.params.turnId, emittedAt: timestamp,
    };
    for (const notification of [
      { method: 'turn.started', params: { ...base, eventId: 'kimi-event-1', sequence: 1, data: {} } },
      { method: 'content.delta', params: { ...base, eventId: 'kimi-event-2', sequence: 2, data: {
        contentId: 'kimi-message-1', kind: 'text', delta: 'hello from Kimi protocol',
      } } },
      { method: 'turn.completed', params: { ...base, eventId: 'kimi-event-3', sequence: 3, data: { stopReason: 'completed' } } },
    ]) process.stdout.write(JSON.stringify(notification) + '\\n');
  }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
  if (request.method === 'shutdown') {
    input.close();
    process.stdin.pause();
    break;
  }
}
`;
}

test('ProxyManager routes a manifest-v2 Codex session through the generic client', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-protocol-v1-routing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'proxy.mjs');
  await writeFile(entry, proxySource());
  const manager = new ProxyManager({
    dataDir: join(root, 'data'),
    ccProxyEntry: entry,
    codexProxyEntry: entry,
    codexProxyProtocolV1: { pluginVersion: '0.1.0', processScope: 'shared' },
  });
  t.after(() => manager.closeAll().catch(() => undefined));

  const client = await manager.getOrCreate('host-session-1', 'codex');
  assert.equal((await client.initialize()).protocolVersion, 'gian.proxy/1.0');
  const capabilities = await client.capabilities();
  assert.equal(capabilities.models[0]?.id, 'fixture-model');

  const created = await client.createSession({ cwd: '/tmp/project', model: 'fixture-model' });
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
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
  });
  assert.equal(started.turn.id, 'host-turn-1');
  assert.equal(started.session.status, 'idle');
  await completed;
  assert.deepEqual(notifications.map(value => value.method), [
    'turn.started',
    'content.delta',
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

test('ProxyManager routes a manifest-v2 Claude session through a session-scoped generic client', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-protocol-v1-claude-routing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'proxy.mjs');
  await writeFile(entry, proxySource('claude', 'session'));
  const manager = new ProxyManager({
    dataDir: join(root, 'data'),
    hostVersion: '4.5.6',
    ccProxyEntry: entry,
    claudeProxyProtocolV1: { pluginVersion: '0.1.0', processScope: 'session' },
  });
  t.after(() => manager.closeAll().catch(() => undefined));

  const client = await manager.getOrCreate('host-claude-session', 'claude');
  assert.equal((await client.initialize()).protocolVersion, 'gian.proxy/1.0');
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
    permissionMode: 'default',
  });
  assert.equal(started.turn.id, 'host-claude-turn');
  assert.equal(started.session.status, 'idle');
  await completed;
  assert.deepEqual(notifications.map(value => value.method), [
    'turn.started',
    'content.delta',
    'turn.completed',
  ]);
  await assert.rejects(client.interruptTurn(), /no active turn/);

  await client.shutdown();
  await manager.closeAll();
});

test('ProxyManager routes a manifest-v2 Kimi session through the shared generic client', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-protocol-v1-kimi-routing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'proxy.mjs');
  await writeFile(entry, kimiProxySource());
  const runtimeManager = {
    acquire: async () => ({
      cli: 'kimi',
      binaryPath: '/unused/kimi',
      version: 'fixture',
      source: 'override',
      env: {},
      release: async () => undefined,
    }),
  } as any;
  const manager = new ProxyManager({
    dataDir: join(root, 'data'),
    hostVersion: '4.5.6',
    ccProxyEntry: entry,
    kimiProxyEntry: entry,
    kimiProxyProtocolV1: { pluginVersion: '0.1.0', processScope: 'shared' },
    runtimeManager,
  });
  t.after(() => manager.closeAll().catch(() => undefined));

  const client = await manager.getOrCreate('host-kimi-session', 'kimi');
  assert.equal((await client.initialize()).protocolVersion, 'gian.proxy/1.0');
  assert.equal((await client.capabilities()).models[0]?.id, 'kimi-model');
  const native = await client.listNativeSessions?.({ cwd: '/tmp/project' }) as {
    sessions: Array<{ sessionId: string }>;
  };
  assert.equal(native.sessions[0]?.sessionId, 'native-existing');

  const created = await client.createSession({
    cwd: '/tmp/project',
    nativeSessionId: 'native-existing',
    resumeMode: 'load',
  });
  assert.equal(created.session.id, 'host-kimi-session');
  assert.equal(created.nativeSessionId, 'native-existing');
  assert.equal(created.replayUpdates?.length, 0);
  assert.equal(created.configOptions?.[0]?.name, 'Mode');
  assert.equal((await client.listSlashCommands()).commands[0]?.name, '/status');
  assert.equal((await client.setNativeConfig?.('mode', 'auto'))?.state.values.mode, 'auto');

  let resolveCompleted!: () => void;
  const completed = new Promise<void>(resolve => { resolveCompleted = resolve; });
  client.onNotification(notification => {
    if (notification.method === 'turn.completed') resolveCompleted();
  });
  const started = await client.startTurn({
    sessionId: created.session.id,
    turnId: 'host-kimi-turn',
    input: [{ type: 'text', text: 'hello' }],
  });
  assert.equal(started.turn.id, 'host-kimi-turn');
  assert.equal(started.session.status, 'idle');
  await completed;
  await assert.rejects(client.interruptTurn(), /no active turn/);

  await client.shutdown();
  await manager.closeAll();
});
