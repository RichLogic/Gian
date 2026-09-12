import assert from 'node:assert/strict';
import { webcrypto as nodeCrypto } from 'node:crypto';
import { test } from 'node:test';

import {
  base64UrlToBytes,
  buildRelayAad,
  decryptRemotePayload,
  deriveDirectionKeys,
  deriveNonce,
  encryptRemotePayload,
  generateCanonicalId,
  generateP256KeyPair,
  handshakeTranscriptHash,
  RemoteProtocolError,
} from '../src/index.js';

const webcrypto = globalThis.crypto ?? nodeCrypto;

test('Node WebCrypto and globalThis.crypto share the same subtle API', () => {
  assert.equal(typeof webcrypto.subtle.generateKey, 'function');
  assert.equal(typeof globalThis.crypto.subtle.encrypt, 'function');
});

test('direction keys decrypt only with matching AAD, nonce, and direction', async () => {
  const host = await generateP256KeyPair();
  const device = await generateP256KeyPair();
  const connectionId = generateCanonicalId();
  const transcript = await handshakeTranscriptHash({
    host_identity: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
    device_identity: { kty: 'EC', crv: 'P-256', x: 'c', y: 'd' },
    host_ephemeral: { kty: 'EC', crv: 'P-256', x: 'e', y: 'f' },
    device_ephemeral: { kty: 'EC', crv: 'P-256', x: 'g', y: 'h' },
    connection_id: connectionId,
  });
  const hostKeys = await deriveDirectionKeys(host.privateKey, device.publicKey, transcript);
  const deviceKeys = await deriveDirectionKeys(device.privateKey, host.publicKey, transcript);
  const aad = {
    host_generation: generateCanonicalId(),
    host_id: generateCanonicalId(),
    device_id: generateCanonicalId(),
    route_id: generateCanonicalId(),
    connection_id: connectionId,
    direction: 'host_to_device' as const,
    transport_sequence: 0,
  };
  const encrypted = await encryptRemotePayload(
    hostKeys.host_to_device,
    aad,
    new TextEncoder().encode('{"type":"hello"}'),
  );
  const plain = await decryptRemotePayload(
    deviceKeys.host_to_device,
    aad,
    base64UrlToBytes(encrypted.ciphertext),
  );
  assert.equal(new TextDecoder().decode(plain), '{"type":"hello"}');

  await assert.rejects(
    () => decryptRemotePayload(
      deviceKeys.device_to_host,
      aad,
      base64UrlToBytes(encrypted.ciphertext),
    ),
    (error: unknown) => error instanceof RemoteProtocolError && error.code === 'INVALID_FRAME',
  );
  await assert.rejects(() => decryptRemotePayload(
    deviceKeys.host_to_device,
    { ...aad, direction: 'device_to_host' },
    base64UrlToBytes(encrypted.ciphertext),
  ));
  await assert.rejects(() => decryptRemotePayload(
    deviceKeys.host_to_device,
    { ...aad, route_id: generateCanonicalId() },
    base64UrlToBytes(encrypted.ciphertext),
  ));
  await assert.rejects(() => decryptRemotePayload(
    deviceKeys.host_to_device,
    { ...aad, transport_sequence: 1 },
    base64UrlToBytes(encrypted.ciphertext),
  ));
});

test('nonce derivation is deterministic and unique per sequence', async () => {
  const connectionId = generateCanonicalId();
  const first = await deriveNonce(connectionId, 'host_to_device', 0);
  const again = await deriveNonce(connectionId, 'host_to_device', 0);
  const next = await deriveNonce(connectionId, 'host_to_device', 1);
  const otherDir = await deriveNonce(connectionId, 'device_to_host', 0);
  assert.deepEqual(first, again);
  assert.notDeepEqual(first, next);
  assert.notDeepEqual(first, otherDir);
  assert.equal(first.byteLength, 12);
});

test('AAD includes generation, route identifiers, and protocol versions', () => {
  const aad = buildRelayAad({
    host_generation: '11111111-1111-4111-8111-111111111111',
    host_id: '22222222-2222-4222-8222-222222222222',
    device_id: '33333333-3333-4333-8333-333333333333',
    route_id: '44444444-4444-4444-8444-444444444444',
    connection_id: '55555555-5555-4555-8555-555555555555',
    direction: 'device_to_host',
    transport_sequence: 9,
  });
  const text = new TextDecoder().decode(aad);
  assert.match(text, /gian.relay\/1/);
  assert.match(text, /gian.remote\/1/);
  assert.match(text, /device_to_host/);
  assert.match(text, /"transport_sequence":9/);
});
