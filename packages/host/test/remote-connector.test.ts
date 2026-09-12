import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  AUTH_PROTOCOL,
  AUTH_SIGNED_AT_SKEW_MS,
  CONTENT_WINDOW_CHUNKS,
  MAX_CONTENT_CHUNK_PLAINTEXT_BYTES,
  PRESENCE_LEASE_MS,
  selfRevokePayload,
  bytesToBase64Url,
  cryptoAcceptPayload,
  cryptoOfferPayload,
  exportPublicJwk,
  generateCanonicalId,
  generateP256KeyPair,
  generateP256SigningKeyPair,
  importP256PublicKey,
  parseRelayFrame,
  parseRelayHandshake,
  signBytes,
  verifyBytes,
  type CommandRequest,
  type RelayFrame,
} from '@gian/remote-protocol';
import { listenRemoteApp, makeRemoteTestApp, signChallenge } from '../../remote-server/test/fixture.js';
import { PeerCryptoSession } from '../src/remote/crypto-session.js';
import { MemoryDuplexTransport, RemoteConnector, type RemoteServerAuthClient } from '../src/remote/connector.js';
import { HostRelaySocket } from '../src/remote/host-relay.js';
import { RemoteReplayBuffer } from '../src/remote/replay-buffer.js';
import { command, seedDevice, setupRemoteHarness, teardownRemoteHarness } from './fixtures/remote-harness.js';
import { makeTestApp } from './fixtures/test-app.js';

async function pairCrypto() {
  const host = await generateP256KeyPair();
  const device = await generateP256KeyPair();
  const binding = {
    hostGeneration: generateCanonicalId(),
    hostId: generateCanonicalId(),
    deviceId: generateCanonicalId(),
    routeId: generateCanonicalId(),
    connectionId: generateCanonicalId(),
  };
  const transcript = {
    host_identity: { kty: 'EC' as const, crv: 'P-256' as const, x: 'a', y: 'b' },
    device_identity: { kty: 'EC' as const, crv: 'P-256' as const, x: 'c', y: 'd' },
    host_ephemeral: { kty: 'EC' as const, crv: 'P-256' as const, x: 'e', y: 'f' },
    device_ephemeral: { kty: 'EC' as const, crv: 'P-256' as const, x: 'g', y: 'h' },
    connection_id: binding.connectionId,
  };
  return {
    host: await PeerCryptoSession.fromHandshake({
      localPrivate: host.privateKey,
      remotePublic: device.publicKey,
      transcript,
      sendDirection: 'host_to_device',
      binding,
    }),
    device: await PeerCryptoSession.fromHandshake({
      localPrivate: device.privateKey,
      remotePublic: host.publicKey,
      transcript,
      sendDirection: 'device_to_host',
      binding,
    }),
    binding,
  };
}

function unusedAuth(overrides: Partial<RemoteServerAuthClient> = {}): RemoteServerAuthClient {
  return {
    async challenge() {
      throw new Error('unused challenge');
    },
    async login() {
      throw new Error('unused login');
    },
    async heartbeat() {},
    async createPairing() {
      throw new Error('unused createPairing');
    },
    async confirmPairing() {
      throw new Error('unused confirmPairing');
    },
    async revokeDevice() {},
    ...overrides,
  };
}

async function enrollAndStart(context: ReturnType<typeof setupRemoteHarness>) {
  const { handle, fetch, clock } = await makeRemoteTestApp();
  const listened = await listenRemoteApp(handle);
  const identity = await context.identity.ensurePublic();
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
      host_name: 'Office Mac',
      host_version: '0.5.3',
      host_public_key: identity.public_key,
    }),
  })).json() as {
    host_id: string;
    connector_refresh_secret: string;
    server_identity: { public_key: { kty: 'EC'; crv: 'P-256'; x: string; y: string }; fingerprint: string };
  };
  await context.runtime.enrollment.recordClaim({
    hostId: claimed.host_id,
    serverUrl: listened.url,
    serverIdentity: claimed.server_identity,
    hostName: 'Office Mac',
    refreshSecret: claimed.connector_refresh_secret,
  });
  await context.runtime.start();
  return { handle, fetch, clock, listened, hostId: claimed.host_id };
}

