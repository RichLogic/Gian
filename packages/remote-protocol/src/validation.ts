import { z } from 'zod';

import {
  AUTH_PROTOCOL,
  COMMAND_RETENTION_MS,
  COMMAND_TIMESTAMP_SKEW_MS,
  CROCKFORD_ALPHABET,
  MAX_ID_CHARS,
  MAX_NAME_CHARS,
  MAX_STRING_CHARS,
  PAIRING_CODE_LENGTH,
  RELAY_PROTOCOL,
  REMOTE_PROTOCOL,
  SHA256_HEX_LENGTH,
} from './constants.js';
import { RemoteProtocolError } from './errors.js';
import { utf8ByteLength } from './serialize.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64_RE = new RegExp(`^[0-9a-f]{${SHA256_HEX_LENGTH}}$`);
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const WIRE_FEATURE_RE = /^wire\.[a-z0-9_]+$/;

export const safeIntegerSchema = z.number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

export const nonNegativeSafeIntegerSchema = safeIntegerSchema.min(0);
export const positiveSafeIntegerSchema = safeIntegerSchema.min(1);

export const boundedStringSchema = z.string().min(1).max(MAX_STRING_CHARS);
export const nameSchema = z.string().min(1).max(MAX_NAME_CHARS);

export const canonicalIdSchema = z.string()
  .min(1)
  .max(MAX_ID_CHARS)
  .regex(UUID_RE, 'Expected a canonical lowercase UUID.');

export const uuidV7Schema = z.string()
  .regex(UUID_V7_RE, 'Expected a canonical lowercase UUIDv7.');

export const sha256HexSchema = z.string().regex(HEX64_RE, 'Expected lowercase SHA-256 hex.');

export const base64UrlSchema = z.string().regex(BASE64URL_RE, 'Expected canonical base64url.');

export const unixMsSchema = nonNegativeSafeIntegerSchema;

export const p256PublicJwkSchema = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: base64UrlSchema,
  y: base64UrlSchema,
});

export const authProtocolSchema = z.literal(AUTH_PROTOCOL);
export const relayProtocolSchema = z.literal(RELAY_PROTOCOL);
export const remoteProtocolSchema = z.literal(REMOTE_PROTOCOL);
export const wireFeatureIdSchema = z.string().regex(WIRE_FEATURE_RE);

export function uuidV7TimestampMs(commandId: string): number {
  const hex = commandId.replaceAll('-', '').slice(0, 12);
  return Number.parseInt(hex, 16);
}

export function validateCommandIdentity(
  commandId: string,
  createdAt: number,
  now: number,
): void {
  const parsed = uuidV7Schema.safeParse(commandId);
  if (!parsed.success) {
    throw new RemoteProtocolError('COMMAND_EXPIRED', 'command_id must be a canonical UUIDv7.');
  }
  const timestamp = uuidV7TimestampMs(commandId);
  if (Math.abs(timestamp - createdAt) > COMMAND_TIMESTAMP_SKEW_MS) {
    throw new RemoteProtocolError(
      'COMMAND_EXPIRED',
      'command_id timestamp must match created_at.',
    );
  }
  if (timestamp - now > COMMAND_TIMESTAMP_SKEW_MS || createdAt - now > COMMAND_TIMESTAMP_SKEW_MS) {
    throw new RemoteProtocolError(
      'COMMAND_EXPIRED',
      'command_id timestamp is in the future.',
    );
  }
  if (now - createdAt > COMMAND_RETENTION_MS || now - timestamp > COMMAND_RETENTION_MS) {
    throw new RemoteProtocolError('COMMAND_EXPIRED', 'command_id is outside the 90-day window.');
  }
}

export function normalizePairingCode(input: string): string {
  const mapped = input
    .trim()
    .toUpperCase()
    .replace(/[-\s]/g, '')
    .replaceAll('I', '1')
    .replaceAll('L', '1')
    .replaceAll('O', '0');
  if (mapped.includes('U') || mapped.length !== PAIRING_CODE_LENGTH) {
    throw new RemoteProtocolError('AUTH_REQUIRED', 'pairing code is not canonical.');
  }
  for (const char of mapped) {
    if (!CROCKFORD_ALPHABET.includes(char)) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'pairing code is not canonical.');
    }
  }
  return mapped;
}

export function formatPairingCode(normalized: string): string {
  const code = normalizePairingCode(normalized);
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function assertUtf8Limit(value: string, maxBytes: number, code: 'FRAME_TOO_LARGE' | 'INVALID_FRAME' = 'FRAME_TOO_LARGE'): void {
  if (utf8ByteLength(value) > maxBytes) {
    throw new RemoteProtocolError(code, 'value exceeds the UTF-8 byte limit.');
  }
}

export function assertByteLimit(byteLength: number, maxBytes: number): void {
  if (byteLength > maxBytes) {
    throw new RemoteProtocolError('FRAME_TOO_LARGE', 'value exceeds the byte limit.');
  }
}

export function generateCanonicalId(): string {
  return crypto.randomUUID();
}

export function generateUuidV7(now = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let timestamp = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parseClosed<T>(schema: z.ZodType<T>, value: unknown, code: 'INVALID_FRAME' | 'AUTH_REQUIRED' = 'INVALID_FRAME'): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RemoteProtocolError(code, 'closed schema validation failed.');
  }
  return parsed.data;
}
