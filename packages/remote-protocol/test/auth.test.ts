import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatPairingCode,
  generateCanonicalId,
  hostConnectorChallengeResultSchema,
  hostEnrollmentClaimRequestSchema,
  normalizePairingCode,
  pairingClaimRequestSchema,
  parseClosed,
  selfRevokePayload,
  serverChallengePayload,
} from '../src/index.js';

test('auth DTOs reject unknown fields and protocols', () => {
  const valid = {
    protocol: 'gian.remote.auth/1',
    enrollment_token: 'token-value',
    host_name: 'Office',
    host_version: '0.5.3',
    host_public_key: {
      kty: 'EC',
      crv: 'P-256',
      x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    },
  };
  assert.equal(hostEnrollmentClaimRequestSchema.safeParse(valid).success, true);
  assert.equal(hostEnrollmentClaimRequestSchema.safeParse({
    ...valid,
    extra: true,
  }).success, false);
  assert.equal(hostEnrollmentClaimRequestSchema.safeParse({
    ...valid,
    protocol: 'gian.remote.auth/2',
  }).success, false);
});

test('pairing claim requires exactly one of code or grant_nonce', () => {
  const base = {
    protocol: 'gian.remote.auth/1',
    browser_installation_id: generateCanonicalId(),
    device_public_key: {
      kty: 'EC',
      crv: 'P-256',
      x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    },
    platform: 'macOS',
    user_agent: 'Test',
  };
  assert.equal(pairingClaimRequestSchema.safeParse({ ...base, code: 'K7DM-F2Q9' }).success, true);
  assert.equal(pairingClaimRequestSchema.safeParse({ ...base, grant_nonce: 'nonce' }).success, true);
  assert.equal(pairingClaimRequestSchema.safeParse(base).success, false);
  assert.equal(pairingClaimRequestSchema.safeParse({
    ...base,
    code: 'K7DM-F2Q9',
    grant_nonce: 'nonce',
  }).success, false);
});

test('pairing codes normalize Crockford Base32 and reject U', () => {
  assert.equal(normalizePairingCode('k7dm-f2q9'), 'K7DMF2Q9');
  assert.equal(normalizePairingCode('k7dM F2Q9'), 'K7DMF2Q9');
  assert.throws(() => normalizePairingCode('ILO-0123'));
  assert.throws(() => normalizePairingCode('ILOU-0123'));
  assert.throws(() => normalizePairingCode('ABCD'));
  assert.equal(formatPairingCode('k7dmf2q9'), 'K7DM-F2Q9');
  parseClosed(pairingClaimRequestSchema, {
    protocol: 'gian.remote.auth/1',
    browser_installation_id: generateCanonicalId(),
    device_public_key: {
      kty: 'EC',
      crv: 'P-256',
      x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    },
    platform: 'iOS',
    user_agent: 'Safari',
    code: 'K7DM-F2Q9',
  }, 'AUTH_REQUIRED');
});

test('connector challenge requires a Server identity signature over the canonical payload', () => {
  const challengeId = generateCanonicalId();
  const hostId = generateCanonicalId();
  const payload = serverChallengePayload({
    host_id: hostId,
    challenge_id: challengeId,
    challenge: 'nonce',
    expires_at: 1_778_000_000_000,
    fingerprint: 'a'.repeat(64),
  });
  assert.match(payload, /gian.remote.server_challenge\/1/);
  assert.match(payload, /fingerprint/);
  const valid = {
    protocol: 'gian.remote.auth/1',
    challenge_id: challengeId,
    challenge: 'nonce',
    expires_at: 1_778_000_000_000,
    server_identity_fingerprint: 'a'.repeat(64),
    server_identity: {
      algorithm: 'P-256',
      public_key: {
        kty: 'EC',
        crv: 'P-256',
        x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
      fingerprint: 'a'.repeat(64),
    },
    server_identity_signature: 'signed',
  };
  assert.equal(hostConnectorChallengeResultSchema.safeParse(valid).success, true);
  const { server_identity_signature: _signature, ...unsigned } = valid;
  assert.equal(hostConnectorChallengeResultSchema.safeParse(unsigned).success, false);
});

test('self-revoke payload binds host, device, and signed_at', () => {
  const hostId = generateCanonicalId();
  const deviceId = generateCanonicalId();
  const payload = selfRevokePayload({ hostId, deviceId, signedAt: 1_778_000_000_000 });
  assert.match(payload, /self_revoke/);
  assert.match(payload, new RegExp(hostId));
  assert.match(payload, new RegExp(deviceId));
  assert.match(payload, /1778000000000/);
});
