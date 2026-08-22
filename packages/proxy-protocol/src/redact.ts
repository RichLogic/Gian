const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_SEGMENTS = new Set([
  'resumeref',
  'resume_ref',
  'resume_ref_id',
  'resumerefid',
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'credential',
  'api_key',
  'apikey',
]);

function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

export function isSensitiveProtocolKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SENSITIVE_KEY_SEGMENTS.has(normalized.replace(/s$/, ''))) return true;
  return normalized.split('_').some((segment) => SENSITIVE_KEY_SEGMENTS.has(segment));
}

export function redactSensitiveProtocolValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveProtocolText(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveProtocolValue(entry));
  }
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveProtocolKey(key) ? REDACTED : redactSensitiveProtocolValue(entry);
  }
  return out;
}

function matchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escape = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

const RESUME_REF_KEY = 'resumeRefId|resume_ref_id|resumeRef|resume_ref';

function redactResumeRefValues(text: string): string {
  const keyRe = new RegExp(`(["']?(?:${RESUME_REF_KEY})["']?)\\s*:\\s*`, 'gi');
  let output = '';
  let lastIndex = 0;
  let match = keyRe.exec(text);
  while (match) {
    const valueStart = match.index + match[0].length;
    const opener = text[valueStart];
    output += `${text.slice(lastIndex, match.index)}${match[0]}`;
    if (opener === '{') {
      const end = matchingBrace(text, valueStart);
      output += `{"id":"${REDACTED}"}`;
      lastIndex = end === -1 ? text.length : end + 1;
    } else if (opener === '"' || opener === "'") {
      const closer = text.indexOf(opener, valueStart + 1);
      output += `${opener}${REDACTED}${opener}`;
      lastIndex = closer === -1 ? text.length : closer + 1;
    } else {
      const token = text.slice(valueStart).match(/^[^\s,}\]]+/);
      output += REDACTED;
      lastIndex = token ? valueStart + token[0].length : text.length;
    }
    keyRe.lastIndex = lastIndex;
    match = keyRe.exec(text);
  }
  return output + text.slice(lastIndex);
}

export function redactSensitiveProtocolText(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(redactSensitiveProtocolValue(JSON.parse(trimmed)));
    } catch {
      // Fall through to fragment redaction for invalid or partial JSON.
    }
  }
  return redactResumeRefValues(input)
    .replace(/([?&](?:resumeRef|resume_ref)=)[^&#\s]+/gi, `$1${REDACTED}`);
}
