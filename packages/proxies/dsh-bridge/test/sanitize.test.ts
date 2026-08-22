import { test } from 'node:test';
import assert from 'node:assert/strict';

import { boundedSanitized, redact } from '../src/sanitize.js';

test('redact masks secret key names recursively', () => {
  const result = redact({
    authorization: 'Bearer token-123',
    nested: { apiKey: 'secret' },
    headers: { 'x-auth-token': 'abc' },
    safe: 'keep',
  });
  assert.equal((result as { authorization: string }).authorization, '[REDACTED]');
  assert.equal(
    ((result as { nested: { apiKey: string } }).nested.apiKey),
    '[REDACTED]',
  );
  assert.equal(
    ((result as { headers: { 'x-auth-token': string } }).headers['x-auth-token']),
    '[REDACTED]',
  );
  assert.equal((result as { safe: string }).safe, 'keep');
});

test('boundedSanitized passes through small payloads', () => {
  const result = boundedSanitized({ hello: 'world' });
  assert.deepEqual(result, { hello: 'world' });
});

test('boundedSanitized truncates oversized payloads below 1 MiB', () => {
  const huge = 'x'.repeat(2 * 1024 * 1024);
  const result = boundedSanitized({ data: huge });
  const record = result as { truncated: boolean; note: string; preview?: string };
  assert.equal(record.truncated, true);
  assert.match(record.note, /exceeded/);
  assert.ok(record.preview !== undefined && record.preview.length < 1024 * 1024);
});
