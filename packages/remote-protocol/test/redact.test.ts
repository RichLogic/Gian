import assert from 'node:assert/strict';
import { test } from 'node:test';

import { redactRemoteText, redactRemoteValue, redactRemoteConversationText } from '../src/index.js';

test('conversation projection preserves ordinary long identifiers and formatting without weakening log redaction', () => {
  const marker = 'REMOTE_AB_12345678-1234-4123-8123-123456789abc';
  const text = `Result: ${marker}\n  { "build": "${'abcdef0123456789'.repeat(4)}" }\nABCD-EFGH\n`;
  assert.equal(redactRemoteConversationText(text), text);
  assert.equal(redactRemoteText(marker), '[REDACTED]', 'log boundary stays conservative');
});

test('conversation projection still redacts explicitly identified credentials', () => {
  const text = [
    'Authorization: Bearer private-credential',
    'Cookie: session=private-cookie',
    'pairing_code=ABCD-EFGH',
    'access_token=private-access',
    '{ "api_key": "private-api-value" }',
    'password=private-password',
    'ghp_privatecredential12345',
    '-----BEGIN PRIVATE KEY-----\nprivate-key-bytes\n-----END PRIVATE KEY-----',
  ].join('\n');
  const safe = redactRemoteConversationText(text);
  assert.doesNotMatch(safe, /private-|privatecredential|ABCD-EFGH/);
  assert.match(safe, /\[REDACTED\]/);
});

test('redaction removes tokens, cookies, codes, ciphertext, and auth headers', () => {
  const text = [
    'Authorization: Bearer super-secret-token-value-1234567890',
    'Cookie: gian_remote_refresh=abc',
    'pairing_code=K7DM-F2Q9',
    'ciphertext=dGVzdC1jaXBoZXJ0ZXh0LWZvci1yZWRhY3Q',
  ].join('\n');
  const redacted = redactRemoteText(text);
  assert.doesNotMatch(redacted, /super-secret-token-value-1234567890/);
  assert.doesNotMatch(redacted, /gian_remote_refresh=abc/);
  assert.doesNotMatch(redacted, /K7DM-F2Q9/);
  assert.doesNotMatch(redacted, /dGVzdC1jaXBoZXJ0ZXh0LWZvci1yZWRhY3Q/);
});

test('object redaction never keeps sensitive keys', () => {
  const redacted = redactRemoteValue({
    host_id: 'ok',
    access_token: 'secret',
    refresh_token: 'secret',
    ciphertext: 'payload',
    nested: { cookie: 'abc', prompt: 'do not log' },
  }) as Record<string, unknown>;
  assert.equal(redacted.host_id, 'ok');
  assert.equal(redacted.access_token, '[REDACTED]');
  assert.equal(redacted.refresh_token, '[REDACTED]');
  assert.equal(redacted.ciphertext, '[REDACTED]');
  const nested = redacted.nested as Record<string, unknown>;
  assert.equal(nested.cookie, '[REDACTED]');
  assert.equal(nested.prompt, '[REDACTED]');
});
