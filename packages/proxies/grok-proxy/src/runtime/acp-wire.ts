/**
 * ACP custom methods are `_`-prefixed on the wire. The SDK
 * (`@agentclientprotocol/sdk` 0.23) passes the method string through
 * unchanged, so this Proxy adds the prefix on send and strips it once
 * on receive. Standard ACP methods stay bare.
 */

export class GrokExtBusinessError extends Error {
  readonly method: string;
  readonly detail: unknown;

  constructor(method: string, detail: unknown) {
    super(extensionBusinessMessage(detail));
    this.name = 'GrokExtBusinessError';
    this.method = method;
    this.detail = detail;
  }
}

export function toWireExtensionMethod(method: string): string {
  if (method.startsWith('_')) return method;
  if (method.startsWith('x.ai/')) return `_${method}`;
  return method;
}

export function fromWireExtensionMethod(method: string): string {
  if (method.startsWith('_x.ai/')) return method.slice(1);
  return method;
}

/** JSON-RPC -32601 on the method that was actually sent. Message text is not proof. */
export function isWireMethodNotFound(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && (error as { code?: unknown }).code === -32601;
}

/**
 * Side-effect-free proof that `x.ai/interject` is registered: the call was
 * made before any session exists and the runtime answered -32602 with
 * "session not found". Any other -32602 is not that proof.
 */
export function isInterjectSessionMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object' || (error as { code?: unknown }).code !== -32602) return false;
  const data = (error as { data?: unknown }).data;
  const message = error instanceof Error ? error.message : '';
  const dataText = typeof data === 'string' ? data : data == null ? '' : JSON.stringify(data);
  return /session not found/i.test(`${message}\n${dataText}`);
}

/**
 * Official extension handlers return `ExtMethodResult`: `{ result, error? }`.
 * A JSON-RPC success can still carry a business error. Direct business
 * objects (no envelope) are returned unchanged.
 */
export function unwrapExtMethodResult(method: string, raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0 || keys.some((key) => key !== 'result' && key !== 'error')) return raw;
  if (Object.prototype.hasOwnProperty.call(record, 'error') && record.error != null) {
    throw new GrokExtBusinessError(method, record.error);
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'result')) {
    throw new GrokExtBusinessError(method, 'missing result');
  }
  return record.result;
}

function extensionBusinessMessage(detail: unknown): string {
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (detail && typeof detail === 'object' && 'message' in detail) {
    const message = (detail as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return 'Grok extension call failed.';
}
