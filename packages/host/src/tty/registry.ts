import { randomBytes } from 'node:crypto';

/**
 * Per-session, single-use auth registry for HTTP hooks.
 *
 * When the host flips a session to TTY mode it mints a fresh `hookToken`,
 * embeds it in every hook URL in the per-spawn `settings.json`, and stores
 * `{ token, sessionId }` here. The receiver verifies the token before
 * forwarding the hook payload anywhere.
 *
 * The token rotates on every mode flip — even if the same Gian session
 * keeps the same Claude uuid, the next TTY spawn gets a brand-new token
 * and old leaked URLs stop working. We do not persist tokens to disk; a
 * host restart invalidates all in-flight hook URLs (the next TTY spawn
 * re-issues fresh ones).
 */
export interface TtyHookCredentials {
  /** Opaque 32-byte hex token. URL-safe and short enough to embed in
   *  the hook URL query string. */
  token: string;
}

export class TtyHookRegistry {
  private bySessionId = new Map<string, TtyHookCredentials>();
  private byToken = new Map<string, string>();

  /** Mint and persist new credentials for a session. Replaces any
   *  existing entry — caller should already have torn down the PTY. */
  issue(sessionId: string): TtyHookCredentials {
    this.revoke(sessionId);
    const token = randomBytes(24).toString('hex');
    const credentials: TtyHookCredentials = { token };
    this.bySessionId.set(sessionId, credentials);
    this.byToken.set(token, sessionId);
    return credentials;
  }

  /** Drop credentials for a session (e.g. on mode flip back to
   *  structured, or session close). Idempotent. */
  revoke(sessionId: string): void {
    const existing = this.bySessionId.get(sessionId);
    if (!existing) return;
    this.bySessionId.delete(sessionId);
    this.byToken.delete(existing.token);
  }

  /** Resolve `token` → `sessionId`, or `null` for unknown tokens.
   *  Constant-time equality is unnecessary here because the lookup is
   *  Map-based, not string-compared. */
  resolve(token: string): string | null {
    return this.byToken.get(token) ?? null;
  }

  get(sessionId: string): TtyHookCredentials | null {
    return this.bySessionId.get(sessionId) ?? null;
  }
}
