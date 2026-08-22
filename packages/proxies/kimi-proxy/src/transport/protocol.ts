const JSONRPC = '2.0' as const;

const JSONRPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  DOMAIN_ERROR: -32000,
} as const;

export type DomainCode =
  | 'INTERNAL'
  | 'PARSE_ERROR'
  | 'INVALID_REQUEST'
  | 'INVALID_PARAMS'
  | 'METHOD_NOT_FOUND'
  | 'INTERNAL_ERROR'
  | 'NOT_INITIALIZED'
  | 'ALREADY_INITIALIZED'
  | 'INCOMPATIBLE_PROTOCOL'
  | 'CAPABILITY_NOT_SUPPORTED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_CLOSED'
  | 'SESSION_STALE'
  | 'SESSION_ERROR'
  | 'SESSION_BUSY'
  | 'TURN_NOT_FOUND'
  | 'CONFLICT'
  | 'INTERACTION_NOT_FOUND'
  | 'INTERACTION_ACTION_NOT_FOUND'
  | 'CONFIG_REQUIRED'
  | 'CONFIG_VALUE_INVALID'
  | 'CONFIG_BINDING_INVALID'
  | 'RUNTIME_ERROR'
  | 'RUNTIME_AUTH_REQUIRED'
  | 'CANCELLED';

export class KimiProtocolError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly domainCode: DomainCode,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = 'KimiProtocolError';
    this.retryable = retryable;
  }
}

export function writeJsonLine(stream: NodeJS.WritableStream, payload: unknown): void {
  stream.write(`${JSON.stringify(payload)}\n`);
}

function jsonRpcCode(domainCode: DomainCode): number {
  switch (domainCode) {
    case 'PARSE_ERROR':
      return JSONRPC_ERROR_CODES.PARSE_ERROR;
    case 'INVALID_REQUEST':
      return JSONRPC_ERROR_CODES.INVALID_REQUEST;
    case 'METHOD_NOT_FOUND':
      return JSONRPC_ERROR_CODES.METHOD_NOT_FOUND;
    case 'INVALID_PARAMS':
      return JSONRPC_ERROR_CODES.INVALID_PARAMS;
    case 'INTERNAL_ERROR':
      return JSONRPC_ERROR_CODES.INTERNAL_ERROR;
    default:
      return JSONRPC_ERROR_CODES.DOMAIN_ERROR;
  }
}

const STANDARD_CODES: ReadonlySet<DomainCode> = new Set([
  'PARSE_ERROR',
  'INVALID_REQUEST',
  'METHOD_NOT_FOUND',
  'INVALID_PARAMS',
  'INTERNAL_ERROR',
]);

export function jsonRpcError(error: unknown) {
  if (error instanceof KimiProtocolError) {
    const code = jsonRpcCode(error.domainCode);
    // Standard JSON-RPC failures carry no data; only -32000 domain errors
    // carry the {domainCode, retryable, details} object Gian branches on.
    if (STANDARD_CODES.has(error.domainCode)) {
      return { code, message: error.message };
    }
    return {
      code,
      message: error.message,
      data: {
        domainCode: error.domainCode,
        retryable: error.retryable,
        details: {},
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: JSONRPC_ERROR_CODES.INTERNAL_ERROR,
    message,
  };
}

export function createProtocolWriter(outputStream: NodeJS.WritableStream) {
  return {
    result(id: string, result: unknown) {
      writeJsonLine(outputStream, { jsonrpc: JSONRPC, id, result });
    },
    error(id: string | null, error: unknown) {
      writeJsonLine(outputStream, { jsonrpc: JSONRPC, id, error: jsonRpcError(error) });
    },
    notification(method: string, params: unknown) {
      writeJsonLine(outputStream, { jsonrpc: JSONRPC, method, params });
    },
  };
}

export function parseRequestLine(line: string): {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: Record<string, unknown>;
} {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new KimiProtocolError('PARSE_ERROR', 'Request is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new KimiProtocolError('INVALID_REQUEST', 'Request must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== JSONRPC) {
    throw new KimiProtocolError('INVALID_REQUEST', 'jsonrpc must be "2.0".');
  }
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new KimiProtocolError('INVALID_REQUEST', 'Request id must be a non-empty string.');
  }
  if (typeof record.method !== 'string' || record.method.length === 0) {
    throw new KimiProtocolError('INVALID_REQUEST', 'method is required.');
  }
  const params = record.params;
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    throw new KimiProtocolError('INVALID_PARAMS', 'params must be an object.');
  }
  return {
    jsonrpc: JSONRPC,
    id: record.id,
    method: record.method,
    params: (params ?? {}) as Record<string, unknown>,
  };
}
