import {
  JSONRPC_ERROR_CODES,
  type DomainCode,
} from './constants.js';

export type ProtocolFaultClass = 'connection' | 'session' | 'request';

export type ProtocolErrorName =
  | DomainCode
  | 'PROTOCOL_VIOLATION'
  | 'PARSE_ERROR'
  | 'INVALID_REQUEST'
  | 'METHOD_NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'INTERNAL_ERROR';

export interface JsonRpcErrorData {
  domainCode: DomainCode;
  retryable: boolean;
  details: Record<string, unknown>;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: JsonRpcErrorData | Record<string, unknown>;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string | null;
  error: JsonRpcErrorObject;
}

export class ProxyProtocolError extends Error {
  readonly faultClass: ProtocolFaultClass;
  readonly jsonRpcCode: number;
  readonly sessionId?: string;
  readonly streamId?: string;

  constructor(
    readonly code: ProtocolErrorName,
    message: string,
    fatalOrClass: boolean | ProtocolFaultClass = 'request',
    sessionId?: string,
    streamId?: string,
  ) {
    super(message);
    this.name = 'ProxyProtocolError';
    this.faultClass = typeof fatalOrClass === 'boolean'
      ? (fatalOrClass ? 'connection' : 'request')
      : fatalOrClass;
    this.jsonRpcCode = jsonRpcCodeFor(code);
    if (sessionId !== undefined) this.sessionId = sessionId;
    if (streamId !== undefined) this.streamId = streamId;
  }

  get fatal(): boolean {
    return this.faultClass === 'connection';
  }
}

function jsonRpcCodeFor(code: ProtocolErrorName): number {
  switch (code) {
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

export function protocolViolation(message: string): ProxyProtocolError {
  return new ProxyProtocolError('PROTOCOL_VIOLATION', message, 'connection');
}

export function sessionViolation(
  message: string,
  sessionId: string,
  streamId: string,
): ProxyProtocolError {
  return new ProxyProtocolError('PROTOCOL_VIOLATION', message, 'session', sessionId, streamId);
}

export function requestViolation(
  code: DomainCode,
  message: string,
): ProxyProtocolError {
  return new ProxyProtocolError(code, message, 'request');
}

export function jsonRpcRequestViolation(
  code: 'PARSE_ERROR' | 'INVALID_REQUEST' | 'METHOD_NOT_FOUND' | 'INVALID_PARAMS' | 'INTERNAL_ERROR',
  message: string,
): ProxyProtocolError {
  return new ProxyProtocolError(code, message, 'request');
}

export function jsonRpcError(
  id: string | null,
  code: number,
  message: string,
  data?: JsonRpcErrorObject['data'],
): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

export function domainError(
  id: string,
  domainCode: DomainCode,
  message: string,
  retryable: boolean,
  details: Record<string, unknown> = {},
): JsonRpcErrorResponse {
  return jsonRpcError(id, JSONRPC_ERROR_CODES.DOMAIN_ERROR, message, {
    domainCode,
    retryable,
    details,
  });
}
