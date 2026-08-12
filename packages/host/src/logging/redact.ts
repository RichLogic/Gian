const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = '(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret|client[_-]?secret|authorization|credential)';

/** Redact credential-shaped values at log boundaries while preserving enough
 * context (key, URL host, error text) to diagnose the failure. */
export function redactSensitiveText(input: string): string {
  return input
    .replace(new RegExp(`(["']${SENSITIVE_KEY}["']\\s*:\\s*["'])(.*?)(["'])`, 'gi'), `$1${REDACTED}$3`)
    .replace(new RegExp(`([?&]${SENSITIVE_KEY}=)[^&#\\s]+`, 'gi'), `$1${REDACTED}`)
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/g, `$1${REDACTED}`)
    .replace(/\b(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, `$1${REDACTED}@`)
    .replace(/\b(?:github_pat_|gh[pousr]_|sk-ant-|sk-|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/g, REDACTED);
}

export function redactErrorForLog(error: unknown): string {
  if (error instanceof Error) return redactSensitiveText(error.stack ?? error.message);
  return redactSensitiveText(String(error));
}
