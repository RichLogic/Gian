import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  exportPublicJwk,
  generateCanonicalId,
  generateP256SigningKeyPair,
  remoteAccountChallengePayload,
  remoteAccountIdentitySchema,
  remoteExecutionBindingInputSchema,
  remoteExecutionTargetSchema,
  remoteServerOriginSchema,
  signBytes,
  verifyBytes,
  base64UrlToBytes,
} from '../src/index.js';

test('execution targets have no remote Task or credential escape hatch', () => {
  const target = {
    server_origin: 'https://remote.example',
    server_identity_fingerprint: 'a'.repeat(64),
    account_id: '123', host_id: generateCanonicalId(),
    remote_session_id: generateCanonicalId(),
  };
  assert.deepEqual(remoteExecutionTargetSchema.parse(target), target);
  for (const extra of [{ task_id: generateCanonicalId() }, { token: 'secret' }, { path: '/tmp/repo' }, { worktree_id: 'viewed-tree' }]) {
    assert.equal(remoteExecutionTargetSchema.safeParse({ ...target, ...extra }).success, false);
  }
  assert.equal(remoteExecutionBindingInputSchema.safeParse({
    local_session_id: generateCanonicalId(), target, remote_task_id: generateCanonicalId(),
  }).success, false);
});

test('Server identity origins cannot hide credentials, redirects or insecure transport', () => {
  for (const origin of [
    'http://remote.example', 'https://user:password@remote.example',
    'https://remote.example/path', 'https://remote.example/', 'https://REMOTE.example',
    'https://remote.example?token=x', 'https://remote.example#fragment', 'not a URL',
  ]) assert.equal(remoteServerOriginSchema.safeParse(origin).success, false, origin);
  assert.equal(remoteServerOriginSchema.safeParse('https://remote.example:8443').success, true);
});

test('account identity uses a positive canonical numeric ID, never a login as identity', () => {
  for (const id of ['alice', '0', '-1', '01', '', '1.0']) {
    assert.equal(remoteAccountIdentitySchema.safeParse({ provider: 'github', id, login: 'alice' }).success, false);
  }
  assert.equal(remoteAccountIdentitySchema.safeParse({ provider: 'github', id: '42', login: 'renamed' }).success, true);
});

test('account signature binds Server identity, role, device, nonce and expiry', async () => {
  const keys = await generateP256SigningKeyPair();
  const challenge = {
    type: 'gian.remote.account_challenge/1' as const,
    challenge_id: generateCanonicalId(), nonce: 'server-nonce',
    server_identity_fingerprint: 'a'.repeat(64), expires_at: 12345,
    peer: { role: 'host' as const, installation_id: generateCanonicalId(), public_key: await exportPublicJwk(keys.publicKey) },
  };
  const bytes = (value: typeof challenge) => new TextEncoder().encode(remoteAccountChallengePayload(value));
  const signature = base64UrlToBytes(await signBytes(keys.privateKey, bytes(challenge)));
  assert.equal(await verifyBytes(keys.publicKey, bytes(challenge), signature), true);
  for (const changed of [
    { ...challenge, server_identity_fingerprint: 'b'.repeat(64) },
    { ...challenge, nonce: 'another-nonce' },
    { ...challenge, expires_at: 12346 },
    { ...challenge, peer: { ...challenge.peer, installation_id: generateCanonicalId() } },
  ]) assert.equal(await verifyBytes(keys.publicKey, bytes(changed), signature), false);
  const otherRole = { ...challenge, peer: { ...challenge.peer, role: 'controller' as const } };
  assert.equal(await verifyBytes(keys.publicKey,
    new TextEncoder().encode(remoteAccountChallengePayload(otherRole)), signature), false);
});
