import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import {
  AUTH_PROTOCOL,
  CONTENT_WINDOW_CHUNKS,
  MAX_ATTACHMENT_BYTES,
  MAX_CONTENT_CHUNK_PLAINTEXT_BYTES,
  contentChunkRawByteLimit,
  parseRelayFrame,
  type RelayFrame,
} from '@gian/remote-protocol';
import { listenRemoteApp, makeRemoteTestApp } from '../../remote-server/test/fixture.js';
import { createProductionController } from '../../remote-web/src/controller/create.js';
import { MemoryEncryptedHostCache } from '../../remote-web/src/cache/encrypted-cache.js';
import { MemoryBrowserIdentityStore } from '../../remote-web/src/transport/identity.js';
import { setupRemoteHarness, teardownRemoteHarness } from './fixtures/remote-harness.js';

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

async function enrollAndStart(context: ReturnType<typeof setupRemoteHarness>) {
  const { handle, fetch } = await makeRemoteTestApp({
    clock: {
      get now() {
        return Date.now();
      },
      tick() {},
    },
  });
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
  return { handle, fetch, listened, hostId: claimed.host_id };
}

async function pairController(context: ReturnType<typeof setupRemoteHarness>) {
  const enrolled = await enrollAndStart(context);
  const identity = new MemoryBrowserIdentityStore();
  const controller = createProductionController({
    baseUrl: enrolled.listened.url,
    publicOrigin: 'https://remote.test',
    wsUrl: enrolled.listened.wsUrl,
    identity,
    cache: new MemoryEncryptedHostCache(),
    autoRestore: false,
    platform: 'macOS',
    userAgent: 'GianRemoteUploadTest',
  });
  const grant = await context.runtime.createPairingGrant();
  controller.actions.submitPairingCode(grant.code);
  const pending = await waitUntil(() => (
    context.runtime.settingsState().pending_pairings
      .find((row) => row.status === 'pending_confirmation') ?? null
  ));
  await context.runtime.confirmPairing(pending.id, 'confirm');
  await waitUntil(() => (
    controller.state.auth.kind === 'authenticated'
    && controller.state.connection.kind === 'online'
      ? controller.state
      : null
  ));
  return { enrolled, controller };
}

async function contendEventLoop(signal: Promise<unknown>): Promise<void> {
  let spinning = true;
  void signal.finally(() => {
    spinning = false;
  });
  while (spinning) {
    const sliceEnd = Date.now() + 2;
    let acc = 0;
    while (Date.now() < sliceEnd) acc += 1;
    await new Promise((resolve) => setImmediate(resolve));
    void acc;
  }
}

function tapRelayFrames(handle: { services: { relay: {
  outbox: { enqueue: (frame: RelayFrame, direction: 'host_to_device' | 'device_to_host') => void };
  content: {
    accept: (connectionId: string, frame: RelayFrame) => void;
    inFlight: (connectionId: string) => number;
  };
} } }) {
  const control: RelayFrame[] = [];
  const content: RelayFrame[] = [];
  let maxInFlight = 0;
  const router = handle.services.relay;
  const enqueue = router.outbox.enqueue.bind(router.outbox);
  router.outbox.enqueue = (frame, direction) => {
    control.push(frame);
    return enqueue(frame, direction);
  };
  const accept = router.content.accept.bind(router.content);
  router.content.accept = (connectionId, frame) => {
    content.push(frame);
    const result = accept(connectionId, frame);
    maxInFlight = Math.max(maxInFlight, router.content.inFlight(connectionId));
    return result;
  };
  return { control, content, maxInFlight: () => maxInFlight };
}

async function visibleSession(
  context: ReturnType<typeof setupRemoteHarness>,
  controller: ReturnType<typeof createProductionController>,
): Promise<string> {
  const created = await context.tool.call({
    request_id: randomUUID(),
    caller_id: 'test-caller',
    method: 'session.create',
    params: { workspace_id: context.workspaceId, task_id: context.taskId, agent_id: 'agent-claude-review' },
    idempotency_key: `remote-web-upload-${randomUUID()}`,
  });
  const sessionId = (created.data as { session: { id: string } }).session.id;
  controller.actions.refreshState();
  await waitUntil(() => (
    controller.state.connection.kind === 'online'
    && controller.state.sessions.some((session) => session.id === sessionId)
  ));
  return sessionId;
}

