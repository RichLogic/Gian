import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { sanitizeTitle } from '../src/session/auto-title.js';

test('sanitizeTitle strips control characters and trims', () => {
  assert.equal(sanitizeTitle('  Hello\nWorld\t!  '), 'Hello World !');
  assert.equal(sanitizeTitle('\u0007secret\u007F'), 'secret');
});

test('sanitizeTitle caps at 200 characters', () => {
  const raw = `  ${'a'.repeat(250)}  `;
  const cleaned = sanitizeTitle(raw);
  assert.equal(cleaned.length, 200);
  assert.equal(cleaned, 'a'.repeat(200));
});

test('sanitizeTitle keeps an already-clean short title', () => {
  assert.equal(sanitizeTitle('Design review'), 'Design review');
});
