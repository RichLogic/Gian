import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addSnapshotPart,
  applyStatePatch,
  createSnapshotPartAssembly,
  finalizeSnapshotParts,
  parseRemoteControlMessage,
  RemoteProtocolError,
  splitSnapshotParts,
} from '../src/index.js';
import { sampleSnapshot } from './helpers.js';

test('snapshot parts reassemble to the same closed snapshot', async () => {
  const snapshot = sampleSnapshot();
  const parts = await splitSnapshotParts(snapshot, 64);
  assert.ok(parts.length >= 2);
  const assembly = createSnapshotPartAssembly(parts[0]!);
  for (const part of parts.slice(1)) addSnapshotPart(assembly, part);
  const restored = await finalizeSnapshotParts(assembly);
  assert.deepEqual(restored, snapshot);
});

test('duplicate conflicting, missing, oversize, and hash-mismatched parts fail closed', async () => {
  const snapshot = sampleSnapshot();
  const [first, second] = await splitSnapshotParts(snapshot, 48);
  assert.ok(first && second);
  const assembly = createSnapshotPartAssembly(first);
  assert.throws(() => addSnapshotPart(assembly, {
    ...first,
    bytes: `${first.bytes}aa`,
  }));
  addSnapshotPart(assembly, second);
  const incomplete = createSnapshotPartAssembly(first);
  await assert.rejects(() => finalizeSnapshotParts(incomplete));
  const tampered = createSnapshotPartAssembly({
    ...first,
    payload_sha256: 'ab'.repeat(32),
  });
  addSnapshotPart(tampered, {
    ...second,
    payload_sha256: 'ab'.repeat(32),
  });
  await assert.rejects(() => finalizeSnapshotParts(tampered));
  assert.throws(() => parseRemoteControlMessage({
    ...first,
    extra: true,
  }));
});

test('StatePatch requires matching base revision and contiguous event_sequence', () => {
  const current = {
    host_generation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    revision: 'rev-1',
    event_sequence: 4,
  };
  const next = applyStatePatch(current, {
    type: 'state.patch',
    host_generation: current.host_generation,
    event_sequence: 5,
    base_revision: 'rev-1',
    revision: 'rev-2',
    patch: {
      attention: [],
    },
  });
  assert.deepEqual(next, { revision: 'rev-2', event_sequence: 5 });
  assert.throws(() => applyStatePatch(current, {
    type: 'state.patch',
    host_generation: current.host_generation,
    event_sequence: 5,
    base_revision: 'rev-other',
    revision: 'rev-2',
    patch: {},
  }), (error: unknown) => error instanceof RemoteProtocolError && error.code === 'SNAPSHOT_REQUIRED');
  assert.throws(() => applyStatePatch(current, {
    type: 'state.patch',
    host_generation: current.host_generation,
    event_sequence: 7,
    base_revision: 'rev-1',
    revision: 'rev-2',
    patch: {},
  }));
});
