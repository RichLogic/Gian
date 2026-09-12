import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CIPHERTEXT_PACE_BYTES_PER_SECOND,
  CIPHERTEXT_PACE_WINDOW_MS,
  CONTROL_OUTBOX_MAX_BYTES,
  CONTROL_OUTBOX_MAX_FRAMES,
  MAX_ATTACHMENT_BYTES,
  MAX_CIPHERTEXT_BYTES_PER_SECOND,
  MAX_RELAY_FRAME_BYTES,
  MAX_SESSION_PAGE_TURNS,
  parseRemoteMethodParams,
  generateCanonicalId,
} from '../src/index.js';

test('published limits match the frozen proposal constants', () => {
  assert.equal(MAX_RELAY_FRAME_BYTES, 512 * 1024);
  assert.equal(MAX_ATTACHMENT_BYTES, 20 * 1024 * 1024);
  assert.equal(CONTROL_OUTBOX_MAX_FRAMES, 2048);
  assert.equal(CONTROL_OUTBOX_MAX_BYTES, 16 * 1024 * 1024);
  assert.equal(MAX_SESSION_PAGE_TURNS, 10);
  assert.equal(MAX_CIPHERTEXT_BYTES_PER_SECOND, 16 * 1024 * 1024);
  assert.ok(CIPHERTEXT_PACE_BYTES_PER_SECOND < MAX_CIPHERTEXT_BYTES_PER_SECOND);
  assert.ok(CIPHERTEXT_PACE_WINDOW_MS > 1000);
});

test('session.page accepts 10 turns and rejects 11', () => {
  const sessionId = generateCanonicalId();
  assert.doesNotThrow(() => parseRemoteMethodParams('session.page', {
    session_id: sessionId,
    turns: 10,
  }));
  assert.throws(() => parseRemoteMethodParams('session.page', {
    session_id: sessionId,
    turns: 11,
  }));
  assert.throws(() => parseRemoteMethodParams('session.page', {
    session_id: sessionId,
    turns: 0,
  }));
});
