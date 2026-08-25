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
  | 'NATIVE_SESSION_NOT_FOUND'
  | 'SIDECHAT_UNAVAILABLE'
  | 'FORK_BOUNDARY_UNAVAILABLE'
  | 'RUNTIME_UNAVAILABLE'
  | 'RUNTIME_ERROR'
  | 'RUNTIME_AUTH_REQUIRED'
  | 'CANCELLED';

export class ClaudeProtocolError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly domainCode: DomainCode,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = 'ClaudeProtocolError';
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
    default:
      return JSONRPC_ERROR_CODES.DOMAIN_ERROR;
  }
}

export function jsonRpcError(error: unknown) {
  if (error instanceof ClaudeProtocolError) {
    return {
      code: jsonRpcCode(error.domainCode),
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
    code: JSONRPC_ERROR_CODES.DOMAIN_ERROR,
    message,
    data: {
      domainCode: 'INTERNAL' as const,
      retryable: false,
      details: {},
    },
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
    throw new ClaudeProtocolError('PARSE_ERROR', 'Request is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClaudeProtocolError('INVALID_REQUEST', 'Request must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== JSONRPC) {
    throw new ClaudeProtocolError('INVALID_REQUEST', 'jsonrpc must be "2.0".');
  }
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new ClaudeProtocolError('INVALID_REQUEST', 'Request id must be a non-empty string.');
  }
  if (typeof record.method !== 'string' || record.method.length === 0) {
    throw new ClaudeProtocolError('INVALID_REQUEST', 'method is required.');
  }
  const params = record.params;
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    throw new ClaudeProtocolError('INVALID_PARAMS', 'params must be an object.');
  }
  return {
    jsonrpc: JSONRPC,
    id: record.id,
    method: record.method,
    params: (params ?? {}) as Record<string, unknown>,
  };
}
