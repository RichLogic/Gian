import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { generateCanonicalId, generateP256KeyPair } from '@gian/remote-protocol';
import { PeerCryptoSession } from '../src/remote/crypto-session.js';
import { DeviceCryptoSession } from '../../remote-web/src/transport/crypto-session.js';

test('Host PeerCryptoSession and DeviceCryptoSession decrypt each other', async () => {
  const hostKeys = await generateP256KeyPair();
  const deviceKeys = await generateP256KeyPair();
  const binding = {
    hostGeneration: generateCanonicalId(),
    hostId: generateCanonicalId(),
    deviceId: generateCanonicalId(),
    routeId: generateCanonicalId(),
    connectionId: generateCanonicalId(),
  };
  const transcript = {
    host_identity: { kty: 'EC' as const, crv: 'P-256' as const, x: 'a', y: 'b' },
    device_identity: { kty: 'EC' as const, crv: 'P-256' as const, x: 'c', y: 'd' },
    host_ephemeral: { kty: 'EC' as const, crv: 'P-256' as const, x: 'e', y: 'f' },
    device_ephemeral: { kty: 'EC' as const, crv: 'P-256' as const, x: 'g', y: 'h' },
    connection_id: binding.connectionId,
  };
  const host = await PeerCryptoSession.fromHandshake({
    localPrivate: hostKeys.privateKey,
    remotePublic: deviceKeys.publicKey,
    transcript,
    sendDirection: 'host_to_device',
    binding,
  });
  const device = await DeviceCryptoSession.fromHandshake({
    localPrivate: deviceKeys.privateKey,
    remotePublic: hostKeys.publicKey,
    transcript,
    sendDirection: 'device_to_host',
    binding,
  });
  const outbound = await Promise.all([
    device.seal(new TextEncoder().encode('cmd-0')),
    device.seal(new TextEncoder().encode('cmd-1')),
  ]);
  assert.deepEqual(outbound.map((item) => item.sequence), [0, 1]);
  const first = await host.open({
    ciphertext: outbound[0]!.ciphertext,
    sequence: outbound[0]!.sequence,
    direction: 'device_to_host',
    routeId: binding.routeId,
    connectionId: binding.connectionId,
  });
  const second = await host.open({
    ciphertext: outbound[1]!.ciphertext,
    sequence: outbound[1]!.sequence,
    direction: 'device_to_host',
    routeId: binding.routeId,
    connectionId: binding.connectionId,
  });
  assert.equal(new TextDecoder().decode(first), 'cmd-0');
  assert.equal(new TextDecoder().decode(second), 'cmd-1');
  const reply = await host.seal(new TextEncoder().encode('result'));
  const opened = await device.open({
    ciphertext: reply.ciphertext,
    sequence: reply.sequence,
    direction: 'host_to_device',
    routeId: binding.routeId,
    connectionId: binding.connectionId,
  });
  assert.equal(new TextDecoder().decode(opened), 'result');
});
