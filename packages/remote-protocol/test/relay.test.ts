import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertRelayRoute,
  cryptoAcceptPayload,
  cryptoOfferPayload,
  generateCanonicalId,
  isContentFrame,
  isControlFrame,
  MAX_RELAY_FRAME_BYTES,
  parseRelayFrame,
  parseRelayHandshake,
  RemoteProtocolError,
  TransportSequenceGuard,
} from '../src/index.js';
import { sampleRelayFrame } from './helpers.js';

test('relay frames fail closed on unknown fields and non-canonical ids', () => {
  const frame = sampleRelayFrame();
  assert.deepEqual(parseRelayFrame(frame), frame);
  assert.throws(() => parseRelayFrame({ ...frame, extra: true }));
  assert.throws(() => parseRelayFrame({ ...frame, protocol: 'gian.relay/2' }));
  assert.throws(() => parseRelayFrame({ ...frame, frame_class: 'business' }));
  assert.throws(() => parseRelayFrame({ ...frame, host_id: 'Host-1' }));
  assert.throws(() => parseRelayFrame({ ...frame, ciphertext: '+++/not-url' }));
});

test('control and content sequence domains stay distinct', () => {
  const control = parseRelayFrame(sampleRelayFrame({ frame_class: 'control', transport_sequence: 0 }));
  const content = parseRelayFrame(sampleRelayFrame({
    frame_class: 'content',
    route_id: control.route_id,
    host_id: control.host_id,
    device_id: control.device_id,
    connection_id: control.connection_id,
    transport_sequence: 0,
  }));
  assert.equal(isControlFrame(control), true);
  assert.equal(isContentFrame(content), true);
  assert.notEqual(control.frame_class, content.frame_class);
});

test('transport replay, rollback, and gaps fail closed', () => {
  const guard = new TransportSequenceGuard();
  guard.accept(0);
  guard.accept(1);
  assert.throws(() => guard.accept(1), (error: unknown) => (
    error instanceof RemoteProtocolError && error.code === 'INVALID_FRAME'
  ));
  assert.throws(() => guard.accept(0));
  assert.throws(() => guard.accept(4));
});

test('cross-route frames fail closed', () => {
  const frame = parseRelayFrame(sampleRelayFrame());
  assert.throws(() => assertRelayRoute(frame, {
    host_id: frame.host_id,
    device_id: frame.device_id,
    route_id: frame.frame_id,
    connection_id: frame.connection_id,
    direction: 'device_to_host',
  }));
});

test('relay frame size has an exact 512 KiB boundary', () => {
  const frame = sampleRelayFrame({
    ciphertext: 'a'.repeat(100),
  });
  const encoded = JSON.stringify(frame);
  assert.ok(encoded.length < MAX_RELAY_FRAME_BYTES);
  assert.throws(() => parseRelayFrame({
    ...frame,
    ciphertext: 'a'.repeat(MAX_RELAY_FRAME_BYTES),
  }));
});

test('crypto handshake payloads bind pairwise ids and reject unknown fields', () => {
  const hostId = generateCanonicalId();
  const deviceId = generateCanonicalId();
  const connectionId = generateCanonicalId();
  const jwk = {
    kty: 'EC' as const,
    crv: 'P-256' as const,
    x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  };
  const handshakeNonce = generateCanonicalId();
  const offerPayload = cryptoOfferPayload({
    host_id: hostId,
    device_id: deviceId,
    crypto_connection_id: connectionId,
    handshake_nonce: handshakeNonce,
    sent_at: 1,
    device_identity: jwk,
    device_ephemeral: jwk,
  });
  assert.match(offerPayload, /gian.remote.crypto_offer\/1/);
  assert.match(offerPayload, new RegExp(connectionId));
  assert.match(offerPayload, new RegExp(handshakeNonce));
  assert.match(offerPayload, /"sent_at":1/);
  const offer = parseRelayHandshake({
    protocol: 'gian.relay/1',
    type: 'crypto.offer',
    host_id: hostId,
    device_id: deviceId,
    crypto_connection_id: connectionId,
    handshake_nonce: handshakeNonce,
    device_identity: jwk,
    device_ephemeral: jwk,
    signature: 'signed',
    sent_at: 1,
  });
  assert.equal(offer.type, 'crypto.offer');
  assert.throws(() => parseRelayHandshake({ ...offer, extra: true }));
  assert.throws(() => parseRelayHandshake({
    protocol: 'gian.relay/1',
    type: 'crypto.offer',
    host_id: hostId,
    device_id: deviceId,
    crypto_connection_id: connectionId,
    device_identity: jwk,
    device_ephemeral: jwk,
    signature: 'signed',
    sent_at: 1,
  }));
  const acceptPayload = cryptoAcceptPayload({
    host_id: hostId,
    device_id: deviceId,
    crypto_connection_id: connectionId,
    handshake_nonce: handshakeNonce,
    sent_at: 2,
    host_generation: generateCanonicalId(),
    host_identity: jwk,
    device_identity: jwk,
    host_ephemeral: jwk,
    device_ephemeral: jwk,
  });
  assert.match(acceptPayload, /gian.remote.crypto_accept\/1/);
  assert.match(acceptPayload, new RegExp(handshakeNonce));
  assert.match(acceptPayload, /"sent_at":2/);
});
