// Coverage for traceability row:
//   ERR-005 — codex-proxy unsupported / malformed input items must return
//             INVALID_REQUEST. cc-proxy already has localImage coverage in
//             its own service.test.ts; this fills the codex side.
//
// The validator lives in `src/core/input.ts` and is the gate for
// `turn.start.input`. Anything that gets past it reaches the codex runtime
// directly, so silent acceptance of an invalid shape would land at the
// codex binary as a corrupt payload.

import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';

import { normalizeInputItems } from '../src/core/input.js';

interface AppError extends Error {
  statusCode?: number;
  code?: string;
}

function expectInvalidRequest(fn: () => unknown, matcher: RegExp) {
  let err: AppError | null = null;
  try {
    fn();
  } catch (caught) {
    err = caught as AppError;
  }
  assert.ok(err, 'expected normalizeInputItems to throw');
  assert.equal(err!.code, 'INVALID_REQUEST',
    `expected code INVALID_REQUEST, got ${err!.code}`);
  assert.equal(err!.statusCode, 400,
    'INVALID_REQUEST must carry HTTP 400 so the proxy CLI rejects with the correct error envelope');
  assert.match(err!.message, matcher);
}

// ---------------------------------------------------------------------------
// Top-level shape
// ---------------------------------------------------------------------------

test('ERR-005: codex input rejects non-array input with INVALID_REQUEST', () => {
  expectInvalidRequest(() => normalizeInputItems(undefined, '/tmp'), /non-empty array/i);
  expectInvalidRequest(() => normalizeInputItems(null, '/tmp'), /non-empty array/i);
  expectInvalidRequest(() => normalizeInputItems('a string', '/tmp'), /non-empty array/i);
  expectInvalidRequest(() => normalizeInputItems({}, '/tmp'), /non-empty array/i);
});

test('ERR-005: codex input rejects empty array', () => {
  expectInvalidRequest(() => normalizeInputItems([], '/tmp'), /non-empty array/i);
});

test('ERR-005: codex input rejects non-object items inside the array', () => {
  expectInvalidRequest(() => normalizeInputItems(['oops'], '/tmp'), /must be an object/i);
  expectInvalidRequest(() => normalizeInputItems([null], '/tmp'), /must be an object/i);
  expectInvalidRequest(() => normalizeInputItems([42], '/tmp'), /must be an object/i);
});

// ---------------------------------------------------------------------------
// text items
// ---------------------------------------------------------------------------

test('ERR-005: codex input text item rejects empty / whitespace-only text', () => {
  expectInvalidRequest(() => normalizeInputItems([{ type: 'text', text: '' }], '/tmp'),
    /non-empty text/i);
  expectInvalidRequest(() => normalizeInputItems([{ type: 'text', text: '   \n\t' }], '/tmp'),
    /non-empty text/i);
  expectInvalidRequest(() => normalizeInputItems([{ type: 'text' }], '/tmp'),
    /non-empty text/i);
});

test('ERR-005: codex input text item passes through when text is non-empty', () => {
  const out = normalizeInputItems([{ type: 'text', text: 'hello world' }], '/tmp');
  assert.deepEqual(out, [{ type: 'text', text: 'hello world' }]);
});

// ---------------------------------------------------------------------------
// localImage items — codex-specific (cc-proxy refuses these outright; codex
// accepts them but resolves the path relative to cwd).
// ---------------------------------------------------------------------------

test('ERR-005: codex input localImage rejects missing / empty path', () => {
  expectInvalidRequest(() => normalizeInputItems([{ type: 'localImage' }], '/tmp'),
    /localImage.*path/i);
  expectInvalidRequest(() => normalizeInputItems([{ type: 'localImage', path: '' }], '/tmp'),
    /localImage.*path/i);
  expectInvalidRequest(() => normalizeInputItems([{ type: 'localImage', path: '   ' }], '/tmp'),
    /localImage.*path/i);
});

test('ERR-005: codex input localImage rejects non-string path', () => {
  expectInvalidRequest(() => normalizeInputItems([{ type: 'localImage', path: 42 }], '/tmp'),
    /localImage.*path/i);
});

test('ERR-005: codex input localImage resolves relative path against cwd', () => {
  const out = normalizeInputItems(
    [{ type: 'localImage', path: 'screenshots/img.png' }],
    '/home/me/proj',
  );
  assert.deepEqual(out, [
    { type: 'localImage', path: resolve('/home/me/proj', 'screenshots/img.png') },
  ]);
});

test('ERR-005: codex input localImage keeps already-absolute path as-is', () => {
  const out = normalizeInputItems(
    [{ type: 'localImage', path: '/etc/hosts.png' }],
    '/home/me/proj',
  );
  // path.resolve preserves an absolute input.
  assert.deepEqual(out, [{ type: 'localImage', path: '/etc/hosts.png' }]);
});

// ---------------------------------------------------------------------------
// skill items — codex's first-class skill dispatch
// ---------------------------------------------------------------------------

test('ERR-005: codex input skill rejects missing / empty name', () => {
  expectInvalidRequest(
    () => normalizeInputItems([{ type: 'skill', path: '/p' }], '/tmp'),
    /skill.*name/i,
  );
  expectInvalidRequest(
    () => normalizeInputItems([{ type: 'skill', name: '', path: '/p' }], '/tmp'),
    /skill.*name/i,
  );
  expectInvalidRequest(
    () => normalizeInputItems([{ type: 'skill', name: '  ', path: '/p' }], '/tmp'),
    /skill.*name/i,
  );
});

test('ERR-005: codex input skill rejects missing / empty path', () => {
  expectInvalidRequest(
    () => normalizeInputItems([{ type: 'skill', name: 'review' }], '/tmp'),
    /skill.*path/i,
  );
  expectInvalidRequest(
    () => normalizeInputItems([{ type: 'skill', name: 'review', path: '' }], '/tmp'),
    /skill.*path/i,
  );
});

test('ERR-005: codex input skill passes through when name + path both present', () => {
  const out = normalizeInputItems(
    [{ type: 'skill', name: 'review-pr', path: '/repo/.codex/skills/review-pr' }],
    '/repo',
  );
  assert.deepEqual(out, [
    { type: 'skill', name: 'review-pr', path: '/repo/.codex/skills/review-pr' },
  ]);
});

// ---------------------------------------------------------------------------
// Unknown / unsupported types
// ---------------------------------------------------------------------------

test('ERR-005: codex input rejects unknown item type', () => {
  expectInvalidRequest(
    () => normalizeInputItems([{ type: 'audio', text: 'hi' }], '/tmp'),
    /Unsupported input item type "audio"/,
  );
  expectInvalidRequest(
    () => normalizeInputItems([{ type: 'remoteImage', url: 'https://example.com/x.png' }], '/tmp'),
    /Unsupported input item type "remoteImage"/,
  );
  expectInvalidRequest(
    () => normalizeInputItems([{}], '/tmp'),
    /Unsupported input item type "undefined"/,
  );
});
