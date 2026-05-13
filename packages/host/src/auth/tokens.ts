import { randomBytes, createHash } from 'node:crypto';
import type { Db } from '../storage/db.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface Token {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt?: number;
}

// ---------------------------------------------------------------------------
// API Token Manager — SQLite-backed, survives restarts
// ---------------------------------------------------------------------------

interface TokenRow {
  id: string;
  hash: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

function rowToToken(row: TokenRow): Token {
  return {
    id: row.id,
    label: row.label,
    createdAt: Date.parse(row.created_at),
    lastUsedAt: row.last_used_at ? Date.parse(row.last_used_at) : undefined,
  };
}

export class TokenManager {
  constructor(private db: Db) {}

  createToken(label: string): { token: string; record: Token } {
    const plaintext = randomBytes(32).toString('hex');
    const hash = hashToken(plaintext);
    const id = randomBytes(16).toString('hex');
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tokens (id, hash, label, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(id, hash, label, now);
    const record: Token = { id, label, createdAt: Date.parse(now) };
    return { token: plaintext, record };
  }

  verifyToken(plaintext: string): Token | null {
    const hash = hashToken(plaintext);
    const row = this.db
      .prepare('SELECT * FROM tokens WHERE hash = ?')
      .get(hash) as TokenRow | undefined;
    if (!row) return null;
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE tokens SET last_used_at = ? WHERE hash = ?')
      .run(now, hash);
    return rowToToken({ ...row, last_used_at: now });
  }

  revokeToken(id: string): void {
    this.db.prepare('DELETE FROM tokens WHERE id = ?').run(id);
  }

  listTokens(): Token[] {
    const rows = this.db
      .prepare('SELECT * FROM tokens ORDER BY created_at ASC')
      .all() as TokenRow[];
    return rows.map(rowToToken);
  }
}

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
