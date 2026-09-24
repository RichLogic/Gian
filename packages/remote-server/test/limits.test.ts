import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AUTH_PROTOCOL, generateCanonicalId } from '@gian/remote-protocol';

import { enrollHost, makeRemoteTestApp, pairDevice, withControllerAccount } from './fixture.js';

test('auth rate limit and per-host device cap isolate abuse', async () => {
  const { fetch: unauthenticatedFetch, handle } = await makeRemoteTestApp({
    config: { authRateLimitPerMinute: 3, maxDevicesPerHost: 1 },
  });
  const fetch = await withControllerAccount(unauthenticatedFetch);
  const host = await enrollHost(fetch);
  await pairDevice(fetch, host.accessToken, host.hostId);
  const second = await (await fetch('/api/v1/host/pairings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${host.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { code: string };
  const overflow = await fetch('/api/v1/pairings/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: generateCanonicalId(),
      device_public_key: {
        kty: 'EC',
        crv: 'P-256',
        x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
      platform: 'macOS',
      user_agent: 'Desktop',
      code: second.code,
    }),
  });
  assert.equal(overflow.status, 429);

  const limited = [];
  for (let index = 0; index < 4; index += 1) {
    limited.push(await fetch('/api/v1/host-enrollments/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
    }));
  }
  assert.ok(limited.some((response) => response.status === 429));
  handle.shutdown();
});
