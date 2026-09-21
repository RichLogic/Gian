import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AUTH_PROTOCOL, ENROLLMENT_TTL_MS, exportPublicJwk } from '@gian/remote-protocol';

import { cookieHeader, enrollHost, makeRemoteTestApp, pairDevice } from './fixture.js';
import { createEnrollmentFromEnv } from '../src/enrollment-command.js';

test('enrollment command uses only the local admin endpoint and returns a claimable token', async () => {
  const context = await makeRemoteTestApp();
  try {
    const issued = await createEnrollmentFromEnv({
      GIAN_REMOTE_ADMIN_TOKEN: 'admin-test-token', GIAN_REMOTE_PUBLIC_ORIGIN: 'https://remote.test',
      GIAN_REMOTE_HOST: '0.0.0.0', GIAN_REMOTE_PORT: '8787',
    }, 'Home Mac', (async (url, init) => {
      assert.equal(String(url), 'http://127.0.0.1:8787/api/v1/admin/host-enrollments');
      assert.equal(init?.redirect, 'error');
      return context.fetch(new URL(String(url)).pathname, init);
    }) as typeof fetch);
    assert.equal(issued.server_url, 'https://remote.test');
    assert.equal(Date.parse(issued.expires_at), context.clock.now + ENROLLMENT_TTL_MS);
    assert.ok(context.handle.services.repos.claimEnrollment(issued.enrollment_token, {
      name: 'Home Mac', public_key_jwk: 'fixture-key',
    }));
    assert.doesNotMatch(JSON.stringify(issued), /admin-test-token/);
  } finally { context.handle.shutdown(); }
});

test('enrollment command rejects bad configuration and never echoes an error body or credential', async () => {
  const env = { GIAN_REMOTE_ADMIN_TOKEN: 'private-admin', GIAN_REMOTE_PUBLIC_ORIGIN: 'https://remote.test' };
  await assert.rejects(createEnrollmentFromEnv({ ...env, GIAN_REMOTE_PORT: '0' }), /Invalid GIAN_REMOTE_PORT/);
  await assert.rejects(createEnrollmentFromEnv({ ...env, GIAN_REMOTE_ADMIN_TOKEN: '' }), /is required/);
  await assert.rejects(createEnrollmentFromEnv(env, undefined, (async () => new Response('private-admin', { status: 401 })) as typeof fetch), error => {
    assert.match(String(error), /HTTP 401/);
    assert.doesNotMatch(String(error), /private-admin/);
    return true;
  });
});

test('Host profile rename changes only the authenticated Host and preserves existing pairings', async () => {
  const { fetch, handle } = await makeRemoteTestApp();
  try {
    const first = await enrollHost(fetch);
    const second = await enrollHost(fetch);
    const device = await pairDevice(fetch, first.accessToken, first.hostId);
    const send = (body: object, token?: string) => fetch('/api/v1/host/profile', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL, ...body }),
    });
    assert.equal((await send({ name: 'Home Mac' })).status, 401);
    assert.equal((await send({ name: 'Home Mac' }, device.accessToken)).status, 401);
    assert.equal((await send({ name: 'Home Mac', host_id: second.hostId }, first.accessToken)).status, 400);
    assert.equal((await send({ name: '   ' }, first.accessToken)).status, 400);
    const originalSecondName = handle.services.repos.getHost(second.hostId)!.name;
    assert.equal((await send({ name: 'Home Mac' }, first.accessToken)).status, 200);
    assert.equal(handle.services.repos.getHost(first.hostId)!.name, 'Home Mac');
    assert.equal(handle.services.repos.getHost(second.hostId)!.name, originalSecondName);
    assert.equal(handle.services.repos.getPairing(device.deviceId)!.host_id, first.hostId);
    const me = await (await fetch('/api/v1/me', { headers: { cookie: cookieHeader(device.cookies) } })).json() as { hosts: Array<{ name: string }> };
    assert.equal(me.hosts[0]!.name, 'Home Mac');
  } finally { handle.shutdown(); }
});