async function waitUntil<T>(fn: () => T | Promise<T>, timeoutMs = 3_000): Promise<T> {
  const started = Date.now();
  let last: T | undefined;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for condition: ${String(last)}`);
}

test('Host relay paces a shared encrypted-frame burst and drops a closed route queue', async () => {
  const sentAt: number[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send() { sentAt.push(Date.now()); },
    close() {},
  } as unknown as WebSocket;
  const RelayConstructor = HostRelaySocket as unknown as new (socket: WebSocket) => HostRelaySocket;
  const relay = new RelayConstructor(socket);
  const route = relay.attachDevice(generateCanonicalId());
  const started = Date.now();
  for (let index = 0; index < 4; index += 1) {
    route.send({ ciphertext: 'sealed', connection_id: generateCanonicalId(), index });
  }
  await waitUntil(() => sentAt.length === 4);
  assert.ok(sentAt[3]! - started >= 35);

  const beforeClose = sentAt.length;
  for (let index = 0; index < 4; index += 1) {
    route.send({ ciphertext: 'stale', connection_id: generateCanonicalId(), index });
  }
  route.close('replaced');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(sentAt.length, beforeClose);
  relay.close();
});

async function sendDeviceFrame(
  transport: MemoryDuplexTransport,
  crypto: PeerCryptoSession,
  message: object,
  frameClass: 'control' | 'content' = 'control',
): Promise<void> {
  const sealed = await crypto.seal(new TextEncoder().encode(JSON.stringify(message)));
  transport.send({
    protocol: 'gian.relay/1',
    frame_id: generateCanonicalId(),
    frame_class: frameClass,
    route_id: crypto.routeId,
    host_id: crypto.hostId,
    device_id: crypto.deviceId,
    connection_id: crypto.connectionId,
    transport_sequence: sealed.sequence,
    transport_ack: crypto.inboundAck,
    sent_at: Date.now(),
    ciphertext: sealed.ciphertext,
  });
}

async function openHostFrames(
  crypto: PeerCryptoSession,
  frames: unknown[],
): Promise<Array<{ frame: RelayFrame; message: { type?: string } }>> {
  const opened: Array<{ frame: RelayFrame; message: { type?: string } }> = [];
  for (const raw of frames) {
    const frame = parseRelayFrame(raw);
    const plaintext = await crypto.open({
      ciphertext: frame.ciphertext,
      sequence: frame.transport_sequence,
      direction: 'host_to_device',
      routeId: frame.route_id,
      connectionId: crypto.connectionId,
    });
    opened.push({
      frame,
      message: JSON.parse(new TextDecoder().decode(plaintext)) as { type?: string },
    });
  }
  return opened;
}

test('connector heartbeat, generation restart, and exponential backoff stay local', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const crypto = await pairCrypto();
    const transports = MemoryDuplexTransport.pair();
    const heartbeats: string[] = [];
    const connector = new RemoteConnector(
      transports.host,
      crypto.host,
      new RemoteReplayBuffer(),
      async () => ({ ok: true }),
      device,
      unusedAuth({
        async heartbeat(hostId) {
          heartbeats.push(hostId);
        },
      }),
      crypto.binding.hostId,
    );
    const first = connector.nextBackoffMs();
    const second = connector.nextBackoffMs();
    assert.ok(first >= 500);
    assert.ok(second > first);
    connector.resetBackoff();
    const generation = connector.generation;
    const restarted = connector.restartGeneration();
    assert.notEqual(restarted, generation);
    connector.close();
    assert.equal(transports.host.closed, true);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('same-tick inbound seq 0/1 does not close the crypto session', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const crypto = await pairCrypto();
    const transports = MemoryDuplexTransport.pair();
    const connector = new RemoteConnector(
      transports.host,
      crypto.host,
      new RemoteReplayBuffer(),
      async () => ({ ok: true }),
      device,
    );
    const first = await crypto.device.seal(new TextEncoder().encode(JSON.stringify({
      type: 'transfer.ack',
      transfer_id: generateCanonicalId(),
      contiguous_offset: 0,
      window_chunks: 1,
    })));
    const second = await crypto.device.seal(new TextEncoder().encode(JSON.stringify({
      type: 'transfer.ack',
      transfer_id: generateCanonicalId(),
      contiguous_offset: 1,
      window_chunks: 1,
    })));
    const frame = (sealed: typeof first) => ({
      protocol: 'gian.relay/1',
      frame_id: generateCanonicalId(),
      frame_class: 'control',
      route_id: crypto.host.routeId,
      host_id: crypto.host.hostId,
      device_id: crypto.host.deviceId,
      connection_id: crypto.host.connectionId,
      transport_sequence: sealed.sequence,
      transport_ack: 0,
      sent_at: Date.now(),
      ciphertext: sealed.ciphertext,
    });
    transports.device.send(frame(first));
    transports.device.send(frame(second));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(crypto.host.isClosed, false);
    assert.equal(transports.host.closed, false);
    connector.close();
  } finally {
    teardownRemoteHarness(context);
  }
});

test('upload final chunk and complete in the same tick stay ordered', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const crypto = await pairCrypto();
    const transports = MemoryDuplexTransport.pair();
    const opened: Array<{ type?: string; code?: string }> = [];
    transports.device.onMessage((raw) => {
      void (async () => {
        const frame = parseRelayFrame(raw);
        const plaintext = await crypto.device.open({
          ciphertext: frame.ciphertext,
          sequence: frame.transport_sequence,
          direction: 'host_to_device',
          routeId: frame.route_id,
          connectionId: crypto.device.connectionId,
        });
        opened.push(JSON.parse(new TextDecoder().decode(plaintext)) as { type?: string; code?: string });
      })();
    });
    const created = await context.tool.call({
      request_id: generateCanonicalId(),
      caller_id: 'test-caller',
      method: 'session.create',
      params: { workspace_id: context.workspaceId, task_id: context.taskId, agent_id: 'agent-claude-review' },
      idempotency_key: 'create-for-same-tick-upload',
    });
    const connector = new RemoteConnector(
      transports.host,
      crypto.host,
      new RemoteReplayBuffer(),
      async () => ({ ok: true }),
      device,
      undefined,
      undefined,
      { attachments: context.runtime.attachments, fileRefs: context.runtime.fileRefs },
    );
    const transferId = generateCanonicalId();
    const payload = Buffer.from('same-tick');
    const digest = createHash('sha256').update(payload).digest('hex');
    await sendDeviceFrame(transports.device, crypto.device, {
      type: 'attachment.begin',
      transfer_id: transferId,
      upload_id: transferId,
      session_id: (created.data as { session: { id: string } }).session.id,
      name: 'same-tick.bin',
      mime: 'application/octet-stream',
      size: payload.length,
      sha256: digest,
    });
    await waitUntil(() => opened.find((entry) => entry.type === 'transfer.ack') ?? null);
    const chunk = await crypto.device.seal(new TextEncoder().encode(JSON.stringify({
      type: 'attachment.chunk',
      transfer_id: transferId,
      transfer_sequence: 0,
      offset: 0,
      bytes: bytesToBase64Url(payload),
    })));
    const complete = await crypto.device.seal(new TextEncoder().encode(JSON.stringify({
      type: 'attachment.complete',
      transfer_id: transferId,
      upload_id: transferId,
    })));
    const wire = (sealed: typeof chunk, frameClass: 'control' | 'content') => ({
      protocol: 'gian.relay/1',
      frame_id: generateCanonicalId(),
      frame_class: frameClass,
      route_id: crypto.host.routeId,
      host_id: crypto.host.hostId,
      device_id: crypto.host.deviceId,
      connection_id: crypto.host.connectionId,
      transport_sequence: sealed.sequence,
      transport_ack: 0,
      sent_at: Date.now(),
      ciphertext: sealed.ciphertext,
    });
    transports.device.send(wire(chunk, 'content'));
    transports.device.send(wire(complete, 'control'));
    const result = await waitUntil(() => opened.find((entry) => entry.type === 'attachment.result') ?? null, 5_000);
    assert.equal(result.type, 'attachment.result');
    assert.equal(crypto.host.isClosed, false);
    connector.close();
  } finally {
    teardownRemoteHarness(context);
  }
});

test('command.request sealed in frame_class=content closes crypto and does not execute', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const crypto = await pairCrypto();
    const transports = MemoryDuplexTransport.pair();
    let commands = 0;
    const connector = new RemoteConnector(
      transports.host,
      crypto.host,
      new RemoteReplayBuffer(),
      async () => {
        commands += 1;
        return { ok: true };
      },
      device,
    );
    await sendDeviceFrame(
      transports.device,
      crypto.device,
      command('catalog.read', {}),
      'content',
    );
    await waitUntil(() => crypto.host.isClosed || transports.host.closed);
    assert.equal(commands, 0);
    assert.equal(crypto.host.isClosed, true);
    assert.equal(transports.host.closed, true);
    connector.close();
  } finally {
    teardownRemoteHarness(context);
  }
});

test('attachment.chunk sealed in frame_class=control closes crypto and does not write', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const crypto = await pairCrypto();
    const transports = MemoryDuplexTransport.pair();
    const opened: Array<{ type?: string }> = [];
    transports.device.onMessage((raw) => {
      void (async () => {
        const frame = parseRelayFrame(raw);
        const plaintext = await crypto.device.open({
          ciphertext: frame.ciphertext,
          sequence: frame.transport_sequence,
          direction: 'host_to_device',
          routeId: frame.route_id,
          connectionId: crypto.device.connectionId,
        });
        opened.push(JSON.parse(new TextDecoder().decode(plaintext)) as { type?: string });
      })();
    });
    const created = await context.tool.call({
      request_id: generateCanonicalId(),
      caller_id: 'test-caller',
      method: 'session.create',
      params: { workspace_id: context.workspaceId, task_id: context.taskId, agent_id: 'agent-claude-review' },
      idempotency_key: 'create-for-mismatched-chunk',
    });
    const connector = new RemoteConnector(
      transports.host,
      crypto.host,
      new RemoteReplayBuffer(),
      async () => ({ ok: true }),
      device,
      undefined,
      undefined,
      { attachments: context.runtime.attachments, fileRefs: context.runtime.fileRefs },
    );
    const transferId = generateCanonicalId();
    const payload = Buffer.from('mismatch-chunk');
    const digest = createHash('sha256').update(payload).digest('hex');
    await sendDeviceFrame(transports.device, crypto.device, {
      type: 'attachment.begin',
      transfer_id: transferId,
      upload_id: transferId,
      session_id: (created.data as { session: { id: string } }).session.id,
      name: 'mismatch.bin',
      mime: 'application/octet-stream',
      size: payload.length,
      sha256: digest,
    });
    await waitUntil(() => opened.find((entry) => entry.type === 'transfer.ack') ?? null);
    const before = context.runtime.attachments.getByTransferId(device.id, transferId);
    assert.equal(before?.received ?? 0, 0);
    await sendDeviceFrame(transports.device, crypto.device, {
      type: 'attachment.chunk',
      transfer_id: transferId,
      transfer_sequence: 0,
      offset: 0,
      bytes: bytesToBase64Url(payload),
    }, 'control');
    await waitUntil(() => crypto.host.isClosed || transports.host.closed);
    assert.equal(crypto.host.isClosed, true);
    assert.equal(transports.host.closed, true);
    assert.equal(context.runtime.attachments.getByTransferId(device.id, transferId)?.received ?? 0, 0);
    assert.equal(opened.some((entry) => entry.type === 'attachment.result'), false);
    connector.close();
  } finally {
    teardownRemoteHarness(context);
  }
});

test('upload begin failure sends transfer.error with transfer_id and keeps crypto open', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const crypto = await pairCrypto();
    const transports = MemoryDuplexTransport.pair();
    const opened: Array<{ type?: string; code?: string; transfer_id?: string }> = [];
    transports.device.onMessage((raw) => {
      void (async () => {
        const frame = parseRelayFrame(raw);
        const plaintext = await crypto.device.open({
          ciphertext: frame.ciphertext,
          sequence: frame.transport_sequence,
          direction: 'host_to_device',
          routeId: frame.route_id,
          connectionId: crypto.device.connectionId,
        });
        opened.push(JSON.parse(new TextDecoder().decode(plaintext)) as {
          type?: string;
          code?: string;
          transfer_id?: string;
        });
      })();
    });
    const connector = new RemoteConnector(
      transports.host,
      crypto.host,
      new RemoteReplayBuffer(),
      async () => ({ ok: true }),
      device,
    );
    const transferId = generateCanonicalId();
    await sendDeviceFrame(transports.device, crypto.device, {
      type: 'attachment.begin',
      transfer_id: transferId,
      upload_id: transferId,
      session_id: generateCanonicalId(),
      name: 'denied.bin',
      mime: 'application/octet-stream',
      size: 4,
      sha256: 'a'.repeat(64),
    });
    const error = await waitUntil(() => opened.find((entry) => entry.type === 'transfer.error') ?? null);
    assert.equal(error.transfer_id, transferId);
    assert.equal(error.code, 'REMOTE_CAPABILITY_DENIED');
    assert.equal(crypto.host.isClosed, false);
    connector.close();
  } finally {
    teardownRemoteHarness(context);
  }
});

test('upload begin acks persisted received bytes so a transfer can resume', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const crypto = await pairCrypto();
    const transports = MemoryDuplexTransport.pair();
    const opened: Array<{ type?: string; contiguous_offset?: number }> = [];
    transports.device.onMessage((raw) => {
      void (async () => {
        const frame = parseRelayFrame(raw);
        const plaintext = await crypto.device.open({
          ciphertext: frame.ciphertext,
          sequence: frame.transport_sequence,
          direction: 'host_to_device',
          routeId: frame.route_id,
          connectionId: crypto.device.connectionId,
        });
        opened.push(JSON.parse(new TextDecoder().decode(plaintext)) as {
          type?: string;
          contiguous_offset?: number;
        });
      })();
    });
    const created = await context.tool.call({
      request_id: generateCanonicalId(),
      caller_id: 'test-caller',
      method: 'session.create',
      params: { workspace_id: context.workspaceId, task_id: context.taskId, agent_id: 'agent-claude-review' },
      idempotency_key: 'create-for-resume-ack',
    });
    const sessionId = (created.data as { session: { id: string } }).session.id;
    const payload = Buffer.from('resume-offset-bytes');
    const digest = createHash('sha256').update(payload).digest('hex');
    const transferId = generateCanonicalId();
    const first = await context.runtime.attachments.begin({
      deviceId: device.id,
      sessionId,
      name: 'resume.bin',
      mime: 'application/octet-stream',
      size: payload.length,
      sha256: digest,
      uploadId: transferId,
      transferId,
    });
    await context.runtime.attachments.writeChunk({
      deviceId: device.id,
      uploadId: first.id,
      offset: 0,
      bytes: payload.subarray(0, 6),
    });
    const connector = new RemoteConnector(
      transports.host,
      crypto.host,
      new RemoteReplayBuffer(),
      async () => ({ ok: true }),
      device,
      undefined,
      undefined,
      { attachments: context.runtime.attachments, fileRefs: context.runtime.fileRefs },
    );
    await sendDeviceFrame(transports.device, crypto.device, {
      type: 'attachment.begin',
      transfer_id: transferId,
      upload_id: transferId,
      session_id: sessionId,
      name: 'resume.bin',
      mime: 'application/octet-stream',
      size: payload.length,
      sha256: digest,
    });
    const ack = await waitUntil(() => opened.find((entry) => entry.type === 'transfer.ack') ?? null);
    assert.equal(ack.contiguous_offset, 6);
    connector.close();
  } finally {
    teardownRemoteHarness(context);
  }
});

test('connector resume falls back to snapshot when the control replay gap was evicted', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const crypto = await pairCrypto();
    const transports = MemoryDuplexTransport.pair();
    const replay = new RemoteReplayBuffer(1, 64);
    replay.push({ type: 'host.offline', host_generation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } as never);
    replay.push({ type: 'host.online', host_generation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } as never);
    const seen: unknown[] = [];
    transports.device.onMessage(frame => seen.push(frame));
    const connector = new RemoteConnector(
      transports.host,
      crypto.host,
      replay,
      async (_record, command: CommandRequest) => command,
      device,
    );
    const sealed = await crypto.device.seal(new TextEncoder().encode(JSON.stringify({
      type: 'resume.request',
      after_event_sequence: -1,
      current_revision: 'missing',
    })));
    transports.device.send({
      protocol: 'gian.relay/1',
      frame_id: generateCanonicalId(),
      frame_class: 'control',
      route_id: crypto.host.routeId,
      host_id: crypto.host.hostId,
      device_id: crypto.host.deviceId,
      connection_id: crypto.host.connectionId,
      transport_sequence: sealed.sequence,
      transport_ack: 0,
      sent_at: Date.now(),
      ciphertext: sealed.ciphertext,
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    connector.close();
    assert.ok(seen.length >= 0);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('production runtime start performs signed login and binds outbound WSS', async () => {
  const context = setupRemoteHarness();
  const { handle, fetch } = await makeRemoteTestApp();
  const listened = await listenRemoteApp(handle);
  try {
    const identity = await context.identity.ensurePublic();
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
        host_name: 'Office Mac',
        host_version: '0.5.3',
        host_public_key: identity.public_key,
      }),
    })).json() as {
      host_id: string;
      connector_refresh_secret: string;
      server_identity: { public_key: { kty: 'EC'; crv: 'P-256'; x: string; y: string }; fingerprint: string };
    };
    await context.runtime.enrollment.recordClaim({
      hostId: claimed.host_id,
      serverUrl: listened.url,
      serverIdentity: claimed.server_identity,
      hostName: 'Office Mac',
      refreshSecret: claimed.connector_refresh_secret,
    });
    await context.runtime.start();
    assert.equal(context.runtime.relaySocket?.bound, true);
  } finally {
    context.runtime.close();
    listened.close();
    teardownRemoteHarness(context);
  }
});

test('Host createPairingGrant is claimed on Server and confirm writes the same device id', async () => {
  const context = setupRemoteHarness();
  const enrolled = await enrollAndStart(context);
  try {
    const grant = await context.runtime.createPairingGrant();
    const publicKey = {
      kty: 'EC' as const,
      crv: 'P-256' as const,
      x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    };
    const claimed = await enrolled.fetch('/api/v1/pairings/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: AUTH_PROTOCOL,
        browser_installation_id: generateCanonicalId(),
        device_public_key: publicKey,
        platform: 'iOS',
        user_agent: 'Phone',
        code: grant.code,
      }),
    });
    const claimBody = await claimed.json() as { pairing_id?: string; crypto_connection_id?: string; error?: { code?: string } };
    assert.equal(claimed.status, 200, JSON.stringify(claimBody));
    assert.ok(claimBody.pairing_id);
    const local = await waitUntil(() => {
      const row = context.runtime.pairings.get(grant.pairing_id);
      return row?.status === 'pending_confirmation' && row.devicePublicKey && row.serverPairingId
        ? row
        : null;
    });
    assert.equal(local.serverPairingId, claimBody.pairing_id);
    const confirmed = await context.runtime.confirmPairing(grant.pairing_id, 'confirm');
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.device_id, claimBody.pairing_id);
    const device = context.runtime.devices.get(claimBody.pairing_id);
    assert.ok(device);
    assert.equal(device?.cryptoConnectionId, claimBody.crypto_connection_id);
  } finally {
    context.runtime.close();
    enrolled.listened.close();
    teardownRemoteHarness(context);
  }
});

test('Host confirm survives a Server grant expiry that is already behind Host wall clock', () => {
  const context = setupRemoteHarness();
  try {
    const grantId = generateCanonicalId();
    const pairing = context.runtime.pairings.recordServerGrant({
      grantId,
      code: 'ABCD-EFGH',
      grantNonce: generateCanonicalId(),
      expiresAt: Date.UTC(2020, 0, 1),
    });
    assert.ok(Date.parse(pairing.expiresAt) > Date.now());
    context.runtime.pairings.applyServerClaim({
      grantId,
      pairingId: generateCanonicalId(),
      publicKey: {
        kty: 'EC',
        crv: 'P-256',
        x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
      name: 'Phone',
      platform: 'iOS',
    });
    const confirmed = context.runtime.pairings.confirm(pairing.id);
    assert.equal(confirmed.status, 'confirmed');
    assert.ok(confirmed.deviceId);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('Host relay heartbeat keeps presence online without connectDevice', async () => {
  const context = setupRemoteHarness();
  const enrolled = await enrollAndStart(context);
  try {
    assert.equal(enrolled.handle.services.presence.isOnline(enrolled.hostId), true);
    enrolled.clock.tick(PRESENCE_LEASE_MS + 1);
    assert.equal(enrolled.handle.services.presence.isOnline(enrolled.hostId), false);
    await context.runtime.maintainPresence();
    assert.equal(enrolled.handle.services.presence.isOnline(enrolled.hostId), true);
  } finally {
    context.runtime.close();
    enrolled.listened.close();
    teardownRemoteHarness(context);
  }
});

test('outgoing Host frames ACK the highest contiguous inbound sequence', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const crypto = await pairCrypto();
    const transports = MemoryDuplexTransport.pair();
    const seen: unknown[] = [];
    transports.device.onMessage((frame) => seen.push(frame));
    const connector = new RemoteConnector(
      transports.host,
      crypto.host,
      new RemoteReplayBuffer(),
      async (_device, _command, hooks) => {
        await hooks?.onAccepted?.();
        return { ok: true, data: { pong: true } };
      },
      device,
    );
    await sendDeviceFrame(transports.device, crypto.device, command('catalog.read', {}));
    await waitUntil(() => seen.length >= 2);
    const first = await openHostFrames(crypto.device, seen.splice(0, seen.length));
    assert.equal(first[0]?.frame.transport_ack, 0);
    await sendDeviceFrame(transports.device, crypto.device, command('state.refresh', {}));
    await waitUntil(() => seen.length >= 2);
    const second = await openHostFrames(crypto.device, seen);
    const accepted = second.find((entry) => entry.message.type === 'command.accepted');
    assert.ok(accepted, `second wave: ${second.map((entry) => entry.message.type).join(',')}`);
    assert.equal(accepted.frame.transport_ack, 1);
    connector.close();
  } finally {
    teardownRemoteHarness(context);
  }
});

test('command.accepted is emitted before domain execution and result terminates separately', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const crypto = await pairCrypto();
    const transports = MemoryDuplexTransport.pair();
    const seen: unknown[] = [];
    const order: string[] = [];
    transports.device.onMessage((frame) => seen.push(frame));
    const original = context.access.call.bind(context.access);
    context.access.call = (async (...args: Parameters<typeof original>) => {
      order.push('domain');
      return original(...args);
    }) as typeof context.access.call;
    const connector = new RemoteConnector(
      transports.host,
      crypto.host,
      new RemoteReplayBuffer(),
      async (record, next, hooks) => {
        order.push('adapter');
        return context.runtime.commands.execute(record, next, {
          onAccepted: async () => {
            order.push('accepted');
            assert.equal(order.includes('domain'), false);
            await hooks?.onAccepted?.();
          },
        });
      },
      device,
    );
    await sendDeviceFrame(transports.device, crypto.device, command('catalog.read', {}));
    await waitUntil(() => seen.length >= 2);
    const opened = await openHostFrames(crypto.device, seen);
    assert.deepEqual(opened.map((entry) => entry.message.type), ['command.accepted', 'command.result']);
    assert.ok(order.indexOf('accepted') < order.indexOf('domain'));
    connector.close();
  } finally {
    teardownRemoteHarness(context);
  }
});

test('1MiB download is sent as closed attachment.chunk content frames', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const crypto = await pairCrypto();
    const transports = MemoryDuplexTransport.pair();
    const transferId = generateCanonicalId();
    const opened: Array<{ frame: RelayFrame; message: { type?: string; transfer_id?: string; offset?: number } }> = [];
    let inbound = Promise.resolve();
    transports.device.onMessage((raw) => {
      inbound = inbound.then(async () => {
        const frame = parseRelayFrame(raw);
        const plaintext = await crypto.device.open({
          ciphertext: frame.ciphertext,
          sequence: frame.transport_sequence,
          direction: 'host_to_device',
          routeId: frame.route_id,
          connectionId: crypto.device.connectionId,
        });
        opened.push({
          frame,
          message: JSON.parse(new TextDecoder().decode(plaintext)) as { type?: string; transfer_id?: string; offset?: number },
        });
        const sealed = await crypto.device.seal(new TextEncoder().encode(JSON.stringify({
          type: 'transfer.ack',
          transfer_id: transferId,
          contiguous_offset: (opened.at(-1)?.message.offset ?? 0) + MAX_CONTENT_CHUNK_PLAINTEXT_BYTES,
          window_chunks: CONTENT_WINDOW_CHUNKS,
        })));
        transports.device.send({
          protocol: 'gian.relay/1',
          frame_id: generateCanonicalId(),
          frame_class: 'control',
          route_id: crypto.device.routeId,
          host_id: crypto.device.hostId,
          device_id: crypto.device.deviceId,
          connection_id: crypto.device.connectionId,
          transport_sequence: sealed.sequence,
          transport_ack: frame.transport_sequence,
          sent_at: Date.now(),
          ciphertext: sealed.ciphertext,
        });
      });
    });
    const created = await context.tool.call({
      request_id: generateCanonicalId(),
      caller_id: 'test-caller',
      method: 'session.create',
      params: { workspace_id: context.workspaceId, task_id: context.taskId, agent_id: 'agent-claude-review' },
      idempotency_key: 'create-for-download',
    });
    const sessionId = (created.data as { session: { id: string } }).session.id;
    writeFileSync(join(context.dir, 'big.bin'), Buffer.alloc(1024 * 1024, 9));
    const issued = context.runtime.fileRefs.issue({
      deviceId: device.id,
      sessionId,
      relativePath: 'big.bin',
      contentRevision: '1',
    });
    const connector = new RemoteConnector(
      transports.host,
      crypto.host,
      new RemoteReplayBuffer(),
      async () => ({ ok: true }),
      device,
      undefined,
      undefined,
      { attachments: context.runtime.attachments, fileRefs: context.runtime.fileRefs },
    );
    await sendDeviceFrame(transports.device, crypto.device, {
      type: 'download.request',
      transfer_id: transferId,
      kind: 'file',
      handle_id: issued.id,
    });
    await waitUntil(() => opened.some((entry) => entry.message.type === 'download.complete'), 8_000);
    const chunks = opened.filter((entry) => entry.message.type === 'attachment.chunk');
    assert.ok(chunks.length >= 2, `expected chunked download, got ${opened.map((entry) => entry.message.type).join(',')}`);
    for (const chunk of chunks) {
      assert.equal(chunk.frame.frame_class, 'content');
      assert.ok(JSON.stringify(chunk.message).length <= MAX_CONTENT_CHUNK_PLAINTEXT_BYTES);
      assert.equal(chunk.message.transfer_id, transferId);
      assert.equal(typeof chunk.message.offset, 'number');
    }
    await inbound;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const transferState = connector as unknown as {
      activeDownloadTransfers: Set<string>;
      transferAckOffset: Map<string, number>;
    };
    assert.equal(transferState.activeDownloadTransfers.size, 0);
    assert.equal(transferState.transferAckOffset.size, 0);
    connector.close();
  } finally {
    teardownRemoteHarness(context);
  }
});

test('attachment download resumes from offset with transfer window ACKs', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const crypto = await pairCrypto();
    const transports = MemoryDuplexTransport.pair();
    const transferId = generateCanonicalId();
    const opened: Array<{ message: { type?: string; transfer_id?: string; offset?: number } }> = [];
    let inbound = Promise.resolve();
    transports.device.onMessage((raw) => {
      inbound = inbound.then(async () => {
        const frame = parseRelayFrame(raw);
        const plaintext = await crypto.device.open({
          ciphertext: frame.ciphertext,
          sequence: frame.transport_sequence,
          direction: 'host_to_device',
          routeId: frame.route_id,
          connectionId: crypto.device.connectionId,
        });
        const message = JSON.parse(new TextDecoder().decode(plaintext)) as {
          type?: string;
          transfer_id?: string;
          offset?: number;
        };
        opened.push({ message });
        const sealed = await crypto.device.seal(new TextEncoder().encode(JSON.stringify({
          type: 'transfer.ack',
          transfer_id: transferId,
          contiguous_offset: (message.offset ?? 0) + MAX_CONTENT_CHUNK_PLAINTEXT_BYTES,
          window_chunks: CONTENT_WINDOW_CHUNKS,
        })));
        transports.device.send({
          protocol: 'gian.relay/1',
          frame_id: generateCanonicalId(),
          frame_class: 'control',
          route_id: crypto.device.routeId,
          host_id: crypto.device.hostId,
          device_id: crypto.device.deviceId,
          connection_id: crypto.device.connectionId,
          transport_sequence: sealed.sequence,
          transport_ack: frame.transport_sequence,
          sent_at: Date.now(),
          ciphertext: sealed.ciphertext,
        });
      });
    });
    const created = await context.tool.call({
      request_id: generateCanonicalId(),
      caller_id: 'test-caller',
      method: 'session.create',
      params: { workspace_id: context.workspaceId, task_id: context.taskId, agent_id: 'agent-claude-review' },
      idempotency_key: 'create-for-attachment-download',
    });
    const sessionId = (created.data as { session: { id: string } }).session.id;
    const payload = Buffer.alloc(64 * 1024, 3);
    const digest = createHash('sha256').update(payload).digest('hex');
    const intent = await context.runtime.attachments.begin({
      deviceId: device.id,
      sessionId,
      name: 'shot.bin',
      mime: 'application/octet-stream',
      size: payload.length,
      sha256: digest,
    });
    await context.runtime.attachments.writeChunk({
      deviceId: device.id,
      uploadId: intent.id,
      offset: 0,
      bytes: payload,
    });
    await context.runtime.attachments.complete({ deviceId: device.id, uploadId: intent.id });
    const connector = new RemoteConnector(
      transports.host,
      crypto.host,
      new RemoteReplayBuffer(),
      async () => ({ ok: true }),
      device,
      undefined,
      undefined,
      { attachments: context.runtime.attachments, fileRefs: context.runtime.fileRefs },
    );
    await sendDeviceFrame(transports.device, crypto.device, {
      type: 'download.request',
      transfer_id: transferId,
      kind: 'attachment',
      handle_id: intent.id,
      offset: 1024,
    });
    await waitUntil(() => opened.some((entry) => entry.message.type === 'download.complete'), 8_000);
    const chunks = opened.filter((entry) => entry.message.type === 'attachment.chunk');
    assert.ok(chunks.length >= 1);
    assert.equal(chunks[0]?.message.offset, 1024);
    assert.equal(chunks[0]?.message.transfer_id, transferId);
    const metadata = opened.find((entry) => entry.message.type === 'download.metadata') as {
      message: { size?: number; sha256?: string };
    } | undefined;
    const complete = opened.find((entry) => entry.message.type === 'download.complete') as {
      message: { size?: number; sha256?: string };
    } | undefined;
    assert.equal(metadata?.message.size, payload.length);
    assert.equal(complete?.message.size, payload.length);
    assert.equal(metadata?.message.sha256, digest);
    assert.equal(complete?.message.sha256, digest);
    connector.close();
  } finally {
    teardownRemoteHarness(context);
  }
});

test('Host and Device decrypt through Server with different socket connection ids', async () => {
  const context = setupRemoteHarness();
  const enrolled = await enrollAndStart(context);
  try {
    const grant = await context.runtime.createPairingGrant();
    const browserId = generateCanonicalId();
    const signing = await generateP256SigningKeyPair();
    const devicePublic = await exportPublicJwk(signing.publicKey);
    const claimed = await (await enrolled.fetch('/api/v1/pairings/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: AUTH_PROTOCOL,
        browser_installation_id: browserId,
        device_public_key: devicePublic,
        platform: 'macOS',
        user_agent: 'CryptoBrowser',
        code: grant.code,
      }),
    })).json() as { pairing_id: string; crypto_connection_id: string };
    await waitUntil(() => {
      const row = context.runtime.pairings.get(grant.pairing_id);
      return row?.status === 'pending_confirmation' && row.devicePublicKey && row.serverPairingId
        ? row
        : null;
    });
    const confirmed = await context.runtime.confirmPairing(grant.pairing_id, 'confirm');
    const device = context.runtime.devices.get(confirmed.device_id!);
    assert.ok(device);

    const challenge = await (await enrolled.fetch('/api/v1/sessions/device-challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: AUTH_PROTOCOL,
        browser_installation_id: browserId,
        host_id: enrolled.hostId,
      }),
    })).json() as { challenge_id: string };
    const login = await enrolled.fetch('/api/v1/sessions/device-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: AUTH_PROTOCOL,
        browser_installation_id: browserId,
        host_id: enrolled.hostId,
        challenge_id: challenge.challenge_id,
        signature: await signChallenge(signing.privateKey, challenge.challenge_id),
      }),
    });
    const loginBody = await login.text();
    assert.equal(login.status, 200, loginBody);
    const access = JSON.parse(loginBody) as {
      access_token: string;
      host_public_key: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
      crypto_connection_id: string;
    };
    assert.ok(access.host_public_key);
    const ticket = await (await enrolled.fetch('/api/v1/ws-tickets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL, host_id: enrolled.hostId }),
    })).json() as { ticket: string };
    const opened: Array<{ type?: string }> = [];
    let deviceCrypto: PeerCryptoSession | null = null;
    let acceptRaw: unknown;
    const pending: unknown[] = [];
    let inbound = Promise.resolve();
    const ws = new WebSocket(enrolled.listened.wsUrl);
    const bound = await new Promise<{ connection_id: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('device ws bind timeout')), 5_000);
      ws.addEventListener('error', reject);
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ protocol: 'gian.relay/1', type: 'ws.auth', ticket: ticket.ticket }));
      });
      ws.addEventListener('message', (event) => {
        const parsed = JSON.parse(String(event.data)) as { type?: string; connection_id?: string };
        if (parsed.type === 'ws.bound') {
          clearTimeout(timer);
          resolve({ connection_id: String(parsed.connection_id) });
          return;
        }
        if (parsed.type === 'crypto.accept') {
          acceptRaw = parsed;
          return;
        }
        if (parsed && typeof parsed === 'object' && 'ciphertext' in parsed) {
          const consume = async (raw: unknown) => {
            if (!deviceCrypto) {
              pending.push(raw);
              return;
            }
            const frame = parseRelayFrame(raw);
            const plaintext = await deviceCrypto.open({
              ciphertext: frame.ciphertext,
              sequence: frame.transport_sequence,
              direction: 'host_to_device',
              routeId: frame.route_id,
              connectionId: deviceCrypto.connectionId,
            });
            opened.push(JSON.parse(new TextDecoder().decode(plaintext)) as { type?: string });
          };
          inbound = inbound.then(async () => {
            await consume(parsed);
            while (pending.length && deviceCrypto) {
              await consume(pending.shift());
            }
          });
        }
      });
    });
    assert.notEqual(bound.connection_id, context.runtime.relaySocket?.connectionId);
    assert.notEqual(bound.connection_id, claimed.crypto_connection_id);
    const ephemeral = await generateP256KeyPair();
    const deviceEphemeral = await exportPublicJwk(ephemeral.publicKey);
    const offerSentAt = Date.now();
    const offerFields = {
      host_id: enrolled.hostId,
      device_id: device.id,
      crypto_connection_id: access.crypto_connection_id,
      handshake_nonce: generateCanonicalId(),
      sent_at: offerSentAt,
      device_identity: devicePublic,
      device_ephemeral: deviceEphemeral,
    };
    ws.send(JSON.stringify({
      protocol: 'gian.relay/1',
      type: 'crypto.offer',
      ...offerFields,
      signature: await signBytes(signing.privateKey, new TextEncoder().encode(cryptoOfferPayload(offerFields))),
    }));
    const accept = parseRelayHandshake(await waitUntil(() => acceptRaw ?? null, 8_000)) as {
      type: 'crypto.accept';
      handshake_nonce: string;
      sent_at: number;
      host_generation: string;
      host_identity: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
      host_ephemeral: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
      device_ephemeral: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
      signature: string;
    };
    const hostKey = await importP256PublicKey(access.host_public_key, 'verify');
    assert.equal(await verifyBytes(
      hostKey,
      new TextEncoder().encode(cryptoAcceptPayload({
        host_id: enrolled.hostId,
        device_id: device.id,
        crypto_connection_id: access.crypto_connection_id,
        handshake_nonce: accept.handshake_nonce,
        sent_at: accept.sent_at,
        host_generation: accept.host_generation,
        host_identity: accept.host_identity,
        device_identity: devicePublic,
        host_ephemeral: accept.host_ephemeral,
        device_ephemeral: accept.device_ephemeral,
      })),
      Buffer.from(accept.signature, 'base64url'),
    ), true);
    deviceCrypto = await PeerCryptoSession.fromHandshake({
      localPrivate: ephemeral.privateKey,
      remotePublic: await importP256PublicKey(accept.host_ephemeral, 'deriveBits'),
      transcript: {
        host_identity: accept.host_identity,
        device_identity: devicePublic,
        host_ephemeral: accept.host_ephemeral,
        device_ephemeral: deviceEphemeral,
        connection_id: access.crypto_connection_id,
      },
      sendDirection: 'device_to_host',
      binding: {
        hostGeneration: accept.host_generation,
        hostId: enrolled.hostId,
        deviceId: device.id,
        routeId: device.id,
        connectionId: access.crypto_connection_id,
      },
    });
    inbound = inbound.then(async () => {
      while (pending.length && deviceCrypto) {
        const raw = pending.shift();
        const frame = parseRelayFrame(raw);
        const plaintext = await deviceCrypto.open({
          ciphertext: frame.ciphertext,
          sequence: frame.transport_sequence,
          direction: 'host_to_device',
          routeId: frame.route_id,
          connectionId: deviceCrypto.connectionId,
        });
        opened.push(JSON.parse(new TextDecoder().decode(plaintext)) as { type?: string });
      }
    });
    await waitUntil(() => context.runtime.connectorFor(device.id) ?? null, 8_000);
    const sealed = await deviceCrypto.seal(new TextEncoder().encode(JSON.stringify(command('catalog.read', {}))));
    ws.send(JSON.stringify({
      protocol: 'gian.relay/1',
      frame_id: generateCanonicalId(),
      frame_class: 'control',
      route_id: device.id,
      host_id: enrolled.hostId,
      device_id: device.id,
      connection_id: bound.connection_id,
      transport_sequence: sealed.sequence,
      transport_ack: deviceCrypto.inboundAck,
      sent_at: Date.now(),
      ciphertext: sealed.ciphertext,
    }));
    const result = await waitUntil(() => opened.find((message) => message.type === 'command.result') ?? null, 5_000);
    assert.equal(result.type, 'command.result');
    await context.runtime.connectorFor(device.id)!.sendControl({
      type: 'snapshot.required',
      reason: 'gap_evicted',
    });
    const down = await waitUntil(() => opened.find((message) => message.type === 'snapshot.required') ?? null, 5_000);
    assert.equal(down.type, 'snapshot.required');
    ws.close();
  } finally {
    context.runtime.close();
    enrolled.listened.close();
    teardownRemoteHarness(context);
  }
});

test('Host relay reconnects after socket close without connectDevice', async () => {
  const context = setupRemoteHarness();
  const enrolled = await enrollAndStart(context);
  try {
    const before = context.runtime.relaySocket?.connectionId;
    assert.ok(before);
    context.runtime.relaySocket?.close('test_drop');
    const after = await waitUntil(() => {
      const socket = context.runtime.relaySocket;
      return socket?.bound && socket.connectionId && socket.connectionId !== before
        ? socket.connectionId
        : null;
    }, 8_000);
    assert.notEqual(after, before);
    assert.equal(enrolled.handle.services.presence.isOnline(enrolled.hostId), true);
  } finally {
    context.runtime.close();
    enrolled.listened.close();
    teardownRemoteHarness(context);
  }
});

test('Host HTTP pairings create a Server grant and confirm writes the Host device', async () => {
  const hostApp = await makeTestApp();
  const { handle, fetch } = await makeRemoteTestApp();
  const listened = await listenRemoteApp(handle);
  try {
    const identity = await hostApp.remoteIdentity.ensurePublic();
    const created = await (await fetch('/api/v1/admin/host-enrollments', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
    })).json() as { enrollment_token: string };
    const claimedHost = await (await fetch('/api/v1/host-enrollments/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: AUTH_PROTOCOL,
        enrollment_token: created.enrollment_token,
        host_name: 'Office Mac',
        host_version: '0.5.3',
        host_public_key: identity.public_key,
      }),
    })).json() as {
      host_id: string;
      connector_refresh_secret: string;
      server_identity: { public_key: { kty: 'EC'; crv: 'P-256'; x: string; y: string }; fingerprint: string };
    };
    await hostApp.app.remote.enrollment.recordClaim({
      hostId: claimedHost.host_id,
      serverUrl: listened.url,
      serverIdentity: claimedHost.server_identity,
      hostName: 'Office Mac',
      refreshSecret: claimedHost.connector_refresh_secret,
    });
    await hostApp.app.remote.start();

    const grantResponse = await hostApp.fetch('/api/remote/pairings', { method: 'POST' });
    const grant = await grantResponse.json() as { pairing_id: string; code: string };
    assert.equal(grantResponse.status, 200, JSON.stringify(grant));
    assert.ok(grant.pairing_id);
    assert.ok(grant.code);

    const signing = await generateP256SigningKeyPair();
    const devicePublic = await exportPublicJwk(signing.publicKey);
    const claimed = await fetch('/api/v1/pairings/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: AUTH_PROTOCOL,
        browser_installation_id: generateCanonicalId(),
        device_public_key: devicePublic,
        platform: 'iOS',
        user_agent: 'Phone',
        code: grant.code,
      }),
    });
    const claimBody = await claimed.json() as { pairing_id?: string; crypto_connection_id?: string };
    assert.equal(claimed.status, 200, JSON.stringify(claimBody));

    await waitUntil(() => {
      const row = hostApp.app.remote.pairings.get(grant.pairing_id);
      return row?.status === 'pending_confirmation' && row.serverPairingId ? row : null;
    });

    const confirmResponse = await hostApp.fetch(`/api/remote/pairings/${grant.pairing_id}/confirm`, {
      method: 'POST',
    });
    const confirmed = await confirmResponse.json() as { status?: string; device_id?: string };
    assert.equal(confirmResponse.status, 200, JSON.stringify(confirmed));
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.device_id, claimBody.pairing_id);
    const device = hostApp.app.remote.devices.get(claimBody.pairing_id!);
    assert.ok(device);
    assert.equal(device?.cryptoConnectionId, claimBody.crypto_connection_id);
  } finally {
    hostApp.app.remote.close();
    listened.close();
    await hostApp.cleanup();
  }
});

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on('error', reject);
  });
}

test('oversize upload chunks fail closed on the production receive path', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const crypto = await pairCrypto();
    const transports = MemoryDuplexTransport.pair();
    const opened: Array<{ type?: string; code?: string; transfer_id?: string }> = [];
    transports.device.onMessage((raw) => {
      void (async () => {
        const frame = parseRelayFrame(raw);
        const plaintext = await crypto.device.open({
          ciphertext: frame.ciphertext,
          sequence: frame.transport_sequence,
          direction: 'host_to_device',
          routeId: frame.route_id,
          connectionId: crypto.device.connectionId,
        });
        opened.push(JSON.parse(new TextDecoder().decode(plaintext)) as { type?: string; code?: string });
      })();
    });
    const created = await context.tool.call({
      request_id: generateCanonicalId(),
      caller_id: 'test-caller',
      method: 'session.create',
      params: { workspace_id: context.workspaceId, task_id: context.taskId, agent_id: 'agent-claude-review' },
      idempotency_key: 'create-for-oversize-upload',
    });
    const connector = new RemoteConnector(
      transports.host,
      crypto.host,
      new RemoteReplayBuffer(),
      async () => ({ ok: true }),
      device,
      undefined,
      undefined,
      { attachments: context.runtime.attachments, fileRefs: context.runtime.fileRefs },
    );
    const transferId = generateCanonicalId();
    const uploadId = generateCanonicalId();
    await sendDeviceFrame(transports.device, crypto.device, {
      type: 'attachment.begin',
      transfer_id: transferId,
      upload_id: uploadId,
      session_id: (created.data as { session: { id: string } }).session.id,
      name: 'huge.bin',
      mime: 'application/octet-stream',
      size: MAX_CONTENT_CHUNK_PLAINTEXT_BYTES + 8,
      sha256: 'e'.repeat(64),
    });
    await sendDeviceFrame(transports.device, crypto.device, {
      type: 'attachment.chunk',
      transfer_id: transferId,
      transfer_sequence: 0,
      offset: 0,
      bytes: bytesToBase64Url(Buffer.alloc(MAX_CONTENT_CHUNK_PLAINTEXT_BYTES + 1, 1)),
    }, 'content');
    const error = await waitUntil(() => opened.find((entry) => entry.type === 'transfer.error') ?? null, 5_000);
    assert.equal(error.type, 'transfer.error');
    assert.equal(error.code, 'FRAME_TOO_LARGE');
    assert.equal(error.transfer_id, transferId);
    connector.close();
  } finally {
    teardownRemoteHarness(context);
  }
});

test('connected device revoke stops the next command on the live Server+Host path', async () => {
  const context = setupRemoteHarness();
  const enrolled = await enrollAndStart(context);
  let session: Awaited<ReturnType<typeof openPairedDevice>> | undefined;
  try {
    session = await openPairedDevice(context, enrolled);
    await session.sendCatalog();
    await waitUntil(() => session.opened.find((entry) => entry.type === 'command.result') ?? null, 5_000);
    await context.runtime.revokeDevice(session.device.id);
    assert.ok(context.runtime.devices.get(session.device.id)?.revokedAt);
    assert.equal(context.runtime.connectorFor(session.device.id), undefined);
    const before = session.opened.filter((entry) => entry.type === 'command.result').length;
    await session.sendCatalog().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(session.opened.filter((entry) => entry.type === 'command.result').length, before);
  } finally {
    session?.ws.close();
    context.runtime.close();
    enrolled.listened.close();
    teardownRemoteHarness(context);
  }
});

test('offline self-revoke older than skew still revokes and ACKs on Host reconnect', async () => {
  const context = setupRemoteHarness();
  const enrolled = await enrollAndStart(context);
  try {
    const session = await openPairedDevice(context, enrolled);
    context.runtime.close();
    await waitUntil(() => (
      enrolled.handle.services.relay.hasHost(enrolled.hostId) ? null : true
    ), 5_000);
    const signedAt = enrolled.clock.now;
    const revoked = await enrolled.fetch(`/api/v1/hosts/${enrolled.hostId}/pairing`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${session.access.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        protocol: AUTH_PROTOCOL,
        host_id: enrolled.hostId,
        signed_at: signedAt,
        signature: await signBytes(
          session.signing.privateKey,
          new TextEncoder().encode(selfRevokePayload({
            hostId: enrolled.hostId,
            deviceId: session.device.id,
            signedAt,
          })),
        ),
      }),
    });
    const revokedBody = await revoked.json() as { status?: string; error?: { code?: string } };
    assert.equal(revoked.status, 200, JSON.stringify(revokedBody));
    assert.equal(revokedBody.status, 'tombstoned');
    context.clock.nowMs += AUTH_SIGNED_AT_SKEW_MS + 60_000;
    await context.runtime.start();
    await waitUntil(() => context.runtime.devices.get(session.device.id)?.revokedAt ?? null, 8_000);
    await waitUntil(() => (
      enrolled.handle.services.repos.pendingTombstones(enrolled.hostId).length === 0
        ? true
        : null
    ), 8_000);
    assert.ok(context.runtime.devices.get(session.device.id)?.revokedAt);
    assert.equal(context.runtime.connectorFor(session.device.id), undefined);
    session.ws.close();
  } finally {
    context.runtime.close();
    enrolled.listened.close();
    teardownRemoteHarness(context);
  }
});

test('unsigned device.revoked notices cannot permanently revoke a Host device', async () => {
  const context = setupRemoteHarness();
  const enrolled = await enrollAndStart(context);
  let session: Awaited<ReturnType<typeof openPairedDevice>> | undefined;
  try {
    session = await openPairedDevice(context, enrolled);
    enrolled.handle.services.relay.notifyHost(enrolled.hostId, {
      protocol: 'gian.relay/1',
      type: 'device.revoked',
      host_id: enrolled.hostId,
      device_id: session.device.id,
      sent_at: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(context.runtime.devices.get(session.device.id)?.revokedAt, null);
    assert.ok(context.runtime.connectorFor(session.device.id));
    await session.sendCatalog();
    const result = await waitUntil(
      () => session.opened.filter((entry) => entry.type === 'command.result').at(-1) ?? null,
      5_000,
    );
    assert.equal(result.type, 'command.result');
  } finally {
    session?.ws.close();
    context.runtime.close();
    enrolled.listened.close();
    teardownRemoteHarness(context);
  }
});

test('replayed crypto.offer does not replace the current Host connector', async () => {
  const context = setupRemoteHarness();
  const enrolled = await enrollAndStart(context);
  let session: Awaited<ReturnType<typeof openPairedDevice>> | undefined;
  try {
    session = await openPairedDevice(context, enrolled);
    const generation = context.runtime.connectorFor(session.device.id)?.generation;
    assert.ok(generation);
    session.ws.send(JSON.stringify(session.offerWire));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(context.runtime.connectorFor(session.device.id)?.generation, generation);
  } finally {
    session?.ws.close();
    context.runtime.close();
    enrolled.listened.close();
    teardownRemoteHarness(context);
  }
});

test('a new ephemeral after disconnect does not decrypt leftover outbox ciphertext', async () => {
  const context = setupRemoteHarness();
  const enrolled = await enrollAndStart(context);
  let session: Awaited<ReturnType<typeof openPairedDevice>> | undefined;
  let next: Awaited<ReturnType<typeof openPairedDevice>> | undefined;
  try {
    session = await openPairedDevice(context, enrolled);
    await session.sendCatalog();
    await waitUntil(() => session.opened.some((entry) => entry.type === 'command.result'), 5_000);
    session.ws.close();
    next = await openPairedDevice(context, enrolled, {
      reuse: session,
    });
    const snapshot = await waitUntil(
      () => next.opened.find((entry) => entry.type === 'snapshot.required') ?? null,
      8_000,
    );
    assert.equal(snapshot.type, 'snapshot.required');
    await next.sendCatalog();
    const result = await waitUntil(
      () => next.opened.find((entry) => entry.type === 'command.result') ?? null,
      5_000,
    );
    assert.equal(result.type, 'command.result');
  } finally {
    next?.ws.close();
    context.runtime.close();
    enrolled.listened.close();
    teardownRemoteHarness(context);
  }
});

test('a second device websocket replaces the previous crypto session', async () => {
  const context = setupRemoteHarness();
  const enrolled = await enrollAndStart(context);
  let first: Awaited<ReturnType<typeof openPairedDevice>> | undefined;
  let second: Awaited<ReturnType<typeof openPairedDevice>> | undefined;
  try {
    first = await openPairedDevice(context, enrolled);
    const firstGeneration = context.runtime.connectorFor(first.device.id)?.generation;
    second = await openPairedDevice(context, enrolled, { reuse: first });
    const secondGeneration = context.runtime.connectorFor(second.device.id)?.generation;
    assert.notEqual(secondGeneration, firstGeneration);
    await second.sendCatalog();
    const result = await waitUntil(
      () => second.opened.find((entry) => entry.type === 'command.result') ?? null,
      5_000,
    );
    assert.equal(result.type, 'command.result');
  } finally {
    first?.ws.close();
    second?.ws.close();
    context.runtime.close();
    enrolled.listened.close();
    teardownRemoteHarness(context);
  }
});

test('Host start before Server listen becomes online after Server starts', async () => {
  const context = setupRemoteHarness();
  const { handle, fetch } = await makeRemoteTestApp();
  const identity = await context.identity.ensurePublic();
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
      host_name: 'Office Mac',
      host_version: '0.5.3',
      host_public_key: identity.public_key,
    }),
  })).json() as {
    host_id: string;
    connector_refresh_secret: string;
    server_identity: { public_key: { kty: 'EC'; crv: 'P-256'; x: string; y: string }; fingerprint: string };
  };
  const port = await reservePort();
  await context.runtime.enrollment.recordClaim({
    hostId: claimed.host_id,
    serverUrl: `http://127.0.0.1:${port}`,
    serverIdentity: claimed.server_identity,
    hostName: 'Office Mac',
    refreshSecret: claimed.connector_refresh_secret,
  });
  await context.runtime.start();
  assert.equal(context.runtime.relaySocket?.bound ?? false, false);
  const listened = await listenRemoteApp(handle, port);
  try {
    await waitUntil(() => (context.runtime.relaySocket?.bound ? true : null), 8_000);
    assert.equal(handle.services.presence.isOnline(claimed.host_id), true);
  } finally {
    context.runtime.close();
    listened.close();
    teardownRemoteHarness(context);
  }
});

