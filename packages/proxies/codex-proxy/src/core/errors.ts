export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function createAppError(statusCode: number, code: string, message: string) {
  return new AppError(statusCode, code, message);
}
