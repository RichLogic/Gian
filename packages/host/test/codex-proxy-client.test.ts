import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProxyNotification } from '@gian/proxy-protocol';
import { ProtocolV2Host } from '../src/proxy/protocol-v2-session-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'fake-codex-proxy.mjs');

function makeHost() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-codex-test-'));
  const host = new ProtocolV2Host({
    executor: 'codex',
    entry: FIXTURE,
    pluginId: 'codex',
    pluginVersion: '0.2.0',
    processScope: 'shared',
    dataDir: dir,
    hostVersion: '9.9.9',
  });
  return { host, dir };
}

test('Codex host answers initialize / catalog / createSession', async () => {
  const { host, dir } = makeHost();
  try {
    const init = await host.initialize();
    assert.equal(init.protocol.version, '2.0');

    const catalog = await host.catalog();
    assert.ok(Array.isArray(catalog.configOptions));

    const facade = host.createSessionClient('codex-host-a');
    const sess = await facade.createSession({ cwd: '/tmp' });
    assert.equal(sess.session.id, 'codex-host-a');
    assert.ok(typeof sess.nativeSessionId === 'string' && sess.nativeSessionId.length > 0);
  } finally {
    await host.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex host routes notifications to the matching session by sessionId', async () => {
  const { host, dir } = makeHost();
  try {
    await host.initialize();
    const sessionA = host.createSessionClient('codex-alice');
    const sessionB = host.createSessionClient('codex-bob');
    const receivedA: ProxyNotification[] = [];
    const receivedB: ProxyNotification[] = [];
    sessionA.onNotification((notification) => receivedA.push(notification));
    sessionB.onNotification((notification) => receivedB.push(notification));

    const a = await sessionA.createSession({ cwd: '/tmp' });
    const b = await sessionB.createSession({ cwd: '/tmp' });
    await sessionA.startTurn({
      sessionId: a.session.id,
      turnId: 'turn-a',
      input: [{ type: 'text', text: 'hi from alice' }],
      config: {},
    });
    await sessionB.startTurn({
      sessionId: b.session.id,
      turnId: 'turn-b',
      input: [{ type: 'text', text: 'hi from bob' }],
      config: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(receivedA.some((item) => item.method === 'content.delta'));
    assert.ok(receivedB.some((item) => item.method === 'content.delta'));
    assert.ok(receivedA.some((item) => item.method === 'turn.completed'));
    assert.ok(receivedB.some((item) => item.method === 'turn.completed'));

    const deltaA = receivedA.find((item) => item.method === 'content.delta');
    const deltaB = receivedB.find((item) => item.method === 'content.delta');
    assert.equal(deltaA && 'sessionId' in deltaA.params ? deltaA.params.sessionId : null, a.session.id);
    assert.equal(deltaB && 'sessionId' in deltaB.params ? deltaB.params.sessionId : null, b.session.id);
    assert.equal(
      deltaA && 'data' in deltaA.params ? (deltaA.params.data as { delta?: string }).delta : null,
      `pong from ${a.session.id}`,
    );
    assert.equal(
      deltaB && 'data' in deltaB.params ? (deltaB.params.data as { delta?: string }).delta : null,
      `pong from ${b.session.id}`,
    );
  } finally {
    await host.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex session shutdown closes the session without killing the host', async () => {
  const { host, dir } = makeHost();
  try {
    await host.initialize();
    const sessionA = host.createSessionClient('codex-close-a');
    const sessionB = host.createSessionClient('codex-close-b');
    await sessionA.createSession({ cwd: '/tmp' });
    await sessionB.createSession({ cwd: '/tmp' });
    assert.equal(host.hasSessions(), true);
    await sessionA.shutdown();
    assert.equal(host.hasSessions(), true);
    await sessionB.shutdown();
    assert.equal(host.hasSessions(), false);
    const init = await host.initialize();
    assert.equal(init.protocol.version, '2.0');
  } finally {
    await host.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex forceKill unregisters a wedged session without killing the shared host', async () => {
  const { host, dir } = makeHost();
  try {
    await host.initialize();
    const wedged = host.createSessionClient('codex-wedged');
    const healthy = host.createSessionClient('codex-healthy');
    await wedged.createSession({ cwd: '/force-busy' });
    await healthy.createSession({ cwd: '/tmp' });
    wedged.forceKill();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(host.hasSessions(), true, 'the healthy shared-host session remains attached');
    await healthy.shutdown();
    assert.equal(host.hasSessions(), false, 'force-closed session was removed from host routing');
  } finally {
    await host.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host process exit notifies all session facades', async () => {
  const { host, dir } = makeHost();
  try {
    await host.initialize();
    const sessionA = host.createSessionClient('codex-exit-a');
    const sessionB = host.createSessionClient('codex-exit-b');
    await sessionA.createSession({ cwd: '/tmp' });
    await sessionB.createSession({ cwd: '/tmp' });
    let exitedA: number | null | undefined;
    let exitedB: number | null | undefined;
    sessionA.onExit((code) => { exitedA = code; });
    sessionB.onExit((code) => { exitedB = code; });
    await host.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.notEqual(exitedA, undefined);
    assert.notEqual(exitedB, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
