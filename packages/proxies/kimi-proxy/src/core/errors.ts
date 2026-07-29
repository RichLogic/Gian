export class KimiProxyError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'KimiProxyError';
    this.status = status;
    this.code = code;
  }
}

export function createAppError(status: number, code: string, message: string): KimiProxyError {
  return new KimiProxyError(status, code, message);
}
