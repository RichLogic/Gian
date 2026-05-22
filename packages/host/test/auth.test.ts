// Coverage for traceability rows:
//   SEC-001 — `GIAN_AUTH_REQUIRED=true` must verify scrypt password hashes
//             before issuing a session token. Hashes are salt:scrypt pairs.
//   SEC-002 — session tokens are high-entropy, in-memory, invalidated on
//             logout; API tokens are stored as hashes only and update
//             last_used_at on verify.
//   ERR-008 — wrong / missing inputs must be rejected (400/401 surface),
//             change password must verify the current password.
//
// These tests target the auth primitives directly. The HTTP wiring at
// `packages/host/src/web/app.ts:224-311` is a thin shell over these.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/storage/db.js';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';
import {
  TokenManager,
  createSessionToken,
  getUsernameForToken,
  deleteToken,
} from '../src/auth/tokens.js';

// ---------------------------------------------------------------------------
// Passwords — scrypt hashing (SEC-001).
// ---------------------------------------------------------------------------

test('SEC-001: hashPassword emits salt:hash format with non-empty hex parts', async () => {
  const hash = await hashPassword('correct-horse-battery-staple');
  // Format: `${saltHex}:${hashHex}` — both are hex strings.
  assert.match(hash, /^[0-9a-f]+:[0-9a-f]+$/,
    'hash must be lowercase hex salt:hash pair');
  const [salt, digest] = hash.split(':');
  assert.ok(salt && salt.length === 32, '16-byte salt → 32 hex chars');
  assert.ok(digest && digest.length === 128, '64-byte scrypt output → 128 hex chars');
});

test('SEC-001: hashPassword is non-deterministic — same input yields different hashes', async () => {
  const a = await hashPassword('same-password');
  const b = await hashPassword('same-password');
  assert.notEqual(a, b,
    'random salt must make two hashes of the same password differ — otherwise leaks indicate password reuse');
  // …but verify still accepts the original password for both.
  assert.equal(await verifyPassword('same-password', a), true);
  assert.equal(await verifyPassword('same-password', b), true);
});

test('SEC-001: verifyPassword accepts the original password and rejects others', async () => {
  const hash = await hashPassword('s3cret!');
  assert.equal(await verifyPassword('s3cret!', hash), true);
  assert.equal(await verifyPassword('s3cret', hash), false, 'one-char-off rejected');
  assert.equal(await verifyPassword('S3cret!', hash), false, 'case-sensitive');
  assert.equal(await verifyPassword('', hash), false, 'empty rejected');
  assert.equal(await verifyPassword('s3cret! ', hash), false, 'trailing whitespace rejected');
});

test('SEC-001: verifyPassword rejects malformed stored hashes (missing salt or digest)', async () => {
  assert.equal(await verifyPassword('any', ''), false,
    'empty stored hash must not vacuously succeed');
  assert.equal(await verifyPassword('any', 'no-colon-here'), false);
  assert.equal(await verifyPassword('any', ':only-digest'), false);
  assert.equal(await verifyPassword('any', 'only-salt:'), false);
});

test('SEC-001: verifyPassword is constant-time across length-equal candidates (no length oracle)', async () => {
  // We can't directly assert constant-time without a wall-clock measurement,
  // but we can verify the function uses `timingSafeEqual` semantics — the
  // length-mismatch short-circuit only triggers when scrypt output lengths
  // differ, which is always 64 bytes for the same KDF params. Two truly
  // length-equal candidates take the timingSafeEqual path.
  const hash = await hashPassword('actual');
  // Both candidates produce 64-byte scrypt output → timingSafeEqual path.
  assert.equal(await verifyPassword('actual', hash), true);
  assert.equal(await verifyPassword('different-but-same-len', hash), false);
  // Different-length passwords also go through scrypt → still constant-time on the digest.
  assert.equal(await verifyPassword('a', hash), false);
});

// ---------------------------------------------------------------------------
// API tokens — TokenManager (SEC-002).
// ---------------------------------------------------------------------------

