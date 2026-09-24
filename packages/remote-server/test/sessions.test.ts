import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUTH_PROTOCOL,
  AUTH_SIGNED_AT_SKEW_MS,
  REFRESH_ABSOLUTE_MS,
  WS_TICKET_TTL_MS,
  exportPublicJwk,
  generateCanonicalId,
  importP256PublicKey,
  serverChallengePayload,
  signBytes,
  verifyBytes,
} from '@gian/remote-protocol';

import { selfRevokePayload } from '../src/auth/signatures.js';
import { cookieHeader, enrollHost, makeRemoteTestApp, pairDevice, signChallenge } from './fixture.js';

test('refresh rotation, reuse-family revoke, logout, and absolute expiry', async () => {
  const { fetch, clock, handle } = await makeRemoteTestApp();
  const host = await enrollHost(fetch);
  const device = await pairDevice(fetch, host.accessToken, host.hostId);
  const cookie = cookieHeader(device.cookies);
  const refresh = await fetch('/api/v1/sessions/refresh', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  });
  assert.equal(refresh.status, 200);
  const replay = await fetch('/api/v1/sessions/refresh', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  });
  assert.equal(replay.status, 401);
  const device2 = await pairDevice(fetch, host.accessToken, host.hostId);
  const parallelCookie = cookieHeader(device2.cookies);
  const [first, second] = await Promise.all([
    fetch('/api/v1/sessions/refresh', {
      method: 'POST',
      headers: { cookie: parallelCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
    }),
    fetch('/api/v1/sessions/refresh', {
      method: 'POST',
      headers: { cookie: parallelCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
    }),
  ]);
  assert.ok([first.status, second.status].includes(401));
  const device3 = await pairDevice(fetch, host.accessToken, host.hostId);
  await fetch('/api/v1/sessions/logout', {
    method: 'POST',
    headers: {
      cookie: cookieHeader(device3.cookies),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  });
  const afterLogout = await fetch('/api/v1/sessions/refresh', {
    method: 'POST',
    headers: {
      cookie: cookieHeader(device3.cookies),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  });
  assert.equal(afterLogout.status, 401);
  const device4 = await pairDevice(fetch, host.accessToken, host.hostId);
  clock.tick(REFRESH_ABSOLUTE_MS + 1);
  const expired = await fetch('/api/v1/sessions/refresh', {
    method: 'POST',
    headers: {
      cookie: cookieHeader(device4.cookies),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  });
  assert.equal(expired.status, 401);
  handle.shutdown();
});

test('WS ticket is single-use, 60s, and never accepted from the URL', async () => {
  const { fetch, clock, handle } = await makeRemoteTestApp();
  const host = await enrollHost(fetch);
  const device = await pairDevice(fetch, host.accessToken, host.hostId);
  const issued = await fetch('/api/v1/ws-tickets', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${device.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL, host_id: host.hostId }),
  });
  const body = await issued.json() as { ticket: string };
  assert.equal(issued.status, 200);
  const first = handle.services.repos.consumeWsTicket(body.ticket);
  const second = handle.services.repos.consumeWsTicket(body.ticket);
  assert.ok(first);
  assert.equal(second, null);
  const leaked = await fetch(`/api/v1/ws-tickets?ticket=${body.ticket}`);
  assert.notEqual(leaked.status, 200);
  const late = await fetch('/api/v1/ws-tickets', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${device.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL, host_id: host.hostId }),
  });
  const lateBody = await late.json() as { ticket: string };
  clock.tick(WS_TICKET_TTL_MS + 1);
  assert.equal(handle.services.repos.consumeWsTicket(lateBody.ticket), null);
  handle.shutdown();
});