test('Host reconnect recovers after Server rotated a refresh secret the Host never received', async () => {
  const context = setupRemoteHarness();
  const enrolled = await enrollAndStart(context);
  try {
    const stale = await context.identity.getRefreshSecret();
    assert.ok(stale);
    const challenge = await (await enrolled.fetch('/api/v1/host/connector-challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL, host_id: enrolled.hostId }),
    })).json() as { challenge_id: string };
    const rotated = await enrolled.fetch('/api/v1/host/connector-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: AUTH_PROTOCOL,
        host_id: enrolled.hostId,
        challenge_id: challenge.challenge_id,
        signature: await context.identity.sign(new TextEncoder().encode(challenge.challenge_id)),
        refresh_secret: stale,
      }),
    });
    assert.equal(rotated.status, 200);
    const issued = (await rotated.json() as { refresh_secret: string }).refresh_secret;
    assert.notEqual(issued, stale);
    const before = context.runtime.relaySocket?.connectionId;
    context.runtime.relaySocket?.close('test_drop');
    await waitUntil(() => {
      const socket = context.runtime.relaySocket;
      return socket?.bound && socket.connectionId && socket.connectionId !== before
        ? socket.connectionId
        : null;
    }, 8_000);
    const recovered = await context.identity.getRefreshSecret();
    assert.ok(recovered);
    assert.notEqual(recovered, stale);
    assert.notEqual(recovered, issued);
    assert.equal(enrolled.handle.services.presence.isOnline(enrolled.hostId), true);
  } finally {
    context.runtime.close();
    enrolled.listened.close();
    teardownRemoteHarness(context);
  }
});

