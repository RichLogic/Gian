import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProxyNotification } from '@gian/proxy-protocol';
import { ProtocolV2Client } from '../src/proxy/protocol-v2-client.js';
import { ProtocolV2Host } from '../src/proxy/protocol-v2-session-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'fake-proxy.mjs');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gian-proxy-test-'));
}

function clientOptions(dataDir: string) {
  return {
    entry: FIXTURE,
    pluginId: 'claude',
    pluginVersion: '0.2.0',
    processScope: 'session' as const,
    dataDir,
    hostVersion: '9.9.9',
  };
}

test('ProtocolV2Client routes responses by request id', async () => {
  const dir = makeTempDir();
  const client = new ProtocolV2Client(clientOptions(dir));
  try {
    const init = await client.initialize();
    assert.equal(init.protocol.version, '2.0');
    assert.equal(init.plugin.id, 'claude');

    const catalog = await client.catalog();
    assert.ok(catalog && typeof catalog === 'object');

    const host = new ProtocolV2Host({
      ...clientOptions(dir),
      executor: 'claude',
    });
    try {
      const facade = host.createSessionClient('sess_fixture');
      const sess = await facade.createSession({ cwd: '/tmp' });
      assert.equal(sess.session.id, 'sess_fixture');
      assert.equal(sess.nativeSessionId, 'cc_fixture');
    } finally {
      await host.shutdown();
    }
  } finally {
    await client.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ProtocolV2Host attests an exact no-replay native Session reattach', async () => {
  const dir = makeTempDir();
  const host = new ProtocolV2Host({
    ...clientOptions(dir),
    executor: 'claude',
  });
  try {
    const facade = host.createSessionClient('sess_owned');
    const session = await facade.createSession({
      cwd: '/tmp/owned-project',
      nativeSessionId: 'native-owned',
      history: 'none',
    });
    assert.equal(session.nativeSessionId, 'native-owned');
  } finally {
    await host.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ProtocolV2Client surfaces error responses', async () => {
  const dir = makeTempDir();
  const client = new ProtocolV2Client(clientOptions(dir));
  try {
    await client.initialize();
    await assert.rejects(
      client.request('catalog.resolve', {
        catalogRevision: 'claude-fixture-1',
        sessionConfig: {},
        turnConfig: {},
      }),
      /forced failure/,
    );
  } finally {
    await client.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ProtocolV2Client dispatches notifications to subscribers', async () => {
  const dir = makeTempDir();
  const host = new ProtocolV2Host({
    ...clientOptions(dir),
    executor: 'claude',
  });
  const received: ProxyNotification[] = [];
  try {
    const facade = host.createSessionClient('sess_fixture');
    const off = facade.onNotification((notification) => received.push(notification));
    await facade.createSession({ cwd: '/tmp' });
    await facade.startTurn({
      sessionId: 'sess_fixture',
      turnId: 'turn_fixture',
      input: [{ type: 'text', text: 'hi' }],
      config: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    off();
    const methods = received.map((notification) => notification.method);
    assert.ok(methods.includes('turn.completed'), 'expected turn.completed notification');
  } finally {
    await host.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ProtocolV2Client rejects requests after shutdown', async () => {
  const dir = makeTempDir();
  const client = new ProtocolV2Client(clientOptions(dir));
  try {
    await client.initialize();
    await client.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(client.initialize(), /exited|already/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
