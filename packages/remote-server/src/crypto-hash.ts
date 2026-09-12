import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const DUMMY_HASH = createHash('sha256').update('gian-remote-dummy').digest('hex');

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashesEqual(actual: string | undefined, expected: string | undefined): boolean {
  const left = Buffer.from(actual && /^[0-9a-f]{64}$/.test(actual) ? actual : DUMMY_HASH, 'hex');
  const right = Buffer.from(expected && /^[0-9a-f]{64}$/.test(expected) ? expected : DUMMY_HASH, 'hex');
  return timingSafeEqual(left, right) && Boolean(actual) && Boolean(expected);
}
