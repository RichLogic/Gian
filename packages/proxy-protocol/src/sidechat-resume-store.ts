import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { ConfigValue, SideChatSnapshot } from './schemas.js';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const REF_VERSION = 'v1';

export interface SidechatResumePayload {
  sidechatId: string;
  parentSessionId: string;
  nativeSessionId: string;
  anchor: SideChatSnapshot['anchor'];
  sessionConfig: Record<string, ConfigValue>;
  turnConfigOptions?: SideChatSnapshot['turnConfigOptions'];
  turnConfigRevision?: string;
  createdAt: string;
}

export interface SidechatCloseTombstone {
  sidechatId: string;
  providerDataDeleted: boolean;
}

interface TombstoneFile {
  schemaVersion: 1;
  closed: Record<string, SidechatCloseTombstone>;
}

function atomicWrite(path: string, value: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, value, { encoding: 'utf8', ...(mode ? { mode } : {}) });
  renameSync(temporary, path);
}

function readTombstones(path: string | null): TombstoneFile {
  if (!path || !existsSync(path)) return { schemaVersion: 1, closed: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TombstoneFile>;
    if (parsed.schemaVersion !== 1 || !parsed.closed || typeof parsed.closed !== 'object') {
      return { schemaVersion: 1, closed: {} };
    }
    return { schemaVersion: 1, closed: parsed.closed };
  } catch {
    return { schemaVersion: 1, closed: {} };
  }
}

function validPayload(value: unknown): value is SidechatResumePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Partial<SidechatResumePayload>;
  return typeof payload.sidechatId === 'string' && payload.sidechatId.length > 0
    && typeof payload.parentSessionId === 'string' && payload.parentSessionId.length > 0
    && typeof payload.nativeSessionId === 'string' && payload.nativeSessionId.length > 0
    && typeof payload.createdAt === 'string' && !Number.isNaN(Date.parse(payload.createdAt))
    && !!payload.anchor && typeof payload.anchor === 'object'
    && !!payload.sessionConfig && typeof payload.sessionConfig === 'object';
}

function canonicalBase64url(value: string): Buffer | null {
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.toString('base64url') === value ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Seals Provider-owned Side Chat recovery data into the opaque resumeRef and
 * persists only hashed close tombstones. The encryption key is plugin-local,
 * never sent over the protocol, and survives Proxy restarts through the Host
 * supplied GIAN_PLUGIN_DATA_DIR.
 */
export class OpaqueSidechatResumeStore {
  private readonly key: Buffer;
  private readonly tombstonePath: string | null;
  private readonly tombstones: TombstoneFile;

  constructor(dataDir = process.env.GIAN_PLUGIN_DATA_DIR?.trim() || null) {
    if (!dataDir) {
      this.key = randomBytes(KEY_BYTES);
      this.tombstonePath = null;
      this.tombstones = { schemaVersion: 1, closed: {} };
      return;
    }

    const keyPath = join(dataDir, 'sidechat-resume.key');
    mkdirSync(dataDir, { recursive: true });
    if (!existsSync(keyPath)) atomicWrite(keyPath, randomBytes(KEY_BYTES).toString('base64url'), 0o600);
    const decoded = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64url');
    if (decoded.length !== KEY_BYTES) {
      throw new Error('Invalid Side Chat resume key.');
    }
    this.key = decoded;
    this.tombstonePath = join(dataDir, 'sidechat-closed.json');
    this.tombstones = readTombstones(this.tombstonePath);
  }

  seal(payload: SidechatResumePayload): { id: string } {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    return {
      id: [
        REF_VERSION,
        iv.toString('base64url'),
        encrypted.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
      ].join('.'),
    };
  }

  open(refId: string): SidechatResumePayload | null {
    const [version, ivText, encryptedText, tagText, ...extra] = refId.split('.');
    if (version !== REF_VERSION || !ivText || !encryptedText || !tagText || extra.length > 0) return null;
    try {
      const iv = canonicalBase64url(ivText);
      const encrypted = canonicalBase64url(encryptedText);
      const tag = canonicalBase64url(tagText);
      if (!iv || !encrypted || !tag || iv.length !== IV_BYTES || encrypted.length === 0 || tag.length !== 16) {
        return null;
      }
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      const decoded = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      const payload = JSON.parse(decoded.toString('utf8')) as unknown;
      return validPayload(payload) ? payload : null;
    } catch {
      return null;
    }
  }

  closed(refId: string): SidechatCloseTombstone | null {
    return this.tombstones.closed[this.digest(refId)] ?? null;
  }

  rememberClosed(refId: string, tombstone: SidechatCloseTombstone): void {
    this.tombstones.closed[this.digest(refId)] = tombstone;
    if (this.tombstonePath) {
      atomicWrite(this.tombstonePath, `${JSON.stringify(this.tombstones)}\n`, 0o600);
    }
  }

  private digest(refId: string): string {
    return createHash('sha256').update(refId).digest('hex');
  }
}
