import type { McpServer } from '@agentclientprotocol/sdk';
import { hostServiceDescriptorSchema, type DomainCode } from '@gian/proxy-protocol';

/**
 * Converts Host `hostServices` into ACP HTTP MCP servers.
 *
 * Official ACP 1.3.0 (`mcp_servers.merge_mcp_servers`) still loads
 * `<GEMINI_HOME|/~/.gemini>/config/mcp_config.json` and lets a client entry
 * replace a global entry with the same name. Admin MCP disable drops every
 * custom server before that merge; an oauth-business allowlist runs after it.
 * This function does not read that file, apply that merge, or write config.
 * An empty result is not host-only isolation.
 */
const REDACTED = '[REDACTED]';

const SENSITIVE_EXACT = new Set([
  'authorization',
  'proxy_authorization',
  'cookie',
  'set_cookie',
  'password',
  'passwd',
  'secret',
  'credential',
  'credentials',
  'header',
  'headers',
  'bearer',
  'api_key',
  'apikey',
  'x_api_key',
  'private_key',
  'client_secret',
]);

const SENSITIVE_SEGMENTS = new Set([
  'token',
  'password',
  'passwd',
  'secret',
  'credential',
  'credentials',
  'authorization',
  'cookie',
  'bearer',
  'apikey',
]);

export class McpDescriptorError extends Error {
  readonly index: number | null;
  readonly domainCode: DomainCode = 'CONFIG_VALUE_INVALID';
  readonly retryable = false;

  constructor(message: string, index: number | null = null) {
    super(message);
    this.name = 'McpDescriptorError';
    this.index = index;
  }
}

function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

const ENV_PAYLOAD_KEYS = new Set(['env', 'environ', 'environment']);
const HEADER_BAG_KEYS = new Set(['header', 'headers']);

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SENSITIVE_EXACT.has(normalized)) return true;
  return normalized.split('_').filter((segment) => segment.length > 0)
    .some((segment) => SENSITIVE_SEGMENTS.has(segment));
}

function isEnvPayloadKey(key: string): boolean {
  return ENV_PAYLOAD_KEYS.has(normalizeKey(key));
}

function isHeaderBagKey(key: string): boolean {
  return HEADER_BAG_KEYS.has(normalizeKey(key));
}

function redactString(input: string): string {
  const withoutUserinfo = input.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,
    `$1${REDACTED}@`,
  );
  const withoutQuery = withoutUserinfo.replace(
    /([?&#](?:token|access_token|refresh_token|id_token|api_key|apikey|secret|password|auth|authorization|key|code_verifier|code_challenge|code|state)=)[^&#\s]*/gi,
    `$1${REDACTED}`,
  );
  return withoutQuery.replace(/\b(Bearer|Basic)\s+\S+/gi, `$1 ${REDACTED}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNamedHeaderEntry(value: Record<string, unknown>): boolean {
  if (typeof value.name !== 'string' || !('value' in value)) return false;
  return Object.keys(value).every((key) => key === 'name' || key === 'value' || key === '_meta');
}

/** Header bags keep names and redact every string value, including innocuous ones. */
function redactHeaderBag(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return REDACTED;
  if (typeof value === 'function') return null;
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactHeaderBag(entry, seen));
  const named = isRecord(value) && isNamedHeaderEntry(value);
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (named && key === 'name' && typeof entry === 'string') {
      redacted.name = entry;
      continue;
    }
    if (typeof entry === 'string') {
      redacted[key] = REDACTED;
      continue;
    }
    redacted[key] = redactHeaderBag(entry, seen);
  }
  return redacted;
}

/** Credential objects keep their keys and drop every nested string. */
function redactSecretPayload(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return REDACTED;
  if (typeof value === 'function') return null;
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactSecretPayload(entry, seen));
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = redactSecretPayload(entry, seen);
  }
  return redacted;
}

function redactSensitive(entry: unknown, seen: WeakSet<object>): unknown {
  if (typeof entry === 'string') return REDACTED;
  if (typeof entry === 'number' || typeof entry === 'boolean' || entry === null) return entry;
  if (typeof entry === 'function') return null;
  return redactSecretPayload(entry, seen);
}

function namedCredentialHeader(value: Record<string, unknown>, seen: WeakSet<object>): Record<string, unknown> | null {
  if (!isNamedHeaderEntry(value) || typeof value.name !== 'string' || !isSensitiveKey(value.name)) return null;
  const redacted: Record<string, unknown> = {
    name: value.name,
    value: redactSensitive(value.value, seen),
  };
  if ('_meta' in value) redacted._meta = redactValue(value._meta, seen);
  return redacted;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'function') return null;
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen));
  const named = isRecord(value) ? namedCredentialHeader(value, seen) : null;
  if (named) return named;
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isEnvPayloadKey(key)) {
      redacted[key] = REDACTED;
      continue;
    }
    if (isHeaderBagKey(key)) {
      redacted[key] = redactHeaderBag(entry, seen);
      continue;
    }
    if (isSensitiveKey(key)) {
      redacted[key] = redactSensitive(entry, seen);
      continue;
    }
    redacted[key] = redactValue(entry, seen);
  }
  return redacted;
}

export function redactRuntimeData(value: unknown): unknown {
  return redactValue(value, new WeakSet());
}

export function toAcpMcpServers(hostServices: unknown): Array<Extract<McpServer, { type: 'http' }>> {
  if (!Array.isArray(hostServices)) {
    throw new McpDescriptorError('hostServices must be a list of Streamable HTTP MCP descriptors.');
  }
  const servers: Array<Extract<McpServer, { type: 'http' }>> = [];
  const seen = new Set<string>();
  for (let index = 0; index < hostServices.length; index += 1) {
    const parsed = hostServiceDescriptorSchema.safeParse(hostServices[index]);
    if (!parsed.success) {
      throw new McpDescriptorError(
        `hostServices[${index}] is not an allowed Streamable HTTP MCP descriptor.`,
        index,
      );
    }
    if (seen.has(parsed.data.id)) {
      const shown = redactRuntimeData(parsed.data.id);
      const id = typeof shown === 'string' ? shown : parsed.data.id;
      throw new McpDescriptorError(
        `hostServices contains duplicate MCP server id '${id}'.`,
        index,
      );
    }
    seen.add(parsed.data.id);
    const headers = Object.entries(parsed.data.transport.headers ?? {}).map(([name, headerValue]) => ({
      name,
      value: headerValue,
    }));
    servers.push({
      type: 'http',
      name: parsed.data.id,
      url: parsed.data.transport.url,
      headers,
    });
  }
  return servers;
}
