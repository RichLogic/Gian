import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AUTH_PROTOCOL, RemoteProtocolError } from '@gian/remote-protocol';
import { listenRemoteApp, makeRemoteTestApp } from '../../remote-server/test/fixture.js';
import { makeTestApp } from './fixtures/test-app.js';
import { HttpRemoteServerAuthClient, RemoteAccountRequiredError } from '../src/remote/server-client.js';
import { MemoryRemoteIdentity } from '../src/remote/identity.js';

async function waitUntil<T>(fn: () => T | Promise<T>, timeoutMs = 5_000): Promise<T> {
  const started = Date.now();
  let last: T | undefined;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for condition: ${String(last)}`);
}

/** Since account admission (gian.remote 1.2), every Server call needs a GitHub
 *  account session. The test Server authorizes the first poll immediately. */
async function loginGitHub(hostApp: Awaited<ReturnType<typeof makeTestApp>>, serverUrl: string): Promise<void> {
  const started = await hostApp.fetch('/api/remote/account/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ server_url: serverUrl }),
  });
  assert.equal(started.status, 200, JSON.stringify(await started.json()));
  const polled = await hostApp.fetch('/api/remote/account/poll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(polled.status, 200, JSON.stringify(await polled.json()));
}

test('enrollment without Host authorization returns a recoverable error without consuming the token', async () => {
  const hostApp = await makeTestApp();
  const server = await makeRemoteTestApp();
  const listened = await listenRemoteApp(server.handle);
  try {
    const issued = await (await server.fetch('/api/v1/admin/host-enrollments', {
      method: 'POST', headers: { authorization: 'Bearer admin-test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
    })).json() as { enrollment_token: string };
    const enroll = () => hostApp.fetch('/api/remote/enroll', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server_url: listened.url, enrollment_token: issued.enrollment_token, host_name: 'Studio Mac' }),
    });
    const missing = await enroll();
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), { error: 'remote_auth_required' });
    assert.equal(hostApp.app.remote.settingsState().enrolled, false);
    await loginGitHub(hostApp, listened.url);
    const recovered = await enroll();
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json() as { enrolled: boolean }).enrolled, true);
    assert.equal(hostApp.app.remote.settingsState().host_name, 'Studio Mac');
  } finally { hostApp.app.remote.close(); listened.close(); await hostApp.cleanup(); }
});

test('an authorized Host gets a distinct sanitized rejection for an invalid enrollment token', async () => {
  const hostApp = await makeTestApp();
  const server = await makeRemoteTestApp();
  const listened = await listenRemoteApp(server.handle);
  try {
    await loginGitHub(hostApp, listened.url);
    const result = await hostApp.fetch('/api/remote/enroll', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server_url: listened.url, enrollment_token: 'invalid-private-token' }),
    });
    assert.equal(result.status, 400);
    assert.deepEqual(await result.json(), { error: 'enrollment_rejected' });
    assert.equal(hostApp.app.remote.settingsState().enrolled, false);
  } finally { hostApp.app.remote.close(); listened.close(); await hostApp.cleanup(); }
});

test('enrollment transport failures are distinct from missing authorization and redact details', async t => {
  const hostApp = await makeTestApp();
  t.mock.method(HttpRemoteServerAuthClient.prototype, 'claimEnrollment', async () => {
    throw new RemoteProtocolError('HOST_OFFLINE', 'private-token and transport details');
  });
  try {
    const result = await hostApp.fetch('/api/remote/enroll', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server_url: 'https://remote.test', enrollment_token: 'private-token' }),
    });
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { error: 'remote_unavailable' });
  } finally { hostApp.app.remote.close(); await hostApp.cleanup(); }
});

test('expired Host authorization fails before dispatching an enrollment claim', async t => {
  const identity = new MemoryRemoteIdentity();
  t.mock.method(identity, 'getAccountSession', async () => ({
    role: 'host' as const, serverOrigin: 'https://remote.test', serverFingerprint: 'a'.repeat(64),
    installationId: 'expired', accountId: '1', accountLogin: 'test', token: 'private-token', expiresAt: 0,
  }));
  let requests = 0;
  const client = new HttpRemoteServerAuthClient('https://remote.test', identity, async () => {
    requests += 1;
    throw new Error('must not reach the server');
  });
  await assert.rejects(client.claimEnrollment({ enrollmentToken: 'private-enrollment-token', hostName: 'Mac',
    hostVersion: 'test', hostPublicKey: (await identity.ensurePublic()).public_key }), RemoteAccountRequiredError);
  assert.equal(requests, 0);
});

for (const failure of ['transport', 'rate-limit', 'upstream'] as const) {
  test(`Remote ${failure} failure is unavailable, not an authorization rejection`, async () => {
    const client = new HttpRemoteServerAuthClient('https://remote.test', new MemoryRemoteIdentity(), async () => {
      if (failure === 'transport') throw new Error('private transport detail');
      return new Response('private upstream detail', { status: failure === 'rate-limit' ? 429 : 503 });
    });
    await assert.rejects(client.challenge('test-host'), (error: unknown) => {
      assert.ok(error instanceof RemoteProtocolError);
      assert.equal(error.code, 'HOST_OFFLINE');
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
  });
}

test('Host HTTP enrollment claims Server and projector host id follows the claim', async () => {
  const hostApp = await makeTestApp();
  const { handle, fetch } = await makeRemoteTestApp();
  const listened = await listenRemoteApp(handle);
  try {
    await loginGitHub(hostApp, listened.url);
    const before = hostApp.app.remote.projector.snapshot({
      capabilities: {} as never,
      attention: [],
    });
    const created = await (await fetch('/api/v1/admin/host-enrollments', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
    })).json() as { enrollment_token: string };
    const enrolled = await hostApp.fetch('/api/remote/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        server_url: listened.url,
        enrollment_token: created.enrollment_token,
      }),
    });
    const body = await enrolled.json() as { host_id?: string; enrolled?: boolean; error?: string };
    assert.equal(enrolled.status, 200, JSON.stringify(body));
    assert.equal(body.enrolled, true);
    await waitUntil(() => hostApp.app.remote.relaySocket?.bound ?? null);
    const after = hostApp.app.remote.projector.snapshot({
      capabilities: {} as never,
      attention: [],
    });
    assert.equal(after.host.id, body.host_id);
    assert.notEqual(after.host.id, before.host.id);
    assert.equal(hostApp.app.remote.settingsState().host_id, body.host_id);
  } finally {
    hostApp.app.remote.close();
    listened.close();
    await hostApp.cleanup();
  }
});

test('enroll accepts an optional machine name and stores it as the remote name', async () => {
  const hostApp = await makeTestApp();
  const { handle, fetch } = await makeRemoteTestApp();
  const listened = await listenRemoteApp(handle);
  try {
    await loginGitHub(hostApp, listened.url);
    const created = await (await fetch('/api/v1/admin/host-enrollments', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
    })).json() as { enrollment_token: string };
    const enrolled = await hostApp.fetch('/api/remote/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        server_url: listened.url,
        enrollment_token: created.enrollment_token,
        host_name: '  Studio Mac  ',
      }),
    });
    const body = await enrolled.json() as { host_id?: string; enrolled?: boolean; error?: string };
    assert.equal(enrolled.status, 200, JSON.stringify(body));
    assert.equal(hostApp.app.remote.settingsState().host_name, 'Studio Mac');
  } finally {
    hostApp.app.remote.close();
    listened.close();
    await hostApp.cleanup();
  }
});
