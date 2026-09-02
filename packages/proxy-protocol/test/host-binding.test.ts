import assert from 'node:assert/strict';
import test from 'node:test';

import {
  signNativeSessionHostBinding,
  verifyNativeSessionHostBinding,
} from '../src/host-binding.js';

const binding = {
  pluginId: 'ai.deepseek.harness',
  sessionId: 'gian-session',
  nativeSessionId: 'dsh-session',
  cwd: '/tmp/project',
};

test('Host binding proof authenticates the exact plugin, Session, native id, and cwd', () => {
  const proof = signNativeSessionHostBinding('host-key', binding);
  assert.match(proof, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(verifyNativeSessionHostBinding('host-key', binding, proof), true);
  assert.equal(verifyNativeSessionHostBinding('other-key', binding, proof), false);
  assert.equal(verifyNativeSessionHostBinding('host-key', {
    ...binding,
    nativeSessionId: 'foreign-session',
  }, proof), false);
  assert.equal(verifyNativeSessionHostBinding('host-key', {
    ...binding,
    sessionId: 'other-gian-session',
  }, proof), false);
});
