import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ProxyNotification } from '@gian/proxy-protocol';
import { ProtocolV2Client } from '../src/proxy/protocol-v2-client.js';

function fixtureSource(options: { malformedCatalog?: boolean; invalidUtf8Catalog?: boolean } = {}): string {
  return `
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const emittedAt = '2026-08-10T00:00:00.000Z';
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.jsonrpc !== '2.0' || typeof request.id !== 'string') {
    throw new Error('fixture expected JSON-RPC 2.0 string ids');
  }
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
      protocol: { name: 'gian.proxy', version: '2.0' },
      plugin: { id: process.env.GIAN_PLUGIN_ID, name: 'Fixture', version: '7.4.2' },
      process: { scope: 'shared' },
      capabilities: {},
    } }) + '\\n');
  } else if (request.method === 'catalog.list') {
    ${options.invalidUtf8Catalog
      ? "process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));"
      : options.malformedCatalog
      ? "process.stdout.write('{bad-json\\n');"
      : "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { catalogRevision: 'rev-1', input: [{ type: 'text' }], configOptions: [], slashCommands: [] } }) + '\\n');"}
  } else if (request.method === 'session.create') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { session: {
      id: request.params.sessionId,
      nativeSession: { id: 'native-1' },
      streamId: 'stream-1',
      state: 'idle',
      sessionConfig: request.params.config ?? {},
      createdAt: emittedAt,
      updatedAt: emittedAt,
    } } }) + '\\n');
  } else if (request.method === 'turn.start') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
      accepted: true,
      turnId: request.params.turnId,
    } }) + '\\n');
    const base = {
      streamId: request.params.streamId,
      sessionId: request.params.sessionId,
      turnId: request.params.turnId,
      sourceTurnId: request.params.turnId,
      emittedAt,
    };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn.started', params: {
      ...base, eventId: 'event-1', sequence: 1, data: {},
    } }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'content.delta', params: {
      ...base, eventId: 'event-2', sequence: 2,
      data: { contentId: 'content-1', kind: 'text', delta: 'hello' },
    } }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'content.completed', params: {
      ...base, eventId: 'event-3', sequence: 3,
      data: { contentId: 'content-1', kind: 'text', content: 'hello' },
    } }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn.completed', params: {
      ...base, eventId: 'event-4', sequence: 4,
      data: { stopReason: 'completed' },
    } }) + '\\n');
  } else if (request.method === 'session.close' || request.method === 'shutdown') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n');
    if (request.method === 'shutdown') break;
  }
}
`;
}

async function fixtureClient(
  t: TestContext,
  source: string,
): Promise<ProtocolV2Client> {
  const root = await mkdtemp(join(tmpdir(), 'gian-protocol-v2-client-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'proxy.mjs');
  await writeFile(entry, source);
  return new ProtocolV2Client({
    entry,
    pluginId: 'io.gian.fixture',
    pluginVersion: '7.4.2',
    processScope: 'shared',
    dataDir: join(root, 'data'),
    runtimeBin: process.execPath,
    hostVersion: '99.8.7',
  });
}

test('generic protocol v2 client validates JSON-RPC requests, responses, and notifications', async (t) => {
  const client = await fixtureClient(t, fixtureSource());
  const notifications: ProxyNotification[] = [];
  let resolveNotifications!: () => void;
  let sessionFault: Error | undefined;
  const allNotifications = new Promise<void>((resolve) => { resolveNotifications = resolve; });
  client.onSessionFault((error) => {
    sessionFault = error;
    resolveNotifications();
  });
  client.onNotification((notification) => {
    notifications.push(notification);
    if (notifications.length === 4) resolveNotifications();
  });

  const initialized = await client.initialize();
  assert.equal(initialized.plugin.id, 'io.gian.fixture');
  assert.equal(initialized.plugin.version, '7.4.2');
  assert.equal(initialized.protocol.version, '2.0');
  assert.deepEqual(await client.catalog(), {
    catalogRevision: 'rev-1',
    input: [{ type: 'text' }],
    configOptions: [],
    slashCommands: [],
  });

  const created = await client.request<{ session: { streamId: string } }>('session.create', {
    sessionId: 'session-1',
    workspace: { cwd: '/tmp/project', roots: ['/tmp/project'] },
    config: {},
  });
  assert.equal(created.session.streamId, 'stream-1');

  await client.request('turn.start', {
    sessionId: 'session-1',
    streamId: 'stream-1',
    turnId: 'turn-1',
    input: [{ type: 'text', text: 'hello' }],
    config: {},
  });
  try {
    await allNotifications;
    if (sessionFault) throw sessionFault;
    assert.deepEqual(notifications.map((value) => value.method), [
      'turn.started',
      'content.delta',
      'content.completed',
      'turn.completed',
    ]);
    await client.request('session.close', { sessionId: 'session-1', streamId: 'stream-1' });
  } finally {
    await client.shutdown().catch(() => undefined);
  }
  assert.equal(client.isExited(), true);
});

test('generic protocol v2 client treats malformed stdout as a fatal connection error', async (t) => {
  const client = await fixtureClient(t, fixtureSource({ malformedCatalog: true }));
  const exited = new Promise<void>((resolve) => client.onExit(() => resolve()));
  await client.initialize();
  await assert.rejects(client.catalog(), /Invalid JSON|PARSE_ERROR|protocol/i);
  await exited;
  assert.equal(client.isExited(), true);
});

test('generic protocol v2 client treats invalid UTF-8 stdout as fatal', async (t) => {
  const client = await fixtureClient(t, fixtureSource({ invalidUtf8Catalog: true }));
  const exited = new Promise<void>((resolve) => client.onExit(() => resolve()));
  await client.initialize();
  await assert.rejects(client.catalog(), /UTF-8|PARSE_ERROR|protocol/i);
  await exited;
  assert.equal(client.isExited(), true);
});
