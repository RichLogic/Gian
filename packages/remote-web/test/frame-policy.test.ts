/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { RELAY_PROTOCOL, base64UrlToBytes, bytesToBase64Url, generateCanonicalId, generateP256KeyPair, type RelayFrame } from '@gian/remote-protocol';
import { DeviceCryptoSession } from '../src/transport/crypto-session.js';
import { openHostFrame } from '../src/transport/relay-client.js';

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
    binding,
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

function frameFrom(binding: typeof pairSessions extends () => Promise<infer P> ? P extends { binding: infer B } ? B : never : never, sealed: { ciphertext: string; sequence: number }): RelayFrame {
  return {
    protocol: RELAY_PROTOCOL,
    frame_id: generateCanonicalId(),
    frame_class: 'control',
    route_id: binding.routeId,
    host_id: binding.hostId,
    device_id: binding.deviceId,
    connection_id: binding.connectionId,
    transport_sequence: sealed.sequence,
    transport_ack: 0,
    sent_at: 1,
    ciphertext: sealed.ciphertext,
  };
}

describe('openHostFrame failure classification', () => {
  it('delivers a valid frame and keeps the connection open', async () => {
    const { binding, host, device } = await pairSessions();
    const received: Array<{ type?: string }> = [];
    const closed: string[] = [];
    const outcome = await openHostFrame(frameFrom(binding, await host.seal(new TextEncoder().encode(JSON.stringify({ type: 'event' })))), {
      crypto: device,
      noteAck: () => undefined,
      onControl: message => { received.push(message); },
      sendError: () => { throw new Error('no error frames expected'); },
      close: reason => closed.push(reason),
    });
    expect(outcome).toBe('handled');
    expect(received).toEqual([{ type: 'event' }]);
    expect(closed).toEqual([]);
  });

  it('answers a malformed inner message with an error frame and keeps the connection', async () => {
    const { binding, host, device } = await pairSessions();
    const closed: string[] = [];
    const errors: Array<{ code?: string }> = [];
    const outcome = await openHostFrame(frameFrom(binding, await host.seal(new TextEncoder().encode('not json at all'))), {
      crypto: device,
      noteAck: () => undefined,
      onControl: () => { throw new Error('must not reach dispatch'); },
      sendError: message => { errors.push(message); },
      close: reason => closed.push(reason),
    });
    expect(outcome).toBe('dropped');
    expect(errors[0]?.code).toBe('INVALID_FRAME');
    expect(closed).toEqual([]);
  });

  it('answers an unknown inner type with an error frame and keeps the connection', async () => {
    const { binding, host, device } = await pairSessions();
    const closed: string[] = [];
    const errors: Array<{ code?: string }> = [];
    const outcome = await openHostFrame(frameFrom(binding, await host.seal(new TextEncoder().encode(JSON.stringify({ type: 'mystery.message' })))), {
      crypto: device,
      noteAck: () => undefined,
      onControl: () => { throw new Error('must not reach dispatch'); },
      sendError: message => { errors.push(message); },
      close: reason => closed.push(reason),
    });
    expect(outcome).toBe('dropped');
    expect(errors[0]?.code).toBe('INVALID_FRAME');
    expect(closed).toEqual([]);
  });

  it('closes the relay when decryption fails the integrity boundary', async () => {
    const { binding, host, device } = await pairSessions();
    const sealed = await host.seal(new TextEncoder().encode(JSON.stringify({ type: 'event' })));
    const corrupted = frameFrom(binding, sealed);
    const raw = base64UrlToBytes(corrupted.ciphertext);
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    corrupted.ciphertext = bytesToBase64Url(raw);
    const closed: string[] = [];
    const outcome = await openHostFrame(corrupted, {
      crypto: device,
      noteAck: () => undefined,
      onControl: () => { throw new Error('must not reach dispatch'); },
      sendError: () => { throw new Error('no error frames expected'); },
      close: reason => closed.push(reason),
    });
    expect(outcome).toBe('closed');
    expect(closed).toHaveLength(1);
  });
});
