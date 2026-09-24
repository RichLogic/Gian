import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportPublicJwk, generateCanonicalId, identityFingerprint, signBytes,
  type DeviceRelayClientOptions } from '@gian/remote-protocol';
import { enrollHost, makeRemoteTestApp, pairDevice } from '../../remote-server/test/fixture.js';
import { RemoteControllerClient } from '../src/remote/controller-client.js';
import { MemoryRemoteIdentity } from '../src/remote/identity.js';

class Relay {
  isOpen = false;
  closed = false;
  hostGeneration = generateCanonicalId();
  sent: Array<{ command_id: string; method: string; expected: { host_generation: string } }> = [];
  constructor(readonly options: DeviceRelayClientOptions) {}
  async connect() { this.isOpen = true; }
  async sendControl(message: object) { this.sent.push(message as typeof this.sent[number]); }
  async sendContent() {}
  close(reason?: string) { this.closed = true; this.isOpen = false; this.options.handlers.onClose?.(reason ?? 'closed'); }
  notice(type: 'host.offline' | 'host.online', hostId = this.options.hostId) {
    this.options.handlers.onNotice?.({ protocol: 'gian.relay/1', type, host_id: hostId, sent_at: Date.now() });
  }
  reply(commandId: string, data: unknown) {
    return this.options.handlers.onControl({ type: 'command.result', command_id: commandId, attempt_id: generateCanonicalId(), ok: true, data });
  }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture() {
  const server = await makeRemoteTestApp();
  const host = await enrollHost(server.fetch);
  const device = await pairDevice(server.fetch, host.accessToken, host.hostId);
  const identity = new MemoryRemoteIdentity();
  const public_key = await exportPublicJwk(device.keys.publicKey);
  identity.ensureControllerIdentity = async () => ({ public_key, fingerprint: await identityFingerprint(public_key) });
  identity.signControllerIdentity = async (_scope, bytes) => signBytes(device.keys.privateKey, bytes);
  const origin = 'https://remote.test';
  const fingerprint = server.handle.services.identity.fingerprint;
  await identity.setAccountSession(origin, { role: 'controller', serverOrigin: origin, serverFingerprint: fingerprint,
    installationId: device.accountPeerId, accountId: '42', accountLogin: 'test-account', token: device.accountToken,
    expiresAt: Date.now() + 60_000 }, 'controller');
  const relays: Relay[] = [];
  const fetchImpl: typeof fetch = async (url, init) => server.fetch(new URL(String(url)).pathname, init);
  const client = new RemoteControllerClient({ id: generateCanonicalId(), name: 'test', server_origin: origin,
    server_identity_fingerprint: fingerprint, host_id: host.hostId, browser_id: device.browserId,
    device_id: device.deviceId, crypto_connection_id: device.cryptoConnectionId,
    host_public_key_json: null, pairing_id: null, created_at: Date.now() }, identity, () => {}, fetchImpl,
  options => { const relay = new Relay(options); relays.push(relay); return relay; });
  return { client, relays, close() { client.close(); server.handle.shutdown(); } };
}

test('Host offline invalidates live relay crypto, rejects uncertain writes, and the next request negotiates anew', async () => {
  const f = await fixture();
  try {
    await f.client.connect();
    const old = f.relays[0]!;
    assert.equal(f.client.connected, true);
    old.notice('host.offline', generateCanonicalId());
    assert.equal(f.client.connected, true, 'another Host cannot invalidate this environment');
    const read = assert.rejects(f.client.request('catalog.read', {}), { code: 'HOST_OFFLINE' });
    const write = assert.rejects(f.client.request('session.stop', { session_id: generateCanonicalId(), session_revision: '1' }), { code: 'UNKNOWN_OUTCOME' });
    await until(() => old.sent.length === 2);
    old.notice('host.offline');
    assert.equal(f.client.connected, false, 'relay availability is not Host availability');
    assert.equal(old.closed, true);
    await Promise.all([read, write]);
    assert.equal(f.relays.length, 1, 'uncertain writes must not be replayed');

    const resumed = f.client.request('catalog.read', {});
    await until(() => f.relays[1]?.sent.length === 1);
    const fresh = f.relays[1]!;
    assert.notEqual(fresh.hostGeneration, old.hostGeneration);
    assert.equal(fresh.sent[0]!.expected.host_generation, fresh.hostGeneration);
    assert.equal(fresh.options.requireExecution, true);
    old.notice('host.online');
    old.options.handlers.onClose?.('late old socket close');
    assert.equal(f.client.connected, true, 'late old callbacks cannot close the new generation');
    await old.reply(fresh.sent[0]!.command_id, { invalid: 'old generation' });
    const catalog = { catalog_revision: 'new-generation', workspaces: [], agents: [], tasks: [] };
    await fresh.reply(fresh.sent[0]!.command_id, catalog);
    assert.deepEqual(await resumed, catalog);
    assert.deepEqual(fresh.sent.map(item => item.method), ['catalog.read']);
  } finally { f.close(); }
});

test('Host online replacement also invalidates the prior handshake without requiring an offline notice', async () => {
  const f = await fixture();
  try {
    await f.client.connect();
    f.relays[0]!.notice('host.online');
    assert.equal(f.client.connected, false);
    await f.client.connect();
    assert.equal(f.relays.length, 2);
    assert.equal(f.client.connected, true);
  } finally { f.close(); }
});
