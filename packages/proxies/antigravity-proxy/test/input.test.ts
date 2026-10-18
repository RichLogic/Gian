import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AntigravityProxyError } from '../src/core/errors.js';
import { normalizeInputItems } from '../src/core/input.js';

function throwsCode(run: () => unknown, domainCode: 'CAPABILITY_NOT_SUPPORTED' | 'CONFIG_VALUE_INVALID'): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof AntigravityProxyError);
    assert.equal(error.domainCode, domainCode);
    assert.equal(error.retryable, false);
    return true;
  });
}

test('normalizeInputItems keeps text blocks and is stable on a second pass', () => {
  const raw = [
    { type: 'text', text: 'one' },
    { type: 'text', text: '  two  ' },
  ];
  const once = normalizeInputItems(raw);
  assert.deepEqual(once, [
    { type: 'text', text: 'one' },
    { type: 'text', text: '  two  ' },
  ]);
  assert.deepEqual(normalizeInputItems(once), once);
});

test('normalizeInputItems rejects empty, non-array, and blank text', () => {
  for (const raw of [undefined, null, 'hello', { type: 'text', text: 'hi' }, []]) {
    throwsCode(() => normalizeInputItems(raw), 'CONFIG_VALUE_INVALID');
  }
  throwsCode(() => normalizeInputItems([null]), 'CONFIG_VALUE_INVALID');
  throwsCode(() => normalizeInputItems(['hello']), 'CONFIG_VALUE_INVALID');
  throwsCode(() => normalizeInputItems([{ type: 'text' }]), 'CONFIG_VALUE_INVALID');
  throwsCode(() => normalizeInputItems([{ type: 'text', text: '' }]), 'CONFIG_VALUE_INVALID');
  throwsCode(() => normalizeInputItems([{ type: 'text', text: '   ' }]), 'CONFIG_VALUE_INVALID');
  throwsCode(() => normalizeInputItems([{ type: 'text', text: 1 }]), 'CONFIG_VALUE_INVALID');
});

test('normalizeInputItems rejects non-text and mixed attachments instead of dropping them', () => {
  const rejected = [
    [{ type: 'image', data: 'aaaa', mimeType: 'image/png' }],
    [{ type: 'audio', data: 'aaaa', mimeType: 'audio/wav' }],
    [{ type: 'resource', resource: { uri: 'file:///tmp/a', text: 'body' } }],
    [{ type: 'resource_link', uri: 'file:///tmp/a', name: 'a' }],
    [{ type: 'localImage', path: '/tmp/a.png' }],
    [{ type: 'localFile', path: '/tmp/a.txt' }],
    [{ type: 'skill', name: 'review' }],
    [{ type: 'text', text: 'keep' }, { type: 'image', data: 'aaaa', mimeType: 'image/png' }],
    [{ type: 'text', text: 'keep', path: '/tmp/a.txt' }],
    [{ type: 'text', text: 'keep', uri: 'file:///tmp/a' }],
    [{ type: 'text', text: 'keep', data: 'aaaa' }],
    [{ type: 'text', text: 'keep', mimeType: 'text/plain' }],
    [{ type: 'text', text: 'keep', mime: 'text/plain' }],
    [{ type: 'text', text: 'keep', resource: { text: 'x' } }],
    [{ type: 'text', text: 'keep', source: 'disk' }],
    [{ type: 'text', text: 'keep', size: 4 }],
  ];
  for (const raw of rejected) {
    throwsCode(() => normalizeInputItems(raw), 'CAPABILITY_NOT_SUPPORTED');
  }
});
