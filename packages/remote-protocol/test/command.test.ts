import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COMMAND_RETENTION_MS,
  generateCanonicalId,
  generateUuidV7,
  parseCommandRequest,
  parseRemoteMethodParams,
  REMOTE_METHOD_LIST,
  RemoteProtocolError,
  sessionUpdateParamsSchema,
  validateCommandIdentity,
} from '../src/index.js';

test('RemoteMethod registry is closed and exhaustive', () => {
  assert.deepEqual([...REMOTE_METHOD_LIST], [
    'catalog.read',
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
  ]);
  assert.throws(() => parseRemoteMethodParams('session.send', { session_id: generateCanonicalId() }));
  assert.doesNotThrow(() => parseRemoteMethodParams('catalog.read', {}));
  assert.throws(() => parseRemoteMethodParams('session.update', {
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
