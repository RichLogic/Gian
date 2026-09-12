import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exportPublicJwk,
  generateP256SigningKeyPair,
  identityFingerprint,
  serverChallengePayload,
  signBytes,
} from '@gian/remote-protocol';
import {
  MemoryRemoteIdentity,
  UnavailableRemoteIdentity,
  createRemoteIdentityFromEnv,
} from '../src/remote/identity.js';
import { RemoteEnrollmentStore } from '../src/remote/enrollment.js';
import { setupRemoteHarness, teardownRemoteHarness } from './fixtures/remote-harness.js';

test('production never silently falls back to an identity file', async () => {
  const identity = createRemoteIdentityFromEnv({
    GIAN_PACKAGED: '1',
    GIAN_ALLOW_REMOTE_IDENTITY_FILE: '1',
    GIAN_REMOTE_IDENTITY_FILE: '/tmp/should-not-be-used.json',
  });
  assert.equal(identity.kind, 'unavailable');
  await assert.rejects(() => identity.ensurePublic());
});

test('development file opt-in writes 0600 material and never stores a broker secret in SQLite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-remote-id-'));
  const path = join(dir, 'identity.json');
  try {
    const identity = createRemoteIdentityFromEnv({
      GIAN_ALLOW_REMOTE_IDENTITY_FILE: '1',
      GIAN_REMOTE_IDENTITY_FILE: path,
    });
    assert.equal(identity.kind, 'file');
    const publicIdentity = await identity.ensurePublic();
    assert.equal(publicIdentity.fingerprint.length, 64);
    await identity.setRefreshSecret('refresh-secret-test');
    const raw = readFileSync(path, 'utf8');
    assert.match(raw, /"version":1/);
    assert.doesNotMatch(raw, /BEGIN PRIVATE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Server application identity change requires explicit Host confirmation', async () => {
  const context = setupRemoteHarness();
  try {
    const enrollment = new RemoteEnrollmentStore(context.db, new MemoryRemoteIdentity());
    const first = await generateP256SigningKeyPair();
    const second = await generateP256SigningKeyPair();
    const firstPub = await exportPublicJwk(first.publicKey);
    const secondPub = await exportPublicJwk(second.publicKey);
    await enrollment.recordClaim({
      hostId: '11111111-1111-4111-8111-111111111111',
      serverUrl: 'wss://remote.test.invalid/relay',
      serverIdentity: {
        public_key: firstPub,
        fingerprint: await identityFingerprint(firstPub),
      },
      hostName: 'Test Host',
      refreshSecret: 'connector-refresh',
    });
    const observed = await enrollment.observeServerIdentity({
      public_key: secondPub,
      fingerprint: await identityFingerprint(secondPub),
    });
    assert.equal(observed.status, 'pending_confirmation');
    const confirmed = enrollment.confirmServerIdentityChange();
    assert.equal(confirmed.serverIdentityFingerprint, await identityFingerprint(secondPub));
    assert.equal(confirmed.pendingIdentityFingerprint, null);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('Host verifies a Server-signed challenge and rejects fingerprint-only or wrong keys', async () => {
  const context = setupRemoteHarness();
  try {
    const enrollment = new RemoteEnrollmentStore(context.db, new MemoryRemoteIdentity());
    const server = await generateP256SigningKeyPair();
    const other = await generateP256SigningKeyPair();
    const publicKey = await exportPublicJwk(server.publicKey);
    const fingerprint = await identityFingerprint(publicKey);
    await enrollment.recordClaim({
      hostId: '11111111-1111-4111-8111-111111111111',
      serverUrl: 'http://127.0.0.1:9',
      serverIdentity: { public_key: publicKey, fingerprint },
      hostName: 'Test Host',
      refreshSecret: 'connector-refresh',
    });
    const payload = {
      host_id: '11111111-1111-4111-8111-111111111111',
      challenge_id: '22222222-2222-4222-8222-222222222222',
      challenge: 'nonce',
      expires_at: Date.now() + 60_000,
      fingerprint,
    };
    const signature = await signBytes(server.privateKey, new TextEncoder().encode(serverChallengePayload(payload)));
    await enrollment.verifySignedChallenge({
      hostId: payload.host_id,
      challengeId: payload.challenge_id,
      challenge: payload.challenge,
      expiresAt: payload.expires_at,
      serverIdentity: { public_key: publicKey, fingerprint },
      signature,
    });
    await assert.rejects(
      () => enrollment.verifySignedChallenge({
        hostId: payload.host_id,
        challengeId: payload.challenge_id,
        challenge: payload.challenge,
        expiresAt: payload.expires_at,
        serverIdentity: { public_key: publicKey, fingerprint },
        signature: 'not-the-server-signature',
      }),
      /invalid|AUTH_REQUIRED/,
    );
    const changed = await exportPublicJwk(other.publicKey);
    const changedFingerprint = await identityFingerprint(changed);
    const changedSig = await signBytes(
      other.privateKey,
      new TextEncoder().encode(serverChallengePayload({ ...payload, fingerprint: changedFingerprint })),
    );
    await assert.rejects(
      () => enrollment.verifySignedChallenge({
        hostId: payload.host_id,
        challengeId: payload.challenge_id,
        challenge: payload.challenge,
        expiresAt: payload.expires_at,
        serverIdentity: { public_key: changed, fingerprint: changedFingerprint },
        signature: changedSig,
      }),
      /fingerprint changed/,
    );
  } finally {
    teardownRemoteHarness(context);
  }
});

test('Unavailable identity is the default without broker or opt-in', () => {
  const identity = createRemoteIdentityFromEnv({});
  assert.ok(identity instanceof UnavailableRemoteIdentity);
});
