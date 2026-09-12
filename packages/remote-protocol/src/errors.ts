import { REMOTE_ERROR_CODES } from './constants.js';

export type RemoteErrorCode = (typeof REMOTE_ERROR_CODES)[number];

export class RemoteProtocolError extends Error {
  readonly code: RemoteErrorCode;
  readonly details?: Record<string, string | number | boolean>;

  constructor(
    code: RemoteErrorCode,
    message: string,
    details?: Record<string, string | number | boolean>,
  ) {
    super(message);
    this.name = 'RemoteProtocolError';
    this.code = code;
    this.details = details;
  }
}

export function isRemoteErrorCode(value: string): value is RemoteErrorCode {
  return (REMOTE_ERROR_CODES as readonly string[]).includes(value);
}
