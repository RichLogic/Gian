import {
  DOMAIN_CODES,
  MAX_NDJSON_LINE_BYTES,
  proxyRequestSchema,
} from '@gian/proxy-protocol';

import { redactRuntimeData } from '../core/mcp.js';
import type { JsonRecord } from '../contracts.js';

export interface WireRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: JsonRecord;
}

export class ProtocolError extends Error {
  readonly details: Record<string, unknown>;

  constructor(
    readonly domainCode: typeof DOMAIN_CODES[number],
    message: string,
    readonly retryable = false,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AntigravityProtocolError';
    this.details = details;
  }
}

export class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'AntigravityRpcError';
  }
}

export function standardError(error: unknown): JsonRecord {
  if (error instanceof RpcError) return { code: error.code, message: error.message };
  const value = error && typeof error === 'object' ? error as JsonRecord : {};
  const domainCode = typeof value.domainCode === 'string'
    && (DOMAIN_CODES as readonly string[]).includes(value.domainCode)
    ? value.domainCode : 'INTERNAL';
  return {
    code: -32000,
    message: String(redactRuntimeData(error instanceof Error ? error.message : 'Unexpected Proxy error.')),
    data: {
      domainCode,
      retryable: value.retryable === true,
      details: redactRuntimeData(value.details ?? {}),
    },
  };
}

export function parseRequestLine(line: string): WireRequest {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { throw new RpcError(-32700, 'Request is not valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError(-32600, 'Request must be a JSON-RPC object.');
  }
  const record = value as JsonRecord;
  if (record.jsonrpc !== '2.0' || typeof record.id !== 'string' || !record.id
    || typeof record.method !== 'string' || !record.method) {
    throw new RpcError(-32600, 'Request requires jsonrpc, a non-empty string id, and method.');
  }
  const parsed = proxyRequestSchema.safeParse(value);
  if (!parsed.success) throw new RpcError(-32602, 'Request does not match the Gian Proxy contract.');
  return parsed.data as WireRequest;
}

export function createProtocolWriter(output: NodeJS.WritableStream) {
  const write = (value: unknown) => {
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line) > MAX_NDJSON_LINE_BYTES) {
      throw new ProtocolError('RUNTIME_ERROR', 'Proxy output exceeds the negotiated frame limit.');
    }
    output.write(line);
  };
  return {
    result(id: string, result: unknown) { write({ jsonrpc: '2.0', id, result }); },
    error(id: string | null, error: unknown) { write({ jsonrpc: '2.0', id, error: standardError(error) }); },
    notification(method: string, params: JsonRecord) { write({ jsonrpc: '2.0', method, params }); },
  };
}
