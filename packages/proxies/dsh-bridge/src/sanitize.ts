/**
 * Bridge-side sanitization for generic/unknown events (plan §7.3):
 *
 * - secret key names, headers, credentials and environment variables are
 *   recursively redacted before anything is written to the bridge wire;
 * - `details` / `presentation.data` are truncated to 1 MiB by the Bridge
 *   BEFORE the wire write; the Proxy validates again and must not rely on the
 *   Host truncating oversized payloads afterwards.
 */

import { Buffer } from 'node:buffer';
import { MAX_DETAIL_BYTES, type BridgeJsonValue } from './schema.js';

const SENSITIVE_KEY = /(secret|token|password|passwd|credential|api[_-]?key|auth(orization)?|bearer|private[_-]?key|access[_-]?key)/i;

export const REDACTED = '[REDACTED]';

export function sanitizeKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function redact(value: unknown, key?: string, depth = 0): BridgeJsonValue {
  if (depth > 40) return REDACTED;
  if (key !== undefined && sanitizeKey(key)) return REDACTED;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, undefined, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, BridgeJsonValue> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (childValue === undefined) continue;
      out[childKey] = redact(childValue, childKey, depth + 1);
    }
    return out;
  }
  return REDACTED;
}

export function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Return a bounded, sanitized JSON projection. When `value` serializes above
 * `maxBytes`, the result is `{ truncated: true, note, preview }` where preview
 * is a capped string slice of the serialized form.
 */
export function boundedSanitized(
  value: unknown,
  maxBytes: number = MAX_DETAIL_BYTES,
): BridgeJsonValue {
  const cleaned = redact(value);
  let serialized: string;
  try {
    serialized = JSON.stringify(cleaned);
  } catch {
    return { truncated: true, note: 'payload was not JSON-serializable' };
  }
  if (serialized.length > 0 && Buffer.byteLength(serialized, 'utf8') <= maxBytes) {
    return cleaned;
  }
  // Serialize progressively smaller slices until the preview fits under the
  // budget while reserving room for the wrapper fields.
  const note = JSON.stringify({ truncated: true, note: `payload exceeded ${maxBytes} bytes` });
  const reserved = Buffer.byteLength(note, 'utf8') + 64;
  const previewBudget = Math.max(0, maxBytes - reserved);
  if (previewBudget <= 0 || serialized.length === 0) {
    return { truncated: true, note: `payload exceeded ${maxBytes} bytes` };
  }
  const asText = typeof value === 'string' ? value : serialized;
  const capped = asText.slice(0, Math.floor(previewBudget / 2));
  return {
    truncated: true,
    note: `payload exceeded ${maxBytes} bytes`,
    preview: capped,
  };
}
