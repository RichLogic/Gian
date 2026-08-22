/**
 * `gian.dsh.bridge/1.0` — the private JSON-RPC 2.0 contract spoken between the
 * Gian dsh-proxy and the @gian/dsh-bridge Cordis bundle running inside a DSH
 * `gian` profile.
 *
 * This file is the frozen contract surface (DSH-WP0). It is deliberately
 * dependency-free: the bridge is installed into a DSH profile and cannot assume
 * that zod or the Gian workspace are present at runtime.
 *
 * Method and notification tables match the integration plan §5.2 / §5.3.
 */

export const BRIDGE_PROTOCOL_NAME = 'gian.dsh.bridge' as const;
export const BRIDGE_PROTOCOL_VERSION = '1.0' as const;
export const BRIDGE_SUPPORTED_VERSIONS = [BRIDGE_PROTOCOL_VERSION] as const;

export const MAX_BRIDGE_LINE_BYTES = 16 * 1024 * 1024;
export const MAX_DETAIL_BYTES = 1 * 1024 * 1024;

export const BRIDGE_METHODS = [
  'initialize',
  'catalog.list',
  'catalog.resolve',
  'session.create',
  'session.resume',
  'session.get',
  'session.close',
  'session.native.list',
  'session.rename',
  'session.events.read',
  'turn.start',
  'turn.steer',
  'turn.interrupt',
  'interaction.respond',
  'shutdown',
] as const;

export const BRIDGE_NOTIFICATIONS = [
  'session.event',
  'agent.status',
  'agent.error',
  'subagent.started',
  'subagent.finished',
  'interaction.requested',
  'interaction.resolved',
  'catalog.changed',
  'runtime.error',
] as const;

export type BridgeMethod = typeof BRIDGE_METHODS[number];
export type BridgeNotificationMethod = typeof BRIDGE_NOTIFICATIONS[number];

export type BridgeJsonValue =
  | string
  | number
  | boolean
  | null
  | BridgeJsonValue[]
  | { [key: string]: BridgeJsonValue };

export interface BridgeRequest {
  jsonrpc: '2.0';
  id: string;
  method: BridgeMethod;
  params: Record<string, unknown>;
}

export interface BridgeSuccessResponse {
  jsonrpc: '2.0';
  id: string;
  result: Record<string, unknown>;
}

export interface BridgeErrorResponse {
  jsonrpc: '2.0';
  id: string | null;
  error: {
    code: number;
    message: string;
    data?: {
      domainCode: string;
      retryable: boolean;
      details?: Record<string, unknown>;
    };
  };
}

export interface BridgeNotification {
  jsonrpc: '2.0';
  method: BridgeNotificationMethod;
  params: Record<string, unknown>;
}

export type BridgeMessage =
  | BridgeRequest
  | BridgeSuccessResponse
  | BridgeErrorResponse
  | BridgeNotification;

/* ------------------------------------------------------------------ *
 * Validators
 * ------------------------------------------------------------------ */

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isJsonValue(value: unknown): value is BridgeJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry));
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every(
      (entry) => isJsonValue(entry),
    );
  }
  return false;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && Array.isArray(value) === false) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function validateBridgeRequest(
  obj: unknown,
): { ok: true; request: BridgeRequest } | { ok: false; error: string } {
  const record = asRecord(obj);
  if (!record || record.jsonrpc !== '2.0') {
    return { ok: false, error: 'request must carry jsonrpc "2.0"' };
  }
  if (isNonEmptyString(record.id) === false) {
    return { ok: false, error: 'request id must be a non-empty string' };
  }
  if (
    isNonEmptyString(record.method) === false
    || BRIDGE_METHODS.includes(record.method as BridgeMethod) === false
  ) {
    return { ok: false, error: `unknown bridge method ${String(record.method)}` };
  }
  const params = asRecord(record.params);
  if (params === null) return { ok: false, error: 'request params must be an object' };
  if (isJsonValue(params) === false) {
    return { ok: false, error: 'request params must be lossless JSON' };
  }
  return {
    ok: true,
    request: {
      jsonrpc: '2.0',
      id: record.id,
      method: record.method as BridgeMethod,
      params,
    },
  };
}

export function validateBridgeNotification(
  obj: unknown,
): { ok: true; notification: BridgeNotification } | { ok: false; error: string } {
  const record = asRecord(obj);
  if (!record || record.jsonrpc !== '2.0') {
    return { ok: false, error: 'notification must carry jsonrpc "2.0"' };
  }
  if ('id' in record && record.id !== undefined) {
    return { ok: false, error: 'notification must omit id' };
  }
  if (
    isNonEmptyString(record.method) === false
    || BRIDGE_NOTIFICATIONS.includes(record.method as BridgeNotificationMethod) === false
  ) {
    return { ok: false, error: `unknown bridge notification ${String(record.method)}` };
  }
  const params = asRecord(record.params);
  if (params === null) {
    return { ok: false, error: 'notification params must be an object' };
  }
  if (isJsonValue(params) === false) {
    return { ok: false, error: 'notification params must be lossless JSON' };
  }
  return {
    ok: true,
    notification: {
      jsonrpc: '2.0',
      method: record.method as BridgeNotificationMethod,
      params,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Core payload shapes (documented contracts)
 * ------------------------------------------------------------------ */

export interface BridgeInitializeParams {
  protocol: { name: typeof BRIDGE_PROTOCOL_NAME; versions: string[] };
}

export interface BridgeInitializeResult {
  protocol: { name: typeof BRIDGE_PROTOCOL_NAME; version: typeof BRIDGE_PROTOCOL_VERSION };
  plugin: { id: 'ai.deepseek.harness'; bundle: '@gian/dsh-bridge'; version: string };
  runtime: {
    id: 'deepseek-harness';
    package: '@deepseek-ai/dsh';
    version: string;
    sessionFormatVersion: number;
  };
  capabilities: {
    'session.resume': 1;
    'session.events.read': 1;
    'turn.interrupt': 1;
    'catalog.changed': 1;
    'interaction': 1;
    'event.step': 1;
    'event.request': 1;
    'event.usage': 1;
  };
}

/** Session format version enters the proxy eventId source key (plan §8.2). */
export const DSH_SESSION_FORMAT_VERSION = 0;
