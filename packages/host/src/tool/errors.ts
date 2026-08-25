import type { GianToolError, GianToolErrorCode } from '@gian/shared';

const RETRYABLE = new Set<GianToolErrorCode>([
  'SESSION_BUSY',
  'EXECUTOR_NOT_READY',
  'AGENT_NOT_READY',
  'TIMEOUT',
  'INTERNAL_ERROR',
]);

export class GianToolServiceError extends Error {
  constructor(
    readonly code: GianToolErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'GianToolServiceError';
  }
}

function knownCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

export function toolError(error: unknown): GianToolError {
  if (error instanceof GianToolServiceError) {
    return {
      code: error.code,
      message: error.message,
      retryable: RETRYABLE.has(error.code),
      ...(error.details ? { details: error.details } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = knownCode(error);
  const mapped: GianToolErrorCode =
    code === 'CAPABILITY_NOT_SUPPORTED' || /does not support|not advertised/i.test(message)
      ? 'CAPABILITY_NOT_SUPPORTED'
      : code === 'AGENT_DELETED' || /Agent was deleted/i.test(message)
        ? 'AGENT_DELETED'
        : code === 'INVALID_APPROVAL_OPTION'
          ? 'INVALID_INTERACTION_RESPONSE'
          : /TASK_HAS_ACTIVE_SUBTASKS/.test(message)
            ? 'TASK_HAS_ACTIVE_SUBTASKS'
            : /task is not open/i.test(message)
              ? 'TASK_NOT_OPEN'
              : /already running|turn already in flight|SESSION_BUSY|queue drains automatically/i.test(message)
                ? 'SESSION_BUSY'
                : /session is completed|session is (?:merged|discarded)|worktree was already|does not have a workspace|closed for input/i.test(message)
                  ? 'SESSION_CLOSED'
                  : /not found|no such/i.test(message)
                    ? 'NOT_FOUND'
                    : /invalid|unsupported|must |requires |unknown field|Select one|answer/i.test(message)
                      ? 'INVALID_ARGUMENT'
                      : /conflict|not assignable|already belongs|is archived|is not a subtask|not an independent coding session/i.test(message)
                        ? 'CONFLICT'
                        : 'INTERNAL_ERROR';
  return {
    code: mapped,
    message: mapped === 'INTERNAL_ERROR' ? 'Gian Tool operation failed' : message,
    retryable: RETRYABLE.has(mapped),
  };
}

export function fail(
  code: GianToolErrorCode,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new GianToolServiceError(code, message, details);
}
