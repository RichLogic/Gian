import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_CONCURRENT_TRANSFERS_PER_DEVICE,
  MAX_INFLIGHT_UPLOAD_BYTES_PER_DEVICE,
  RemoteProtocolError,
  generateCanonicalId,
} from '@gian/remote-protocol';
import type { InputItem } from '@gian/shared';
import { writeAttachment } from '../storage/attachments.js';
import type { Db } from '../storage/db.js';

const UPLOAD_TTL_MS = 30 * 60 * 1000;

export interface RemoteUploadIntent {
  id: string;
  deviceId: string;
  sessionId: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  received: number;
  state: 'open' | 'complete' | 'expired';
  pinned: boolean;
  tempName: string;
  transferId: string;
}

export class RemoteAttachmentService {
  private readonly writeLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly sessionVisible?: (sessionId: string) => boolean,
  ) {}

  async begin(input: {
    deviceId: string;
    sessionId: string;
    name: string;
    mime: string;
    size: number;
    sha256: string;
    uploadId?: string;
    transferId?: string;
  }): Promise<RemoteUploadIntent> {
    if (input.size > MAX_ATTACHMENT_BYTES) {
      throw new RemoteProtocolError('FILE_TOO_LARGE', 'attachment exceeds 20 MiB');
    }
    if (this.sessionVisible && !this.sessionVisible(input.sessionId)) {
      throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'upload session is not visible');
    }
    this.gc();
    const transferId = input.transferId ?? input.uploadId ?? generateCanonicalId();
    const existing = this.getByTransferId(input.deviceId, transferId)
      ?? (input.uploadId ? this.get(input.uploadId) : null);
    if (existing && existing.deviceId === input.deviceId && existing.state === 'open') {
      return existing;
    }
    const id = input.uploadId ?? transferId;
    const stats = this.db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes
         FROM remote_upload_intents
        WHERE device_id = ? AND state = 'open'`,
    ).get(input.deviceId) as { n: number; bytes: number };
    if (stats.n >= MAX_CONCURRENT_TRANSFERS_PER_DEVICE) {
      throw new RemoteProtocolError('RATE_LIMITED', 'too many open uploads for this device');
    }
    if (stats.bytes + input.size > MAX_INFLIGHT_UPLOAD_BYTES_PER_DEVICE) {
      throw new RemoteProtocolError('RATE_LIMITED', 'open upload bytes exceed the per-device limit');
    }
    const tempName = `${id}.part`;
    await mkdir(this.tempDir(), { recursive: true, mode: 0o700 });
    await writeFile(this.tempPath(tempName), Buffer.alloc(0), { mode: 0o600 });
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO remote_upload_intents
        (id, device_id, session_id, name, mime, size, sha256, received, state, pinned, temp_name, created_at, expires_at, transfer_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'open', 0, ?, ?, ?, ?)`,
    ).run(
      id,
      input.deviceId,
      input.sessionId,
      input.name,
      input.mime,
      input.size,
      input.sha256,
      tempName,
      new Date(now).toISOString(),
      new Date(now + UPLOAD_TTL_MS).toISOString(),
      transferId,
    );
    return this.get(id)!;
  }

  async writeChunk(input: {
    deviceId: string;
    uploadId: string;
    offset: number;
    bytes: Buffer;
  }): Promise<RemoteUploadIntent> {
    const previous = this.writeLocks.get(input.uploadId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ours = previous.then(() => gate);
    this.writeLocks.set(input.uploadId, ours);
    await previous;
    try {
      const intent = this.requireOpen(input.deviceId, input.uploadId);
      if (input.offset !== intent.received) {
        throw new RemoteProtocolError('TRANSFER_CONFLICT', 'upload offset does not match received bytes');
      }
      if (intent.received + input.bytes.length > intent.size) {
        throw new RemoteProtocolError('FILE_TOO_LARGE', 'upload exceeds declared size');
      }
      const handle = await open(this.tempPath(intent.tempName), 'r+');
      try {
        await handle.write(input.bytes, 0, input.bytes.length, input.offset);
      } finally {
        await handle.close();
      }
      this.db.prepare('UPDATE remote_upload_intents SET received = ? WHERE id = ?')
        .run(intent.received + input.bytes.length, intent.id);
      return this.get(intent.id)!;
    } finally {
      release();
      if (this.writeLocks.get(input.uploadId) === ours) this.writeLocks.delete(input.uploadId);
    }
  }

  async complete(input: { deviceId: string; uploadId: string }): Promise<InputItem> {
    const previous = this.writeLocks.get(input.uploadId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ours = previous.then(() => gate);
    this.writeLocks.set(input.uploadId, ours);
    await previous;
    try {
      const intent = this.requireOpen(input.deviceId, input.uploadId);
      if (intent.received !== intent.size) {
        throw new RemoteProtocolError('TRANSFER_CONFLICT', 'upload is incomplete');
      }
      const bytes = await readFile(this.tempPath(intent.tempName));
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== intent.sha256) {
        throw new RemoteProtocolError('ATTACHMENT_HASH_MISMATCH', 'attachment hash mismatch');
      }
      const path = await writeAttachment(intent.sessionId, bytes, intent.mime, intent.name);
      this.db.prepare(`UPDATE remote_upload_intents SET state = 'complete', temp_name = ? WHERE id = ?`)
        .run(path, intent.id);
      await rm(this.tempPath(intent.tempName), { force: true });
      return intent.mime.startsWith('image/')
        ? { type: 'localImage', path, name: intent.name, mime: intent.mime, size: intent.size }
        : { type: 'localFile', path, name: intent.name, mime: intent.mime, size: intent.size };
    } finally {
      release();
      if (this.writeLocks.get(input.uploadId) === ours) this.writeLocks.delete(input.uploadId);
    }
  }

  pin(uploadId: string): void {
    this.db.prepare('UPDATE remote_upload_intents SET pinned = 1 WHERE id = ?').run(uploadId);
  }

  unpin(uploadId: string): void {
    this.db.prepare('UPDATE remote_upload_intents SET pinned = 0 WHERE id = ?').run(uploadId);
  }

  resolveHandle(deviceId: string, attachmentId: string, sessionId?: string): InputItem | null {
    const intent = this.get(attachmentId);
    if (!intent || intent.deviceId !== deviceId || intent.state !== 'complete') return null;
    if (sessionId && intent.sessionId !== sessionId) return null;
    if (this.sessionVisible && !this.sessionVisible(intent.sessionId)) return null;
    const path = intent.tempName;
    return intent.mime.startsWith('image/')
      ? { type: 'localImage', path, name: intent.name, mime: intent.mime, size: intent.size }
      : { type: 'localFile', path, name: intent.name, mime: intent.mime, size: intent.size };
  }

  invalidateDevice(deviceId: string): void {
    const rows = this.db.prepare('SELECT id FROM remote_upload_intents WHERE device_id = ?')
      .all(deviceId) as Array<{ id: string }>;
    for (const row of rows) this.writeLocks.delete(row.id);
    this.db.prepare(`UPDATE remote_upload_intents SET state = 'expired' WHERE device_id = ?`).run(deviceId);
  }

  findHandle(deviceId: string, sessionId: string, path: string): string | null {
    const row = this.db.prepare(
      `SELECT id FROM remote_upload_intents
        WHERE device_id = ? AND session_id = ? AND temp_name = ? AND state = 'complete'`,
    ).get(deviceId, sessionId, path) as { id: string } | undefined;
    return row?.id ?? null;
  }

  async readBytes(deviceId: string, attachmentId: string): Promise<{
    bytes: Buffer;
    name: string;
    mime: string;
    size: number;
  }> {
    const intent = this.get(attachmentId);
    if (!intent || intent.deviceId !== deviceId || intent.state !== 'complete') {
      throw new RemoteProtocolError('ATTACHMENT_NOT_FOUND', 'attachment handle is not usable');
    }
    if (this.sessionVisible && !this.sessionVisible(intent.sessionId)) {
      throw new RemoteProtocolError('ATTACHMENT_NOT_FOUND', 'attachment handle is no longer usable');
    }
    const bytes = await readFile(intent.tempName);
    return { bytes, name: intent.name, mime: intent.mime, size: intent.size };
  }

  findHandleByPath(path: string): string | null {
    const row = this.db.prepare(
      `SELECT id FROM remote_upload_intents WHERE temp_name = ? AND state = 'complete'`,
    ).get(path) as { id: string } | undefined;
    return row?.id ?? null;
  }

  gc(now = Date.now()): number {
    const rows = this.db.prepare(
      `SELECT id, temp_name, state FROM remote_upload_intents
        WHERE pinned = 0
          AND (
            (state IN ('open', 'expired') AND expires_at <= ?)
            OR (state = 'complete' AND expires_at <= ?)
          )`,
    ).all(new Date(now).toISOString(), new Date(now).toISOString()) as Array<{
      id: string;
      temp_name: string;
      state: string;
    }>;
    for (const row of rows) {
      const path = row.state === 'complete' ? row.temp_name : this.tempPath(row.temp_name);
      rmSync(path, { force: true });
      this.writeLocks.delete(row.id);
      this.db.prepare(`UPDATE remote_upload_intents SET state = 'expired' WHERE id = ?`).run(row.id);
    }
    return rows.length;
  }

  writeLockCount(): number {
    return this.writeLocks.size;
  }

  getByTransferId(deviceId: string, transferId: string): RemoteUploadIntent | null {
    const row = this.db.prepare(
      `SELECT * FROM remote_upload_intents
        WHERE device_id = ? AND (transfer_id = ? OR id = ?)
        ORDER BY CASE WHEN state = 'open' THEN 0 ELSE 1 END
        LIMIT 1`,
    ).get(deviceId, transferId, transferId) as UploadRow | undefined;
    return row ? projectUpload(row) : null;
  }

  get(id: string): RemoteUploadIntent | null {
    const row = this.db.prepare('SELECT * FROM remote_upload_intents WHERE id = ?').get(id) as UploadRow | undefined;
    return row ? projectUpload(row) : null;
  }

  private requireOpen(deviceId: string, uploadId: string): RemoteUploadIntent {
    const intent = this.get(uploadId);
    if (!intent || intent.deviceId !== deviceId) {
      throw new RemoteProtocolError('ATTACHMENT_NOT_FOUND', 'upload handle is not valid for this device');
    }
    if (intent.state !== 'open') {
      throw new RemoteProtocolError('UPLOAD_EXPIRED', 'upload handle is no longer open');
    }
    if (this.sessionVisible && !this.sessionVisible(intent.sessionId)) {
      throw new RemoteProtocolError('UPLOAD_EXPIRED', 'upload session is no longer visible');
    }
    return intent;
  }

  private tempDir(): string {
    return join(this.dataDir, 'remote-uploads');
  }

  private tempPath(name: string): string {
    return join(this.tempDir(), name);
  }
}

interface UploadRow {
  id: string;
  device_id: string;
  session_id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  received: number;
  state: RemoteUploadIntent['state'];
  pinned: number;
  temp_name: string;
  transfer_id?: string | null;
}

function projectUpload(row: UploadRow): RemoteUploadIntent {
  return {
    id: row.id,
    deviceId: row.device_id,
    sessionId: row.session_id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    received: row.received,
    state: row.state,
    pinned: row.pinned === 1,
    tempName: row.temp_name,
    transferId: row.transfer_id ?? row.id,
  };
}
