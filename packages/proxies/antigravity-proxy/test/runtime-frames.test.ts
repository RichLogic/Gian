import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AcpFrameLimitError } from '../src/runtime/errors.js';
import {
  ACP_MAX_FRAME_BYTES,
  assertOutboundFrame,
  consumeFrameBytes,
  type FrameCursor,
} from '../src/runtime/frames.js';

test('shares the Host NDJSON ceiling', () => {
  assert.equal(ACP_MAX_FRAME_BYTES, 16 * 1024 * 1024);
});

test('counts inbound bytes across chunks and resets on LF', () => {
  const state: FrameCursor = { current: 0 };
  consumeFrameBytes(state, Buffer.from('abc'), 4);
  consumeFrameBytes(state, Buffer.from('d\nxy'), 4);
  assert.equal(state.current, 2);
});

test('rejects an inbound frame one byte past the ceiling', () => {
  const state: FrameCursor = { current: 0 };
  assert.throws(
    () => consumeFrameBytes(state, Buffer.from('abcde'), 4),
    (error: unknown) => {
      assert.ok(error instanceof AcpFrameLimitError);
      assert.equal(error.bytes, 5);
      assert.equal(error.limit, 4);
      assert.match(error.message, /5 bytes/);
      return true;
    },
  );
});

test('ignores one trailing LF on an outbound record', () => {
  assertOutboundFrame(Buffer.from('{"id":1}\n'), 8);
  assert.throws(
    () => assertOutboundFrame(Buffer.from('{"id":1}'), 7),
    (error: unknown) => error instanceof AcpFrameLimitError && error.bytes === 8,
  );
  assert.throws(
    () => assertOutboundFrame(Buffer.from('ab\ncd\n'), 4),
    (error: unknown) => error instanceof AcpFrameLimitError && error.bytes === 5,
  );
});
