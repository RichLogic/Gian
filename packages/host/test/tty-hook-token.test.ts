// Coverage for traceability row:
//   SEC-004 — Claude TTY hook endpoint is exempt from web auth, so it is
//             fully gated by a per-session token issued by TtyHookRegistry.
//             A token must (a) resolve only to the exact session it was
//             minted for, (b) become invalid after revoke / re-issue, and
//             (c) never resolve across the wrong-session boundary.
//
// This file targets the registry directly — the smallest unit that backs
// the `/internal/hooks/claude/:sessionId/:event?t=…` auth check at
// packages/host/src/web/app.ts:205-218. Token-as-string is the only thing
// standing between an unauthenticated caller and PTY-spawn metadata.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TtyHookRegistry } from '../src/tty/registry.js';

test('SEC-004: issue mints a high-entropy token bound to exactly one session', () => {
  const reg = new TtyHookRegistry();
  const sid = 'sess-A';
  const creds = reg.issue(sid);

  // 24 random bytes → 48 hex chars. Enough entropy that guessing is infeasible.
  assert.match(creds.token, /^[0-9a-f]{48}$/,
    'token must be 48-char lowercase hex (24 random bytes)');
  assert.equal(reg.resolve(creds.token), sid,
    'freshly-minted token resolves back to its session');
  assert.equal(reg.get(sid)?.token, creds.token,
    'registry exposes the same credentials by session id');
});

test('SEC-004: re-issuing for the same session rotates the token and invalidates the old one', () => {
  const reg = new TtyHookRegistry();
  const sid = 'sess-A';
  const first = reg.issue(sid);
  const second = reg.issue(sid);

  assert.notEqual(first.token, second.token, 'second issue must produce a fresh token');
  assert.equal(reg.resolve(first.token), null,
    'old token must no longer resolve — every mode flip rotates credentials');
  assert.equal(reg.resolve(second.token), sid,
    'new token resolves to the same session');
});

test('SEC-004: revoke wipes both lookup directions (no leaked token, no orphan session entry)', () => {
  const reg = new TtyHookRegistry();
  const sid = 'sess-A';
  const creds = reg.issue(sid);

  reg.revoke(sid);
  assert.equal(reg.resolve(creds.token), null,
    'revoked token must not resolve (caller could otherwise still hit the hook endpoint)');
  assert.equal(reg.get(sid), null,
    'session→credentials lookup also cleared');

  // revoke is idempotent — safe to call on a session that has no entry.
  reg.revoke('never-issued');
  reg.revoke(sid);
});

test('SEC-004: unknown / empty / wrong-format tokens never resolve', () => {
  const reg = new TtyHookRegistry();
  reg.issue('sess-A'); // populate registry to be sure resolve isn't trivially null

  assert.equal(reg.resolve(''), null, 'empty token is rejected');
  assert.equal(reg.resolve('x'.repeat(48)), null, 'random unknown hex is rejected');
  assert.equal(reg.resolve('not-a-token'), null, 'wrong-shape token is rejected');
});

test('SEC-004: tokens are per-session — session A token must not resolve to session B', () => {
  // This is the exact assertion the hook endpoint encodes:
  //   resolvedSession !== sessionIdParam → 401
  // — see packages/host/src/web/app.ts:210-213.
  const reg = new TtyHookRegistry();
  const credsA = reg.issue('sess-A');
  const credsB = reg.issue('sess-B');

  assert.equal(reg.resolve(credsA.token), 'sess-A',
    'token A resolves to its own session only');
  assert.equal(reg.resolve(credsB.token), 'sess-B');
  assert.notEqual(reg.resolve(credsA.token), 'sess-B',
    'token A must NEVER resolve to session B — this is the cross-session boundary');
  assert.notEqual(reg.resolve(credsB.token), 'sess-A',
    'symmetric: token B must NEVER resolve to session A');

  // Simulate the app.ts hook check: caller hits /…/sess-B/Stop?t=<tokenA>.
  // The endpoint resolves the token, then compares to the URL sessionId.
  const resolved = reg.resolve(credsA.token);
  const urlSessionId = 'sess-B';
  assert.notEqual(resolved, urlSessionId,
    'cross-session token reuse — endpoint compares resolved !== urlSessionId and returns 401');
});

test('SEC-004: revoking session A does not invalidate session B credentials', () => {
  const reg = new TtyHookRegistry();
  const credsA = reg.issue('sess-A');
  const credsB = reg.issue('sess-B');

  reg.revoke('sess-A');
  assert.equal(reg.resolve(credsA.token), null);
  assert.equal(reg.resolve(credsB.token), 'sess-B',
    'unrelated session B must remain valid after revoking A');
});

test('SEC-004: re-issuing for session A leaves session B token untouched', () => {
  const reg = new TtyHookRegistry();
  reg.issue('sess-A');
  const credsB = reg.issue('sess-B');
  reg.issue('sess-A'); // rotate A

  assert.equal(reg.resolve(credsB.token), 'sess-B',
    'rotating A must not collaterally invalidate B');
});
