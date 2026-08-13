export class GrokProxyError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'GrokProxyError';
    this.status = status;
    this.code = code;
  }
}

export function createAppError(status: number, code: string, message: string): GrokProxyError {
  return new GrokProxyError(status, code, message);
}
