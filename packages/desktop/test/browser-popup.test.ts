import assert from 'node:assert/strict';
import test from 'node:test';
import { transientBrowserPopupOptions } from '../src/browser-popup.js';

test('transient Browser popup requires an explicit HTTP(S) popup shape', () => {
  assert.deepEqual(transientBrowserPopupOptions({
    url: 'https://login.example/authorize',
    disposition: 'new-window',
    features: 'popup=yes,width=480,height=640',
  }), { width: 480, height: 640 });
  assert.deepEqual(transientBrowserPopupOptions({
    url: 'http://localhost/callback',
    disposition: 'default',
    features: 'width=50,height=5000',
  }), { width: 320, height: 900 });
  assert.equal(transientBrowserPopupOptions({
    url: 'https://example.com',
    disposition: 'foreground-tab',
    features: 'popup=yes',
  }), null);
  assert.equal(transientBrowserPopupOptions({
    url: 'https://example.com',
    disposition: 'new-window',
    features: '',
  }), null);
  assert.equal(transientBrowserPopupOptions({
    url: 'file:///tmp/secret',
    disposition: 'new-window',
    features: 'popup=yes',
  }), null);
});
