import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/core/service.js';

test('cc-proxy buildPrompt joins text items with double newline', () => {
  const out = buildPrompt([
    { type: 'text', text: 'hello' },
    { type: 'text', text: 'world' },
  ]);
  assert.equal(out, 'hello\n\nworld');
});

test('cc-proxy buildPrompt appends [Attached image: <path>] for localImage items', () => {
  const out = buildPrompt([
    { type: 'text', text: 'what is in this?' },
    { type: 'localImage', path: '/tmp/abc.png' },
  ]);
  assert.equal(out, 'what is in this?\n\n[Attached image: /tmp/abc.png]');
});

test('cc-proxy buildPrompt handles image-only input', () => {
  const out = buildPrompt([{ type: 'localImage', path: '/tmp/x.png' }]);
  assert.equal(out, '[Attached image: /tmp/x.png]');
});
