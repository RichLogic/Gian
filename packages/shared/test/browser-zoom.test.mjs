import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  DEFAULT_BROWSER_ZOOM_FACTOR,
  MAX_BROWSER_ZOOM_FACTOR,
  MIN_BROWSER_ZOOM_FACTOR,
  normalizeBrowserZoomFactor,
  stepBrowserZoomFactor,
} from '../dist/index.js';

test('browser zoom defaults to 1 and clamps onto the 25%–500% range', () => {
  assert.equal(DEFAULT_BROWSER_ZOOM_FACTOR, 1);
  assert.equal(normalizeBrowserZoomFactor(undefined), 1);
  assert.equal(normalizeBrowserZoomFactor(Number.NaN, 1.2), 1.2);
  assert.equal(normalizeBrowserZoomFactor(0.1), MIN_BROWSER_ZOOM_FACTOR);
  assert.equal(normalizeBrowserZoomFactor(42), MAX_BROWSER_ZOOM_FACTOR);
});

test('browser zoom steps by 10% on a clean decimal scale and stops at the bounds', () => {
  assert.equal(stepBrowserZoomFactor(1, 1), 1.1);
  assert.equal(stepBrowserZoomFactor(1, -1), 0.9);
  assert.equal(stepBrowserZoomFactor(1.1, 1), 1.2);
  assert.equal(stepBrowserZoomFactor(0.3, -1), 0.25);
  assert.equal(stepBrowserZoomFactor(0.25, -1), 0.25);
  assert.equal(stepBrowserZoomFactor(5, 1), 5);
});

test('browser zoom normalizes arbitrary factors to the nearest step', () => {
  assert.equal(normalizeBrowserZoomFactor(1.13), 1.1);
  assert.equal(normalizeBrowserZoomFactor(1.17), 1.2);
});
