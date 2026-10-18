import { ProxyProtocolError, redactSensitiveProtocolText } from '@gian/proxy-protocol';
import { isProxyPluginId } from '@gian/shared';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = '(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret|client[_-]?secret|authorization|credential|resume[_-]?ref(?:[_-]?id)?)';

/** Redact credential-shaped values at log boundaries while preserving enough
 * context (key, URL host, error text) to diagnose the failure. */
export function redactSensitiveText(input: string): string {
  return redactSensitiveProtocolText(input)
    .replace(new RegExp(`(["']${SENSITIVE_KEY}["']\\s*:\\s*["'])(.*?)(["'])`, 'gi'), `$1${REDACTED}$3`)
    .replace(new RegExp(`([?&]${SENSITIVE_KEY}=)[^&#\\s]+`, 'gi'), `$1${REDACTED}`)
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/g, `$1${REDACTED}`)
    .replace(/\b(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/\bgian_mcp_v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}\b/gi, REDACTED)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, `$1${REDACTED}@`)
    .replace(/\b(?:github_pat_|gh[pousr]_|sk-ant-|sk-|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/g, REDACTED);
}

export function redactErrorForLog(error: unknown): string {
  if (error instanceof Error) return redactSensitiveText(error.stack ?? error.message);
  return redactSensitiveText(String(error));
}

const PUBLIC_DIAGNOSTIC_CODE = /^(?:RUNTIME|AGENT_HOME|PLUGIN)_[A-Z0-9_]{1,60}$/;
const FIXED_PROBE_FAILURE = 'Runtime probe failed.';
/** Host-authored sentences. Provider text is never copied into these. */
const HOST_PROBE_MESSAGE: Readonly<Record<string, string>> = {
  RUNTIME_FINGERPRINT_BUDGET: 'Runtime files exceed the allowed fingerprint size.',
};
const DIAGNOSTIC_OPERATIONS = new Set(['draft-defaults', 'agent.create']);
const DIAGNOSTIC_STAGES = new Set(['runtime-probe']);

export function integrationProbeMessage(code: string): string {
  return HOST_PROBE_MESSAGE[code] ?? FIXED_PROBE_FAILURE;
}

/** Allowlisted Host code plus controlled copy. The thrown message is ignored. */
export function safeIntegrationDiagnostic(error: unknown): { code: string; message: string } {
  const rawCode = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  const code = typeof rawCode === 'string' && PUBLIC_DIAGNOSTIC_CODE.test(rawCode)
    ? rawCode
    : 'RUNTIME_PROBE_FAILED';
  return { code, message: integrationProbeMessage(code) };
}

/** Fixed operational tokens. Lookup is a Set, so constructor/__proto__ never match. */
const CAPABILITY_REASONS = new Set([
  'timeout',
  'helper_missing',
  'home_unsupported',
  'invalid_response',
  'models_unavailable',
  'query_failed',
  'output_limit',
  'cancelled',
  'cleanup_failed',
  'busy',
]);

export const GENERIC_CAPABILITY_FAILURE = 'Proxy capabilities are unavailable.';

/** The single `details.reason` token, or nothing. Other detail fields are ignored. */
export function capabilityReasonFromRpcData(data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  if (!Object.hasOwn(data, 'details')) return undefined;
  const details = (data as { details?: unknown }).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  if (!Object.hasOwn(details, 'reason')) return undefined;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' && CAPABILITY_REASONS.has(reason) ? reason : undefined;
}

const CAPABILITY_OPERATION = 'capabilities';

function capabilityDiagnosticCode(error: unknown): string {
  const candidates = [
    error instanceof ProxyProtocolError ? error.code : undefined,
    typeof error === 'object' && error !== null && 'domainCode' in error
      ? (error as { domainCode?: unknown }).domainCode
      : undefined,
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && PUBLIC_DIAGNOSTIC_CODE.test(candidate)) return candidate;
  }
  return 'RUNTIME_ERROR';
}

function capabilityReason(error: unknown): string | undefined {
  if (!(error instanceof ProxyProtocolError) || !Object.hasOwn(error, 'reason')) return undefined;
  const raw = error.reason;
  return typeof raw === 'string' && CAPABILITY_REASONS.has(raw) ? raw : undefined;
}

/** Generic copy plus at most one allowlisted reason. Provider text is dropped. */
export function safeCapabilityFailure(error: unknown): {
  code: string;
  message: string;
  reason?: string;
} {
  const reason = capabilityReason(error);
  return {
    code: capabilityDiagnosticCode(error),
    message: GENERIC_CAPABILITY_FAILURE,
    ...(reason ? { reason } : {}),
  };
}

/** Log plugin, operation, code, and an allowlisted reason. Never message, stack, URL, or environment. */
export function logCapabilityFailure(
  pluginId: string,
  error: unknown,
): { code: string; message: string; reason?: string } {
  const failure = safeCapabilityFailure(error);
  const safePlugin = isProxyPluginId(pluginId) ? pluginId : 'invalid-plugin';
  console.error('[proxy]', JSON.stringify({
    pluginId: safePlugin,
    operation: CAPABILITY_OPERATION,
    code: failure.code,
    ...(failure.reason ? { reason: failure.reason } : {}),
  }));
  return failure;
}

/** Log only an allowlisted code, a fixed operation and stage, and a legal plugin id. */
export function logIntegrationDiagnostic(
  context: { pluginId: string; operation: string; stage?: string },
  diagnostic: { code: string },
): void {
  const code = PUBLIC_DIAGNOSTIC_CODE.test(diagnostic.code) ? diagnostic.code : 'RUNTIME_PROBE_FAILED';
  const operation = DIAGNOSTIC_OPERATIONS.has(context.operation) ? context.operation : 'agent.create';
  const stage = context.stage && DIAGNOSTIC_STAGES.has(context.stage) ? context.stage : 'runtime-probe';
  const pluginId = isProxyPluginId(context.pluginId) ? context.pluginId : 'invalid-plugin';
  console.error('[integration]', JSON.stringify({ pluginId, operation, stage, code }));
}
