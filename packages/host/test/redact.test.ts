import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { redactErrorForLog, redactSensitiveText } from '../src/logging/redact.js';

test('SEC-LOG-001: centralized redaction removes common credential shapes', () => {
  const cases = [
    'Authorization: Bearer provider-secret-token',
    'OPENAI_API_KEY=sk-exampleprovider123456',
    'GITHUB_TOKEN=github_pat_examplecredential123456',
    '{"access_token":"oauth-secret-value","password":"db-secret"}',
    'https://alice:super-secret@example.invalid/private.git',
    'https://example.invalid/callback?client_secret=oauth-secret&ok=1',
    'provider stderr: sk-ant-exampleprovidercredential123456',
    'git stderr: remote https://bob:password@example.invalid/repo failed',
  ];
  for (const value of cases) {
    const redacted = redactSensitiveText(value);
    assert.match(redacted, /\[REDACTED\]/, value);
    assert.doesNotMatch(redacted, /provider-secret|examplecredential|oauth-secret|db-secret|super-secret|:password@/i);
  }
});

test('SEC-LOG-001: redaction preserves diagnostic counterexamples', () => {
  const safe = [
    'branch feature/monkey-patch',
    'commit 0123456789abcdef0123456789abcdef01234567',
    'Git command failed with exit code 128',
    'https://example.invalid/public/repo.git',
    'token budget is 12000',
  ];
  for (const value of safe) assert.equal(redactSensitiveText(value), value);
});

test('SEC-LOG-001: Error stacks are redacted before logging', () => {
  const error = new Error('fetch failed: Authorization: Bearer runtime-secret-value');
  const output = redactErrorForLog(error);
  assert.match(output, /Error: fetch failed/);
  assert.doesNotMatch(output, /runtime-secret-value/);
});
