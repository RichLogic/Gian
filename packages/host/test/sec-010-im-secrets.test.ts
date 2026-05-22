// Coverage for traceability row:
//   SEC-010 — IM bot credentials must be AES-256-GCM encrypted, the key
//             file must be written 0600, tampering must fail decrypt, and
//             legacy plaintext storage must not be silently re-emitted.
//
// `packages/host/src/im/messaging/secrets.ts` is the new key-file based
// helper used by `im/{discord,slack}/secrets.ts`. The legacy plaintext
// migration / `GIAN_SECRET` fallback lives in `storage/bots.ts`; that is a
// separate dimension and stays GAP here.
//
// We use a temp key file in `os.tmpdir()` so the test never touches the
// real `~/.config/gian/discord.key` or `~/.config/gian/slack.key`. Each
// test allocates its own key path so the module-level keyPromiseByPath
// cache inside `secrets.ts` doesn't cross-pollinate between tests.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret } from '../src/im/messaging/secrets.ts';

function makeKeyDir() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-sec010-'));
  const keyPath = join(dir, `${randomBytes(8).toString('hex')}.key`);
  return {
    keyPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

test('SEC-010: encryptSecret + decryptSecret round-trips the original plaintext', async () => {
  const { keyPath, cleanup } = makeKeyDir();
  try {
    const plaintext = 'xoxb-test-bot-token-with-some-content';
    const sealed = await encryptSecret(keyPath, plaintext);
    const recovered = await decryptSecret(keyPath, sealed);
    assert.equal(recovered, plaintext);
  } finally {
    cleanup();
  }
});

test('SEC-010: ciphertext is non-deterministic (fresh IV per encrypt)', async () => {
  const { keyPath, cleanup } = makeKeyDir();
  try {
    const a = await encryptSecret(keyPath, 'same-token');
    const b = await encryptSecret(keyPath, 'same-token');
    assert.notEqual(a, b,
      'two encryptions of the same plaintext must differ — IV reuse would leak equality');
    // ...but both must still decrypt back to the same plaintext.
    assert.equal(await decryptSecret(keyPath, a), 'same-token');
    assert.equal(await decryptSecret(keyPath, b), 'same-token');
  } finally {
    cleanup();
  }
});

test('SEC-010: sealed payload format is v1:<iv>:<tag>:<ciphertext> with 4 base64url parts', async () => {
  const { keyPath, cleanup } = makeKeyDir();
  try {
    const sealed = await encryptSecret(keyPath, 'token');
    const parts = sealed.split(':');
    assert.equal(parts.length, 4, 'sealed payload must have exactly 4 colon-separated parts');
    assert.equal(parts[0], 'v1', 'version must be v1 so future formats can be distinguished');
    // base64url uses [-_A-Za-z0-9] with no padding.
    for (const part of parts.slice(1)) {
      assert.match(part, /^[A-Za-z0-9_-]+$/,
        'iv/tag/ciphertext must be base64url-encoded');
    }
  } finally {
    cleanup();
  }
});

test('SEC-010: ciphertext never contains the plaintext substring (sanity)', async () => {
  const { keyPath, cleanup } = makeKeyDir();
  try {
    const plaintext = 'PLAIN-MARKER-TOKEN-ABCXYZ';
    const sealed = await encryptSecret(keyPath, plaintext);
    assert.ok(!sealed.includes(plaintext),
      'sealed payload must not echo the plaintext back — even partially');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tampering
// ---------------------------------------------------------------------------

test('SEC-010: tampered ciphertext fails decrypt (GCM auth tag rejects modification)', async () => {
  const { keyPath, cleanup } = makeKeyDir();
  try {
    const sealed = await encryptSecret(keyPath, 'token');
    const parts = sealed.split(':');
    // Flip one byte of the ciphertext component by replacing the first char
    // with a different valid base64url char.
    const ct = parts[3]!;
    const firstChar = ct[0]!;
    const replacement = firstChar === 'A' ? 'B' : 'A';
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${replacement}${ct.slice(1)}`;
    await assert.rejects(
      () => decryptSecret(keyPath, tampered),
      /Unsupported state|auth|decrypt|tag/i,
      'AES-GCM must reject any modification to the ciphertext',
    );
  } finally {
    cleanup();
  }
});

test('SEC-010: tampered auth tag fails decrypt', async () => {
  const { keyPath, cleanup } = makeKeyDir();
  try {
    const sealed = await encryptSecret(keyPath, 'token');
    const parts = sealed.split(':');
    const tag = parts[2]!;
    const flipped = tag[0]! === 'A' ? `B${tag.slice(1)}` : `A${tag.slice(1)}`;
    const tampered = `${parts[0]}:${parts[1]}:${flipped}:${parts[3]}`;
    await assert.rejects(() => decryptSecret(keyPath, tampered),
      /Unsupported state|auth|decrypt|tag/i,
      'modifying the auth tag must fail decrypt');
  } finally {
    cleanup();
  }
});

test('SEC-010: decryptSecret with a different key file fails (cross-host secret cannot be opened)', async () => {
  // Bot DB rows are tied to a host's key file. If the file is replaced
  // (e.g. ransomware, restore from a clean state), the existing rows must
  // become opaque rather than fall back to plaintext.
  const { keyPath: keyA, cleanup: cleanupA } = makeKeyDir();
  const { keyPath: keyB, cleanup: cleanupB } = makeKeyDir();
  try {
    const sealed = await encryptSecret(keyA, 'top secret');
    await assert.rejects(() => decryptSecret(keyB, sealed),
      /Unsupported state|auth|decrypt|tag/i,
      'a payload encrypted with key A must NOT decrypt under key B');
  } finally {
    cleanupA();
    cleanupB();
  }
});

// ---------------------------------------------------------------------------
// Wire format hardening
// ---------------------------------------------------------------------------

test('SEC-010: decryptSecret rejects malformed payload shapes with a clear error', async () => {
  const { keyPath, cleanup } = makeKeyDir();
  try {
    // Wrong version
    await assert.rejects(
      () => decryptSecret(keyPath, 'v2:aaa:bbb:ccc'),
      /Invalid secret payload/,
    );
    // Missing fields
    await assert.rejects(
      () => decryptSecret(keyPath, 'v1::bbb:ccc'),
      /Invalid secret payload/,
    );
    await assert.rejects(
      () => decryptSecret(keyPath, 'v1:aaa::ccc'),
      /Invalid secret payload/,
    );
    await assert.rejects(
      () => decryptSecret(keyPath, 'v1:aaa:bbb:'),
      /Invalid secret payload/,
    );
    // Completely empty
    await assert.rejects(
      () => decryptSecret(keyPath, ''),
      /Invalid secret payload/,
    );
  } finally {
    cleanup();
  }
});

test('SEC-010: decryptSecret rejects IV / tag of the wrong byte length', async () => {
  const { keyPath, cleanup } = makeKeyDir();
  try {
    // Seal something valid first so we know the key file exists.
    const valid = await encryptSecret(keyPath, 'ok');
    const parts = valid.split(':');
    // Replace IV with 8 bytes instead of 12 (base64url-encoded).
    const shortIv = Buffer.alloc(8, 0).toString('base64url');
    await assert.rejects(
      () => decryptSecret(keyPath, `v1:${shortIv}:${parts[2]}:${parts[3]}`),
      /Invalid secret payload/,
      'IV must be exactly 12 bytes — shorter values must be rejected before decrypt',
    );
    // Replace tag with 8 bytes (must be 16).
    const shortTag = Buffer.alloc(8, 0).toString('base64url');
    await assert.rejects(
      () => decryptSecret(keyPath, `v1:${parts[1]}:${shortTag}:${parts[3]}`),
      /Invalid secret payload/,
      'auth tag must be exactly 16 bytes',
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Key file mode
// ---------------------------------------------------------------------------

test('SEC-010: the auto-generated key file is created with mode 0o600', async () => {
  const { keyPath, cleanup } = makeKeyDir();
  try {
    // First encryptSecret creates the key file lazily.
    await encryptSecret(keyPath, 'token');
    const mode = statSync(keyPath).mode & 0o777;
    assert.equal(mode, 0o600,
      `key file must be owner read/write only (0o600), got 0o${mode.toString(8)}`);
  } finally {
    cleanup();
  }
});

test('SEC-010: key file contents are a base64url-encoded 32-byte key', async () => {
  const { keyPath, cleanup } = makeKeyDir();
  try {
    await encryptSecret(keyPath, 'token');
    const content = readFileSync(keyPath, 'utf8').trim();
    assert.match(content, /^[A-Za-z0-9_-]+$/,
      'key file must be base64url with no padding/newlines');
    const decoded = Buffer.from(content, 'base64url');
    assert.equal(decoded.length, 32,
      'AES-256 key must be 32 bytes; key file decoded to wrong length');
  } finally {
    cleanup();
  }
});

test('SEC-010: an existing valid key file is reused, not overwritten', async () => {
  const { keyPath, cleanup } = makeKeyDir();
  try {
    // Seed a deterministic key so we can detect overwrite.
    const seed = randomBytes(32);
    writeFileSync(keyPath, seed.toString('base64url'), { mode: 0o600 });
    const sealed = await encryptSecret(keyPath, 'token');
    const afterContent = readFileSync(keyPath, 'utf8').trim();
    assert.equal(afterContent, seed.toString('base64url'),
      'pre-existing key file content must NOT be overwritten on first use');
    assert.equal(await decryptSecret(keyPath, sealed), 'token',
      'round-trip still works with the pre-seeded key');
  } finally {
    cleanup();
  }
});

test('SEC-010: a wrong-length key file is replaced with a fresh 32-byte key', async () => {
  // The loader checks `key.length === KEY_BYTES`. Anything else (corrupted
  // file, accidental string write, leftover from an old version) must
  // be regenerated rather than silently truncated/padded.
  const { keyPath, cleanup } = makeKeyDir();
  try {
    writeFileSync(keyPath, Buffer.alloc(16, 7).toString('base64url'), { mode: 0o600 });
    await encryptSecret(keyPath, 'token');
    const replaced = readFileSync(keyPath, 'utf8').trim();
    const decoded = Buffer.from(replaced, 'base64url');
    assert.equal(decoded.length, 32,
      'short / wrong-length key file must be regenerated to 32 bytes on next use');
  } finally {
    cleanup();
  }
});
