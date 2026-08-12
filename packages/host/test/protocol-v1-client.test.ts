import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ProxyNotification } from '@gian/proxy-protocol';
import { ProtocolV1Client } from '../src/proxy/protocol-v1-client.js';

function fixtureSource(options: { malformedCatalog?: boolean; invalidUtf8Catalog?: boolean } = {}): string {
  return `
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const emittedAt = '2026-08-10T00:00:00.000Z';
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: request.id, result: {
      protocol: { name: 'gian.proxy', version: '1.0' },
      plugin: { id: process.env.GIAN_PLUGIN_ID, name: 'Fixture', version: '7.4.2' },
      process: { scope: 'shared' },
      capabilities: {},
    } }) + '\\n');
  } else if (request.method === 'catalog.list') {
    ${options.invalidUtf8Catalog
      ? "process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));"
      : options.malformedCatalog
      ? "process.stdout.write('{bad-json\\n');"
      : "process.stdout.write(JSON.stringify({ id: request.id, result: { models: [], modes: [], sessionOptions: [] } }) + '\\n');"}
  } else if (request.method === 'session.create') {
    process.stdout.write(JSON.stringify({ id: request.id, result: { session: {
      id: request.params.sessionId,
      nativeSession: { id: 'native-1' },
      streamId: 'stream-1',
      status: 'idle',
      createdAt: emittedAt,
      updatedAt: emittedAt,
    } } }) + '\\n');
  } else if (request.method === 'turn.start') {
    process.stdout.write(JSON.stringify({ id: request.id, result: {
      accepted: true,
      turnId: request.params.turnId,
    } }) + '\\n');
    const base = {
      streamId: request.params.streamId,
      sessionId: request.params.sessionId,
      turnId: request.params.turnId,
      emittedAt,
    };
    process.stdout.write(JSON.stringify({ method: 'turn.started', params: {
      ...base, eventId: 'event-1', sequence: 1, data: {},
    } }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'content.delta', params: {
      ...base, eventId: 'event-2', sequence: 2,
      data: { contentId: 'content-1', kind: 'text', delta: 'hello' },
    } }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'turn.completed', params: {
      ...base, eventId: 'event-3', sequence: 3,
      data: { stopReason: 'completed' },
    } }) + '\\n');
  } else if (request.method === 'session.close' || request.method === 'shutdown') {
    process.stdout.write(JSON.stringify({ id: request.id, result: { ok: true } }) + '\\n');
    if (request.method === 'shutdown') break;
  }
}
`;
}

async function fixtureClient(
  t: TestContext,
  source: string,
): Promise<ProtocolV1Client> {
  const root = await mkdtemp(join(tmpdir(), 'gian-protocol-v1-client-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'proxy.mjs');
  await writeFile(entry, source);
  return new ProtocolV1Client({
    entry,
    pluginId: 'io.gian.fixture',
    pluginVersion: '7.4.2',
    processScope: 'shared',
    dataDir: join(root, 'data'),
    runtimeBin: process.execPath,
    hostVersion: '99.8.7',
  });
}

test('generic protocol v1 client validates requests, responses, and notifications', async t => {
  const client = await fixtureClient(t, fixtureSource());
  const notifications: ProxyNotification[] = [];
  let resolveNotifications!: () => void;
  const allNotifications = new Promise<void>(resolve => { resolveNotifications = resolve; });
  client.onNotification((notification) => {
    notifications.push(notification);
    if (notifications.length === 3) resolveNotifications();
  });

  const initialized = await client.initialize();
  assert.equal(initialized.plugin.id, 'io.gian.fixture');
  assert.equal(initialized.plugin.version, '7.4.2');
  assert.deepEqual(await client.catalog(), { models: [], modes: [], sessionOptions: [] });

  const created = await client.request<{ session: { streamId: string } }>('session.create', {
    sessionId: 'session-1',
    cwd: '/tmp/project',
    workspaceRoots: ['/tmp/project'],
    config: {},
  });
  assert.equal(created.session.streamId, 'stream-1');

  await client.request('turn.start', {
    sessionId: 'session-1',
    streamId: 'stream-1',
    turnId: 'turn-1',
    input: [{ type: 'text', text: 'hello' }],
    policy: {
      workspaceRoots: ['/tmp/project'],
      approval: 'relay',
      network: 'ask',
    },
    config: { native: {} },
  });
  await allNotifications;
  assert.deepEqual(notifications.map(value => value.method), [
    'turn.started',
    'content.delta',
    'turn.completed',
  ]);

  await client.request('session.close', { sessionId: 'session-1', streamId: 'stream-1' });
  await client.shutdown();
  assert.equal(client.isExited(), true);
});

test('generic protocol v1 client treats malformed stdout as a fatal connection error', async t => {
  const client = await fixtureClient(t, fixtureSource({ malformedCatalog: true }));
  const exited = new Promise<void>(resolve => client.onExit(() => resolve()));
  await client.initialize();
  await assert.rejects(client.catalog(), /Invalid JSON/i);
  await exited;
  assert.equal(client.isExited(), true);
});

test('generic protocol v1 client treats invalid UTF-8 stdout as fatal', async t => {
  const client = await fixtureClient(t, fixtureSource({ invalidUtf8Catalog: true }));
  const exited = new Promise<void>(resolve => client.onExit(() => resolve()));
  await client.initialize();
  await assert.rejects(client.catalog(), /valid UTF-8/i);
  await exited;
  assert.equal(client.isExited(), true);
});
