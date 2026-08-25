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

export class CodexProtocolError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly domainCode: DomainCode,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = 'CodexProtocolError';
    this.retryable = retryable;
  }
}

export class CodexJsonRpcError extends Error {
  constructor(
    readonly code: -32700 | -32600 | -32601 | -32602 | -32603,
    message: string,
  ) {
    super(message);
    this.name = 'CodexJsonRpcError';
  }
}

export function writeJsonLine(stream: NodeJS.WritableStream, payload: unknown): void {
  stream.write(`${JSON.stringify(payload)}\n`);
}

export function jsonRpcError(error: unknown) {
  if (error instanceof CodexJsonRpcError) {
    return {
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof CodexProtocolError) {
    return {
      code: JSONRPC_ERROR_CODES.DOMAIN_ERROR,
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
    throw new CodexJsonRpcError(JSONRPC_ERROR_CODES.PARSE_ERROR, 'Parse error.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CodexJsonRpcError(JSONRPC_ERROR_CODES.INVALID_REQUEST, 'Invalid Request.');
  }
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== JSONRPC) {
    throw new CodexJsonRpcError(JSONRPC_ERROR_CODES.INVALID_REQUEST, 'Invalid Request.');
  }
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new CodexJsonRpcError(JSONRPC_ERROR_CODES.INVALID_REQUEST, 'Invalid Request.');
  }
  if (typeof record.method !== 'string' || record.method.length === 0) {
    throw new CodexJsonRpcError(JSONRPC_ERROR_CODES.INVALID_REQUEST, 'Invalid Request.');
  }
  const params = record.params;
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    throw new CodexJsonRpcError(JSONRPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params.');
  }
  return {
    jsonrpc: JSONRPC,
    id: record.id,
    method: record.method,
    params: (params ?? {}) as Record<string, unknown>,
  };
}
