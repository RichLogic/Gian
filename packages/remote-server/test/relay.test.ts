import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CONTENT_WINDOW_CHUNKS,
  RELAY_PROTOCOL,
  RemoteProtocolError,
  generateCanonicalId,
  parseClosed,
  relayNoticeSchema,
  type RelayFrame,
  type RelayHandshake,
  type RelayNotice,
} from '@gian/remote-protocol';

import { createConfig } from '../src/config.js';
import { createRemoteApp } from '../src/app.js';
import { PresenceService } from '../src/presence/leases.js';
import { ControlOutbox } from '../src/relay/outbox.js';
import { RelayRouter, type RelayPeer } from '../src/relay/router.js';
import { openRemoteDatabase } from '../src/storage/db.js';
import { RemoteRepositories } from '../src/storage/repositories.js';
import { listenRemoteApp } from './fixture.js';

function ids() {
  return {
    host: generateCanonicalId(),
    device: generateCanonicalId(),
    route: generateCanonicalId(),
    connection: generateCanonicalId(),
  };
}

function controlFrame(
  binding: ReturnType<typeof ids>,
  sequence: number,
  extra: Partial<RelayFrame> = {},
): RelayFrame {
  return {
    protocol: RELAY_PROTOCOL,
    frame_id: generateCanonicalId(),
    frame_class: 'control',
    route_id: binding.route,
    host_id: binding.host,
    device_id: binding.device,
    connection_id: binding.connection,
    transport_sequence: sequence,
    transport_ack: 0,
    sent_at: 1,
    ciphertext: 'AAAA',
    ...extra,
  };
}

function fakePeer(
  role: 'host' | 'device',
  binding: ReturnType<typeof ids>,
  sent: Array<RelayFrame | RelayNotice | RelayHandshake> = [],
): RelayPeer {
  return {
    role,
    hostId: binding.host,
    deviceId: binding.device,
    routeId: binding.route,
    connectionId: binding.connection,
    send(frame) {
      sent.push(frame);
    },
    close() {},
  };
}

function createRouter(overrides: Partial<Parameters<typeof createConfig>[0]> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-remote-relay-'));
  const now = () => Date.UTC(2026, 8, 1);
  const db = openRemoteDatabase(dataDir);
  const repos = new RemoteRepositories(db, now);
  const config = createConfig({
    dataDir,
    publicOrigin: 'https://remote.test',
    adminToken: 'admin-test-token',
    now,
    ...overrides,
  });
  const presence = new PresenceService(repos, config);
  function online(hostId: string): void {
    db.prepare(`
      INSERT OR IGNORE INTO hosts(id, name, public_key_jwk, created_at) VALUES (?, ?, ?, ?)
    `).run(hostId, 'test-host', '{}', now());
    presence.heartbeat(hostId);
  }
  return { router: new RelayRouter(config, presence), presence, db, online };
}

test('content frames never enter the control outbox', () => {
  const outbox = new ControlOutbox(8, 1024);
  const binding = ids();
  assert.throws(
    () => outbox.enqueue(controlFrame(binding, 0, { frame_class: 'content' }), 'device_to_host'),
    /content frames cannot enter the control outbox/,
  );
});

test('offline host rejects device frames without queuing ciphertext', () => {
  const { router, presence } = createRouter();
  const binding = ids();
  const sent: Array<RelayFrame | RelayNotice> = [];
  router.attach(fakePeer('device', binding, sent));
  assert.equal(presence.isOnline(binding.host), false);
  assert.throws(
    () => router.handleFrame(binding.connection, controlFrame(binding, 0)),
    (error: unknown) => error instanceof RemoteProtocolError && error.code === 'HOST_OFFLINE',
  );
  assert.equal(router.outbox.size(binding.route).frames, 0);
  assert.deepEqual(sent, []);
});

