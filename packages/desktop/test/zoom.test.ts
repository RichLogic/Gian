import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeZoomPercent,
  stepZoomPercent,
} from '../src/zoom.js';

test('zoom defaults to 100 and stays on the 80–150 range', () => {
  assert.equal(normalizeZoomPercent(undefined), 100);
  assert.equal(normalizeZoomPercent(null), 100);
  assert.equal(normalizeZoomPercent(79), 80);
  assert.equal(normalizeZoomPercent(126), 130);
  assert.equal(normalizeZoomPercent(151), 150);
});

test('native zoom steps by 10% and stops at either bound', () => {
  assert.equal(stepZoomPercent(100, 1), 110);
  assert.equal(stepZoomPercent(100, -1), 90);
  assert.equal(stepZoomPercent(150, 1), 150);
  assert.equal(stepZoomPercent(80, -1), 80);
});
