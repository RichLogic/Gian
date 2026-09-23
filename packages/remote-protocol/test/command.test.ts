import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COMMAND_RETENTION_MS,
  generateCanonicalId,
  generateUuidV7,
  MAX_PROXY_LOGO_BYTES,
  parseCommandRequest,
  parseRemoteMethodParams,
  proxyLogoResultSchema,
  REMOTE_METHOD_LIST,
  RemoteProtocolError,
  sessionUpdateParamsSchema,
  validateCommandIdentity,
} from '../src/index.js';

test('RemoteMethod registry is closed and exhaustive', () => {
  assert.deepEqual([...REMOTE_METHOD_LIST], [
    'execution.create',
    'execution.list',
    'execution.sync',
    'catalog.read',
    'catalog.agent',
    'execution.configure',
    'state.refresh',
    'session.subscribe',
    'session.page',
    'command.status',
    'session.create',
    'session.update',
    'session.send',
    'session.stop',
    'queue.update',
    'queue.remove',
    'queue.clear',
    'queue.send_now',
    'interaction.respond',
    'file.preview',
    'file.resolve',
    'file.tree',
    'file.list',
    'git.read',
    'proxy.logo',
  ]);
  assert.throws(() => parseRemoteMethodParams('session.send', { session_id: generateCanonicalId() }));
  assert.doesNotThrow(() => parseRemoteMethodParams('catalog.read', {}));
  // approval_mode joined the session config set (2026-09-15 audit-mode sync).
  assert.doesNotThrow(() => parseRemoteMethodParams('session.update', {
    session_id: generateCanonicalId(),
    session_revision: 'rev-1',
    approval_mode: 'full-access',
  }));
  assert.equal(sessionUpdateParamsSchema.safeParse({
    session_id: generateCanonicalId(),
    session_revision: 'rev-1',
    path: '/tmp/secret',
  }).success, false);
});

test('proxy.logo params and result are closed and bounded', () => {
  assert.doesNotThrow(() => parseRemoteMethodParams('proxy.logo', { proxy: 'claude', variant: 'light' }));
  assert.throws(() => parseRemoteMethodParams('proxy.logo', { proxy: 'claude', variant: 'auto' }));
  assert.throws(() => parseRemoteMethodParams('proxy.logo', { proxy: 'claude' }));
  assert.equal(proxyLogoResultSchema.safeParse({
    media_type: 'image/png',
    data_base64: Buffer.from('png-bytes').toString('base64'),
    sha256: 'a'.repeat(64),
  }).success, true);
  // Oversized payloads stay inside the relay frame budget.
  assert.equal(proxyLogoResultSchema.safeParse({
    media_type: 'image/png',
    data_base64: Buffer.alloc(MAX_PROXY_LOGO_BYTES + 3).toString('base64'),
    sha256: 'a'.repeat(64),
  }).success, false);
  // Unknown fields are rejected (closed contract).
  assert.equal(proxyLogoResultSchema.safeParse({
    media_type: 'image/png',
    data_base64: 'aGk=',
    sha256: 'a'.repeat(64),
    path: '/tmp/secret',
  }).success, false);
});

test('UUIDv7 command timestamp and 90-day retention are enforced', () => {
  const now = Date.UTC(2026, 8, 1);
  const commandId = generateUuidV7(now);
  validateCommandIdentity(commandId, now, now);
  assert.throws(() => validateCommandIdentity(commandId, now + 5000, now));
  assert.throws(
    () => validateCommandIdentity(generateUuidV7(now - COMMAND_RETENTION_MS - 1), now - COMMAND_RETENTION_MS - 1, now),
    (error: unknown) => error instanceof RemoteProtocolError && error.code === 'COMMAND_EXPIRED',
  );
  assert.throws(() => validateCommandIdentity(generateCanonicalId(), now, now));
  const future = now + 60_000;
  assert.throws(
    () => validateCommandIdentity(generateUuidV7(future), future, now),
    (error: unknown) => error instanceof RemoteProtocolError && error.code === 'COMMAND_EXPIRED',
  );
});

test('command.request validates method params and rejects unknown fields', () => {
  const now = Date.now();
  const command = parseCommandRequest({
    type: 'command.request',
    command_id: generateUuidV7(now),
    created_at: now,
    attempt_id: generateCanonicalId(),
    method: 'session.stop',
    params: {
      session_id: generateCanonicalId(),
      session_revision: 'rev-1',
    },
  }, now);
  assert.equal(command.method, 'session.stop');
  assert.throws(() => parseCommandRequest({
    type: 'command.request',
    command_id: generateUuidV7(now),
    created_at: now,
    attempt_id: generateCanonicalId(),
    method: 'tool.call',
    params: {},
  }, now));
  assert.throws(() => parseCommandRequest({
    type: 'command.request',
    command_id: generateUuidV7(now),
    created_at: now,
    attempt_id: generateCanonicalId(),
    method: 'session.send',
    params: {
      session_id: generateCanonicalId(),
      text: 'hi',
      extra: true,
    },
  }, now));
});