test('multi-host keys and offline self-revoke write a tombstone', async () => {
  const { fetch, handle } = await makeRemoteTestApp();
  const hostA = await enrollHost(fetch);
  const hostB = await enrollHost(fetch);
  const deviceA = await pairDevice(fetch, hostA.accessToken, hostA.hostId);
  const deviceB = await pairDevice(fetch, hostB.accessToken, hostB.hostId, {
    keys: deviceA.keys,
    browserId: deviceA.browserId,
  });
  assert.notEqual(deviceA.deviceId, deviceB.deviceId);
  assert.equal(deviceA.browserId, deviceB.browserId);
  const signature = await signBytes(
    deviceA.keys.privateKey,
    new TextEncoder().encode(selfRevokePayload({
      hostId: hostA.hostId,
      deviceId: deviceA.deviceId,
      signedAt: handle.services.config.now(),
    })),
  );
  const revoked = await fetch(`/api/v1/hosts/${hostA.hostId}/pairing`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${deviceA.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      host_id: hostA.hostId,
      signed_at: handle.services.config.now(),
      signature,
    }),
  });
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json() as { status: string }).status, 'tombstoned');
  const tombstones = handle.services.repos.pendingTombstones(hostA.hostId);
  assert.equal(tombstones.length, 1);
  assert.ok(tombstones[0]?.signature);
  assert.ok(tombstones[0]?.public_key_jwk);
  assert.equal(handle.services.repos.getPairing(deviceA.deviceId)?.revoked_at, null);
  const stillB = await fetch('/api/v1/ws-tickets', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${deviceB.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL, host_id: hostB.hostId }),
  });
  assert.equal(stillB.status, 200);
  const rejected = await fetch('/api/v1/ws-tickets', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${deviceA.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL, host_id: hostA.hostId }),
  });
  assert.equal(rejected.status, 401);
  handle.shutdown();
});

test('me and hosts reject a refresh cookie with the correct family and a wrong secret', async () => {
  const { fetch, handle } = await makeRemoteTestApp();
  const host = await enrollHost(fetch);
  const device = await pairDevice(fetch, host.accessToken, host.hostId);
  const cookie = cookieHeader(device.cookies);
  const familyId = cookie.split('=')[1]?.split('.')[0];
  assert.ok(familyId);
  const forged = `gian_remote_refresh=${familyId}.not-the-secret`;
  const me = await fetch('/api/v1/me', { headers: { cookie: forged } });
  const hosts = await fetch('/api/v1/hosts', { headers: { cookie: forged } });
  assert.equal(me.status, 401);
  assert.equal(hosts.status, 401);
  const realMe = await fetch('/api/v1/me', { headers: { cookie } });
  assert.equal(realMe.status, 200);
  handle.shutdown();
});

test('refresh with two hosts requires host_id and issues a ticket for that host', async () => {
  const { fetch, handle } = await makeRemoteTestApp();
  const hostA = await enrollHost(fetch);
  const hostB = await enrollHost(fetch);
  const deviceA = await pairDevice(fetch, hostA.accessToken, hostA.hostId);
  await pairDevice(fetch, hostB.accessToken, hostB.hostId, {
    keys: deviceA.keys,
    browserId: deviceA.browserId,
  });
  const cookie = cookieHeader(deviceA.cookies);
  const missing = await fetch('/api/v1/sessions/refresh', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  });
  assert.equal(missing.status, 401);
  const nextCookie = cookieHeader(missing.headers.getSetCookie());
  const refresh = await fetch('/api/v1/sessions/refresh', {
    method: 'POST',
    headers: { cookie: nextCookie || cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL, host_id: hostB.hostId }),
  });
  assert.equal(refresh.status, 200);
  const body = await refresh.json() as { access_token: string };
  const ticket = await fetch('/api/v1/ws-tickets', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${body.access_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL, host_id: hostB.hostId }),
  });
  assert.equal(ticket.status, 200);
  handle.shutdown();
});

