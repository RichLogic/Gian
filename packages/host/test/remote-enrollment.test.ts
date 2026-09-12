import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AUTH_PROTOCOL } from '@gian/remote-protocol';
import { listenRemoteApp, makeRemoteTestApp } from '../../remote-server/test/fixture.js';
import { makeTestApp } from './fixtures/test-app.js';

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

test('Host HTTP enrollment claims Server and projector host id follows the claim', async () => {
  const hostApp = await makeTestApp();
  const { handle, fetch } = await makeRemoteTestApp();
  const listened = await listenRemoteApp(handle);
  try {
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
