import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AUTH_PROTOCOL } from '@gian/remote-protocol';

import { REFRESH_COOKIE } from '../src/auth/cookies.js';
import { SECURITY_HEADERS } from '../src/static/headers.js';
import { enrollHost, makeRemoteTestApp, pairDevice } from './fixture.js';

test('origin allowlist, cookies, and security headers hold', async () => {
  const { fetch, handle, publicOrigin } = await makeRemoteTestApp();
  const host = await enrollHost(fetch);
  const device = await pairDevice(fetch, host.accessToken, host.hostId);
  const cookie = device.cookies.join('; ');
  assert.match(cookie, new RegExp(REFRESH_COOKIE));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Secure/i);

  const health = await fetch('/health');
  assert.equal(health.headers.get('Content-Security-Policy'), SECURITY_HEADERS['Content-Security-Policy']);
  assert.equal(health.headers.get('Referrer-Policy'), 'no-referrer');

  const csrf = await handle.app.fetch(new Request('https://remote.test/api/v1/pairings/claim', {
    method: 'POST',
    headers: {
      origin: 'https://evil.test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  }));
  assert.equal(csrf.status, 403);

  const missingOrigin = await handle.app.fetch(new Request('https://remote.test/api/v1/pairings/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: '99999999-9999-4999-8999-999999999999',
      device_public_key: {
        kty: 'EC',
        crv: 'P-256',
        x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
      platform: 'macOS',
      user_agent: 'Desktop',
      code: 'AAAA-AAAA',
    }),
  }));
  assert.equal(missingOrigin.status, 403);
  assert.equal(publicOrigin, 'https://remote.test');
  handle.shutdown();
});

test('WS ticket is not consumed from a URL query', async () => {
  const { fetch, handle } = await makeRemoteTestApp();
  const host = await enrollHost(fetch);
  const device = await pairDevice(fetch, host.accessToken, host.hostId);
  const issued = await (await fetch('/api/v1/ws-tickets', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${device.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL, host_id: host.hostId }),
  })).json() as { ticket: string };
  const leaked = await handle.app.fetch(new Request(`https://remote.test/ws?ticket=${issued.ticket}`));
  assert.notEqual(leaked.status, 101);
  assert.ok(handle.services.repos.consumeWsTicket(issued.ticket));
  handle.shutdown();
});
