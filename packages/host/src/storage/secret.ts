import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SECRET_VERSION = 'v1';

function keyPath(dataDir: string): string {
  return join(dataDir, 'secrets.key');
}

function loadOrCreateKey(dataDir: string): Buffer {
  const path = keyPath(dataDir);
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    const key = Buffer.from(existing, 'base64url');
    if (key.length === KEY_BYTES) return key;
  }

  const key = randomBytes(KEY_BYTES);
  writeFileSync(path, key.toString('base64url'), { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

export function encryptSecret(dataDir: string, value: string): string {
  const key = loadOrCreateKey(dataDir);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    SECRET_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptSecret(dataDir: string, payload: string): string {
  const [version, ivValue, tagValue, ciphertextValue] = payload.split(':');
  if (version !== SECRET_VERSION || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error('Invalid secret payload.');
  }

  const key = loadOrCreateKey(dataDir);
  const iv = Buffer.from(ivValue, 'base64url');
  const tag = Buffer.from(tagValue, 'base64url');
  const ciphertext = Buffer.from(ciphertextValue, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Invalid secret payload.');
  }

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}
