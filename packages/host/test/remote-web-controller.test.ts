import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AUTH_PROTOCOL } from '@gian/remote-protocol';
import { listenRemoteApp, makeRemoteTestApp } from '../../remote-server/test/fixture.js';
import { createProductionController } from '../../remote-web/src/controller/create.js';
import { MemoryEncryptedHostCache } from '../../remote-web/src/cache/encrypted-cache.js';
import { MemoryBrowserIdentityStore } from '../../remote-web/src/transport/identity.js';
import { DeviceRelayClient } from '../../remote-web/src/transport/relay-client.js';
import { makeTestApp } from './fixtures/test-app.js';
import { authenticatedRemoteFixture } from './fixtures/remote-account.js';

async function waitUntil<T>(fn: () => T | Promise<T>, timeoutMs = 12_000): Promise<T> {
  const started = Date.now();
  let last: T | undefined;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for condition: ${String(last)}`);
}

for (const silentHelloPeer of [false, true]) {
test(`production controller pairs through real Server+Host (${silentHelloPeer ? 'silent hello compatibility' : 'negotiated protocol'})`, async () => {
  const hostApp = await makeTestApp();
  if (silentHelloPeer) {
    const connectDevice = hostApp.app.remote.connectDevice.bind(hostApp.app.remote);
    hostApp.app.remote.connectDevice = (...args) => {
      const connector = connectDevice(...args);
      const send = connector.sendControl.bind(connector);
      connector.sendControl = async message => {
        if ((message as { type?: string }).type !== 'hello.ok') await send(message);
      };
      return connector;
    };
  }
  const { handle, fetch } = await makeRemoteTestApp();
  const listened = await listenRemoteApp(handle);
  await authenticatedRemoteFixture(fetch, hostApp.remoteIdentity, listened.url);
  const identity = new MemoryBrowserIdentityStore();
  let controller: ReturnType<typeof createProductionController> | undefined;
  const relays: DeviceRelayClient[] = [];
  try {
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
    const enrollBody = await enrolled.json() as { host_id?: string; enrolled?: boolean };
    assert.equal(enrolled.status, 200, JSON.stringify(enrollBody));
    await waitUntil(() => hostApp.app.remote.relaySocket?.bound ?? null);
    const grant = await (await hostApp.fetch('/api/remote/pairings', { method: 'POST' })).json() as {
      pairing_id: string;
      code: string;
    };
    assert.ok(grant.code);
    controller = createProductionController({
      baseUrl: listened.url,
      publicOrigin: 'https://remote.test',
      wsUrl: listened.wsUrl,
      identity,
      cache: new MemoryEncryptedHostCache(),
      autoRestore: false,
      createRelay: (input) => {
        const relay = new DeviceRelayClient(input);
        relays.push(relay);
        return relay;
      },
      platform: 'macOS',
      userAgent: 'GianRemoteSystemTest',
    });
    controller.actions.startGitHubLogin!();
    await waitUntil(() => controller!.state.account?.userCode);
    controller.actions.pollGitHubLogin!();
    await waitUntil(() => controller!.state.account?.status === 'signed_in');
    controller.actions.submitPairingCode(grant.code);
    const pending = await waitUntil(() => (
      hostApp.app.remote.settingsState().pending_pairings
        .find((row) => row.status === 'pending_confirmation') ?? null
    ));
    const confirm = await hostApp.fetch(`/api/remote/pairings/${pending.id}/confirm`, {
      method: 'POST',
    });
    assert.equal(confirm.status, 200, await confirm.text());
    await waitUntil(() => (
      controller!.state.auth.kind === 'authenticated'
      && controller!.state.connection.kind === 'online'
      && controller!.state.currentHostId === enrollBody.host_id
      ? controller!.state
      : null
    ));
    assert.equal(controller.state.currentHostId, enrollBody.host_id);
    assert.equal(controller.state.hosts[0]?.id, enrollBody.host_id);
    assert.notEqual(controller.state.snapshotReceivedAt, null);
    assert.equal(relays.at(-1)?.protocolMode, silentHelloPeer ? 'legacy' : 'negotiated');
  } finally {
    controller?.close();
    hostApp.app.remote.close();
    listened.close();
    await hostApp.cleanup();
  }
});
}