test('online route forwards control frames and isolates outbox overflow', () => {
  const { router, online } = createRouter({
    controlOutboxMaxFrames: 2,
    maxControlFramesPerSecond: 50,
  });
  const slow = ids();
  const other = ids();
  const otherHost: Array<RelayFrame | RelayNotice> = [];
  online(slow.host);
  online(other.host);
  router.attach(fakePeer('device', slow));
  router.attach({
    ...fakePeer('host', slow),
    connectionId: generateCanonicalId(),
  });
  router.attach(fakePeer('device', other));
  router.attach({
    ...fakePeer('host', other, otherHost),
    connectionId: generateCanonicalId(),
  });

  router.handleFrame(slow.connection, controlFrame(slow, 0));
  router.handleFrame(slow.connection, controlFrame(slow, 1));
  assert.throws(
    () => router.handleFrame(slow.connection, controlFrame(slow, 2)),
    (error: unknown) => error instanceof RemoteProtocolError && error.code === 'RATE_LIMITED',
  );
  assert.equal(router.outbox.size(slow.route).frames, 2);

  router.handleFrame(other.connection, controlFrame(other, 0));
  assert.equal(router.outbox.size(other.route).frames, 1);
  assert.equal(otherHost.length, 1);
});

test('transport replay, rollback, and cross-route frames fail closed', () => {
  const { router, online } = createRouter();
  const binding = ids();
  online(binding.host);
  router.attach(fakePeer('device', binding));
  router.handleFrame(binding.connection, controlFrame(binding, 0));
  const framesBefore = router.outbox.size(binding.route).frames;
  assert.throws(
    () => router.handleFrame(binding.connection, controlFrame(binding, 0)),
    /replay or rollback/,
  );
  assert.equal(router.outbox.size(binding.route).frames, framesBefore);
  assert.throws(
    () => router.handleFrame(binding.connection, controlFrame(binding, 2)),
    /transport sequence gap/,
  );
  assert.equal(router.outbox.size(binding.route).frames, framesBefore);
  assert.throws(
    () => router.handleFrame(binding.connection, controlFrame(binding, 0, {
      host_id: generateCanonicalId(),
      transport_sequence: 1,
    })),
    /crossed its route binding/,
  );
  assert.equal(router.outbox.size(binding.route).frames, framesBefore);
});

test('content window backpressure stays off the control outbox', () => {
  const { router, online } = createRouter();
  const binding = ids();
  online(binding.host);
  router.attach(fakePeer('device', binding));
  for (let sequence = 0; sequence < CONTENT_WINDOW_CHUNKS; sequence += 1) {
    router.handleFrame(binding.connection, controlFrame(binding, sequence, { frame_class: 'content' }));
  }
  assert.equal(router.outbox.size(binding.route).frames, 0);
  assert.throws(
    () => router.handleFrame(binding.connection, controlFrame(binding, CONTENT_WINDOW_CHUNKS, { frame_class: 'content' })),
    /content window is full/,
  );
  assert.equal(router.outbox.size(binding.route).frames, 0);
});

test('host and device with different route ids still forward to each other', () => {
  const { router, online } = createRouter();
  const hostId = generateCanonicalId();
  const deviceId = generateCanonicalId();
  const hostSent: RelayFrame[] = [];
  const deviceSent: RelayFrame[] = [];
  online(hostId);
  router.attach({
    role: 'host',
    hostId,
    routeId: hostId,
    connectionId: generateCanonicalId(),
    send(frame) {
      if ('ciphertext' in frame) hostSent.push(frame as RelayFrame);
    },
    close() {},
  });
  const deviceConnection = generateCanonicalId();
  router.attach({
    role: 'device',
    hostId,
    deviceId,
    routeId: deviceId,
    connectionId: deviceConnection,
    send(frame) {
      if ('ciphertext' in frame) deviceSent.push(frame as RelayFrame);
    },
    close() {},
  });
  router.handleFrame(deviceConnection, {
    protocol: RELAY_PROTOCOL,
    frame_id: generateCanonicalId(),
    frame_class: 'control',
    route_id: deviceId,
    host_id: hostId,
    device_id: deviceId,
    connection_id: deviceConnection,
    transport_sequence: 0,
    transport_ack: 0,
    sent_at: 1,
    ciphertext: 'AAAA',
  });
  assert.equal(hostSent.length, 1);
  assert.equal(hostSent[0]?.device_id, deviceId);
});

