import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Session tokens — in-memory, intentionally ephemeral (invalidated on restart)
// ---------------------------------------------------------------------------

interface SessionEntry {
  username: string;
  createdAt: number;
}

const sessionStore = new Map<string, SessionEntry>();

export function createSessionToken(username: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  sessionStore.set(token, { username, createdAt: Date.now() });
  return Promise.resolve(token);
}

export function getUsernameForToken(token: string): string | null {
  return sessionStore.get(token)?.username ?? null;
}

export function deleteToken(token: string): void {
  sessionStore.delete(token);
}
