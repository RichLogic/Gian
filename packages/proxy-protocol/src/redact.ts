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

/** Any scheme with an authority (`https://`, `wss://`, …). Only tokens that
 *  actually carry an authority are treated as URLs, so ordinary prose with a
 *  bare `host:port` or `mailto:` never gets mangled. */
const URL_TOKEN_RE = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>)\]}]+/g;

/** Strip query strings, fragments, and userinfo from a display summary. The
 *  bare origin/path is kept so the target stays recognizable without leaking
 *  `?token=…`, `#fragment`, or `user:pass@` credential material (Contract
 *  §8.1). Userinfo is credentials, never a displayable target part. Works for
 *  every scheme with an authority (http/https/wss/…); malformed URLs fall
 *  back to a conservative character-level strip. */
export function redactCustomizationTarget(input: string): string {
  return input.replace(URL_TOKEN_RE, (token) => {
    // Cut query/fragment first: the character-level cut applies to every
    // scheme and never needs a successful parse.
    const cut = token.search(/[?#]/);
    const base = cut === -1 ? token : token.slice(0, cut);
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch {
      // Malformed URL: conservative fallback — strip any userinfo-like
      // segment after the scheme, keep the remainder readable.
      const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(.*)$/.exec(base);
      if (!match) return base;
      const at = match[2]!.indexOf('@');
      if (at === -1) return base;
      return `${match[1]}${REDACTED}@${match[2]!.slice(at + 1)}`;
    }
    if (parsed.username || parsed.password) {
      const authority = parsed.host; // includes any port
      return `${parsed.protocol}//${REDACTED}@${authority}${parsed.pathname}`;
    }
    return base;
  });
}

const COMMON_SECRET_VALUE_RE = /[A-Za-z0-9._~+/-]{12,}={0,2}/g;

/** Two-pass text redaction for Customization wire fields: sensitive-key
 *  protocol redaction first, then URL query/fragment stripping, then common
 *  inline credential shapes (Bearer/Basic tokens) and `key=value` secrets. */
export function redactCustomizationText(input: string): string {
  const base = redactCustomizationTarget(redactSensitiveProtocolText(input));
  const withBearers = base.replace(
    /\b(?:Bearer|bearer|Basic|basic)\s+[A-Za-z0-9._~+/=-]{8,}/g,
    `Bearer ${REDACTED}`,
  );
  return withBearers.replace(
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|token)=[A-Za-z0-9._~+/=-]{8,}/gi,
    (match) => `${match.split('=')[0]}=${REDACTED}`,
  );
}
void COMMON_SECRET_VALUE_RE;

/** Structural redaction for Customization wire values (Host second layer):
 *  sensitive keys become [REDACTED], every string passes through
 *  `redactCustomizationText`. */
export function redactCustomizationValue(value: unknown): unknown {
  if (typeof value === 'string') return redactCustomizationText(value);
  if (Array.isArray(value)) return value.map((entry) => redactCustomizationValue(entry));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveProtocolKey(key) ? REDACTED : redactCustomizationValue(entry);
  }
  return out;
}

const CREDENTIAL_FLAG_RE = /^--?([\w-]*)?(?:token|api[_-]?key|secret|password|passwd|auth|authorization|header|cookie|bearer|credential|key)[\w-]*(?:=(.*))?$/i;

/** Redact credential-bearing command arguments. Values behind known
 *  credential flags (`--token x`, `--api-key=y`) and `key=value` arguments
 *  whose key looks sensitive are replaced; everything else survives so the
 *  sanitized config view stays recognizable (Contract §8.1, §4.8). */
export function redactCredentialArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const flagged = CREDENTIAL_FLAG_RE.exec(arg);
    if (flagged) {
      if (flagged[2] !== undefined) {
        out.push(`${arg.split('=')[0]}=${REDACTED}`);
        continue;
      }
      // Keep the flag visible; redact the following value argument.
      out.push(arg);
      const next = args[index + 1];
      if (next !== undefined && !/^--?[A-Za-z0-9]/.test(next)) {
        out.push(REDACTED);
        index += 1;
      }
      continue;
    }
    const pair = /^([A-Za-z_][A-Za-z0-9_.-]*)=(.*)$/.exec(arg);
    if (pair && isSensitiveProtocolKey(pair[1]!)) {
      out.push(`${pair[1]}=${REDACTED}`);
      continue;
    }
    out.push(arg);
  }
  return out;
}

const SHELL_CREDENTIAL_TOKEN_RE = /(--?[\w.:/-]*?(?:token|api[_-]?key|secret|password|passwd|auth|authorization|header|cookie|bearer|credential)[\w.:/-]*?)(=)([^\s"'`;|&]+)/gi;

/** `KEY=value` environment assignments whose key carries a sensitive segment
 *  (`API_TOKEN=…`, `export GH_TOKEN=…`). The value — quoted or bare — is
 *  redacted so a command string never carries credentials into a stable id,
 *  the wire, or a detail view. */
const SHELL_ENV_ASSIGNMENT_RE = /(^|[;\s|&])([A-Za-z_][A-Za-z0-9_.-]*)(=)(?:"[^"]*"|'[^']*'|[^\s"'`;|&]+)/g;

/** Redact credential-shaped tokens inside a shell command string while
 *  keeping the rest readable (used for Hook target summaries and sanitized
 *  config views; full commands never reach the wire for prompt handlers). */
export function redactShellCommandText(command: string): string {
  const withPairs = command.replace(
    SHELL_CREDENTIAL_TOKEN_RE,
    `$1=${REDACTED}`,
  );
  const withEnvAssignments = withPairs.replace(
    SHELL_ENV_ASSIGNMENT_RE,
    (match, prefix: string, key: string, eq: string) => (
      isSensitiveProtocolKey(key) ? `${prefix}${key}${eq}${REDACTED}` : match
    ),
  );
  const withValueArgs = withEnvAssignments.replace(
    /(--?[\w.:/-]*?(?:token|api[_-]?key|secret|password|passwd|auth|authorization|header|cookie|bearer|credential)[\w.:/-]*?)\s+((?:"[^"]*")|(?:'[^']*')|(?:[^\s"'`;|&]+))/gi,
    (match, flag: string, value: string) => {
      const quoted = value.startsWith('"') || value.startsWith("'");
      const inner = quoted ? value.slice(1, -1) : value;
      if (inner === '') return match;
      if (!quoted && /^--?[\w:./-]+$/.test(inner)) return match;
      if (quoted && /^--?[\w:./-]+$/.test(inner)) return match;
      return `${flag} ${quoted ? value[0] : ''}${REDACTED}${quoted ? value[value.length - 1] : ''}`;
    },
  );
  return withValueArgs.replace(
    /\b(?:Bearer|bearer|Basic|basic)\s+[^\s"'`;|&]+/g,
    `Bearer ${REDACTED}`,
  );
}
