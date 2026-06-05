/**
 * Bookkeeping for the "switch a session to TTY, then flush a staged first
 * message once it's up" dance used by the Beta surface.
 *
 * Why this exists as its own unit: the logic used to live as two loose refs in
 * App.tsx (a `Set` of in-flight switches + a `Map` of staged text). They only
 * cleared themselves when the host confirmed `runtime_mode='tty'`. If that
 * confirmation never came — the session wedged and the user force-recovered,
 * or they switched back to Chat — the refs leaked: the next Beta send saw a
 * stale "switch already in flight" entry, suppressed the `switch-runtime`, and
 * the message was stashed forever while the composer sat disabled. Encapsulating
 * the two collections behind explicit lifecycle methods makes that leak
 * impossible to reintroduce silently and lets it be unit-tested.
 */
export class PendingTtySwitch {
  /** sessionId → text staged to paste into the PTY once TTY is up. */
  private readonly staged = new Map<string, string>();
  /** sessionIds with a `switch-runtime → tty` request already in flight. */
  private readonly switching = new Set<string>();

  /**
   * Record intent to switch this session to TTY and (optionally) flush `text`
   * once it's up. Returns whether the caller should actually emit a
   * `switch-runtime` now — `false` when one is already in flight, so we don't
   * double-switch. Pass `text=null` for a switch with nothing to flush (a
   * brand-new session whose first message was empty).
   */
  stage(sessionId: string, text: string | null): { sendSwitch: boolean } {
    if (text !== null) this.staged.set(sessionId, text);
    if (this.switching.has(sessionId)) return { sendSwitch: false };
    this.switching.add(sessionId);
    return { sendSwitch: true };
  }

  /**
   * The host confirmed `runtime_mode='tty'`. Clears the in-flight flag and
   * returns the staged text to flush (or `null` if nothing was staged).
   */
  onTty(sessionId: string): { flush: string | null } {
    this.switching.delete(sessionId);
    const text = this.staged.get(sessionId);
    if (text === undefined) return { flush: null };
    this.staged.delete(sessionId);
    return { flush: text };
  }

  /**
   * Drop all bookkeeping for a session. Call when it leaves TTY for any reason
   * the switch confirmation won't cover — force-recover, a manual switch back
   * to Chat, or a dispatch error — so the next `stage()` re-initiates a clean
   * switch instead of being suppressed by a stale in-flight flag.
   */
  clear(sessionId: string): void {
    this.switching.delete(sessionId);
    this.staged.delete(sessionId);
  }

  /** Test/inspection helper: is a switch currently considered in flight? */
  isSwitching(sessionId: string): boolean {
    return this.switching.has(sessionId);
  }
}
