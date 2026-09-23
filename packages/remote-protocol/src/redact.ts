const REDACTED = '[REDACTED]';

const SENSITIVE_SEGMENTS = new Set([
  'token',
  'cookie',
  'authorization',
  'password',
  'passwd',
  'secret',
  'ciphertext',
  'code',
  'pairing_code',
  'enrollment_token',
  'refresh',
  'refresh_token',
  'access_token',
  'ws_ticket',
  'ticket',
  'key',
  'private_key',
  'public_key',
  'signature',
  'challenge',
  'prompt',
  'path',
  'stack',
  'body',
]);

function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

export function isSensitiveRemoteKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SENSITIVE_SEGMENTS.has(normalized)) return true;
  return normalized.split('_').some((segment) => SENSITIVE_SEGMENTS.has(segment));
}

/** Conversation content is not a log: length alone does not identify a secret. */
export function redactRemoteConversationText(input: string): string {
  return input
    .replace(/(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/(Cookie\s*:\s*)[^\r\n]+/gi, `$1${REDACTED}`)
    .replace(/((?:refresh|access|enrollment|connector)[_-]?token\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, `$1${REDACTED}`)
    .replace(/((?:pairing[_-]?code|grant[_-]?nonce|ws[_-]?ticket|ciphertext)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, `$1${REDACTED}`)
    .replace(/((?:api[_-]?key|password|passwd|client[_-]?secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, `$1${REDACTED}`)
    .replace(/(["'](?:access_token|refresh_token|enrollment_token|connector_token|pairing_code|grant_nonce|ws_ticket|ciphertext|api_key|password|passwd|secret|private_key)["']\s*:\s*["'])(.*?)(["'])/gi, `$1${REDACTED}$3`)
    .replace(/\b(?:github_pat_|gh[pousr]_|sk-ant-|sk-|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g, REDACTED);
}

export function redactRemoteText(input: string): string {
  return redactRemoteConversationText(input)
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, REDACTED)
    .replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, REDACTED);
}

export function redactRemoteValue(value: unknown): unknown {
  if (typeof value === 'string') return redactRemoteText(value);
  if (Array.isArray(value)) return value.map((entry) => redactRemoteValue(entry));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveRemoteKey(key) ? REDACTED : redactRemoteValue(entry);
  }
  return out;
}

export function redactRemoteError(error: unknown): string {
  if (error instanceof Error) return redactRemoteText(error.message);
  return redactRemoteText(String(error));
}
