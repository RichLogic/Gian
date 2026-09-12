import type { GianToolError, GianToolErrorCode } from '@gian/shared';
import { QueueRevisionConflict } from '../queue/manager.js';
import { ScheduleError } from '../schedule/errors.js';

const RETRYABLE = new Set<GianToolErrorCode>([
  'SESSION_BUSY',
  'EXECUTOR_NOT_READY',
  'AGENT_NOT_READY',
  'TIMEOUT',
  'INTERNAL_ERROR',
]);

/** Closed mapping from Schedule domain codes onto the Tool error union. */
const SCHEDULE_CODE_MAP: Record<string, GianToolErrorCode> = {
  SCHEDULE_NOT_FOUND: 'NOT_FOUND',
  SCHEDULE_RUN_NOT_FOUND: 'NOT_FOUND',
  SCHEDULE_CONFIRMATION_NOT_FOUND: 'NOT_FOUND',
  SCHEDULE_ARCHIVED: 'CONFLICT',
  SCHEDULE_COMPLETED: 'CONFLICT',
  SCHEDULE_REVISION_CONFLICT: 'CONFLICT',
  SCHEDULE_LIMIT_REACHED: 'CONFLICT',
  SCHEDULE_OVERLAP_SKIPPED: 'CONFLICT',
  SCHEDULE_CONFIRMATION_EXPIRED: 'CONFLICT',
  SCHEDULE_CREATE_REJECTED: 'SCHEDULE_CREATE_REJECTED',
  SCHEDULE_FORK_UNSUPPORTED: 'CONFLICT',
  SCHEDULE_NO_STABLE_FORK_POINT: 'CONFLICT',
  SCHEDULE_FORK_FAILED: 'CONFLICT',
  SCHEDULE_CONTROL_SESSION_NOT_FOUND: 'NOT_FOUND',
  SCHEDULE_CONTROL_SESSION_BLOCKED: 'SESSION_CLOSED',
  SCHEDULE_TRIGGER_INVALID: 'INVALID_ARGUMENT',
  SCHEDULE_TIMEZONE_INVALID: 'INVALID_ARGUMENT',
  SCHEDULE_INTERVAL_TOO_FREQUENT: 'INVALID_ARGUMENT',
  SCHEDULE_HAS_NO_FUTURE_OCCURRENCE: 'INVALID_ARGUMENT',
  AGENT_DELETED: 'AGENT_DELETED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

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
  if (error instanceof QueueRevisionConflict) {
    return {
      code: 'PRECONDITION_FAILED',
      message: error.message,
      retryable: false,
      details: {
        queue_revision: error.revision,
        queue: error.queue.map(entry => ({
          id: entry.id,
          session_id: entry.sessionId,
          text: entry.text,
          created_at: new Date(entry.createdAt).toISOString(),
        })),
      },
    };
  }
  if (error instanceof GianToolServiceError) {
    return {
      code: error.code,
      message: error.message,
      retryable: RETRYABLE.has(error.code),
      ...(error.details ? { details: error.details } : {}),
    };
  }
  if (error instanceof ScheduleError) {
    const code = SCHEDULE_CODE_MAP[error.code] ?? 'INTERNAL_ERROR';
    return {
      code,
      message: error.message,
      retryable: RETRYABLE.has(code),
      ...(error.details ? { details: error.details } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = knownCode(error);
  const mapped: GianToolErrorCode =
    code === 'PERMISSION_DENIED'
      ? 'PERMISSION_DENIED'
      : code === 'CAPABILITY_NOT_SUPPORTED' || /does not support|not advertised/i.test(message)
      ? 'CAPABILITY_NOT_SUPPORTED'
      : code === 'AGENT_DELETED' || /Agent was deleted/i.test(message)
        ? 'AGENT_DELETED'
        : code === 'INVALID_APPROVAL_OPTION'
          ? 'INVALID_INTERACTION_RESPONSE'
          : /TASK_HAS_ACTIVE_SUBTASKS/.test(message)
            ? 'TASK_HAS_ACTIVE_SUBTASKS'
            : /task is not open/i.test(message)
              ? 'TASK_NOT_OPEN'
              : code === 'PRECONDITION_FAILED' || /revision mismatch/i.test(message)
                ? 'PRECONDITION_FAILED'
                : code === 'UNKNOWN_OUTCOME' || /receipt was not persisted/i.test(message)
                  ? 'UNKNOWN_OUTCOME'
                  : code === 'COMMAND_EXPIRED'
                    ? 'COMMAND_EXPIRED'
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
