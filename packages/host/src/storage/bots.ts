import type { Bot, BotExtra, BotMode, IMPlatform } from '@gian/shared';
import type { Db } from './db.js';
import { randomUUID, scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// ---------------------------------------------------------------------------
// Encryption key derivation
// Tokens and platform credentials in `extra` are stored as
// <iv-hex>:<authTag-hex>:<ciphertext-hex> using AES-256-GCM.
// On read: detect the new format (three colon-separated hex segments) and
// decrypt. Old plaintext JSON rows (starting with '{') are parsed directly
// and re-saved encrypted on the next write.
// ---------------------------------------------------------------------------

let _warned = false;

function getEncryptionKey(): Buffer {
  const secret = process.env['GIAN_SECRET'] ?? '';
  if (!secret) {
    if (!_warned) {
      console.warn(
        '[gian] WARNING: GIAN_SECRET not set; using dev key. Set GIAN_SECRET=<32-char-random> for production.',
      );
      _warned = true;
    }
  }
  const passphrase = secret || 'gian-dev-key-change-me';
  // Derive a stable 32-byte key from the passphrase using scrypt with a fixed
  // salt. The salt is not secret — its only job is to make the derived key
  // domain-separated from any other use of the same passphrase.
  return scryptSync(passphrase, 'gian-extra-v1', 32);
}

function encryptExtra(plain: BotExtra): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const json = JSON.stringify(plain);
  const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

function decryptExtra(stored: string): BotExtra {
  // Detect encrypted format: three colon-separated hex segments.
  const parts = stored.split(':');
  if (parts.length === 3) {
    const key = getEncryptionKey();
    const iv = Buffer.from(parts[0]!, 'hex');
    const authTag = Buffer.from(parts[1]!, 'hex');
    const ciphertext = Buffer.from(parts[2]!, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as BotExtra;
  }
  // Legacy plaintext JSON — parse directly; caller re-saves encrypted on next update.
  return JSON.parse(stored) as BotExtra;
}

// ---------------------------------------------------------------------------
// Row types + mapping
// ---------------------------------------------------------------------------

interface BotRow {
  id: string;
  label: string;
  platform: string;
  workspace_id: string | null;
  mode: string;
  allowed_user_id: string | null;
  enabled: number;
  status: string;
  last_error: string | null;
  last_connected_at: string | null;
  extra: string;
  created_at: string;
  updated_at: string;
}

function rowToBot(row: BotRow): Bot {
  return {
    id: row.id,
    label: row.label,
    platform: row.platform as IMPlatform,
    workspace_id: row.workspace_id,
    mode: row.mode as BotMode,
    allowed_user_id: row.allowed_user_id,
    enabled: row.enabled as 0 | 1,
    status: row.status as Bot['status'],
    last_error: row.last_error,
    last_connected_at: row.last_connected_at,
    extra: decryptExtra(row.extra),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listBots(db: Db): Bot[] {
  const rows = db.prepare('SELECT * FROM bots ORDER BY created_at ASC').all() as BotRow[];
  return rows.map(rowToBot);
}

export function getBot(db: Db, id: string): Bot | null {
  const row = db.prepare('SELECT * FROM bots WHERE id = ?').get(id) as BotRow | undefined;
  return row ? rowToBot(row) : null;
}

export interface CreateBotInput {
  label: string;
  platform: IMPlatform;
  workspace_id?: string | null;
  mode?: BotMode;
  allowed_user_id?: string | null;
  extra: BotExtra;
}

export function createBot(db: Db, input: CreateBotInput): Bot {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO bots (id, label, platform, workspace_id, mode, allowed_user_id, enabled, status, extra, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'disabled', ?, ?, ?)`,
  ).run(
    id,
    input.label,
    input.platform,
    input.workspace_id ?? null,
    input.mode ?? 'read-only',
    input.allowed_user_id ?? null,
    encryptExtra(input.extra),
    now,
    now,
  );
  return getBot(db, id)!;
}

export interface UpdateBotInput {
  label?: string;
  workspace_id?: string | null;
  mode?: BotMode;
  allowed_user_id?: string | null;
  extra?: BotExtra;
  status?: Bot['status'];
  last_error?: string | null;
  last_connected_at?: string | null;
}

export function updateBot(db: Db, id: string, input: UpdateBotInput): Bot | null {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if ('label' in input && input.label !== undefined) { sets.push('label = ?'); vals.push(input.label); }
  if ('workspace_id' in input) { sets.push('workspace_id = ?'); vals.push(input.workspace_id ?? null); }
  if ('mode' in input && input.mode !== undefined) { sets.push('mode = ?'); vals.push(input.mode); }
  if ('allowed_user_id' in input) { sets.push('allowed_user_id = ?'); vals.push(input.allowed_user_id ?? null); }
  if ('extra' in input && input.extra !== undefined) { sets.push('extra = ?'); vals.push(encryptExtra(input.extra)); }
  if ('status' in input && input.status !== undefined) { sets.push('status = ?'); vals.push(input.status); }
  if ('last_error' in input) { sets.push('last_error = ?'); vals.push(input.last_error ?? null); }
  if ('last_connected_at' in input) { sets.push('last_connected_at = ?'); vals.push(input.last_connected_at ?? null); }
  if (sets.length === 0) return getBot(db, id);
  sets.push("updated_at = ?");
  vals.push(new Date().toISOString());
  vals.push(id);
  db.prepare(`UPDATE bots SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getBot(db, id);
}

export function setEnabled(db: Db, id: string, enabled: boolean): Bot | null {
  const now = new Date().toISOString();
  const status = enabled ? 'connecting' : 'disabled';
  db.prepare(`UPDATE bots SET enabled = ?, status = ?, updated_at = ? WHERE id = ?`).run(
    enabled ? 1 : 0,
    status,
    now,
    id,
  );
  return getBot(db, id);
}

export function deleteBot(db: Db, id: string): boolean {
  const result = db.prepare('DELETE FROM bots WHERE id = ?').run(id);
  return result.changes > 0;
}
