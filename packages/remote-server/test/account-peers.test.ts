import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCOUNT_SESSION_TTL_MS,
  exportPublicJwk,
  generateCanonicalId,
  generateP256SigningKeyPair,
  remoteAccountChallengePayload,
  signBytes,
  type RemoteAccountPeer,
} from '@gian/remote-protocol';
import { RemoteAccountPeers } from '../src/auth/account-peers.js';
import { GitHubIdentityVerifier } from '../src/auth/github-identity.js';
import { openRemoteDatabase } from '../src/storage/db.js';

function fixture(fetchImpl: typeof fetch = async (_url, init) => {
  const token = new Headers(init?.headers).get('authorization');
  const id = token === 'Bearer oauth-other' ? 43 : 42;
  return Response.json({ id, login: token === 'Bearer oauth-renamed' ? 'new-name' : 'same-name', type: 'User' });
}) {
  const dir = mkdtempSync(join(tmpdir(), 'gian-remote-account-'));
  const db = openRemoteDatabase(dir);
  let now = 1000;
  const service = new RemoteAccountPeers(db, 'a'.repeat(64), () => now, new GitHubIdentityVerifier(fetchImpl));
  return {
    db, dir, service,
    tick(ms: number) { now += ms; },
    now: () => now,
    close() { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

async function peer(role: RemoteAccountPeer['role']) {
  const keys = await generateP256SigningKeyPair();
  return {
    keys,
    input: { role, installation_id: generateCanonicalId(), public_key: await exportPublicJwk(keys.publicKey) },
  };
}

async function proof(service: RemoteAccountPeers, value: Awaited<ReturnType<typeof peer>>) {
  const challenge = service.challenge(value.input);
  return {
    challenge,
    request: {
      challengeId: challenge.challenge_id,
      nonce: challenge.nonce,
      signature: await signBytes(value.keys.privateKey, new TextEncoder().encode(remoteAccountChallengePayload(challenge))),
      accessToken: 'oauth-primary',
    },
  };
}

test('GitHub identity is verified online, with fixed endpoint, no redirect and minimal projected fields', async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const verifier = new GitHubIdentityVerifier(async (url, init) => {
    request = { url: String(url), init };
    return Response.json({ id: 42, login: 'account', type: 'User', email: 'not-exported@example.test' });
  });
  assert.deepEqual(await verifier.verify('oauth-value'), { provider: 'github', id: '42', login: 'account' });
  assert.equal(request?.url, 'https://api.github.com/user');
  assert.equal(request?.init?.redirect, 'error');
  assert.equal(new Headers(request?.init?.headers).get('authorization'), 'Bearer oauth-value');
  assert.ok(request?.init?.signal);
});

test('GitHub failures, invalid IDs and machine identities fail closed without leaking upstream errors', async () => {
  for (const body of [null, {}, { id: '42', login: 'user', type: 'User' },
    { id: 0, login: 'user', type: 'User' }, { id: Number.MAX_SAFE_INTEGER + 1, login: 'user', type: 'User' },
    { id: 42, login: 'bot', type: 'Bot' }, { id: 42, login: '', type: 'User' }]) {
    const verifier = new GitHubIdentityVerifier(async () => Response.json(body));
    await assert.rejects(() => verifier.verify('secret'), /GitHub account verification failed/);
  }
  for (const status of [301, 401, 403, 429, 500]) {
    const verifier = new GitHubIdentityVerifier(async () => new Response('secret response', { status }));
    await assert.rejects(() => verifier.verify('secret'), /GitHub account verification failed/);
  }
  const failed = new GitHubIdentityVerifier(async () => { throw new Error('Authorization: Bearer secret'); });
  await assert.rejects(() => failed.verify('secret'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /Bearer|secret/);
    return true;
  });
});

test('same numeric account succeeds despite login changes; same login with a different ID is denied', async () => {
  const f = fixture();
  try {
    const host = await peer('host');
    const controller = await peer('controller');
    const other = await peer('controller');
    await f.service.authenticate((await proof(f.service, host)).request);
    await f.service.authenticate({ ...(await proof(f.service, controller)).request, accessToken: 'oauth-renamed' });
    await f.service.authenticate({ ...(await proof(f.service, other)).request, accessToken: 'oauth-other' });
    assert.equal(f.service.requireSameAccount(host.input.installation_id, controller.input.installation_id).id, '42');
    assert.throws(() => f.service.requireSameAccount(host.input.installation_id, other.input.installation_id), /account proof required/);
    assert.throws(() => f.service.requireSameAccount(generateCanonicalId(), controller.input.installation_id), /account proof required/);
    assert.throws(() => f.service.requireSameAccount(controller.input.installation_id, host.input.installation_id), /account proof required/);
  } finally { f.close(); }
});

test('challenge replay, wrong private key, altered nonce and expiry are rejected', async () => {
  let calls = 0;
  const f = fixture(async () => { calls += 1; return Response.json({ id: 42, login: 'user', type: 'User' }); });
  try {
    const host = await peer('host');
    const first = await proof(f.service, host);
    await f.service.authenticate(first.request);
    await assert.rejects(() => f.service.authenticate(first.request), /account proof required/);
    const second = await proof(f.service, host);
    await assert.rejects(() => f.service.authenticate({ ...second.request, nonce: 'tampered' }), /account proof required/);
    const stranger = await peer('host');
    const signature = await signBytes(stranger.keys.privateKey,
      new TextEncoder().encode(remoteAccountChallengePayload(second.challenge)));
    await assert.rejects(() => f.service.authenticate({ ...second.request, signature }), /account proof required/);
    assert.equal(calls, 1);
    f.tick(5 * 60 * 1000);
    await assert.rejects(() => f.service.authenticate(second.request), /account proof required/);
    assert.equal(calls, 1);
  } finally { f.close(); }
});

test('concurrent completion consumes a challenge exactly once', async () => {
  let calls = 0;
  const f = fixture(async () => { calls += 1; return Response.json({ id: 42, login: 'user', type: 'User' }); });
  try {
    const request = (await proof(f.service, await peer('host'))).request;
    const results = await Promise.allSettled([f.service.authenticate(request), f.service.authenticate(request)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(calls, 1);
  } finally { f.close(); }
});

test('account and key cannot be silently replaced on the same installation', async () => {
  const f = fixture();
  try {
    const host = await peer('host');
    await f.service.authenticate((await proof(f.service, host)).request);
    await assert.rejects(() => f.service.authenticate({
      challengeId: 'not-an-id', nonce: 'nonce', signature: 'signature', accessToken: 'oauth-primary',
    }), /closed schema validation failed/);
    const swappedAccount = (await proof(f.service, host)).request;
    await assert.rejects(() => f.service.authenticate({ ...swappedAccount, accessToken: 'oauth-other' }), /account proof required/);
    assert.equal((f.db.prepare('SELECT revoked_at FROM account_peers').get() as { revoked_at: number }).revoked_at, f.now());
    const otherKey = await peer('host');
    otherKey.input.installation_id = host.input.installation_id;
    const swappedKey = (await proof(f.service, otherKey)).request;
    await assert.rejects(() => f.service.authenticate(swappedKey), /account proof required/);
    assert.equal((f.db.prepare('SELECT github_account_id FROM account_peers').get() as { github_account_id: string }).github_account_id, '42');
  } finally { f.close(); }
});

test('revocation during GitHub verification fences late success, including a never-bound peer', async () => {
  let release!: (response: Response) => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const response = new Promise<Response>(resolve => { release = resolve; });
  const f = fixture(async () => { started(); return response; });
  try {
    const host = await peer('host');
    const request = (await proof(f.service, host)).request;
    const authenticating = f.service.authenticate(request);
    const rejected = assert.rejects(authenticating, /account proof required/);
    await waiting;
    f.service.revoke('host', host.input.installation_id);
    release(Response.json({ id: 42, login: 'user', type: 'User' }));
    await rejected;
    assert.equal(f.db.prepare('SELECT * FROM account_peers').get(), undefined);
  } finally { f.close(); }
});

test('account proof leases expire and revocation cannot be revived by new proofs', async () => {
  const f = fixture();
  try {
    const host = await peer('host');
    const controller = await peer('controller');
    await f.service.authenticate((await proof(f.service, host)).request);
    await f.service.authenticate((await proof(f.service, controller)).request);
    f.tick(ACCOUNT_SESSION_TTL_MS);
    assert.throws(() => f.service.requireSameAccount(host.input.installation_id, controller.input.installation_id), /account proof required/);
    await f.service.authenticate((await proof(f.service, host)).request);
    await f.service.authenticate((await proof(f.service, controller)).request);
    f.service.revoke('controller', controller.input.installation_id);
    assert.throws(() => f.service.requireSameAccount(host.input.installation_id, controller.input.installation_id), /account proof required/);
    const afterRevoke = (await proof(f.service, controller)).request;
    await assert.rejects(() => f.service.authenticate(afterRevoke), /account proof required/);
  } finally { f.close(); }
});

test('GitHub verification finishing after challenge expiry cannot issue a fresh account lease', async () => {
  let advance = () => {};
  const f = fixture(async () => {
    advance();
    return Response.json({ id: 42, login: 'user', type: 'User' });
  });
  advance = () => f.tick(5 * 60 * 1000);
  try {
    const request = (await proof(f.service, await peer('host'))).request;
    await assert.rejects(() => f.service.authenticate(request), /account proof required/);
    assert.equal(f.db.prepare('SELECT * FROM account_peers').get(), undefined);
  } finally { f.close(); }
});

test('restart keeps public account bindings but never persists OAuth tokens or challenge nonces', async () => {
  const f = fixture();
  try {
    const host = await peer('host');
    const controller = await peer('controller');
    const first = await proof(f.service, host);
    await f.service.authenticate(first.request);
    await f.service.authenticate((await proof(f.service, controller)).request);
    const serialized = JSON.stringify({
      peers: f.db.prepare('SELECT * FROM account_peers').all(),
      challenges: f.db.prepare('SELECT * FROM account_challenges').all(),
    });
    assert.equal(serialized.includes(first.request.accessToken), false);
    assert.equal(serialized.includes(first.request.nonce), false);
    f.db.close();
    const db = openRemoteDatabase(f.dir);
    try {
      const service = new RemoteAccountPeers(db, 'a'.repeat(64), f.now);
      assert.equal(service.requireSameAccount(host.input.installation_id, controller.input.installation_id).id, '42');
      const changedServer = new RemoteAccountPeers(db, 'b'.repeat(64), f.now);
      assert.throws(() => changedServer.requireSameAccount(host.input.installation_id, controller.input.installation_id), /account proof required/);
    } finally { db.close(); }
  } finally { f.close(); }
});
