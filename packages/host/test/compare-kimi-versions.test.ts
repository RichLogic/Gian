import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { compareKimiVersions, KimiDataVersionError } from '../src/runtime/kimi-session-store.js';

test('compareKimiVersions orders major.minor.patch', () => {
  assert.equal(compareKimiVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareKimiVersions('1.2.3', '1.2.4'), -1);
  assert.equal(compareKimiVersions('1.2.3', '1.2.3'), 0);
});

test('compareKimiVersions treats a prerelease as older than the release', () => {
  assert.equal(compareKimiVersions('1.0.0-alpha', '1.0.0'), -1);
  assert.equal(compareKimiVersions('1.0.0', '1.0.0-alpha'), 1);
});

test('compareKimiVersions rejects unsupported version strings', () => {
  assert.throws(() => compareKimiVersions('nope', '1.0.0'), KimiDataVersionError);
  assert.throws(() => compareKimiVersions('1.0.0', ''), KimiDataVersionError);
});