test('content window releases after the peer acks those sequences', () => {
  const { router, online } = createRouter();
  const binding = ids();
  const hostConnection = generateCanonicalId();
  online(binding.host);
  router.attach(fakePeer('device', binding));
  router.attach({
    ...fakePeer('host', binding),
    connectionId: hostConnection,
  });
  for (let sequence = 0; sequence < CONTENT_WINDOW_CHUNKS; sequence += 1) {
    router.handleFrame(binding.connection, controlFrame(binding, sequence, { frame_class: 'content' }));
  }
  assert.throws(
    () => router.handleFrame(binding.connection, controlFrame(binding, CONTENT_WINDOW_CHUNKS, { frame_class: 'content' })),
    /content window is full/,
  );
  router.handleFrame(hostConnection, {
    ...controlFrame({ ...binding, connection: hostConnection }, 0),
    transport_ack: CONTENT_WINDOW_CHUNKS - 1,
  });
  router.handleFrame(binding.connection, controlFrame(binding, CONTENT_WINDOW_CHUNKS, { frame_class: 'content' }));
  assert.equal(router.content.inFlight(binding.connection) <= CONTENT_WINDOW_CHUNKS, true);
});

test('reattach does not replay ciphertext from a previous crypto generation', () => {
  const { router, online } = createRouter();
  const binding = ids();
  const replayed: Array<RelayFrame | RelayNotice | RelayHandshake> = [];
  online(binding.host);
  router.attach(fakePeer('device', binding));
  router.handleFrame(binding.connection, controlFrame(binding, 0));
  assert.equal(router.outbox.size(binding.route).frames, 1);
  router.detach(binding.connection);
  const hostConnection = generateCanonicalId();
  router.attach({
    ...fakePeer('host', { ...binding, connection: hostConnection }, replayed),
  });
  assert.equal(replayed.length, 0);
  const jwk = { kty: 'EC' as const, crv: 'P-256' as const, x: 'a', y: 'b' };
  router.handleHandshake(hostConnection, {
    protocol: RELAY_PROTOCOL,
    type: 'crypto.accept',
    host_id: binding.host,
    device_id: binding.device,
    crypto_connection_id: generateCanonicalId(),
    handshake_nonce: generateCanonicalId(),
    host_generation: generateCanonicalId(),
    host_identity: jwk,
    host_ephemeral: jwk,
    device_ephemeral: jwk,
    signature: 'd',
    sent_at: 2,
  });
  assert.equal(router.outbox.size(binding.route).frames, 0);
});

test('a second device attach replaces the previous peer', () => {
  const { router, online } = createRouter({ maxConnectionsPerDevice: 1 });
  const binding = ids();
  const closed: string[] = [];
  online(binding.host);
  router.attach({
    ...fakePeer('device', binding),
    close(reason) { closed.push(reason); },
  });
  const second = generateCanonicalId();
  router.attach({
    ...fakePeer('device', { ...binding, connection: second }),
  });
  assert.deepEqual(closed, ['replaced']);
  router.handleFrame(second, controlFrame({ ...binding, connection: second }, 0));
  assert.equal(router.outbox.size(binding.route).frames, 1);
});

test('late frames from a replaced authenticated socket are ignored', () => {
  const { router, online } = createRouter();
  const binding = ids();
  online(binding.host);
  router.attach(fakePeer('device', binding));
  const replacement = generateCanonicalId();
  router.attach(fakePeer('device', { ...binding, connection: replacement }));

  assert.doesNotThrow(() => router.handleFrame(binding.connection, controlFrame(binding, 0)));
  assert.equal(router.outbox.size(binding.route).frames, 0);
});

test('server restart drops the in-memory control outbox', () => {
  const { router, online } = createRouter();
  const binding = ids();
  online(binding.host);
  router.attach(fakePeer('device', binding));
  router.handleFrame(binding.connection, controlFrame(binding, 0));
  assert.equal(router.outbox.size(binding.route).frames, 1);
  router.restart();
  assert.equal(router.outbox.size(binding.route).frames, 0);
});

test('connection and ciphertext byte rates fail closed', () => {
  const { router, online } = createRouter({
    maxConnectionsPerDevice: 1,
    maxCiphertextBytesPerSecond: 8,
    maxControlFramesPerSecond: 50,
  });
  const binding = ids();
  online(binding.host);
  router.attach(fakePeer('device', binding));
  const replacement = generateCanonicalId();
  router.attach({
    ...fakePeer('device', { ...binding, connection: replacement }),
  });
  assert.throws(
    () => router.handleFrame(replacement, controlFrame({ ...binding, connection: replacement }, 0, {
      ciphertext: 'ABCDEFGHIJK',
    })),
    /ciphertext byte rate exceeded/,
  );
});

