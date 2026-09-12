/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { generateCanonicalId, generateP256KeyPair } from '@gian/remote-protocol';
import { DeviceCryptoSession } from '../src/transport/crypto-session.js';

async function pairSessions() {
  const host = await generateP256KeyPair();
  const device = await generateP256KeyPair();
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
  return {
    host: await DeviceCryptoSession.fromHandshake({
      localPrivate: host.privateKey,
      remotePublic: device.publicKey,
      transcript,
      sendDirection: 'host_to_device',
      binding,
    }),
    device: await DeviceCryptoSession.fromHandshake({
      localPrivate: device.privateKey,
      remotePublic: host.publicKey,
      transcript,
      sendDirection: 'device_to_host',
      binding,
    }),
  };
}

describe('DeviceCryptoSession FIFO', () => {
  it('concurrent seal assigns unique contiguous sequences that decrypt in order', async () => {
    const { host, device } = await pairSessions();
    const sealed = await Promise.all(
      Array.from({ length: 8 }, (_, index) => device.seal(new TextEncoder().encode(`m${index}`))),
    );
    expect(sealed.map((item) => item.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const item of sealed) {
      const plain = await host.open({
        ciphertext: item.ciphertext,
        sequence: item.sequence,
        direction: 'device_to_host',
        routeId: host.routeId,
        connectionId: host.connectionId,
      });
      expect(new TextDecoder().decode(plain)).toBe(`m${item.sequence}`);
    }
  });
});
