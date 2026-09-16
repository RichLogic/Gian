import type {
  GianDesktopNavigationApi,
  GianDesktopNavigationTarget,
} from './desktop-bridge.js';
import type { Mode } from './components/Topbar.js';

/**
 * Join the cold-start ready handshake with live navigation pushes without
 * allowing an older ready result to overwrite a newer notification click.
 */
export function subscribeDesktopNavigation(
  navigation: GianDesktopNavigationApi,
  handle: (target: GianDesktopNavigationTarget) => void,
): () => void {
  let disposed = false;
  let liveRevision = 0;

  const consume = (target: GianDesktopNavigationTarget) => {
    if (disposed) return;
    handle(target);
    void navigation.acknowledge(target).catch(() => undefined);
  };

  const unsubscribe = navigation.onTarget(target => {
    liveRevision += 1;
    consume(target);
  });
  const readyRevision = liveRevision;
  void navigation.ready().then(target => {
    if (!target || disposed || liveRevision !== readyRevision) return;
    consume(target);
  }).catch(() => undefined);

  return () => {
    disposed = true;
    unsubscribe();
  };
}

export type SessionNavigationAction =
  /** Repos (sessions) view: select the session in place. */
  | { kind: 'select-in-sessions'; sessionId: string }
  /** Tasks view, session belongs to a Task: open it as the active Subtask
   *  without leaving the view. */
  | { kind: 'select-subtask-in-tasks'; taskId: string; sessionId: string }
  /** Tasks view, standalone session: select it in the 未分配 group without
   *  leaving the view. */
  | { kind: 'select-standalone-in-tasks'; sessionId: string }
  /** Any other view cannot present a conversation: fall back to Repos. */
  | { kind: 'fallback-sessions'; sessionId: string };

/**
 * Notification-click targeting (in-place jump): both the Repos and the
 * Tasks view can present every unarchived Session, so a session target
 * selects inside the CURRENT view instead of yanking the user back to
 * Repos. Views without a conversation surface keep the legacy Repos
 * fallback.
 */
export function resolveSessionNavigation(
  target: { sessionId: string },
  context: {
    mode: Mode;
    session: { task_id: string | null } | null;
  },
): SessionNavigationAction {
  if (context.mode === 'sessions') {
    return { kind: 'select-in-sessions', sessionId: target.sessionId };
  }
  if (context.mode === 'tasks') {
    const taskId = context.session?.task_id;
    if (taskId) {
      return { kind: 'select-subtask-in-tasks', taskId, sessionId: target.sessionId };
    }
    return { kind: 'select-standalone-in-tasks', sessionId: target.sessionId };
  }
  return { kind: 'fallback-sessions', sessionId: target.sessionId };
}