test('a new handshake drops stale host ciphertext and accepts a fresh sequence', () => {
  const { router, online } = createRouter();
  const binding = ids();
  const hostConnection = generateCanonicalId();
  const forwarded: Array<RelayFrame | RelayNotice | RelayHandshake> = [];
  online(binding.host);
  router.attach(fakePeer('device', binding, forwarded));
  router.attach({
    ...fakePeer('host', { ...binding, connection: hostConnection }),
    connectionId: hostConnection,
  });
  router.handleFrame(hostConnection, controlFrame({ ...binding, connection: hostConnection }, 0));
  router.handleFrame(hostConnection, controlFrame({ ...binding, connection: hostConnection }, 1));
  assert.equal(router.outbox.size(binding.route).frames, 2);
  const replacement = generateCanonicalId();
  const nextForwarded: Array<RelayFrame | RelayNotice | RelayHandshake> = [];
  router.attach({
    ...fakePeer('device', { ...binding, connection: replacement }, nextForwarded),
  });
  const before = router.outbox.size(binding.route).frames;
  router.handleFrame(hostConnection, controlFrame({ ...binding, connection: hostConnection }, 2));
  assert.equal(router.outbox.size(binding.route).frames, before);
  assert.equal(nextForwarded.length, 0);
  const jwk = { kty: 'EC' as const, crv: 'P-256' as const, x: 'a', y: 'b' };
  router.handleHandshake(hostConnection, {
    protocol: RELAY_PROTOCOL,
    type: 'crypto.accept',
    host_id: binding.host,
    device_id: binding.device,
    crypto_connection_id: generateCanonicalId(),
    handshake_nonce: generateCanonicalId(),
    host_generation: generateCanonicalId(),
    host_identity: jwk,
    host_ephemeral: jwk,
    device_ephemeral: jwk,
    signature: 'd',
    sent_at: 2,
  });
  assert.equal(router.outbox.size(binding.route).frames, 0);
  router.handleFrame(hostConnection, controlFrame({ ...binding, connection: hostConnection }, 0));
  assert.equal(router.outbox.size(binding.route).frames, 1);
  assert.equal(nextForwarded.filter((entry) => 'ciphertext' in entry).length, 1);
});

test('crypto handshake is forwarded without ciphertext sequence or outbox', () => {
  const { router, online } = createRouter();
  const hostId = generateCanonicalId();
  const deviceId = generateCanonicalId();
  const hostSent: Array<RelayFrame | RelayNotice | RelayHandshake> = [];
  const deviceSent: Array<RelayFrame | RelayNotice | RelayHandshake> = [];
  const hostConnection = generateCanonicalId();
  const deviceConnection = generateCanonicalId();
  const jwk = { kty: 'EC' as const, crv: 'P-256' as const, x: 'a', y: 'b' };
  const offer: RelayHandshake = {
    protocol: RELAY_PROTOCOL,
    type: 'crypto.offer',
    host_id: hostId,
    device_id: deviceId,
    crypto_connection_id: generateCanonicalId(),
    handshake_nonce: generateCanonicalId(),
    device_identity: jwk,
    device_ephemeral: jwk,
    signature: 'c',
    sent_at: 1,
  };
  router.attach({
    role: 'device',
    hostId,
    deviceId,
    routeId: deviceId,
    connectionId: deviceConnection,
    send(frame: RelayFrame | RelayNotice | RelayHandshake) { deviceSent.push(frame); },
    close() {},
  });
  assert.throws(
    () => router.handleHandshake(deviceConnection, offer),
    (error: unknown) => error instanceof RemoteProtocolError && error.code === 'HOST_OFFLINE',
  );
  assert.equal(hostSent.length, 0);
  online(hostId);
  router.attach({
    role: 'host',
    hostId,
    routeId: hostId,
    connectionId: hostConnection,
    send(frame: RelayFrame | RelayNotice | RelayHandshake) { hostSent.push(frame); },
    close() {},
  });
  router.handleHandshake(deviceConnection, offer);
  assert.equal(hostSent.length, 1);
  assert.equal((hostSent[0] as { type?: string }).type, 'crypto.offer');
  assert.equal(router.outbox.size(deviceId).frames, 0);
  assert.throws(
    () => router.handleHandshake(deviceConnection, {
      protocol: RELAY_PROTOCOL,
      type: 'crypto.accept',
      host_id: hostId,
      device_id: deviceId,
      crypto_connection_id: offer.crypto_connection_id,
      handshake_nonce: offer.handshake_nonce,
      host_generation: generateCanonicalId(),
      host_identity: jwk,
      host_ephemeral: jwk,
      device_ephemeral: jwk,
      signature: 'd',
      sent_at: 2,
    }),
    /device may only offer/,
  );
  const accept: RelayHandshake = {
    protocol: RELAY_PROTOCOL,
    type: 'crypto.accept',
    host_id: hostId,
    device_id: deviceId,
    crypto_connection_id: offer.crypto_connection_id,
    handshake_nonce: offer.handshake_nonce,
    host_generation: generateCanonicalId(),
    host_identity: jwk,
    host_ephemeral: jwk,
    device_ephemeral: jwk,
    signature: 'd',
    sent_at: 2,
  };
  router.handleHandshake(hostConnection, accept);
  assert.equal(deviceSent.length, 1);
  assert.equal((deviceSent[0] as { type?: string }).type, 'crypto.accept');
});

