import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeDisplayName } from '../../src/runtime/claude-mcp-runtime.js';

// SESSION-NAME-001: the Claude CLI `--name` value is sanitized before it hits
// the argv so a pasted multi-line name can't smuggle extra args / blow up the
// terminal title.
test('sanitizeDisplayName trims surrounding whitespace', () => {
  assert.equal(sanitizeDisplayName('  hello world  '), 'hello world');
});

test('sanitizeDisplayName replaces control chars (CR/LF/tab) with spaces', () => {
  assert.equal(sanitizeDisplayName('a\nb\tc\rd'), 'a b c d');
});

test('sanitizeDisplayName returns null for empty / whitespace / nullish', () => {
  assert.equal(sanitizeDisplayName(''), null);
  assert.equal(sanitizeDisplayName('   '), null);
  assert.equal(sanitizeDisplayName('\n\t'), null);
  assert.equal(sanitizeDisplayName(null), null);
  assert.equal(sanitizeDisplayName(undefined), null);
});

test('sanitizeDisplayName caps length at 200 chars', () => {
  assert.equal(sanitizeDisplayName('x'.repeat(300))!.length, 200);
});

test('sanitizeDisplayName preserves unicode', () => {
  assert.equal(sanitizeDisplayName('我的会话 🚀'), '我的会话 🚀');
});