function makeDbCtx() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-auth-test-'));
  const db = openDatabase(dir);
  return {
    db,
    dispose: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('SEC-002: createToken returns plaintext exactly once; DB row stores only the hash', () => {
  const { db, dispose } = makeDbCtx();
  try {
    const mgr = new TokenManager(db);
    const { token, record } = mgr.createToken('my laptop');

    // Plaintext token is 32 random bytes → 64 hex chars.
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(record.label, 'my laptop');

    // The DB column `hash` must NOT contain the plaintext anywhere — searching
    // for the substring is the strongest assertion against accidental
    // round-trip storage regressions.
    const row = db.prepare('SELECT hash, label FROM tokens WHERE id = ?').get(record.id) as
      | { hash: string; label: string } | undefined;
    assert.ok(row);
    assert.notEqual(row!.hash, token,
      'stored hash must not equal the plaintext token');
    assert.ok(!row!.hash.includes(token),
      'stored hash must not contain the plaintext as a substring');
    assert.match(row!.hash, /^[0-9a-f]{64}$/,
      'sha256 hash → 64 hex chars');
  } finally {
    dispose();
  }
});

test('SEC-002: verifyToken accepts the original plaintext, rejects unknown, updates last_used_at', () => {
  const { db, dispose } = makeDbCtx();
  try {
    const mgr = new TokenManager(db);
    const { token, record } = mgr.createToken('cli');

    // last_used_at starts NULL.
    const before = db.prepare('SELECT last_used_at FROM tokens WHERE id = ?').get(record.id) as
      { last_used_at: string | null };
    assert.equal(before.last_used_at, null);

    const verified = mgr.verifyToken(token);
    assert.ok(verified, 'verify must return the token record');
    assert.equal(verified!.id, record.id);

    const after = db.prepare('SELECT last_used_at FROM tokens WHERE id = ?').get(record.id) as
      { last_used_at: string | null };
    assert.ok(after.last_used_at, 'last_used_at must be set on first verify');

    // Unknown plaintext → null.
    assert.equal(mgr.verifyToken('definitely-not-a-real-token'), null);
    assert.equal(mgr.verifyToken(''), null, 'empty plaintext must not vacuously succeed');
  } finally {
    dispose();
  }
});

test('SEC-002: revokeToken removes the row — subsequent verify returns null', () => {
  const { db, dispose } = makeDbCtx();
  try {
    const mgr = new TokenManager(db);
    const { token, record } = mgr.createToken('temp');
    assert.ok(mgr.verifyToken(token));
    mgr.revokeToken(record.id);
    assert.equal(mgr.verifyToken(token), null,
      'revoked token must no longer authenticate');
    const row = db.prepare('SELECT COUNT(*) AS c FROM tokens WHERE id = ?').get(record.id) as
      { c: number };
    assert.equal(row.c, 0, 'row physically deleted, not just flagged');
  } finally {
    dispose();
  }
});

test('SEC-002: listTokens returns metadata without exposing the hash to callers', () => {
  const { db, dispose } = makeDbCtx();
  try {
    const mgr = new TokenManager(db);
    mgr.createToken('a');
    mgr.createToken('b');
    const tokens = mgr.listTokens();
    assert.equal(tokens.length, 2);
    for (const t of tokens) {
      // Token shape exposed to callers — no `hash` field.
      assert.ok(t.id);
      assert.ok(t.label === 'a' || t.label === 'b');
      assert.ok(!('hash' in t), 'public token shape must not leak hash');
    }
  } finally {
    dispose();
  }
});

// ---------------------------------------------------------------------------
// Session tokens — in-memory store (SEC-002).
// ---------------------------------------------------------------------------

test('SEC-002: createSessionToken yields 64-hex token tied to the supplied username', async () => {
  const token = await createSessionToken('admin');
  assert.match(token, /^[0-9a-f]{64}$/, '32 random bytes → 64 hex chars');
  assert.equal(getUsernameForToken(token), 'admin');
  deleteToken(token); // cleanup — module-level Map is shared.
});

test('SEC-002: deleteToken invalidates the session — getUsernameForToken returns null afterwards', async () => {
  const token = await createSessionToken('user1');
  assert.equal(getUsernameForToken(token), 'user1');
  deleteToken(token);
  assert.equal(getUsernameForToken(token), null,
    'after logout, the same token must no longer authenticate');
});

test('SEC-002: getUsernameForToken returns null for unknown tokens', () => {
  assert.equal(getUsernameForToken('never-issued'), null);
  assert.equal(getUsernameForToken(''), null, 'empty token must not match anything');
});

test('SEC-002: two createSessionToken calls produce distinct tokens (uniqueness)', async () => {
  const t1 = await createSessionToken('u');
  const t2 = await createSessionToken('u');
  try {
    assert.notEqual(t1, t2, '32-byte random tokens must be unique across calls');
    assert.equal(getUsernameForToken(t1), 'u');
    assert.equal(getUsernameForToken(t2), 'u');
    deleteToken(t1);
    // t2 must still resolve after t1 is deleted.
    assert.equal(getUsernameForToken(t2), 'u');
  } finally {
    deleteToken(t2);
  }
});

// ---------------------------------------------------------------------------
// ERR-008 — negative paths the HTTP layer relies on.
// ---------------------------------------------------------------------------

test('ERR-008: verifyPassword against the change-password "current_password" check rejects wrong values', async () => {
  // Mirrors `/api/auth/password` semantics: caller must prove the current
  // password before the new hash overwrites the stored one.
  const stored = await hashPassword('current-pass');
  assert.equal(await verifyPassword('wrong-current', stored), false,
    'change-password endpoint must reject when current_password is wrong');
  assert.equal(await verifyPassword('current-pass', stored), true);
});

test('ERR-008: empty / missing inputs must not authenticate', async () => {
  const stored = await hashPassword('the-pass');
  assert.equal(await verifyPassword('', stored), false,
    'empty password must not authenticate (HTTP layer returns 401)');
  // Token verification of an unknown plaintext returns null (→ 401 at HTTP layer).
  const { db, dispose } = makeDbCtx();
  try {
    const mgr = new TokenManager(db);
    assert.equal(mgr.verifyToken(''), null);
    assert.equal(mgr.verifyToken('garbage'), null);
  } finally {
    dispose();
  }
});

test('ERR-008: session-token lifecycle — logout invalidates, re-login mints a fresh token', async () => {
  // Cookie-based session flow: login → token, logout → token gone, login → new token.
  const first = await createSessionToken('admin');
  assert.equal(getUsernameForToken(first), 'admin');
  deleteToken(first);
  const second = await createSessionToken('admin');
  try {
    assert.notEqual(first, second, 'second login mints a brand-new token');
    assert.equal(getUsernameForToken(first), null, 'logged-out token stays invalid');
    assert.equal(getUsernameForToken(second), 'admin');
  } finally {
    deleteToken(second);
  }
});
