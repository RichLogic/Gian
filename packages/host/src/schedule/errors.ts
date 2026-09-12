import type { ScheduleErrorCode } from '@gian/shared';

/** Stable Schedule domain error. `httpStatus` maps the code to the REST
 *  error envelope. */
export class ScheduleError extends Error {
  constructor(
    readonly code: ScheduleErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ScheduleError';
  }

  get httpStatus(): number {
    return scheduleHttpStatus(this.code);
  }
}

const HTTP_STATUS_BY_CODE: Record<string, number> = {
  SCHEDULE_NOT_FOUND: 404,
  SCHEDULE_RUN_NOT_FOUND: 404,
  SCHEDULE_CONFIRMATION_NOT_FOUND: 404,
  SCHEDULE_ARCHIVED: 409,
  SCHEDULE_COMPLETED: 409,
  SCHEDULE_REVISION_CONFLICT: 409,
  SCHEDULE_LIMIT_REACHED: 409,
  SCHEDULE_OVERLAP_SKIPPED: 409,
  SCHEDULE_CONFIRMATION_EXPIRED: 409,
  SCHEDULE_CREATE_REJECTED: 409,
  SCHEDULE_FORK_UNSUPPORTED: 409,
  SCHEDULE_NO_STABLE_FORK_POINT: 409,
  SCHEDULE_FORK_FAILED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  SCHEDULE_TRIGGER_INVALID: 422,
  SCHEDULE_TIMEZONE_INVALID: 422,
  SCHEDULE_INTERVAL_TOO_FREQUENT: 422,
  SCHEDULE_HAS_NO_FUTURE_OCCURRENCE: 422,
  SCHEDULE_CONTROL_SESSION_NOT_FOUND: 422,
  SCHEDULE_CONTROL_SESSION_BLOCKED: 409,
  AGENT_DELETED: 422,
  SCHEDULE_DISPATCH_UNKNOWN: 500,
  INVALID_ARGUMENT: 400,
  INTERNAL_ERROR: 500,
};

export function scheduleHttpStatus(code: ScheduleErrorCode): number {
  return HTTP_STATUS_BY_CODE[code] ?? 500;
}

export function scheduleFailure(
  code: ScheduleErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ScheduleError {
  return new ScheduleError(code, message, details);
}
