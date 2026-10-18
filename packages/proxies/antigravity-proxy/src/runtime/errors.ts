export class AntigravityRuntimeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AntigravityRuntimeError';
  }
}

/** A bounded ACP call or startup exceeded its deadline. */
export class AntigravityTimeoutError extends AntigravityRuntimeError {
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`Antigravity ACP ${label} timed out after ${timeoutMs}ms.`);
    this.name = 'AntigravityTimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/** The owned process group could not be confirmed gone. `stop()` must reject. */
export class AntigravityCleanupError extends AntigravityRuntimeError {
  constructor(cause: Error) {
    super(`Antigravity ACP process cleanup failed: ${cause.message}`, { cause });
    this.name = 'AntigravityCleanupError';
  }
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** One ACP stdio record exceeded the shared NDJSON frame ceiling. */
export class AcpFrameLimitError extends Error {
  readonly bytes: number;
  readonly limit: number;

  constructor(bytes: number, limit: number) {
    super(`ACP NDJSON frame is ${bytes} bytes; maximum is ${limit}.`);
    this.name = 'AcpFrameLimitError';
    this.bytes = bytes;
    this.limit = limit;
  }
}
