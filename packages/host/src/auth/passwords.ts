import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 64);
  return Promise.resolve(`${salt.toString('hex')}:${hash.toString('hex')}`);
}

export function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return Promise.resolve(false);
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  let actual: Buffer;
  try {
    actual = scryptSync(plain, salt, 64) as Buffer;
  } catch {
    return Promise.resolve(false);
  }
  if (actual.length !== expected.length) return Promise.resolve(false);
  return Promise.resolve(timingSafeEqual(actual, expected));
}
