import type {
  GianDesktopNavigationApi,
  GianDesktopNavigationTarget,
} from './desktop-bridge.js';
import type { Mode } from './components/Topbar.js';

/**
 * `settled` — the target was applied, or it is confirmed missing/archived.
 * `pending` — the session snapshot is not ready, or a reload failed; do not
 * acknowledge, or the desktop process drops the target permanently.
 * `dropped` — a newer target replaced this one. Do not acknowledge it.
 */
export type DesktopNavigationDelivery = 'settled' | 'pending' | 'dropped';

export interface DesktopNavigationRetry {
  retry: (() => void) | null;
}

/**
 * Join the cold-start ready handshake with live navigation pushes without
 * allowing an older ready result to overwrite a newer notification click.
 * A pending delivery is not acknowledged. `retry.current()` runs the newest
 * pending target again after the session snapshot is ready.
 */
export function subscribeDesktopNavigation(
  navigation: GianDesktopNavigationApi,
  handle: (
    target: GianDesktopNavigationTarget,
    isCurrent: () => boolean,
  ) => DesktopNavigationDelivery | Promise<DesktopNavigationDelivery> | void,
  retry?: DesktopNavigationRetry,
): () => void {
  let disposed = false;
  let liveRevision = 0;
  let deliveryId = 0;
  let deferred: { target: GianDesktopNavigationTarget; revision: number } | null = null;

  const consume = (target: GianDesktopNavigationTarget, revision: number) => {
    if (disposed || liveRevision !== revision) return;
    const currentDelivery = ++deliveryId;
    const isCurrent = () => !disposed && liveRevision === revision && deliveryId === currentDelivery;
    const finish = (disposition: DesktopNavigationDelivery | void) => {
      if (!isCurrent()) return;
      if (disposition === 'pending') {
        deferred = { target, revision };
        return;
      }
      if (deferred?.revision === revision) deferred = null;
      if (disposition === 'dropped') return;
      void navigation.acknowledge(target).catch(() => undefined);
    };
    const outcome = handle(target, isCurrent);
    if (outcome && typeof (outcome as Promise<DesktopNavigationDelivery>).then === 'function') {
      void (outcome as Promise<DesktopNavigationDelivery>).then(finish).catch(() => {
        if (isCurrent()) deferred = { target, revision };
      });
      return;
    }
    finish(outcome as DesktopNavigationDelivery | void);
  };

  const retryPending = () => {
    if (disposed || !deferred || deferred.revision !== liveRevision) return;
    const target = deferred.target;
    const revision = deferred.revision;
    deferred = null;
    consume(target, revision);
  };
  if (retry) retry.retry = retryPending;

  const unsubscribe = navigation.onTarget(target => {
    liveRevision += 1;
    consume(target, liveRevision);
  });
  const readyRevision = liveRevision;
  void navigation.ready().then(target => {
    if (!target || disposed || liveRevision !== readyRevision) return;
    consume(target, readyRevision);
  }).catch(() => undefined);

  return () => {
    disposed = true;
    deferred = null;
    if (retry && retry.retry === retryPending) retry.retry = null;
    unsubscribe();
  };
}

/** Repos (`sessions`) or Tasks. Startup default Tasks is not one of these. */
export type ConversationListMode = Extract<Mode, 'sessions' | 'tasks'>;

export type SessionNavigationAction =
  /** Repos (sessions) view: select the session in place. */
  | { kind: 'select-in-sessions'; sessionId: string }
  /** Tasks view, session belongs to a Task: open it as the active Subtask
   *  without leaving the view. */
  | { kind: 'select-subtask-in-tasks'; taskId: string; sessionId: string }
  /** Tasks view, standalone session: select it in the 未分配 group without
   *  leaving the view. */
  | { kind: 'select-standalone-in-tasks'; sessionId: string }
  /** A non-conversation page with no explicit Repos/Tasks choice: Repos. */
  | { kind: 'fallback-sessions'; sessionId: string }
  /** Missing or archived. Callers must keep the current selection. */
  | { kind: 'unavailable'; sessionId: string; reason: 'missing' | 'archived' };

export interface SessionNavigationContext {
  mode: Mode;
  /**
   * Last Repos/Tasks list the user explicitly chose.
   * Null (or omitted) means there is no record. Do not pass the startup
   * Tasks default — that is not a user choice.
   */
  explicitListMode?: ConversationListMode | null;
  /**
   * The list whose row the user just activated. When set, that list is the
   * surface even if the current page is Agents, Timer, or Custom.
   */
  requestedListMode?: ConversationListMode | null;
  /** Null when the id is not in the active read model. */
  session: { task_id: string | null; archived?: 0 | 1 } | null;
}

function conversationSurface(
  context: SessionNavigationContext,
): ConversationListMode | 'fallback' {
  const requested = context.requestedListMode;
  if (requested === 'sessions' || requested === 'tasks') return requested;
  if (context.mode === 'sessions' || context.mode === 'tasks') return context.mode;
  const explicit = context.explicitListMode;
  if (explicit === 'sessions' || explicit === 'tasks') return explicit;
  return 'fallback';
}

/**
 * Decide which conversation surface opens an existing session.
 *
 * Repos and Tasks each keep their own surface. Any other page uses the last
 * explicit Repos/Tasks choice, or Repos when that choice was never recorded.
 * A missing or archived target is unavailable in every surface: it is not
 * the 未分配 group and it is not another session.
 */
export function resolveSessionNavigation(
  target: { sessionId: string },
  context: SessionNavigationContext,
): SessionNavigationAction {
  if (!context.session) {
    return { kind: 'unavailable', sessionId: target.sessionId, reason: 'missing' };
  }
  if (context.session.archived === 1) {
    return { kind: 'unavailable', sessionId: target.sessionId, reason: 'archived' };
  }
  const taskId = context.session.task_id || null;
  const surface = conversationSurface(context);
  if (surface === 'tasks') {
    if (taskId) {
      return { kind: 'select-subtask-in-tasks', taskId, sessionId: target.sessionId };
    }
    return { kind: 'select-standalone-in-tasks', sessionId: target.sessionId };
  }
  if (surface === 'fallback') {
    return { kind: 'fallback-sessions', sessionId: target.sessionId };
  }
  return { kind: 'select-in-sessions', sessionId: target.sessionId };
}
