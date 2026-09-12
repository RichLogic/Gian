import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  RemoteProtocolError,
  generateCanonicalId,
  generateP256KeyPair,
  handshakeTranscriptHash,
} from '@gian/remote-protocol';
import { PeerCryptoSession } from '../src/remote/crypto-session.js';

async function pairedSessions() {
  const host = await generateP256KeyPair();
  const device = await generateP256KeyPair();
  const connectionId = generateCanonicalId();
  const routeId = generateCanonicalId();
  const binding = {
    hostGeneration: generateCanonicalId(),
    hostId: generateCanonicalId(),
    deviceId: generateCanonicalId(),
    routeId,
    connectionId,
  };
  const transcript = {
    host_identity: { kty: 'EC' as const, crv: 'P-256' as const, x: 'a', y: 'b' },
    device_identity: { kty: 'EC' as const, crv: 'P-256' as const, x: 'c', y: 'd' },
    host_ephemeral: { kty: 'EC' as const, crv: 'P-256' as const, x: 'e', y: 'f' },
    device_ephemeral: { kty: 'EC' as const, crv: 'P-256' as const, x: 'g', y: 'h' },
    connection_id: connectionId,
  };
  await handshakeTranscriptHash(transcript);
  const hostSession = await PeerCryptoSession.fromHandshake({
    localPrivate: host.privateKey,
    remotePublic: device.publicKey,
    transcript,
    sendDirection: 'host_to_device',
    binding,
  });
  const deviceSession = await PeerCryptoSession.fromHandshake({
    localPrivate: device.privateKey,
    remotePublic: host.publicKey,
    transcript,
    sendDirection: 'device_to_host',
    binding,
  });
  return { hostSession, deviceSession, binding };
}

test('pairwise AAD ignores a different socket connection_id', async () => {
  const { hostSession, deviceSession, binding } = await pairedSessions();
  const sealed = await hostSession.seal(new TextEncoder().encode('{"type":"hello"}'));
  const opened = await deviceSession.open({
    ciphertext: sealed.ciphertext,
    sequence: sealed.sequence,
    direction: 'host_to_device',
    routeId: binding.routeId,
    connectionId: generateCanonicalId(),
  });
  assert.equal(new TextDecoder().decode(opened), '{"type":"hello"}');
});

test('Host and device peers decrypt each other using protocol helpers', async () => {
  const { hostSession, deviceSession } = await pairedSessions();
  const sealed = await hostSession.seal(new TextEncoder().encode('{"type":"hello"}'));
  const opened = await deviceSession.open({
    ciphertext: sealed.ciphertext,
    sequence: sealed.sequence,
    direction: 'host_to_device',
    routeId: hostSession.routeId,
    connectionId: hostSession.connectionId,
  });
  assert.equal(new TextDecoder().decode(opened), '{"type":"hello"}');
});

test('concurrent seal assigns unique consecutive sequences that decrypt in order', async () => {
  const { hostSession, deviceSession, binding } = await pairedSessions();
  const sealed = await Promise.all(
    Array.from({ length: 8 }, (_, index) => hostSession.seal(new TextEncoder().encode(`m${index}`))),
  );
  assert.deepEqual(sealed.map((item) => item.sequence), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(new Set(sealed.map((item) => item.sequence)).size, 8);
  for (const [index, item] of sealed.entries()) {
    const opened = await deviceSession.open({
      ciphertext: item.ciphertext,
      sequence: item.sequence,
      direction: 'host_to_device',
      routeId: binding.routeId,
      connectionId: binding.connectionId,
    });
    assert.equal(new TextDecoder().decode(opened), `m${index}`);
  }
});

test('replay, rollback, wrong direction, and cross-route frames close the connection', async () => {
  const { hostSession, deviceSession, binding } = await pairedSessions();
  const first = await hostSession.seal(new TextEncoder().encode('one'));
  await deviceSession.open({
    ciphertext: first.ciphertext,
    sequence: first.sequence,
    direction: 'host_to_device',
    routeId: binding.routeId,
    connectionId: binding.connectionId,
  });

  await assert.rejects(
    () => deviceSession.open({
      ciphertext: first.ciphertext,
      sequence: first.sequence,
      direction: 'host_to_device',
      routeId: binding.routeId,
      connectionId: binding.connectionId,
    }),
    (error: unknown) => error instanceof RemoteProtocolError && error.code === 'INVALID_FRAME',
  );
  assert.equal(deviceSession.isClosed, true);

  const fresh = await pairedSessions();
  const sealed = await fresh.hostSession.seal(new TextEncoder().encode('two'));
  await assert.rejects(() => fresh.deviceSession.open({
    ciphertext: sealed.ciphertext,
    sequence: sealed.sequence,
    direction: 'device_to_host',
    routeId: fresh.binding.routeId,
    connectionId: fresh.binding.connectionId,
  }));
  assert.equal(fresh.deviceSession.isClosed, true);

  const cross = await pairedSessions();
  const other = await cross.hostSession.seal(new TextEncoder().encode('cross'));
  await assert.rejects(() => cross.deviceSession.open({
    ciphertext: other.ciphertext,
    sequence: other.sequence,
    direction: 'host_to_device',
    routeId: generateCanonicalId(),
    connectionId: cross.binding.connectionId,
  }));
  assert.equal(cross.deviceSession.isClosed, true);
});
