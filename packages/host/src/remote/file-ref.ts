import { lstat, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  MAX_FILE_PREVIEW_BYTES,
  RemoteProtocolError,
  generateCanonicalId,
} from '@gian/remote-protocol';
import { previewMimeForAttachment, resolveAttachmentPath } from '../storage/attachments.js';
import { resolveWithinWorkspace } from '../workspace/safe-path.js';
import type { Db } from '../storage/db.js';

const FILE_REF_TTL_MS = 60 * 60 * 1000;
// The marker cannot be a valid workspace-relative path, so ordinary files can
// never be mistaken for Session attachments when a stored handle is resolved.
const SESSION_ATTACHMENT_PREFIX = '../@gian-attachment/';

export interface RemoteFileRefRecord {
  id: string;
  deviceId: string;
  sessionId: string;
  relativePath: string;
  contentRevision: string;
  issuedAt: string;
  expiresAt: string;
}

export class RemoteFileRefService {
  constructor(
    private readonly db: Db,
    private readonly workspacePath: (sessionId: string) => string | null,
    private readonly sessionVisible?: (sessionId: string) => boolean,
  ) {}

  issue(input: {
    deviceId: string;
    sessionId: string;
    relativePath: string;
    contentRevision: string;
  }): RemoteFileRefRecord {
    if (input.relativePath.startsWith('/') || input.relativePath.includes('\0')) {
      throw new RemoteProtocolError('INVALID_FRAME', 'file references are Host-issued only');
    }
    const now = Date.now();
    const record: RemoteFileRefRecord = {
      id: generateCanonicalId(),
      deviceId: input.deviceId,
      sessionId: input.sessionId,
      relativePath: input.relativePath,
      contentRevision: input.contentRevision,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + FILE_REF_TTL_MS).toISOString(),
    };
    this.db.prepare(
      `INSERT INTO remote_file_refs
        (id, device_id, session_id, relative_path, content_revision, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id,
      record.deviceId,
      record.sessionId,
      record.relativePath,
      record.contentRevision,
      record.issuedAt,
      record.expiresAt,
    );
    return record;
  }

  issueSessionAttachment(input: {
    deviceId: string;
    sessionId: string;
    filename: string;
    contentRevision: string;
  }): RemoteFileRefRecord {
    const filename = basename(input.filename);
    if (!filename || filename !== input.filename) {
      throw new RemoteProtocolError('INVALID_FRAME', 'attachment filename is invalid');
    }
    return this.issue({
      deviceId: input.deviceId,
      sessionId: input.sessionId,
      relativePath: `${SESSION_ATTACHMENT_PREFIX}${filename}`,
      contentRevision: input.contentRevision,
    });
  }

  get(id: string): RemoteFileRefRecord | null {
    const row = this.db.prepare('SELECT * FROM remote_file_refs WHERE id = ?').get(id) as {
      id: string;
      device_id: string;
      session_id: string;
      relative_path: string;
      content_revision: string;
      issued_at: string;
      expires_at: string;
    } | undefined;
    return row ? {
      id: row.id,
      deviceId: row.device_id,
      sessionId: row.session_id,
      relativePath: row.relative_path,
      contentRevision: row.content_revision,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
    } : null;
  }

  invalidateDevice(deviceId: string): void {
    this.db.prepare('DELETE FROM remote_file_refs WHERE device_id = ?').run(deviceId);
  }

  absolutePath(record: RemoteFileRefRecord): string {
    const attachment = this.attachmentFilename(record);
    if (attachment) {
      const path = resolveAttachmentPath(record.sessionId, attachment);
      if (!path) throw new RemoteProtocolError('INVALID_FRAME', 'attachment path is invalid');
      return path;
    }
    const root = this.workspacePath(record.sessionId);
    if (!root) throw new RemoteProtocolError('INVALID_FRAME', 'session has no workspace');
    return join(root, record.relativePath);
  }

  async readBytes(input: {
    deviceId: string;
    handleId: string;
    maxBytes?: number;
  }): Promise<{ record: RemoteFileRefRecord; bytes: Buffer; name: string; mime: string }> {
    const record = this.get(input.handleId);
    if (!record || record.deviceId !== input.deviceId) {
      throw new RemoteProtocolError('FILE_REFERENCE_EXPIRED', 'file reference is not valid for this device');
    }
    this.assertSessionVisible(record);
    if (Date.parse(record.expiresAt) <= Date.now()) {
      throw new RemoteProtocolError('FILE_REFERENCE_EXPIRED', 'file reference expired');
    }
    const attachment = this.attachmentFilename(record);
    if (attachment) {
      const path = resolveAttachmentPath(record.sessionId, attachment);
      const stat = path ? await lstat(path).catch(() => null) : null;
      if (!path || !stat || stat.isSymbolicLink() || !stat.isFile()) {
        throw new RemoteProtocolError('ATTACHMENT_NOT_FOUND', 'attachment is unavailable');
      }
      const limit = input.maxBytes ?? Number.POSITIVE_INFINITY;
      if (stat.size > limit) throw new RemoteProtocolError('FILE_TOO_LARGE', 'download exceeds the allowed size');
      return {
        record,
        bytes: await readFile(path),
        name: attachment,
        mime: previewMimeForAttachment(attachment),
      };
    }
    const root = this.workspacePath(record.sessionId);
    if (!root) throw new RemoteProtocolError('INVALID_FRAME', 'session has no workspace');
    const candidate = join(root, record.relativePath);
    const linkStat = await lstat(candidate).catch(() => null);
    if (!linkStat || linkStat.isSymbolicLink() || !linkStat.isFile()) {
      throw new RemoteProtocolError('INVALID_FRAME', 'symlink or non-file targets are rejected');
    }
    const resolved = await resolveWithinWorkspace(root, record.relativePath);
    if (!resolved) throw new RemoteProtocolError('INVALID_FRAME', 'path is outside the workspace');
    const stat = await lstat(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new RemoteProtocolError('INVALID_FRAME', 'symlink or non-file targets are rejected');
    }
    const limit = input.maxBytes ?? Number.POSITIVE_INFINITY;
    if (stat.size > limit) {
      throw new RemoteProtocolError('FILE_TOO_LARGE', 'download exceeds the allowed size');
    }
    return {
      record,
      bytes: await readFile(resolved),
      name: basename(record.relativePath),
      mime: 'application/octet-stream',
    };
  }

  async preview(input: {
    deviceId: string;
    handleId: string;
    expectedRevision?: string;
  }): Promise<{
    transfer_id: string;
    file: { handle_id: string; name: string; mime: string; size: number; revision: string };
    preview_max_bytes: typeof MAX_FILE_PREVIEW_BYTES;
    bytes: Buffer;
  }> {
    const record = this.get(input.handleId);
    if (!record || record.deviceId !== input.deviceId) {
      throw new RemoteProtocolError('FILE_REFERENCE_EXPIRED', 'file reference is not valid for this device');
    }
    this.assertSessionVisible(record);
    if (Date.parse(record.expiresAt) <= Date.now()) {
      throw new RemoteProtocolError('FILE_REFERENCE_EXPIRED', 'file reference expired');
    }
    if (input.expectedRevision && input.expectedRevision !== record.contentRevision) {
      throw new RemoteProtocolError('FILE_REFERENCE_EXPIRED', 'file revision changed');
    }
    const attachment = this.attachmentFilename(record);
    if (attachment) {
      const path = resolveAttachmentPath(record.sessionId, attachment);
      const stat = path ? await lstat(path).catch(() => null) : null;
      if (!path || !stat || stat.isSymbolicLink() || !stat.isFile()) {
        throw new RemoteProtocolError('ATTACHMENT_NOT_FOUND', 'attachment is unavailable');
      }
      if (stat.size > MAX_FILE_PREVIEW_BYTES) {
        throw new RemoteProtocolError('FILE_TOO_LARGE', 'preview exceeds 1 MiB');
      }
      const bytes = await readFile(path);
      return {
        transfer_id: generateCanonicalId(),
        file: {
          handle_id: record.id,
          name: attachment,
          mime: previewMimeForAttachment(attachment),
          size: bytes.length,
          revision: record.contentRevision,
        },
        preview_max_bytes: MAX_FILE_PREVIEW_BYTES,
        bytes,
      };
    }
    const root = this.workspacePath(record.sessionId);
    if (!root) throw new RemoteProtocolError('INVALID_FRAME', 'session has no workspace');
    const candidate = join(root, record.relativePath);
    const linkStat = await lstat(candidate).catch(() => null);
    if (!linkStat || linkStat.isSymbolicLink() || !linkStat.isFile()) {
      throw new RemoteProtocolError('INVALID_FRAME', 'symlink or non-file targets are rejected');
    }
    const resolved = await resolveWithinWorkspace(root, record.relativePath);
    if (!resolved) throw new RemoteProtocolError('INVALID_FRAME', 'path is outside the workspace');
    const stat = await lstat(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new RemoteProtocolError('INVALID_FRAME', 'symlink or non-file targets are rejected');
    }
    if (stat.size > MAX_FILE_PREVIEW_BYTES) {
      throw new RemoteProtocolError('FILE_TOO_LARGE', 'preview exceeds 1 MiB');
    }
    const bytes = await readFile(resolved);
    return {
      transfer_id: generateCanonicalId(),
      file: {
        handle_id: record.id,
        name: basename(record.relativePath),
        mime: 'application/octet-stream',
        size: bytes.length,
        revision: record.contentRevision,
      },
      preview_max_bytes: MAX_FILE_PREVIEW_BYTES,
      bytes,
    };
  }

  private attachmentFilename(record: RemoteFileRefRecord): string | null {
    if (!record.relativePath.startsWith(SESSION_ATTACHMENT_PREFIX)) return null;
    const filename = record.relativePath.slice(SESSION_ATTACHMENT_PREFIX.length);
    return filename && basename(filename) === filename ? filename : null;
  }

  private assertSessionVisible(record: RemoteFileRefRecord): void {
    if (this.sessionVisible && !this.sessionVisible(record.sessionId)) {
      throw new RemoteProtocolError('FILE_REFERENCE_EXPIRED', 'file reference is no longer available');
    }
  }
}
