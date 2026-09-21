import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  AUTH_PROTOCOL,
  RemoteProtocolError,
  exportPublicJwk,
  generateCanonicalId,
  generateP256SigningKeyPair,
  identityFingerprint,
} from '@gian/remote-protocol';
import { createTestClock, listenRemoteApp, makeRemoteTestApp } from '../../remote-server/test/fixture.js';
import { createProductionController } from '../../remote-web/src/controller/create.js';
import { MemoryEncryptedHostCache } from '../../remote-web/src/cache/encrypted-cache.js';
import { MemoryBrowserIdentityStore } from '../../remote-web/src/transport/identity.js';
import { createRemoteSettingsController } from '../../web/src/remote-settings/production.js';
import { HttpRemoteServerAuthClient } from '../src/remote/server-client.js';
import { MemoryRemoteIdentity } from '../src/remote/identity.js';
import { makeTestApp } from './fixtures/test-app.js';

async function until<T>(read: () => T | Promise<T>): Promise<NonNullable<T>> {
  for (let i = 0; i < 250; i++) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Condition did not become true');
}

test('Host Remote HTTP requests time out instead of pinning reconnect forever', async () => {
  const hangingFetch = ((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  })) as typeof fetch;
  const client = new HttpRemoteServerAuthClient(
    'https://remote.test',
    new MemoryRemoteIdentity(),
    hangingFetch,
    20,
  );
  await assert.rejects(
    () => client.challenge(generateCanonicalId()),
    (error: unknown) => error instanceof RemoteProtocolError && error.code === 'HOST_OFFLINE',
  );
});

