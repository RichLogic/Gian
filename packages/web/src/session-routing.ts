import type {
  ErrorMessage,
  Executor,
  RuntimeMode,
  SessionStatus,
} from '@gian/shared';

export interface CreatedSessionFirstMessagePlan {
  switchToTty: boolean;
  ttyText: string | null;
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
  _executor: Executor,
  pendingMessage: string | null | undefined,
): CreatedSessionFirstMessagePlan {
  const text = pendingMessage?.trim() || null;
  return {
    switchToTty: false,
    ttyText: null,
    structuredText: text,
    seedOptimisticEcho: text !== null,
  };
}

export type SessionSurface = 'chat' | 'cli';

/** The runtime a given surface implies. 'chat' is structured; 'cli' is TTY. */
export function runtimeForSurface(surface: SessionSurface): RuntimeMode {
  return surface === 'chat' ? 'structured' : 'tty';
}

export interface RuntimeTab {
  surface: SessionSurface;
  /** i18n label kind: 'chat' (the primary surface) or 'cli'. */
  label: 'chat' | 'cli';
}

/** Tabs to render in the chat-area tablist. Always a single primary chat
 *  tab — the caller hides the tab bar entirely for a single entry. */
export function runtimeTabs(_executor: Executor): RuntimeTab[] {
  return [{ surface: 'chat', label: 'chat' }];
}

/**
 * Whether the Stop button should show (a turn is actually in flight) — NOT
 * merely because the composer is blocked on a pending question. Hook-driven
 * `status==='running'` gives this for TTY sessions; structured turns set
 * status='running' too, and `pending` covers the structured in-flight window.
 */
export function isTurnRunning(status: SessionStatus, pending: boolean): boolean {
  return pending || status === 'running';
}
