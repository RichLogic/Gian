import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateCanonicalId, RemoteProtocolError } from '@gian/remote-protocol';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import type { RemoteControllerClient, RemoteControllerEnvironment } from '../src/remote/controller-client.js';
import { RemoteControllerHub } from '../src/remote/controller-hub.js';
import { seedDevice, setupRemoteHarness, teardownRemoteHarness } from './fixtures/remote-harness.js';

test('native send retries reuse a durable command and never execute twice after a lost sync response', async t => {
  const f = setupRemoteHarness();
  const hub = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity);
  try {
    const seeded = seedDevice(f);
    f.runtime.devices.bindAccount(seeded.id, '42');
    const device = f.runtime.devices.get(seeded.id)!;
    const remote = await f.sessions.createSession({ workspace_id: f.workspaceId, agent_id: 'agent-claude-review' });
    f.runtime.executions.register(remote.id, device);
    const environment: RemoteControllerEnvironment = {
      id: generateCanonicalId(), name: 'Remote test', server_origin: 'https://remote.test', server_identity_fingerprint: 'a'.repeat(64),
      host_id: generateCanonicalId(), browser_id: generateCanonicalId(), device_id: device.id,
      crypto_connection_id: generateCanonicalId(), host_public_key_json: null, pairing_id: null, created_at: Date.now(),
    };
    f.db.prepare(`INSERT INTO remote_controller_environments
      (id, name, server_origin, server_identity_fingerprint, host_id, browser_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(environment.id, environment.name, environment.server_origin, environment.server_identity_fingerprint,
        environment.host_id, environment.browser_id, environment.created_at);
    const localId = generateCanonicalId();
    f.db.prepare(`INSERT INTO sessions
      (id, executor, native_session_id, task_id, remote_environment_id, remote_repository_id, remote_repository_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(localId, 'claude', generateCanonicalId(), f.taskId, environment.id, f.workspaceId, 'Remote test');
    hub.bindings.bind({ local_session_id: localId, target: { server_origin: environment.server_origin,
      server_identity_fingerprint: environment.server_identity_fingerprint, account_id: '42',
      host_id: environment.host_id, remote_session_id: remote.id } });
    await f.identity.setAccountSession(environment.server_origin, { role: 'controller', serverOrigin: environment.server_origin,
      serverFingerprint: environment.server_identity_fingerprint, installationId: generateCanonicalId(), accountId: '42',
      accountLogin: 'owner', token: 'fixture-only', expiresAt: Date.now() + 60_000 }, 'controller');
    let sends = 0;
    let loseSync = false;
    const commands: string[] = [];
    t.mock.method(hub, 'client', () => ({ environment, connected: true,
      async request(method: string, params: { after?: number; stream_id?: string }, commandId: string) {
        if (method === 'execution.sync') {
          if (loseSync) throw new RemoteProtocolError('HOST_OFFLINE', 'lost response');
          return f.runtime.executions.sync(device, { session_id: remote.id, after: params.after ?? 0, stream_id: params.stream_id });
        }
        assert.equal(method, 'session.send');
        sends += 1; commands.push(commandId);
        loseSync = true;
        return { session: f.runtime.projector.projectSession(remote) };
      },
    }) as unknown as RemoteControllerClient);
    await hub.sync(localId);
    const input = { type: 'message:send' as const, session_id: localId, request_id: generateCanonicalId(), text: 'Run once' };
    await assert.rejects(hub.handleMessage(input), /lost response/);
    assert.equal(sends, 1);
    loseSync = false;
    await hub.handleMessage(input);
    assert.equal(sends, 1);
    assert.match(commands[0]!, /^[0-9a-f-]{36}$/);
    assert.ok(hub.bindings.get(localId)?.execution_started_at);
    await assert.rejects(hub.handleMessage({ ...input, text: 'Different operation' }), /request changed/);
    assert.equal(f.sessions.getSession(localId).task_id, f.taskId);
    assert.equal(f.sessions.getSession(remote.id).task_id, null);
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('removeEnvironment closes the client and deletes the row', () => {
  const f = setupRemoteHarness();
  const hub = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity);
  try {
    const environment: RemoteControllerEnvironment = {
      id: generateCanonicalId(), name: 'Remote test', server_origin: 'https://remote.test', server_identity_fingerprint: 'a'.repeat(64),
      host_id: generateCanonicalId(), browser_id: generateCanonicalId(), device_id: null,
      crypto_connection_id: generateCanonicalId(), host_public_key_json: null, pairing_id: null, created_at: Date.now(),
    };
    f.db.prepare(`INSERT INTO remote_controller_environments
      (id, name, server_origin, server_identity_fingerprint, host_id, browser_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(environment.id, environment.name, environment.server_origin, environment.server_identity_fingerprint,
        environment.host_id, environment.browser_id, environment.created_at);
    assert.equal(hub.listEnvironments().length, 1);

    hub.removeEnvironment(environment.id);

    assert.equal(hub.listEnvironments().length, 0);
    const remaining = f.db.prepare('SELECT COUNT(*) AS count FROM remote_controller_environments WHERE id = ?')
      .get(environment.id) as { count: number };
    assert.equal(remaining.count, 0);
  } finally { hub.close(); teardownRemoteHarness(f); }
});