test('1MiB and 20MiB Device uploads stay on content frames and honor the window', { timeout: 180_000 }, async () => {
  const context = setupRemoteHarness();
  let paired: Awaited<ReturnType<typeof pairController>> | undefined;
  try {
    paired = await pairController(context);
    const tapped = tapRelayFrames(paired.enrolled.handle);
    const sessionId = await visibleSession(context, paired.controller);
    const rawLimit = contentChunkRawByteLimit();
    for (const size of [1024 * 1024, MAX_ATTACHMENT_BYTES] as const) {
      const beforeContent = tapped.content.length;
      const beforeControl = tapped.control.length;
      const bytes = new Uint8Array(size).fill(size === MAX_ATTACHMENT_BYTES ? 11 : 9);
      paired.controller.actions.uploadDraftAttachment(sessionId, {
        name: `${size}.bin`,
        mime: 'application/octet-stream',
        size,
        bytes,
      });
      const finished = waitUntil(() => {
        const failed = Object.values(paired!.controller.state.mutations).find((item) => (
          item.label === 'attachment.upload' && item.phase === 'failed'
        ));
        if (failed) {
          throw new Error(`upload failed: ${failed.errorCode} ${failed.errorMessage} conn=${paired!.controller.state.connection.kind}`);
        }
        return paired!.controller.state.drafts[sessionId]?.attachments.some((item) => item.size === size)
          ?? false;
      }, size === MAX_ATTACHMENT_BYTES ? 160_000 : 30_000);
      const load = size === MAX_ATTACHMENT_BYTES ? contendEventLoop(finished) : Promise.resolve();
      await finished;
      await load;
      const newContent = tapped.content.slice(beforeContent);
      const newControl = tapped.control.slice(beforeControl);
      assert.ok(newContent.length >= Math.ceil(size / rawLimit) - 1, `expected content chunks for ${size}`);
      assert.ok(newContent.every((frame) => frame.frame_class === 'content'));
      assert.ok(newControl.every((frame) => frame.frame_class === 'control'));
      assert.ok(newControl.every((frame) => {
        try {
          parseRelayFrame(frame);
          return frame.frame_class === 'control';
        } catch {
          return false;
        }
      }));
      assert.ok(
        tapped.maxInFlight() <= CONTENT_WINDOW_CHUNKS,
        `content window exceeded: ${tapped.maxInFlight()}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    }
    assert.ok(rawLimit * 4 / 3 + 256 <= MAX_CONTENT_CHUNK_PLAINTEXT_BYTES);
  } finally {
    paired?.controller.close();
    context.runtime.close();
    paired?.enrolled.listened.close();
    teardownRemoteHarness(context);
  }
});

test('session.page restores transcript after disconnect when live items are gone', { timeout: 30_000 }, async () => {
  const context = setupRemoteHarness();
  let paired: Awaited<ReturnType<typeof pairController>> | undefined;
  try {
    paired = await pairController(context);
    const sessionId = await visibleSession(context, paired.controller);
    paired.controller.actions.selectSession(sessionId);
    await waitUntil(() => paired!.controller.state.view.kind === 'chat');
    const turnId = randomUUID();
    context.db.prepare(
      `INSERT INTO turns (id, session_id, turn_number, status, created_at)
       VALUES (?, ?, 1, 'completed', datetime('now'))`,
    ).run(turnId, sessionId);
    context.db.prepare(
      `INSERT INTO events (id, session_id, turn_id, call_id, type, data, created_at)
       VALUES (?, ?, ?, ?, 'user.message', ?, datetime('now'))`,
    ).run(randomUUID(), sessionId, turnId, randomUUID(), JSON.stringify({
      text: 'restored-after-disconnect',
    }));
    assert.equal(
      paired.controller.state.transcripts[sessionId]?.items.some((item) => (
        'text' in item && String(item.text).includes('restored-after-disconnect')
      )) ?? false,
      false,
    );
    paired.controller.actions.challengeLogin(paired.enrolled.hostId);
    await waitUntil(() => (
      paired!.controller.state.transcripts[sessionId]?.items.some((item) => (
        'text' in item && String(item.text).includes('restored-after-disconnect')
      )) ?? false
    ), 20_000);
  } finally {
    paired?.controller.close();
    context.runtime.close();
    paired?.enrolled.listened.close();
    teardownRemoteHarness(context);
  }
});
