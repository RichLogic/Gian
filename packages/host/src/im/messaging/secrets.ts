import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';

import { ensureDataDir } from '../config.js';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SECRET_VERSION = 'v1';

const keyPromiseByPath = new Map<string, Promise<Buffer>>();

async function loadOrCreateKey(keyFilePath: string) {
  await ensureDataDir();
  try {
    const existing = (await readFile(keyFilePath, 'utf8')).trim();
    const key = Buffer.from(existing, 'base64url');
    if (key.length === KEY_BYTES) {
      return key;
    }
  } catch {
    // Fall through and create a new key.
  }

  const nextKey = randomBytes(KEY_BYTES);
  await writeFile(keyFilePath, nextKey.toString('base64url'), { mode: 0o600 });
  await chmod(keyFilePath, 0o600);
  return nextKey;
}

function getKey(keyFilePath: string) {
  let promise = keyPromiseByPath.get(keyFilePath);
  if (!promise) {
    promise = loadOrCreateKey(keyFilePath);
    keyPromiseByPath.set(keyFilePath, promise);
  }
  return promise;
}

export async function encryptSecret(keyFilePath: string, value: string) {
  const key = await getKey(keyFilePath);
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

export async function decryptSecret(keyFilePath: string, payload: string) {
  const [version, ivValue, tagValue, ciphertextValue] = payload.split(':');
  if (version !== SECRET_VERSION || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error('Invalid secret payload.');
  }

  const key = await getKey(keyFilePath);
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
