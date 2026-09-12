import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  generateCanonicalId,
  MAX_CONTENT_CHUNK_PLAINTEXT_BYTES,
  RemoteProtocolError,
  assertFrameClassMatchesInner,
  assertInnerContentPlaintext,
  bytesToBase64Url,
  contentChunkRawByteLimit,
  parseContentChunk,
  parseRemoteControlMessage,
} from '../src/index.js';

test('content chunks accept the 256 KiB plaintext boundary and reject one extra byte', () => {
  const transferId = generateCanonicalId();
  const maxBytes = 'a'.repeat(MAX_CONTENT_CHUNK_PLAINTEXT_BYTES);
  const chunk = parseContentChunk({
    type: 'attachment.chunk',
    transfer_id: transferId,
    transfer_sequence: 0,
    offset: 0,
    bytes: maxBytes,
  });
  assert.equal(chunk.bytes.length, MAX_CONTENT_CHUNK_PLAINTEXT_BYTES);
  assert.throws(() => parseContentChunk({
    type: 'attachment.chunk',
    transfer_id: transferId,
    transfer_sequence: 1,
    offset: MAX_CONTENT_CHUNK_PLAINTEXT_BYTES,
    bytes: `${maxBytes}x`,
  }));
});

test('raw content chunks stay inside the serialized 256 KiB inner plaintext budget', () => {
  const transferId = generateCanonicalId();
  const rawLimit = contentChunkRawByteLimit();
  const legal = {
    type: 'attachment.chunk',
    transfer_id: transferId,
    transfer_sequence: 0,
    offset: 0,
    bytes: bytesToBase64Url(new Uint8Array(rawLimit)),
  };
  assertInnerContentPlaintext(legal);
  assert.equal(Buffer.byteLength(JSON.stringify(legal), 'utf8') <= MAX_CONTENT_CHUNK_PLAINTEXT_BYTES, true);
  const oversizedRaw = {
    ...legal,
    bytes: bytesToBase64Url(new Uint8Array(MAX_CONTENT_CHUNK_PLAINTEXT_BYTES)),
  };
  assert.throws(() => assertInnerContentPlaintext(oversizedRaw));
});

test('outer frame_class must match the closed inner message classification', () => {
  assert.doesNotThrow(() => assertFrameClassMatchesInner('content', 'attachment.chunk'));
  assert.doesNotThrow(() => assertFrameClassMatchesInner('control', 'command.request'));
  assert.doesNotThrow(() => assertFrameClassMatchesInner('control', 'attachment.begin'));
  assert.doesNotThrow(() => assertFrameClassMatchesInner('control', 'transfer.error'));
  assert.throws(
    () => assertFrameClassMatchesInner('content', 'command.request'),
    (error: unknown) => error instanceof RemoteProtocolError
      && error.code === 'INVALID_FRAME'
      && error.details?.reason === 'frame_class_mismatch',
  );
  assert.throws(
    () => assertFrameClassMatchesInner('control', 'attachment.chunk'),
    (error: unknown) => error instanceof RemoteProtocolError
      && error.code === 'INVALID_FRAME'
      && error.details?.reason === 'frame_class_mismatch',
  );
  const transferError = parseRemoteControlMessage({
    type: 'transfer.error',
    transfer_id: generateCanonicalId(),
    code: 'ATTACHMENT_HASH_MISMATCH',
    message: 'hash mismatch',
  });
  assert.equal(transferError.type, 'transfer.error');
});

test('content messages stay outside the generic control snapshot types', () => {
  const message = parseRemoteControlMessage({
    type: 'transfer.ack',
    transfer_id: generateCanonicalId(),
    contiguous_offset: 1024,
    window_chunks: 4,
  });
  assert.equal(message.type, 'transfer.ack');
  assert.throws(() => parseRemoteControlMessage({
    type: 'state.patch',
    host_generation: generateCanonicalId(),
    event_sequence: 1,
    base_revision: 'rev-1',
    revision: 'rev-2',
    patch: {
      queues: [{
        session_id: generateCanonicalId(),
        queue_revision: 'q-1',
        entries: [],
        bytes: 'file-bytes',
      }],
    },
  }));
});
