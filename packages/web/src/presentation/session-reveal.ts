/**
 * Session reveal intent (Issue #53/#168 navigation follow-up).
 *
 * An explicit session navigation — search hit, Inbox open, notification,
 * rail row click — selects the conversation in the main pane. The rail that
 * lists the session must also reveal the row: expand its section/group,
 * raise the show-more cap, and scroll the row into the rail's own scroll
 * container. The two sides are decoupled (App commits the navigation; the
 * Repos/Tasks rail mounts afterwards, possibly with the read model still
 * loading), so the intent lives in this module-level slot until the owning
 * rail consumes it.
 *
 * Rules:
 * - Only explicit navigation posts here (App.commitSessionNavigation). WS
 *   refreshes never do — a reveal must never steal the user's scroll.
 * - Latest request wins: a quick A→B navigation supersedes A even when the
 *   rail has not consumed A yet.
 * - A rail consumes only once the row is actually rendered and scrolled. A
 *   row that can never render (archived read-only target, done-task subtask)
 *   is consumed-and-dropped so the intent does not replay forever; an
 *   absent read model keeps the intent pending until data arrives.
 */

export interface SessionRevealRequest {
  readonly sessionId: string;
  /** Which conversation list surfaces the row. */
  readonly surface: 'sessions' | 'tasks';
  /** Owning task id when the surface is Tasks and the session is task-bound. */
  readonly taskId: string | null;
  readonly nonce: number;
}

let latest: SessionRevealRequest | null = null;
let counter = 0;
const listeners = new Set<() => void>();

export function requestSessionReveal(input: {
  sessionId: string;
  surface: 'sessions' | 'tasks';
  taskId: string | null;
}): SessionRevealRequest {
  counter += 1;
  latest = { ...input, nonce: counter };
  for (const listener of [...listeners]) listener();
  return latest;
}

export function peekSessionReveal(): SessionRevealRequest | null {
  return latest;
}

/** Consume only when the request is still the latest — an older rail pass
 *  must never clear a newer navigation's intent. */
export function consumeSessionReveal(nonce: number): void {
  if (latest && latest.nonce === nonce) {
    latest = null;
    for (const listener of [...listeners]) listener();
  }
}

export function subscribeSessionReveal(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper: drop any pending intent between cases. */
export function __resetSessionRevealForTest(): void {
  latest = null;
}

/** Drop the pending intent without revealing — a newer navigation or leaving
 *  the conversation surface retires it so a late read-model arrival cannot
 *  scroll the rail long after the user moved on. */
export function retireSessionReveal(): void {
  if (!latest) return;
  latest = null;
  for (const listener of [...listeners]) listener();
}

/** A rail child's show-more cap finished raising, so the target row may now
 *  be in the DOM. The rail re-runs its scroll pass on this signal — a child
 *  re-render alone never re-fires the parent's effects. */
const readinessListeners = new Set<() => void>();

export function notifyRevealRowReady(): void {
  for (const listener of [...readinessListeners]) listener();
}

export function subscribeRevealRowReady(listener: () => void): () => void {
  readinessListeners.add(listener);
  return () => {
    readinessListeners.delete(listener);
  };
}

/** Scroll `row` into view inside the rail's own scroll container only —
 *  never a page-level scrollIntoView, which would drag the chat pane. */
export function scrollRowIntoContainerView(container: HTMLElement, row: HTMLElement): void {
  const cRect = container.getBoundingClientRect();
  const rRect = row.getBoundingClientRect();
  if (rRect.top >= cRect.top && rRect.bottom <= cRect.bottom) return;
  const margin = 8;
  container.scrollTop += rRect.top < cRect.top
    ? rRect.top - cRect.top - margin
    : rRect.bottom - cRect.bottom + margin;
}
