import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBrowserSmokeDownloadDirectory } from '../src/browser-download.js';

test('Browser smoke download destination stays inside unpackaged temporary user data', () => {
  assert.equal(resolveBrowserSmokeDownloadDirectory({
    packaged: false,
    userDataPath: '/tmp/gian-smoke',
    candidate: '/tmp/gian-smoke/downloads',
  }), '/tmp/gian-smoke/downloads');
  assert.equal(resolveBrowserSmokeDownloadDirectory({
    packaged: false,
    userDataPath: '/tmp/gian-smoke',
    candidate: '/tmp/gian-smoke',
  }), '/tmp/gian-smoke');
  assert.equal(resolveBrowserSmokeDownloadDirectory({
    packaged: false,
    userDataPath: '/tmp/gian-smoke',
    candidate: '/tmp/gian-smoke-other/downloads',
  }), null);
  assert.equal(resolveBrowserSmokeDownloadDirectory({
    packaged: false,
    userDataPath: '/tmp/gian-smoke',
    candidate: 'relative/downloads',
  }), null);
  assert.equal(resolveBrowserSmokeDownloadDirectory({
    packaged: true,
    userDataPath: '/tmp/gian-smoke',
    candidate: '/tmp/gian-smoke/downloads',
  }), null);
});
