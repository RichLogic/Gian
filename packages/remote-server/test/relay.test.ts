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
  type RelayFrame,
  type RelayHandshake,
  type RelayNotice,
} from '@gian/remote-protocol';

import { createConfig } from '../src/config.js';
import { PresenceService } from '../src/presence/leases.js';
import { ControlOutbox } from '../src/relay/outbox.js';
import { RelayRouter, type RelayPeer } from '../src/relay/router.js';
import { openRemoteDatabase } from '../src/storage/db.js';
import { RemoteRepositories } from '../src/storage/repositories.js';

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