test('notifyDevices reaches every authenticated device connection of its host', () => {
  const { router, online } = createRouter();
  const hostId = generateCanonicalId();
  online(hostId);
  const hostSent: Array<RelayFrame | RelayNotice | RelayHandshake> = [];
  const otherHostSent: Array<RelayFrame | RelayNotice | RelayHandshake> = [];
  const deviceSent: Array<RelayFrame | RelayNotice | RelayHandshake> = [];
  const otherDeviceSent: Array<RelayFrame | RelayNotice | RelayHandshake> = [];
  const binding = (role: 'host' | 'device', host: string) => ({
    host,
    device: role === 'device' ? generateCanonicalId() : generateCanonicalId(),
    route: generateCanonicalId(),
    connection: generateCanonicalId(),
  });
  router.attach(fakePeer('host', binding('host', hostId), hostSent));
  router.attach(fakePeer('device', binding('device', hostId), deviceSent));
  const otherHostId = generateCanonicalId();
  online(otherHostId);
  router.attach(fakePeer('host', binding('host', otherHostId), otherHostSent));
  router.attach(fakePeer('device', binding('device', otherHostId), otherDeviceSent));
  const notice = parseClosed(relayNoticeSchema, {
    protocol: RELAY_PROTOCOL,
    type: 'host.offline',
    host_id: hostId,
    sent_at: 1,
  });
  router.notifyDevices(hostId, notice);
  assert.deepEqual(deviceSent, [notice]);
  assert.deepEqual(hostSent, []);
  assert.deepEqual(otherDeviceSent, []);
  assert.deepEqual(otherHostSent, []);
});

function openRelaySocket(
  wsUrl: string,
  ticket: string,
  onMessage: (parsed: { type?: string }) => void,
): { close(): void; bound: Promise<void> } {
  const ws = new WebSocket(wsUrl);
  let boundResolve: (() => void) | null = null;
  const bound = new Promise<void>((resolve, reject) => {
    boundResolve = resolve;
    const timer = setTimeout(() => reject(new Error('relay ws bind timeout')), 5_000);
    ws.addEventListener('error', (event) => {
      clearTimeout(timer);
      reject(new Error(String(event)));
    });
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ protocol: RELAY_PROTOCOL, type: 'ws.auth', ticket }));
    });
    ws.addEventListener('message', (event) => {
      const parsed = JSON.parse(String(event.data)) as { type?: string };
      if (parsed.type === 'ws.bound') {
        clearTimeout(timer);
        boundResolve?.();
        boundResolve = null;
        return;
      }
      onMessage(parsed);
    });
  });
  return { close: () => ws.close(), bound };
}

test('shutdown is idempotent and late Host socket close never touches the closed database', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-remote-shutdown-'));
  const handle = await createRemoteApp(createConfig({ dataDir, publicOrigin: 'https://remote.test', adminToken: 'test-only' }));
  const listened = await listenRemoteApp(handle, 0);
  const hostId = generateCanonicalId();
  handle.services.db.prepare('INSERT INTO hosts(id, name, public_key_jwk, created_at) VALUES (?, ?, ?, ?)').run(hostId, 'test', '{}', Date.now());
  handle.services.repos.createWsTicket({ role: 'host', hostId, ticket: 'shutdown-ticket' });
  const host = openRelaySocket(listened.wsUrl, 'shutdown-ticket', () => undefined);
  try {
    await host.bound;
    let lateExpire = 0;
    handle.services.presence.expire = () => { lateExpire += 1; };
    handle.shutdown();
    assert.doesNotThrow(() => handle.shutdown());
    host.close();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(lateExpire, 0);
  } finally { host.close(); listened.close(); }
});

