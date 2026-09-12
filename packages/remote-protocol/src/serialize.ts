import { SHA256_HEX_LENGTH } from './constants.js';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error('Expected canonical base64url.');
  }
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const padLength = (4 - (padded.length % 4)) % 4;
  const binary = atob(`${padded}${'='.repeat(padLength)}`);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function canonicalize(value: unknown): JsonValue {
  if (value === undefined) {
    throw new Error('Canonical JSON cannot contain undefined.');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON numbers must be finite.');
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined) continue;
      out[key] = canonicalize(entry);
    }
    return out;
  }
  throw new Error('Canonical JSON cannot contain non-JSON values.');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function asBufferSource(data: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export async function sha256Bytes(data: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', asBufferSource(data)));
}

export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
  const digest = await sha256Bytes(data);
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function canonicalSha256Hex(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson(value)));
}

export function assertSha256Hex(value: string): string {
  if (!new RegExp(`^[0-9a-f]{${SHA256_HEX_LENGTH}}$`).test(value)) {
    throw new Error('Expected lowercase SHA-256 hex.');
  }
  return value;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function writeUint64Be(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Expected a non-negative safe integer.');
  }
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Math.floor(value / 0x1_0000_0000), false);
  view.setUint32(4, value >>> 0, false);
  return bytes;
}
