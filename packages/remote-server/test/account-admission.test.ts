import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCOUNT_PROTOCOL, ACCOUNT_SESSION_TTL_MS, AUTH_PROTOCOL, accountLoginStartedSchema, exportPublicJwk,
  generateCanonicalId, generateP256SigningKeyPair, remoteAccountChallengePayload, signBytes } from '@gian/remote-protocol';
import { authorizeAccount, enrollHost, makeRemoteTestApp, pairDevice } from './fixture.js';
import { hashSecret } from '../src/crypto-hash.js';

const json = (value: unknown, token?: string): RequestInit => ({ method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });

test('account Device Flow verifies key possession before OAuth exchange and never returns GitHub credentials', async () => {
  let exchanges = 0;
  const f = await makeRemoteTestApp({ config: { githubFetch: async url => {
    if (String(url).endsWith('/login/device/code')) return Response.json({ device_code: 'secret-device-code',
      user_code: 'USER-CODE', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    if (String(url).endsWith('/login/oauth/access_token')) { exchanges += 1; return Response.json({ access_token: 'secret-github-token', token_type: 'bearer' }); }
    return Response.json({ id: 42, login: 'owner', type: 'User' });
  } } });
  try {
    const keys = await generateP256SigningKeyPair();
    const started = accountLoginStartedSchema.parse(await (await f.fetch('/api/v1/account/start', json({
      protocol: ACCOUNT_PROTOCOL, peer: { role: 'controller', installation_id: generateCanonicalId(), public_key: await exportPublicJwk(keys.publicKey) },
    }))).json());
    assert.equal(JSON.stringify(started).includes('secret-device-code'), false);
    const wrong = await generateP256SigningKeyPair();
    const payload = new TextEncoder().encode(remoteAccountChallengePayload(started.challenge));
    const rejected = await f.fetch('/api/v1/account/poll', json({ protocol: ACCOUNT_PROTOCOL,
      login_id: started.login_id, signature: await signBytes(wrong.privateKey, payload) }));
    assert.equal(rejected.status, 401);
    assert.equal(exchanges, 0);
    const accepted = await f.fetch('/api/v1/account/poll', json({ protocol: ACCOUNT_PROTOCOL,
      login_id: started.login_id, signature: await signBytes(keys.privateKey, payload) }));
    const result = await accepted.json() as { status: string; account_token: string; account: { id: string } };
    assert.equal(result.status, 'authorized');
    assert.equal(result.account.id, '42');
    assert.equal(JSON.stringify(result).includes('secret-github-token'), false);
    assert.equal(f.logs.join('\n').includes('secret-github-token'), false);
    assert.equal((await f.fetch('/api/v1/account/me', { headers: { authorization: `Bearer ${result.account_token}` } })).status, 200);
    await f.fetch('/api/v1/account/logout', json({ protocol: ACCOUNT_PROTOCOL }, result.account_token));
    assert.equal((await f.fetch('/api/v1/account/me', { headers: { authorization: `Bearer ${result.account_token}` } })).status, 401);
  } finally { f.handle.shutdown(); }
});

test('native pairing rejects an invalid bearer or a different numeric GitHub account even when names match', async () => {
  let accountId = 42;
  const f = await makeRemoteTestApp({ config: { githubFetch: async url => {
    if (String(url).endsWith('/login/device/code')) return Response.json({ device_code: 'fixture-device-code',
      user_code: 'CODE', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    if (String(url).endsWith('/login/oauth/access_token')) return Response.json({ access_token: 'fixture-token', token_type: 'bearer' });
    return Response.json({ id: accountId, login: 'same-name', type: 'User' });
  } } });
  try {
    const host = await enrollHost(f.fetch);
    const grant = await (await f.fetch('/api/v1/host/pairings', json({ protocol: AUTH_PROTOCOL }, host.accessToken))).json() as { code: string };
    const keys = await generateP256SigningKeyPair();
    const input = { protocol: AUTH_PROTOCOL, browser_installation_id: generateCanonicalId(), device_public_key: await exportPublicJwk(keys.publicKey),
      platform: 'test', user_agent: 'test', code: grant.code };
    assert.equal((await f.fetch('/api/v1/pairings/claim', { ...json(input),
      headers: { 'content-type': 'application/json', 'x-gian-account-token': 'invalid' } })).status, 401);
    accountId = 99;
    const other = await authorizeAccount(f.fetch, keys, 'controller');
    const rejected = await f.fetch('/api/v1/pairings/claim', { ...json(input),
      headers: { 'content-type': 'application/json', 'x-gian-account-token': other.token } });
    assert.equal(rejected.status, 401);
    assert.equal((f.handle.services.db.prepare('SELECT COUNT(*) AS n FROM device_host_pairings').get() as { n: number }).n, 0);
  } finally { f.handle.shutdown(); }
});

test('browser without GitHub needs Host confirmation and device key; delegated lease is bounded and cannot issue tokens', async () => {
  const f = await makeRemoteTestApp();
  try {
    const host = await enrollHost(f.fetch);
    const grant = await (await f.fetch('/api/v1/host/pairings', json({ protocol: AUTH_PROTOCOL }, host.accessToken))).json() as { code: string };
    const keys = await generateP256SigningKeyPair();
    const browserId = generateCanonicalId();
    const claim = await f.fetch('/api/v1/pairings/claim', json({ protocol: AUTH_PROTOCOL,
      browser_installation_id: browserId, device_public_key: await exportPublicJwk(keys.publicKey),
      code: grant.code, platform: 'iOS', user_agent: 'Mobile Safari' }));
    assert.equal(claim.status, 200);
    const pairing = await claim.json() as { pairing_id: string };
    const deviceInput = { protocol: AUTH_PROTOCOL, browser_installation_id: browserId, host_id: host.hostId };
    assert.equal((await f.fetch('/api/v1/sessions/device-challenge', json(deviceInput))).status, 401);
    assert.equal((await f.fetch('/api/v1/pairings/' + pairing.pairing_id + '/confirm', json({ protocol: AUTH_PROTOCOL,
      pairing_id: pairing.pairing_id, decision: 'confirm' }, host.accessToken))).status, 200);
    const peer = f.handle.services.accounts.requirePairing(pairing.pairing_id);
    assert.equal(peer.delegated_host_id, host.hostId);
    assert.equal(peer.expires_at, f.clock.now + ACCOUNT_SESSION_TTL_MS);
    f.clock.tick(1000);
    assert.equal((await f.fetch('/api/v1/pairings/' + pairing.pairing_id + '/confirm', json({ protocol: AUTH_PROTOCOL,
      pairing_id: pairing.pairing_id, decision: 'confirm' }, host.accessToken))).status, 200);
    assert.equal(f.handle.services.accounts.requirePairing(pairing.pairing_id).expires_at, peer.expires_at, 'confirmation retries do not renew the lease');
    assert.equal((await f.fetch('/api/v1/pairings/' + pairing.pairing_id + '/confirm', json({ protocol: AUTH_PROTOCOL,
      pairing_id: pairing.pairing_id, decision: 'reject' }, host.accessToken))).status, 401);
    const challenge = await (await f.fetch('/api/v1/sessions/device-challenge', json(deviceInput))).json() as { challenge_id: string };
    const wrongKeys = await generateP256SigningKeyPair();
    const login = async (privateKey: CryptoKey) => f.fetch('/api/v1/sessions/device-login', json({ ...deviceInput,
      challenge_id: challenge.challenge_id, signature: await signBytes(privateKey, new TextEncoder().encode(challenge.challenge_id)) }));
    assert.equal((await login(wrongKeys.privateKey)).status, 401);
    const response = await login(keys.privateKey);
    assert.equal(response.status, 200);
    const session = await response.json() as { access_token: string };
    assert.equal((await f.fetch('/api/v1/enrollment/tokens', json({ protocol: AUTH_PROTOCOL }, session.access_token))).status, 401);
    assert.equal((await f.fetch('/api/v1/ws-tickets', json({ protocol: AUTH_PROTOCOL, host_id: host.hostId }, session.access_token))).status, 200);
    // Keep Host proof alive to isolate the browser lease's own expiry boundary.
    f.handle.services.db.prepare("UPDATE account_peers SET expires_at = ? WHERE role = 'host'").run(peer.expires_at + ACCOUNT_SESSION_TTL_MS);
    f.clock.tick(peer.expires_at - f.clock.now);
    assert.throws(() => f.handle.services.accounts.requirePairing(pairing.pairing_id));
    assert.equal((await f.fetch('/api/v1/ws-tickets', json({ protocol: AUTH_PROTOCOL, host_id: host.hostId }, session.access_token))).status, 401);
    f.handle.services.config.maxDevicesPerHost = 1;
    f.handle.services.repos.createPairingGrant(host.hostId, hashSecret('fresh-code'), hashSecret('fresh-nonce'));
    const freshClaim = await f.fetch('/api/v1/pairings/claim', json({ protocol: AUTH_PROTOCOL,
      browser_installation_id: browserId, device_public_key: await exportPublicJwk(wrongKeys.publicKey),
      grant_nonce: 'fresh-nonce', platform: 'phone', user_agent: 'browser' }));
    assert.equal(freshClaim.status, 200, 'expired delegation can be paired again with a fresh device key');
    assert.equal((await f.fetch('/api/v1/sessions/device-challenge', json(deviceInput))).status, 401, 're-pairing still needs Host confirmation');
  } finally { f.handle.shutdown(); }
});

test('Host rejection and revocation close browser delegation without GitHub', async () => {
  const f = await makeRemoteTestApp();
  try {
    const host = await enrollHost(f.fetch);
    const keys = await generateP256SigningKeyPair();
    const browserId = generateCanonicalId();
    const grant = await (await f.fetch('/api/v1/host/pairings', json({ protocol: AUTH_PROTOCOL }, host.accessToken))).json() as { code: string };
    const pairing = await (await f.fetch('/api/v1/pairings/claim', json({ protocol: AUTH_PROTOCOL,
      browser_installation_id: browserId, device_public_key: await exportPublicJwk(keys.publicKey),
      code: grant.code, platform: 'phone', user_agent: 'browser' }))).json() as { pairing_id: string };
    assert.equal((await f.fetch('/api/v1/pairings/' + pairing.pairing_id + '/confirm', json({ protocol: AUTH_PROTOCOL,
      pairing_id: pairing.pairing_id, decision: 'reject' }, host.accessToken))).status, 200);
    assert.equal((await f.fetch('/api/v1/sessions/device-challenge', json({ protocol: AUTH_PROTOCOL,
      browser_installation_id: browserId, host_id: host.hostId }))).status, 401);
    assert.throws(() => f.handle.services.accounts.requirePairing(pairing.pairing_id));
    const nextGrant = await (await f.fetch('/api/v1/host/pairings', json({ protocol: AUTH_PROTOCOL }, host.accessToken))).json() as { code: string };
    const nextPairing = await (await f.fetch('/api/v1/pairings/claim', json({ protocol: AUTH_PROTOCOL,
      browser_installation_id: generateCanonicalId(), device_public_key: await exportPublicJwk(keys.publicKey),
      code: nextGrant.code, platform: 'phone', user_agent: 'browser' }))).json() as { pairing_id: string };
    assert.equal((await f.fetch('/api/v1/pairings/' + nextPairing.pairing_id + '/confirm', json({ protocol: AUTH_PROTOCOL,
      pairing_id: nextPairing.pairing_id, decision: 'confirm' }, host.accessToken))).status, 200);
    assert.ok(f.handle.services.accounts.requirePairing(nextPairing.pairing_id));
    await f.fetch('/api/v1/account/logout', json({ protocol: ACCOUNT_PROTOCOL }, host.accountToken));
    assert.throws(() => f.handle.services.accounts.requirePairing(nextPairing.pairing_id));
  } finally { f.handle.shutdown(); }
});

test('legacy unbound browser can pair again only with a fresh invitation and Host confirmation', async () => {
  const f = await makeRemoteTestApp();
  try {
    const host = await enrollHost(f.fetch);
    const old = await pairDevice(f.fetch, host.accessToken, host.hostId);
    f.handle.services.db.prepare('UPDATE device_host_pairings SET account_peer_id = NULL WHERE id = ?').run(old.deviceId);
    assert.throws(() => f.handle.services.accounts.requirePairing(old.deviceId));
    f.handle.services.config.maxDevicesPerHost = 1;
    const grant = await (await f.fetch('/api/v1/host/pairings', json({ protocol: AUTH_PROTOCOL }, host.accessToken))).json() as { code: string };
    const keys = await generateP256SigningKeyPair();
    const claim = await f.fetch('/api/v1/pairings/claim', json({ protocol: AUTH_PROTOCOL,
      browser_installation_id: old.browserId, device_public_key: await exportPublicJwk(keys.publicKey),
      code: grant.code, platform: 'phone', user_agent: 'browser' }));
    assert.equal(claim.status, 200);
    const pairing = await claim.json() as { pairing_id: string };
    assert.notEqual(pairing.pairing_id, old.deviceId);
    const deviceInput = { protocol: AUTH_PROTOCOL, browser_installation_id: old.browserId, host_id: host.hostId };
    assert.equal((await f.fetch('/api/v1/sessions/device-challenge', json(deviceInput))).status, 401);
    assert.equal((await f.fetch('/api/v1/pairings/' + pairing.pairing_id + '/confirm', json({ protocol: AUTH_PROTOCOL,
      pairing_id: pairing.pairing_id, decision: 'confirm' }, host.accessToken))).status, 200);
    assert.equal((await f.fetch('/api/v1/sessions/device-challenge', json(deviceInput))).status, 200);
    assert.equal((await f.fetch('/api/v1/ws-tickets', json({ protocol: AUTH_PROTOCOL, host_id: host.hostId }, old.accessToken))).status, 401);
  } finally { f.handle.shutdown(); }
});

test('logout invalidates authenticated device routes and Host logout blocks new tickets', async () => {
  const f = await makeRemoteTestApp();
  try {
    const host = await enrollHost(f.fetch);
    const device = await pairDevice(f.fetch, host.accessToken, host.hostId);
    const ticketInput = { protocol: AUTH_PROTOCOL, host_id: host.hostId };
    assert.equal((await f.fetch('/api/v1/ws-tickets', json(ticketInput, device.accessToken))).status, 200);
    await f.fetch('/api/v1/account/logout', json({ protocol: ACCOUNT_PROTOCOL }, device.accountToken));
    assert.equal((await f.fetch('/api/v1/ws-tickets', json(ticketInput, device.accessToken))).status, 401);
    await f.fetch('/api/v1/account/logout', json({ protocol: ACCOUNT_PROTOCOL }, host.accountToken));
    assert.equal((await f.fetch('/api/v1/host/ws-tickets', json({ protocol: AUTH_PROTOCOL }, host.accessToken))).status, 401);
  } finally { f.handle.shutdown(); }
});