test('Host WS lifecycle broadcasts host.online and host.offline to devices', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-remote-presence-'));
  const now = () => Date.UTC(2026, 8, 1);
  const db = openRemoteDatabase(dataDir);
  const config = createConfig({
    dataDir,
    publicOrigin: 'https://remote.test',
    adminToken: 'admin-test-token',
    now,
  });
  const handle = await createRemoteApp(config);
  const listened = await listenRemoteApp(handle, 0);
  try {
    const hostId = generateCanonicalId();
    const deviceId = generateCanonicalId();
    db.prepare(`
      INSERT INTO hosts(id, name, public_key_jwk, created_at) VALUES (?, ?, ?, ?)
    `).run(hostId, 'test-host', '{}', now());
    db.prepare('INSERT INTO browser_installations(id, created_at) VALUES (?, ?)').run('browser-1', now());
    handle.services.repos.insertPairing({
      id: deviceId,
      browser_installation_id: 'browser-1',
      host_id: hostId,
      public_key_jwk: '{}',
      platform: 'web',
      user_agent: 'node-test',
      created_at: now(),
      crypto_connection_id: null,
    });
    handle.services.presence.heartbeat(hostId);
    const deviceTicket = 'device-ticket';
    handle.services.repos.createWsTicket({ role: 'device', hostId, deviceId, ticket: deviceTicket });
    const deviceNotices: string[] = [];
    const device = openRelaySocket(listened.wsUrl, deviceTicket, (parsed) => {
      deviceNotices.push(String(parsed.type));
    });
    await device.bound;

    const hostTicket = 'host-ticket';
    handle.services.repos.createWsTicket({ role: 'host', hostId, ticket: hostTicket });
    const host = openRelaySocket(listened.wsUrl, hostTicket, () => undefined);
    await host.bound;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(deviceNotices, ['host.online']);
    assert.equal(handle.services.presence.isOnline(hostId), true);

    // A replacement Host socket keeps the host online when the old one closes.
    const hostTicket2 = 'host-ticket-2';
    handle.services.repos.createWsTicket({ role: 'host', hostId, ticket: hostTicket2 });
    const replacement = openRelaySocket(listened.wsUrl, hostTicket2, () => undefined);
    await replacement.bound;
    host.close();
    await new Promise(resolve => setTimeout(resolve, 30));
    // The replacement bind announced itself online; closing the replaced
    // socket must not add an offline notice while it holds the lease.
    assert.deepEqual(deviceNotices, ['host.online', 'host.online']);
    assert.equal(handle.services.presence.isOnline(hostId), true);

    replacement.close();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(deviceNotices, ['host.online', 'host.online', 'host.offline']);
    assert.equal(handle.services.presence.isOnline(hostId), false);
    device.close();
  } finally {
    listened.close();
  }
});

test('host frames for a stale route answer route.not_bound instead of dropping silently', () => {
  const { router, online } = createRouter();
  const hostId = generateCanonicalId();
  const deviceId = generateCanonicalId();
  online(hostId);
  const hostSent: Array<RelayFrame | RelayNotice | RelayHandshake> = [];
  const deviceSent: Array<RelayFrame | RelayNotice | RelayHandshake> = [];
  const hostBinding = { host: hostId, device: generateCanonicalId(), route: generateCanonicalId(), connection: generateCanonicalId() };
  const hostPeer = fakePeer('host', hostBinding, hostSent);
  const deviceBinding = { host: hostId, device: deviceId, route: generateCanonicalId(), connection: generateCanonicalId() };
  const devicePeer = fakePeer('device', deviceBinding, deviceSent);
  router.attach(hostPeer);
  router.attach(devicePeer);
  // Detach holds the device crypto; the reattached socket is not bound
  // until its next crypto.accept completes.
  router.detach(devicePeer.connectionId);
  router.attach(devicePeer);
  router.handleFrame(hostPeer.connectionId, controlFrame({
    host: hostId,
    device: deviceId,
    route: deviceBinding.route,
    connection: hostBinding.connection,
  }, 0));
  assert.deepEqual(deviceSent, []);
  const notices = (hostSent as RelayNotice[]).filter(entry => entry.type === 'route.not_bound');
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.device_id, deviceId);
  assert.equal(notices[0]?.route_id, deviceBinding.route);
});
