import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserPermissionKinds,
  browserPermissionOrigin,
} from '../src/browser-permissions.js';

test('Browser permission mapping keeps a small explicit capability set', () => {
  assert.deepEqual(browserPermissionKinds('media', { mediaTypes: ['video', 'audio'] }), [
    'camera',
    'microphone',
  ]);
  assert.deepEqual(browserPermissionKinds('media', { mediaType: 'audio' }), ['microphone']);
  assert.deepEqual(browserPermissionKinds('clipboard-read', {}), ['clipboard']);
  assert.deepEqual(browserPermissionKinds('geolocation', {}), ['geolocation']);
  assert.deepEqual(browserPermissionKinds('notifications', {}), ['notifications']);
  assert.equal(browserPermissionKinds('display-capture', {}), null);
  assert.equal(browserPermissionKinds('media', { mediaType: 'unknown' }), null);
});

test('Browser permission origins accept only normalized HTTP(S) origins', () => {
  assert.equal(browserPermissionOrigin('https://example.com/path?q=secret'), 'https://example.com');
  assert.equal(browserPermissionOrigin('http://localhost:5173/page'), 'http://localhost:5173');
  assert.equal(browserPermissionOrigin('gian-browser://project/index.html'), null);
  assert.equal(browserPermissionOrigin('file:///tmp/secret'), null);
  assert.equal(browserPermissionOrigin('not a url'), null);
});
