import type {
  ErrorMessage,
  Session,
  SessionStatus,
} from '@gian/shared';

export interface CreatedSessionFirstMessagePlan {
  structuredText: string | null;
  seedOptimisticEcho: boolean;
}

/** A session:create failure can carry an executor-native code (for example
 * AUTH_REQUIRED), so the request correlation is authoritative. Keep the
 * legacy code fallback for hosts that predate request_type. */
export function isSessionCreateDispatchError(
  error: Pick<ErrorMessage, 'code' | 'request_type'>,
): boolean {
  return error.request_type === 'session:create'
    || error.code === 'SESSION_CREATE_FAILED';
}

/**
 * Decide how the App should dispatch the first message after session:create.
 * Both executors stay on the structured path (`message:send`).
 */
export function planCreatedSessionFirstMessage(
  pendingMessage: string | null | undefined,
): CreatedSessionFirstMessagePlan {
  const text = pendingMessage?.trim() || null;
  return {
    structuredText: text,
    seedOptimisticEcho: text !== null,
  };
}
/**
 * Whether the Stop button should show (a turn is actually in flight) — NOT
 * merely because the composer is blocked on a pending question.
 * `status==='running'` covers proxy lifecycle and `pending` covers the
 * structured in-flight window.
 */
export function isTurnRunning(status: SessionStatus, pending: boolean): boolean {
  return pending || status === 'running';
}

/** A session needs the user's attention when it is waiting for input, or when
 * its completed/failed turn has not been read yet. */
export function sessionNeedsAttention(
  session: Pick<Session, 'status' | 'unread'>,
): boolean {
  return session.status === 'pending'
    || ((session.status === 'done' || session.status === 'error') && session.unread === 1);
}