test('enrollment token is single-use, expires, and concurrent claim loses', async () => {
  const { fetch, clock, handle } = await makeRemoteTestApp();
  const host = await enrollHost(fetch);
  assert.ok(host.hostId);
  const created = await (await fetch('/api/v1/admin/host-enrollments', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { enrollment_token: string };
  const firstClaim = await fetch('/api/v1/host-enrollments/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      enrollment_token: created.enrollment_token,
      host_name: 'Second',
      host_version: '0.5.3',
      host_public_key: {
        kty: 'EC',
        crv: 'P-256',
        x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
    }),
  });
  assert.equal(firstClaim.status, 200);
  const firstClaimBody = await firstClaim.json() as { host_id: string };
  assert.notEqual(firstClaimBody.host_id, host.hostId);
  const reuse = await fetch('/api/v1/host-enrollments/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      enrollment_token: created.enrollment_token,
      host_name: 'Other',
      host_version: '0.5.3',
      host_public_key: {
        kty: 'EC',
        crv: 'P-256',
        x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
    }),
  });
  assert.equal(reuse.status, 401);

  const second = await (await fetch('/api/v1/admin/host-enrollments', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { enrollment_token: string };
  clock.tick(ENROLLMENT_TTL_MS + 1);
  const expired = await fetch('/api/v1/host-enrollments/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      enrollment_token: second.enrollment_token,
      host_name: 'Late',
      host_version: '0.5.3',
      host_public_key: {
        kty: 'EC',
        crv: 'P-256',
        x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
    }),
  });
  assert.equal(expired.status, 401);
  handle.shutdown();
});

test('concurrent enrollment claims consume the token once', async () => {
  const { fetch, handle } = await makeRemoteTestApp();
  const created = await (await fetch('/api/v1/admin/host-enrollments', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { enrollment_token: string };
  const body = {
    protocol: AUTH_PROTOCOL,
    enrollment_token: created.enrollment_token,
    host_name: 'Race',
    host_version: '0.5.3',
    host_public_key: {
      kty: 'EC',
      crv: 'P-256',
      x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    },
  };
  const [first, second] = await Promise.all([
    fetch('/api/v1/host-enrollments/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    fetch('/api/v1/host-enrollments/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, host_name: 'Race-2' }),
    }),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 401]);
  handle.shutdown();
});

test('re-enrolling the same Host identity reuses its id and existing browser pairing', async () => {
  const { fetch, handle } = await makeRemoteTestApp();
  const first = await enrollHost(fetch);
  const device = await pairDevice(fetch, first.accessToken, first.hostId);
  const publicKey = await exportPublicJwk(first.keys.publicKey);
  const created = await (await fetch('/api/v1/admin/host-enrollments', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { enrollment_token: string };

  const response = await fetch('/api/v1/host-enrollments/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      enrollment_token: created.enrollment_token,
      host_name: 'Renamed Office Mac',
      host_version: '0.5.3',
      host_public_key: publicKey,
    }),
  });
  assert.equal(response.status, 200);
  const claimed = await response.json() as { host_id: string };
  assert.equal(claimed.host_id, first.hostId);
  const hostCount = handle.services.repos.db.prepare(
    'SELECT COUNT(*) count FROM hosts',
  ).get() as { count: number };
  assert.equal(hostCount.count, 1);
  assert.equal(handle.services.repos.getPairing(device.deviceId)?.host_id, first.hostId);
  const me = await fetch('/api/v1/me', {
    headers: { cookie: cookieHeader(device.cookies) },
  });
  assert.equal(me.status, 200);
  assert.deepEqual(
    (await me.json() as { hosts: Array<{ host_id: string }> }).hosts.map(host => host.host_id),
    [first.hostId],
  );
  handle.shutdown();
});

test('/health has no host or device identifiers and enrollment returns app identity', async () => {
  const { fetch, handle } = await makeRemoteTestApp();
  const health = await (await fetch('/health')).json() as Record<string, unknown>;
  assert.equal(health.ok, true);
  assert.equal('host_id' in health, false);
  assert.equal('device_id' in health, false);
  const created = await (await fetch('/api/v1/admin/host-enrollments', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { enrollment_token: string };
  const claimed = await (await fetch('/api/v1/host-enrollments/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      enrollment_token: created.enrollment_token,
      host_name: 'Identity',
      host_version: '0.5.3',
      host_public_key: {
        kty: 'EC',
        crv: 'P-256',
        x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
    }),
  })).json() as { server_identity?: { fingerprint?: string; algorithm?: string } };
  assert.equal(claimed.server_identity?.algorithm, 'P-256');
  assert.equal(typeof claimed.server_identity?.fingerprint, 'string');
  assert.doesNotMatch(JSON.stringify(claimed), /tls|certificate|leaf/i);
  handle.shutdown();
});