async function setup() {
  const host = await makeTestApp();
  const server = await makeRemoteTestApp({ clock: createTestClock(Date.now()) });
  const listener = await listenRemoteApp(server.handle);
  const controller = createRemoteSettingsController({
    fetchFn: ((path: string, init?: RequestInit) => host.fetch(path, init)) as typeof fetch,
    pollIntervalMs: 30,
  });
  const unsubscribe = controller.subscribe(() => {});
  await until(() => controller.getState().enrollment.kind === 'not-enrolled');
  const issued = await (await server.fetch('/api/v1/admin/host-enrollments', {
    method: 'POST', headers: { authorization: 'Bearer admin-test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { enrollment_token: string };
  await controller.enroll({ serverUrl: listener.url, enrollmentToken: issued.enrollment_token });
  assert.equal(controller.getState().enrollment.kind, 'connected');
  assert.equal(host.app.remote.settingsState().connection, 'online');
  assert.ok(!JSON.stringify(controller.getState()).includes(issued.enrollment_token));
  return {
    host, server, listener, controller,
    async close() {
      unsubscribe(); controller.dispose?.(); host.app.remote.close(); listener.close(); await host.cleanup();
    },
  };
}

test('remote rename propagates through Settings to Server without replacing enrollment', async () => {
  const context = await setup();
  try {
    const original = context.host.app.remote.enrollment.current()!;
    await context.controller.setHostName?.('Home Mac');
    const saved = context.host.app.remote.enrollment.current()!;
    assert.equal(saved.hostId, original.hostId);
    assert.deepEqual(saved.hostPublicKey, original.hostPublicKey);
    assert.equal(saved.hostName, 'Home Mac');
    assert.equal(context.server.handle.services.repos.getHost(saved.hostId)!.name, 'Home Mac');
    const bad = await context.host.fetch('/api/remote/host-name', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host_name: ' ' }),
    });
    assert.equal(bad.status, 400);
    assert.equal(context.host.app.remote.enrollment.current()!.hostName, 'Home Mac');
  } finally { await context.close(); }
});

test('failed Server rename leaves the persisted local name unchanged', async t => {
  const context = await setup();
  try {
    const original = context.host.app.remote.enrollment.current()!.hostName;
    t.mock.method(HttpRemoteServerAuthClient.prototype, 'renameHost', async () => { throw new Error('offline'); });
    await context.controller.setHostName?.('Unsaved name');
    assert.equal(context.host.app.remote.enrollment.current()!.hostName, original);
    assert.equal(context.controller.getState().error, 'operation_failed');
  } finally { await context.close(); }
});

for (const pairingMode of ['code', 'qr'] as const) test(`live Settings adapter pairs a real Remote Web browser by ${pairingMode} through Server + Host`, async () => {
  const context = await setup();
  const { controller, host, listener } = context;
  let browser: ReturnType<typeof createProductionController> | undefined;
  try {
    await controller.setPublicUrl?.('https://phone.example.test');
    await controller.startPairing();
    const grant = controller.getState().pairing;
    assert.equal(grant.kind, 'awaiting-claim');
    if (grant.kind !== 'awaiting-claim') throw new Error('grant missing');
    assert.match(grant.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const qr = new URL(grant.qrPayload);
    assert.equal(qr.origin, 'https://phone.example.test');
    assert.equal(qr.pathname, '/', 'QR opens the static entry supported by deployed Servers');
    assert.equal(qr.search, '');
    assert.ok(new URLSearchParams(qr.hash.slice(1)).get('nonce'));
    assert.equal((await host.fetch('/api/remote/settings')).headers.get('cache-control'), 'no-store');

    browser = createProductionController({
      baseUrl: listener.url, publicOrigin: 'https://remote.test', wsUrl: listener.wsUrl,
      identity: new MemoryBrowserIdentityStore(), cache: new MemoryEncryptedHostCache(),
      autoRestore: false, platform: 'iOS', userAgent: 'Version/26.0 Mobile Safari/605.1.15',
      ...(pairingMode === 'qr' ? { pairingNonce: new URLSearchParams(qr.hash.slice(1)).get('nonce')! } : {}),
    });
    if (pairingMode === 'qr') {
      assert.equal(browser.state.auth.kind, 'pairing');
      assert.equal(host.app.remote.pairings.latest()?.status, 'pending_claim');
      browser.actions.confirmQrPairing();
    } else browser.actions.submitPairingCode(grant.code);
    await until(() => controller.getState().pairing.kind === 'claimed');
    assert.equal(host.app.remote.devices.list().length, 0, 'claim is not authorization');
    const claimed = controller.getState().pairing;
    if (claimed.kind === 'claimed') {
      assert.equal(claimed.claim.os, 'iOS');
      assert.equal(claimed.claim.browser, 'Safari');
      assert.equal(claimed.claim.networkOrigin, '—', 'do not fabricate location');
    }
    await controller.confirmPairingClaim('allow');
    await until(() => browser!.state.auth.kind === 'authenticated');
    await controller.refresh?.();
    assert.equal(controller.getState().pairing.kind, 'consumed');
    assert.equal(controller.getState().devices.length, 1);
    assert.equal(controller.getState().devices[0].activeConnections, 1);
    if (pairingMode === 'qr') {
      const hostId = host.app.remote.enrollment.current()!.hostId;
      await controller.setHostName?.('Renamed Home Mac');
      await until(() => browser!.state.hosts.find(entry => entry.id === hostId)?.name === 'Renamed Home Mac');
      assert.equal(host.app.remote.enrollment.current()!.hostId, hostId);
      assert.equal(controller.getState().devices.length, 1);
    }
  } finally { browser?.close(); await context.close(); }
});

test('device revoke reauthenticates once after an expired Host access token', async t => {
  const context = await setup();
  const { controller, host, listener, server } = context;
  let browser: ReturnType<typeof createProductionController> | undefined;
  try {
    await controller.startPairing();
    const grant = controller.getState().pairing;
    if (grant.kind !== 'awaiting-claim') throw new Error('grant missing');
    browser = createProductionController({
      baseUrl: listener.url,
      publicOrigin: 'https://remote.test',
      wsUrl: listener.wsUrl,
      identity: new MemoryBrowserIdentityStore(),
      cache: new MemoryEncryptedHostCache(),
      autoRestore: false,
      platform: 'iOS',
      userAgent: 'Version/26.0 Mobile Safari/605.1.15',
    });
    browser.actions.submitPairingCode(grant.code);
    await until(() => controller.getState().pairing.kind === 'claimed');
    await controller.confirmPairingClaim('allow');
    await until(() => browser!.state.auth.kind === 'authenticated');
    const device = host.app.remote.devices.list()[0]!;

    const original = HttpRemoteServerAuthClient.prototype.revokeDevice;
    let calls = 0;
    t.mock.method(HttpRemoteServerAuthClient.prototype, 'revokeDevice', async function (
      this: HttpRemoteServerAuthClient,
      deviceId: string,
    ) {
      calls += 1;
      if (calls === 1) throw new RemoteProtocolError('AUTH_REQUIRED', 'access token expired');
      return original.call(this, deviceId);
    });

    await controller.revokeDevice(device.id);
    await controller.refresh?.();
    assert.ok(calls >= 2);
    assert.equal(controller.getState().devices[0]?.revokeStatus, 'revoked');
    assert.ok(server.handle.services.repos.getPairing(device.id)?.revoked_at);
  } finally {
    browser?.close();
    await context.close();
  }
});

test('disconnect fences a pending authentication attempt so it cannot restore the relay', async t => {
  const context = await setup();
  try {
    const remote = context.host.app.remote;
    const original = HttpRemoteServerAuthClient.prototype.challenge;
    let release!: () => void;
    let reached = false;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    t.mock.method(HttpRemoteServerAuthClient.prototype, 'challenge', async function (this: HttpRemoteServerAuthClient, id: string) {
      const result = await original.call(this, id);
      reached = true;
      await waiting;
      return result;
    });
    remote.disconnect();
    const reconnecting = remote.reconnect();
    await until(() => reached);
    remote.disconnect();
    release();
    await reconnecting;
    assert.equal(remote.relaySocket, null);
    assert.equal(remote.settingsState().connection, 'disconnected');
    assert.equal(remote.enrollment.current()?.connectorEnabled, false);
  } finally { await context.close(); }
});

test('cancelled grants cannot be revived by a delayed Server claim', async () => {
  const context = await setup();
  const { host, controller } = context;
  try {
    await controller.startPairing();
    const grant = host.app.remote.pairings.latest()!;
    await controller.cancelPairing();
    assert.equal(controller.getState().pairing.kind, 'idle');
    const key = await exportPublicJwk((await generateP256SigningKeyPair()).publicKey);
    assert.throws(() => host.app.remote.pairings.applyServerClaim({
      grantId: grant.grantId, pairingId: 'late-claim', publicKey: key,
    }), /no longer claimable/);
    assert.equal(host.app.remote.pairings.get(grant.id)?.status, 'rejected');
    const decision = await host.fetch('/api/remote/pairings/' + grant.id + '/confirm', { method: 'POST' });
    assert.equal(decision.status, 400);
    assert.equal(host.app.remote.devices.list().length, 0);
  } finally { await context.close(); }
});

test('disconnect persists, does not mint enrollment, and explicit reconnect resumes; disable clears credential', async () => {
  const context = await setup();
  const { host, controller } = context;
  try {
    const hostId = host.app.remote.settingsState().host_id;
    await controller.disconnect();
    assert.equal(controller.getState().enrollment.kind, 'disconnected');
    assert.equal(host.app.remote.enrollment.current()?.connectorEnabled, false);
    await host.app.remote.start();
    await host.app.remote.maintainPresence();
    assert.equal(host.app.remote.relaySocket, null);
    assert.equal((await host.fetch('/api/remote/pairings', { method: 'POST' })).status, 400);
    await controller.reconnect();
    assert.equal(host.app.remote.settingsState().connection, 'online');
    assert.equal(host.app.remote.settingsState().host_id, hostId);
    await controller.disableRemote();
    assert.equal(controller.getState().enrollment.kind, 'not-enrolled');
    assert.equal(Boolean(await host.remoteIdentity.getRefreshSecret()), false);
    assert.equal(host.app.remote.relaySocket, null);
  } finally { await context.close(); }
});

test('revocation remains pending until Server acknowledgement and reconciles on heartbeat', async t => {
  const context = await setup();
  const { host, controller } = context;
  try {
    const key = await exportPublicJwk((await generateP256SigningKeyPair()).publicKey);
    const device = host.app.remote.devices.create({ publicKey: JSON.stringify(key), name: 'Phone', platform: 'iOS' });
    const stub = t.mock.method(HttpRemoteServerAuthClient.prototype, 'revokeDevice', async () => { throw new Error('offline'); });
    await controller.revokeDevice(device.id);
    assert.equal(host.app.remote.devices.getActive(device.id), null);
    assert.equal(controller.getState().devices[0].revokeStatus, 'pending-reconciliation');
    // A Server ACK (rather than local revoked_at) is required for completion.
    stub.mock.restore();
    t.mock.method(HttpRemoteServerAuthClient.prototype, 'revokeDevice', async () => {});
    await host.app.remote.maintainPresence();
    await controller.refresh?.();
    assert.equal(controller.getState().devices[0].revokeStatus, 'revoked');
    host.app.remote.audit.write({ deviceId: device.id, method: 'session.create', commandId: '12345678-secret-tail', resultCategory: 'accepted' });
    await controller.loadAudit?.(device.id);
    assert.equal(controller.getState().audit[device.id][0].commandIdSummary, '12345678');
    assert.equal(controller.getState().audit[device.id][0].result, 'pending');
  } finally { await context.close(); }
});

test('identity approval is bound to the displayed fingerprint; rejection retains original pin', async () => {
  const context = await setup();
  const { host, controller } = context;
  try {
    const original = host.app.remote.enrollment.current()!.serverIdentityFingerprint;
    const key = await exportPublicJwk((await generateP256SigningKeyPair()).publicKey);
    await host.app.remote.enrollment.observeServerIdentity({ public_key: key, fingerprint: await identityFingerprint(key) });
    await controller.refresh?.();
    assert.equal(controller.getState().enrollment.kind, 'identity-changed');
    const rejected = await host.fetch('/api/remote/enrollment/confirm-identity', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_fingerprint: 'stale-fingerprint' }),
    });
    assert.equal(rejected.status, 400);
    await controller.rejectServerIdentityChange();
    assert.equal(host.app.remote.enrollment.current()!.serverIdentityFingerprint, original);
    assert.equal(controller.getState().enrollment.kind, 'disconnected');
  } finally { await context.close(); }
});