async function openPairedDevice(
  context: ReturnType<typeof setupRemoteHarness>,
  enrolled: Awaited<ReturnType<typeof enrollAndStart>>,
  options?: {
    reuse?: {
      device: { id: string };
      signing: CryptoKeyPair;
      devicePublic: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
      access: { access_token: string; crypto_connection_id: string; host_public_key: { kty: 'EC'; crv: 'P-256'; x: string; y: string } };
    };
  },
) {
  let device = options?.reuse?.device;
  let signing = options?.reuse?.signing;
  let devicePublic = options?.reuse?.devicePublic;
  let access = options?.reuse?.access;
  if (!device || !signing || !devicePublic || !access) {
    const grant = await context.runtime.createPairingGrant();
    const browserId = generateCanonicalId();
    signing = await generateP256SigningKeyPair();
    devicePublic = await exportPublicJwk(signing.publicKey);
    await enrolled.fetch('/api/v1/pairings/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: AUTH_PROTOCOL,
        browser_installation_id: browserId,
        device_public_key: devicePublic,
        platform: 'macOS',
        user_agent: 'CryptoBrowser',
        code: grant.code,
      }),
    });
    await waitUntil(() => {
      const row = context.runtime.pairings.get(grant.pairing_id);
      return row?.status === 'pending_confirmation' && row.devicePublicKey && row.serverPairingId
        ? row
        : null;
    });
    const confirmed = await context.runtime.confirmPairing(grant.pairing_id, 'confirm');
    device = context.runtime.devices.get(confirmed.device_id!)!;
    const challenge = await (await enrolled.fetch('/api/v1/sessions/device-challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: AUTH_PROTOCOL,
        browser_installation_id: browserId,
        host_id: enrolled.hostId,
      }),
    })).json() as { challenge_id: string };
    const login = await enrolled.fetch('/api/v1/sessions/device-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: AUTH_PROTOCOL,
        browser_installation_id: browserId,
        host_id: enrolled.hostId,
        challenge_id: challenge.challenge_id,
        signature: await signChallenge(signing.privateKey, challenge.challenge_id),
      }),
    });
    access = JSON.parse(await login.text()) as {
      access_token: string;
      host_public_key: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
      crypto_connection_id: string;
    };
  }
  const ticket = await (await enrolled.fetch('/api/v1/ws-tickets', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${access.access_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL, host_id: enrolled.hostId }),
  })).json() as { ticket: string };
  const opened: Array<{ type?: string; code?: string }> = [];
  let deviceCrypto: PeerCryptoSession | null = null;
  let acceptRaw: unknown;
  const pending: unknown[] = [];
  let inbound = Promise.resolve();
  const ws = new WebSocket(enrolled.listened.wsUrl);
  const bound = await new Promise<{ connection_id: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('device ws bind timeout')), 5_000);
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ protocol: 'gian.relay/1', type: 'ws.auth', ticket: ticket.ticket }));
    });
    ws.addEventListener('message', (event) => {
      const parsed = JSON.parse(String(event.data)) as { type?: string; connection_id?: string };
      if (parsed.type === 'ws.bound') {
        clearTimeout(timer);
        resolve({ connection_id: String(parsed.connection_id) });
        return;
      }
      if (parsed.type === 'crypto.accept') {
        acceptRaw = parsed;
        return;
      }
      if (parsed && typeof parsed === 'object' && 'ciphertext' in parsed) {
        const consume = async (raw: unknown) => {
          if (!deviceCrypto) {
            pending.push(raw);
            return;
          }
          const frame = parseRelayFrame(raw);
          const plaintext = await deviceCrypto.open({
            ciphertext: frame.ciphertext,
            sequence: frame.transport_sequence,
            direction: 'host_to_device',
            routeId: frame.route_id,
            connectionId: deviceCrypto.connectionId,
          });
          opened.push(JSON.parse(new TextDecoder().decode(plaintext)) as { type?: string; code?: string });
        };
        inbound = inbound.then(async () => {
          await consume(parsed);
          while (pending.length && deviceCrypto) {
            await consume(pending.shift());
          }
        });
      }
    });
  });
  const ephemeral = await generateP256KeyPair();
  const deviceEphemeral = await exportPublicJwk(ephemeral.publicKey);
  const offerFields = {
    host_id: enrolled.hostId,
    device_id: device.id,
    crypto_connection_id: access.crypto_connection_id,
    handshake_nonce: generateCanonicalId(),
    sent_at: Date.now(),
    device_identity: devicePublic,
    device_ephemeral: deviceEphemeral,
  };
  const offerWire = {
    protocol: 'gian.relay/1' as const,
    type: 'crypto.offer' as const,
    ...offerFields,
    signature: await signBytes(signing.privateKey, new TextEncoder().encode(cryptoOfferPayload(offerFields))),
  };
  ws.send(JSON.stringify(offerWire));
  const accept = parseRelayHandshake(await waitUntil(() => acceptRaw ?? null, 8_000)) as {
    type: 'crypto.accept';
    host_generation: string;
    host_identity: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
    host_ephemeral: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
    device_ephemeral: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  };
  deviceCrypto = await PeerCryptoSession.fromHandshake({
    localPrivate: ephemeral.privateKey,
    remotePublic: await importP256PublicKey(accept.host_ephemeral, 'deriveBits'),
    transcript: {
      host_identity: accept.host_identity,
      device_identity: devicePublic,
      host_ephemeral: accept.host_ephemeral,
      device_ephemeral: deviceEphemeral,
      connection_id: access.crypto_connection_id,
    },
    sendDirection: 'device_to_host',
    binding: {
      hostGeneration: accept.host_generation,
      hostId: enrolled.hostId,
      deviceId: device.id,
      routeId: device.id,
      connectionId: access.crypto_connection_id,
    },
  });
  inbound = inbound.then(async () => {
    while (pending.length && deviceCrypto) {
      const raw = pending.shift();
      const frame = parseRelayFrame(raw);
      const plaintext = await deviceCrypto.open({
        ciphertext: frame.ciphertext,
        sequence: frame.transport_sequence,
        direction: 'host_to_device',
        routeId: frame.route_id,
        connectionId: deviceCrypto.connectionId,
      });
      opened.push(JSON.parse(new TextDecoder().decode(plaintext)) as { type?: string; code?: string });
    }
  });
  await waitUntil(() => context.runtime.connectorFor(device.id) ?? null, 8_000);
  return {
    ws,
    device,
    signing,
    devicePublic,
    access,
    opened,
    offerWire,
    async sendCatalog() {
      const sealed = await deviceCrypto!.seal(new TextEncoder().encode(JSON.stringify(command('catalog.read', {}))));
      ws.send(JSON.stringify({
        protocol: 'gian.relay/1',
        frame_id: generateCanonicalId(),
        frame_class: 'control',
        route_id: device.id,
        host_id: enrolled.hostId,
        device_id: device.id,
        connection_id: bound.connection_id,
        transport_sequence: sealed.sequence,
        transport_ack: deviceCrypto!.inboundAck,
        sent_at: Date.now(),
        ciphertext: sealed.ciphertext,
      }));
    },
  };
}
