import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  helloSchema,
  negotiateHello,
  parseRemoteControlMessage,
  RemoteProtocolError,
} from '../src/index.js';
import { generateCanonicalId } from '../src/index.js';

test('minor version overlap selects the highest shared minor', () => {
  const result = negotiateHello({
    peer_min_minor: 0,
    peer_max_minor: 2,
    local_min_minor: 1,
    local_max_minor: 3,
    peer_capabilities: ['wire.snapshot_parts', 'wire.content_resume'],
  });
  assert.equal(result.negotiated_minor_version, 2);
  assert.deepEqual(result.negotiated_capabilities, ['wire.snapshot_parts', 'wire.content_resume']);
});

test('minor version no-overlap fails closed', () => {
  assert.throws(
    () => negotiateHello({
      peer_min_minor: 3,
      peer_max_minor: 4,
      local_min_minor: 0,
      local_max_minor: 2,
      peer_capabilities: [],
    }),
    (error: unknown) => error instanceof RemoteProtocolError && error.code === 'PROTOCOL_VERSION_UNSUPPORTED',
  );
});

test('feature negotiation is a closed intersection', () => {
  const result = negotiateHello({
    peer_min_minor: 1,
    peer_max_minor: 1,
    peer_capabilities: ['wire.snapshot_parts', 'wire.unknown_future'],
  });
  assert.deepEqual(result.negotiated_capabilities, ['wire.snapshot_parts']);
});

test('the structured transcript contract does not negotiate with legacy minor zero', () => {
  assert.throws(
    () => negotiateHello({
      peer_min_minor: 0,
      peer_max_minor: 0,
      peer_capabilities: [],
    }),
    (error: unknown) => error instanceof RemoteProtocolError && error.code === 'PROTOCOL_VERSION_UNSUPPORTED',
  );
});

test('hello rejects unknown fields, types, and inverted ranges', () => {
  const hello = {
    type: 'hello',
    protocol: 'gian.remote/1',
    client_version: '1.0.0',
    major_version: 1,
    min_minor_version: 0,
    max_minor_version: 0,
    capabilities: ['wire.snapshot_parts'],
    device_id: generateCanonicalId(),
  };
  assert.equal(helloSchema.safeParse(hello).success, true);
  assert.equal(helloSchema.safeParse({ ...hello, extra: 1 }).success, false);
  assert.equal(helloSchema.safeParse({ ...hello, protocol: 'gian.remote/2' }).success, false);
  assert.equal(helloSchema.safeParse({ ...hello, type: 'hello.v2' }).success, false);
  assert.equal(helloSchema.safeParse({ ...hello, min_minor_version: 2, max_minor_version: 1 }).success, false);
  assert.throws(() => parseRemoteControlMessage({ ...hello, type: 'unknown' }));
});
