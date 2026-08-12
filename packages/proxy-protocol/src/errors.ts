import type { ProtocolErrorCode } from './constants.js';

export class ProxyProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode | 'PROTOCOL_VIOLATION',
    message: string,
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = 'ProxyProtocolError';
  }
}

export function protocolViolation(message: string): ProxyProtocolError {
  return new ProxyProtocolError('PROTOCOL_VIOLATION', message, true);
}

export function requestViolation(
  code: ProtocolErrorCode,
  message: string,
): ProxyProtocolError {
  return new ProxyProtocolError(code, message, false);
}