test('online self-revoke notifies the host without marking the tombstone delivered', async () => {
  const { fetch, handle } = await makeRemoteTestApp();
  const host = await enrollHost(fetch);
  const device = await pairDevice(fetch, host.accessToken, host.hostId);
  handle.services.presence.heartbeat(host.hostId);
  const notices: Array<{ type?: string }> = [];
  handle.services.relay.attach({
    role: 'host',
    hostId: host.hostId,
    routeId: host.hostId,
    connectionId: generateCanonicalId(),
    send(frame) {
      notices.push(frame as { type?: string });
    },
    close() {},
  });
  let deviceClosed = false;
  handle.services.relay.attach({
    role: 'device',
    hostId: host.hostId,
    deviceId: device.deviceId,
    routeId: device.deviceId,
    connectionId: generateCanonicalId(),
    send() {},
    close() {
      deviceClosed = true;
    },
  });
  const signature = await signBytes(
    device.keys.privateKey,
    new TextEncoder().encode(selfRevokePayload({
      hostId: host.hostId,
      deviceId: device.deviceId,
      signedAt: handle.services.config.now(),
    })),
  );
  const revoked = await fetch(`/api/v1/hosts/${host.hostId}/pairing`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${device.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      host_id: host.hostId,
      signed_at: handle.services.config.now(),
      signature,
    }),
  });
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json() as { status: string }).status, 'pending_host');
  const notice = notices.find((entry) => entry.type === 'device.revoked') as {
    type?: string;
    signature?: string;
    signed_at?: number;
    device_public_key?: unknown;
  } | undefined;
  assert.ok(notice?.signature);
  assert.ok(notice?.signed_at);
  assert.ok(notice?.device_public_key);
  assert.equal(deviceClosed, true);
  assert.equal(handle.services.repos.getPairing(device.deviceId)?.revoked_at, null);
  assert.equal(handle.services.repos.pendingTombstones(host.hostId).length, 1);
  handle.services.finalizeDeviceRevoke(host.hostId, device.deviceId);
  assert.ok(handle.services.repos.getPairing(device.deviceId)?.revoked_at);
  assert.equal(handle.services.repos.pendingTombstones(host.hostId).length, 0);
  handle.shutdown();
});

test('connector challenge is signed over host_id/challenge_id/challenge/expiry/fingerprint', async () => {
  const { fetch, handle } = await makeRemoteTestApp();
  const host = await enrollHost(fetch);
  const response = await fetch('/api/v1/host/connector-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL, host_id: host.hostId }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as {
    challenge_id: string;
    challenge: string;
    expires_at: number;
    server_identity: { public_key: { kty: 'EC'; crv: 'P-256'; x: string; y: string }; fingerprint: string };
    server_identity_signature: string;
  };
  const payload = serverChallengePayload({
    host_id: host.hostId,
    challenge_id: body.challenge_id,
    challenge: body.challenge,
    expires_at: body.expires_at,
    fingerprint: body.server_identity.fingerprint,
  });
  const key = await importP256PublicKey(handle.services.identity.publicJwk, 'verify');
  assert.equal(
    await verifyBytes(key, new TextEncoder().encode(payload), Buffer.from(body.server_identity_signature, 'base64url')),
    true,
  );
  assert.equal(body.server_identity.fingerprint, handle.services.identity.fingerprint);
  handle.shutdown();
});

