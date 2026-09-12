import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AUTH_SIGNED_AT_SKEW_MS, generateCanonicalId } from '@gian/remote-protocol';
import { DEFAULT_REMOTE_DEVICE_GRANTS } from '../src/remote/grants.js';
import { seedDevice, setupRemoteHarness, teardownRemoteHarness } from './fixtures/remote-harness.js';

test('Remote devices persist exact V1 grants and reject extras', () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    assert.deepEqual(device.grants, [...DEFAULT_REMOTE_DEVICE_GRANTS]);
    assert.equal(device.role, 'admin');
    assert.equal(device.revokedAt, null);
    assert.throws(
      () => context.runtime.devices.create({
        publicKey: '{"kty":"EC","crv":"P-256","x":"extra","y":"grant"}',
        name: 'Bad',
        platform: 'ios',
        grants: [...DEFAULT_REMOTE_DEVICE_GRANTS, 'task.create'] as never,
      }),
      /cannot receive task.create|must match/,
    );
  } finally {
    teardownRemoteHarness(context);
  }
});

test('revoked device public keys cannot be reused and audit stays redacted and bounded', () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context, 'Watch');
    const publicKey = device.publicKey;
    const revoked = context.runtime.devices.revoke(device.id);
    assert.ok(revoked.revokedAt);
    assert.equal(revoked.revision, 1);
    assert.throws(
      () => context.runtime.devices.create({
        publicKey,
        name: 'Watch again',
        platform: 'ios',
      }),
      /cannot be reused/,
    );
    assert.throws(
      () => context.runtime.devices.createGeneration({
        publicKey,
        name: 'Watch again',
        platform: 'ios',
        cryptoConnectionId: '33333333-3333-4333-8333-333333333333',
      }),
      /cannot be reused/,
    );
    const next = context.runtime.devices.createGeneration({
      publicKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: `${'a'.repeat(43)}=`, y: `${'b'.repeat(43)}=` }),
      name: 'Watch again',
      platform: 'ios',
      cryptoConnectionId: '33333333-3333-4333-8333-333333333333',
    });
    assert.notEqual(next.id, device.id);
    assert.equal(next.revokedAt, null);
    assert.equal(next.cryptoConnectionId, '33333333-3333-4333-8333-333333333333');

    for (let index = 0; index < 12; index += 1) {
      context.runtime.audit.write({
        deviceId: device.id,
        method: 'session.send',
        commandId: `00000000-0000-7000-8000-0000000000${String(index).padStart(2, '0')}`,
        resultCategory: 'succeeded',
      });
    }
    const entries = context.runtime.audit.list(device.id);
    assert.equal(entries.length, 12);
    for (const entry of entries) {
      const serialized = JSON.stringify(entry);
      assert.equal(serialized.includes('prompt'), false);
      assert.equal(serialized.includes('params'), false);
      assert.ok(entry.resultCategory);
      assert.ok(entry.commandId);
    }
  } finally {
    teardownRemoteHarness(context);
  }
});

test('handshake receipts prune rows older than the signed_at freshness window', () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const staleNonce = generateCanonicalId();
    const liveNonce = generateCanonicalId();
    context.db.prepare(
      `INSERT INTO remote_handshake_receipts (handshake_nonce, device_id, signed_at) VALUES (?, ?, ?)`,
    ).run(staleNonce, device.id, context.clock.nowMs - AUTH_SIGNED_AT_SKEW_MS - 1);
    assert.equal(
      context.runtime.pairings.consumeHandshakeNonce({
        handshakeNonce: liveNonce,
        deviceId: device.id,
        signedAt: context.clock.nowMs,
      }),
      true,
    );
    const stale = context.db.prepare(
      `SELECT handshake_nonce FROM remote_handshake_receipts WHERE handshake_nonce = ?`,
    ).get(staleNonce);
    const live = context.db.prepare(
      `SELECT handshake_nonce FROM remote_handshake_receipts WHERE handshake_nonce = ?`,
    ).get(liveNonce);
    assert.equal(stale, undefined);
    assert.ok(live);
  } finally {
    teardownRemoteHarness(context);
  }
});