test('self-revoke rejects stale signed_at, is idempotent, and allows a later re-pair', async () => {
  const { fetch, clock, handle } = await makeRemoteTestApp();
  const host = await enrollHost(fetch);
  const other = await enrollHost(fetch);
  const device = await pairDevice(fetch, host.accessToken, host.hostId);
  await pairDevice(fetch, other.accessToken, other.hostId, {
    keys: device.keys,
    browserId: device.browserId,
  });
  const staleAt = clock.now - AUTH_SIGNED_AT_SKEW_MS - 1;
  const stale = await fetch(`/api/v1/hosts/${host.hostId}/pairing`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${device.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      host_id: host.hostId,
      signed_at: staleAt,
      signature: await signBytes(
        device.keys.privateKey,
        new TextEncoder().encode(selfRevokePayload({
          hostId: host.hostId,
          deviceId: device.deviceId,
          signedAt: staleAt,
        })),
      ),
    }),
  });
  assert.equal(stale.status, 401);

  const signedAt = clock.now;
  const signature = await signBytes(
    device.keys.privateKey,
    new TextEncoder().encode(selfRevokePayload({
      hostId: host.hostId,
      deviceId: device.deviceId,
      signedAt,
    })),
  );
  const first = await fetch(`/api/v1/hosts/${host.hostId}/pairing`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${device.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      host_id: host.hostId,
      signed_at: signedAt,
      signature,
    }),
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { status: string }).status, 'tombstoned');
  handle.services.finalizeDeviceRevoke(host.hostId, device.deviceId);
  const revokedChallenge = await fetch('/api/v1/sessions/device-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: device.browserId,
      host_id: host.hostId,
    }),
  });
  assert.equal(revokedChallenge.status, 401);
  assert.equal(
    (await revokedChallenge.json() as { error: { code: string } }).error.code,
    'DEVICE_REVOKED',
  );
  const replay = await fetch(`/api/v1/hosts/${host.hostId}/pairing`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${device.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      host_id: host.hostId,
      signed_at: signedAt,
      signature,
    }),
  });
  assert.equal(replay.status, 200);
  const reused = await fetch('/api/v1/host/pairings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${host.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  });
  const reusedGrant = await reused.json() as { code: string };
  const sameKey = await fetch('/api/v1/pairings/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gian-account-token': device.accountToken },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: device.browserId,
      device_public_key: await exportPublicJwk(device.keys.publicKey),
      platform: 'macOS',
      user_agent: 'TestBrowser',
      code: reusedGrant.code,
    }),
  });
  assert.equal(sameKey.status, 401);

  const repaired = await pairDevice(fetch, host.accessToken, host.hostId, {
    browserId: device.browserId,
  });
  assert.notEqual(repaired.deviceId, device.deviceId);
  assert.ok(repaired.cryptoConnectionId);
  handle.shutdown();
});

test('connector login recovers when the rotated refresh response is lost', async () => {
  const { fetch, handle } = await makeRemoteTestApp();
  const host = await enrollHost(fetch);
  const stale = host.refreshSecret;
  const firstChallenge = await (await fetch('/api/v1/host/connector-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL, host_id: host.hostId }),
  })).json() as { challenge_id: string };
  const rotated = await fetch('/api/v1/host/connector-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      host_id: host.hostId,
      challenge_id: firstChallenge.challenge_id,
      signature: await signChallenge(host.keys.privateKey, firstChallenge.challenge_id),
      refresh_secret: stale,
    }),
  });
  assert.equal(rotated.status, 200);
  const issued = (await rotated.json() as { refresh_secret: string }).refresh_secret;
  assert.notEqual(issued, stale);
  const retryChallenge = await (await fetch('/api/v1/host/connector-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL, host_id: host.hostId }),
  })).json() as { challenge_id: string };
  const recovered = await fetch('/api/v1/host/connector-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      host_id: host.hostId,
      challenge_id: retryChallenge.challenge_id,
      signature: await signChallenge(host.keys.privateKey, retryChallenge.challenge_id),
      refresh_secret: stale,
    }),
  });
  assert.equal(recovered.status, 200);
  const recoveredSecret = (await recovered.json() as { refresh_secret: string }).refresh_secret;
  assert.notEqual(recoveredSecret, issued);
  assert.notEqual(recoveredSecret, stale);
  const thirdChallenge = await (await fetch('/api/v1/host/connector-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL, host_id: host.hostId }),
  })).json() as { challenge_id: string };
  const recoveredAgain = await fetch('/api/v1/host/connector-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      host_id: host.hostId,
      challenge_id: thirdChallenge.challenge_id,
      signature: await signChallenge(host.keys.privateKey, thirdChallenge.challenge_id),
      refresh_secret: stale,
    }),
  });
  assert.equal(recoveredAgain.status, 200);
  const thirdSecret = (await recoveredAgain.json() as { refresh_secret: string }).refresh_secret;
  assert.notEqual(thirdSecret, recoveredSecret);
  const currentChallenge = await (await fetch('/api/v1/host/connector-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL, host_id: host.hostId }),
  })).json() as { challenge_id: string };
  const currentLogin = await fetch('/api/v1/host/connector-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      host_id: host.hostId,
      challenge_id: currentChallenge.challenge_id,
      signature: await signChallenge(host.keys.privateKey, currentChallenge.challenge_id),
      refresh_secret: thirdSecret,
    }),
  });
  assert.equal(currentLogin.status, 200);
  handle.shutdown();
});
