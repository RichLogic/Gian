import { lstat, realpath, readdir } from 'node:fs/promises';
import { basename, join, relative, resolve, isAbsolute, sep } from 'node:path';
import type { Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  MAX_FILE_PREVIEW_BYTES,
  MAX_ATTACHMENT_BYTES,
  RemoteProtocolError,
  generateCanonicalId,
} from '@gian/remote-protocol';
import { previewMimeForAttachment, resolveAttachmentPath } from '../storage/attachments.js';
import { resolveWithinWorkspace } from '../workspace/safe-path.js';
import { readBoundedFile, fileReadFailure } from '../workspace/bounded-file.js';
import type { Db } from '../storage/db.js';

const FILE_REF_TTL_MS = 60 * 60 * 1000;
// The marker cannot be a valid workspace-relative path, so ordinary files can
// never be mistaken for Session attachments when a stored handle is resolved.
const SESSION_ATTACHMENT_PREFIX = '../@gian-attachment/';
const EXTERNAL_FILE_PREFIX = '../@gian-external-file/';

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
  private readonly listings = new Map<string, { root: string; until: number; files: string[] }>();
  constructor(
    private readonly db: Db,
    private readonly workspacePath: (sessionId: string) => string | null,
    private readonly sessionVisible?: (sessionId: string) => boolean,
    private readonly referencedFile?: (sessionId: string, path: string) => boolean | Promise<boolean>,
    private readonly referencedAttachment?: (sessionId: string, filename: string) => boolean,
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
    if (record.relativePath.startsWith(EXTERNAL_FILE_PREFIX)) {
      return (JSON.parse(Buffer.from(record.relativePath.slice(EXTERNAL_FILE_PREFIX.length), 'base64url').toString()) as { target: string }).target;
    }
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
    deviceId: string; handleId: string; maxBytes?: number;
  }): Promise<{ record: RemoteFileRefRecord; bytes: Buffer; name: string; mime: string }> {
    const record = this.requireReference(input.deviceId, input.handleId);
    const path = await this.resolveRecord(record);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new RemoteProtocolError('FILE_REFERENCE_EXPIRED', 'file is unavailable');
    if (record.contentRevision.startsWith('fs:') && record.contentRevision !== fileRevision(info)) {
      throw new RemoteProtocolError('FILE_REFERENCE_EXPIRED', 'file content changed');
    }
    const limit = Math.min(input.maxBytes ?? MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES);
    if (info.size > limit) throw new RemoteProtocolError('FILE_TOO_LARGE', 'file exceeds transfer limit');
    let bytes: Buffer;
    try { bytes = await readBoundedFile(path, limit, info); }
    catch (error) {
      const failure = fileReadFailure(error);
      throw new RemoteProtocolError(failure.status === 413 ? 'FILE_TOO_LARGE' : 'FILE_REFERENCE_EXPIRED', failure.error);
    }
    return { record, bytes, name: basename(path), mime: previewMimeForAttachment(path) };
  }

  async preview(input: {
    deviceId: string; handleId: string; expectedRevision?: string;
  }): Promise<{
    transfer_id: string;
    file: { handle_id: string; name: string; mime: string; size: number; revision: string };
    preview_max_bytes: typeof MAX_FILE_PREVIEW_BYTES;
    bytes: Buffer;
  }> {
    const record = this.requireReference(input.deviceId, input.handleId);
    if (input.expectedRevision && input.expectedRevision !== record.contentRevision) {
      throw new RemoteProtocolError('FILE_REFERENCE_EXPIRED', 'file revision changed');
    }
    const read = await this.readBytes({ ...input, maxBytes: MAX_FILE_PREVIEW_BYTES });
    return { transfer_id: generateCanonicalId(), file: {
      handle_id: record.id, name: read.name, mime: read.mime, size: read.bytes.length, revision: record.contentRevision,
    }, preview_max_bytes: MAX_FILE_PREVIEW_BYTES, bytes: read.bytes };
  }

  async resolveFile(input: { deviceId: string; sessionId: string; reference: string }) {
    this.assertVisibleId(input.sessionId);
    if (input.reference.startsWith('attachment:')) {
      const filename = input.reference.slice('attachment:'.length);
      if (!filename || basename(filename) !== filename || filename.includes('\\') || filename.includes('\0')
        || !this.referencedAttachment?.(input.sessionId, filename)) {
        throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'attachment was not referenced by this conversation');
      }
      const path = resolveAttachmentPath(input.sessionId, filename);
      const info = path ? await lstat(path).catch(() => null) : null;
      if (!info?.isFile() || info.isSymbolicLink()) throw new RemoteProtocolError('ATTACHMENT_NOT_FOUND', 'attachment unavailable');
      if (info.size > MAX_ATTACHMENT_BYTES) throw new RemoteProtocolError('FILE_TOO_LARGE', 'attachment exceeds transfer limit');
      const record = this.issueSessionAttachment({ ...input, filename, contentRevision: fileRevision(info) });
      return { id: record.id, reference: input.reference, session_id: input.sessionId, name: filename,
        mime: previewMimeForAttachment(filename), size: info.size, revision: record.contentRevision,
        previewable: info.size <= MAX_FILE_PREVIEW_BYTES, downloadable: true, expires_at: record.expiresAt };
    }
    const existing = this.get(input.reference);
    if (existing && existing.deviceId === input.deviceId && existing.sessionId === input.sessionId) {
      const path = await this.resolveRecord(existing);
      const info = await lstat(path);
      if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES) throw new RemoteProtocolError('FILE_TOO_LARGE', 'file is not previewable');
      const renewed = this.issue({ deviceId: input.deviceId, sessionId: input.sessionId,
        relativePath: existing.relativePath, contentRevision: fileRevision(info) });
      return { id: renewed.id, session_id: input.sessionId, name: basename(path), mime: previewMimeForAttachment(path),
        size: info.size, revision: renewed.contentRevision, previewable: info.size <= MAX_FILE_PREVIEW_BYTES,
        downloadable: true, expires_at: renewed.expiresAt };
    }
    let reference: string;
    try { reference = decodeURIComponent(input.reference); } catch { throw new RemoteProtocolError('INVALID_FRAME', 'invalid file reference'); }
    reference = reference.replace(/:\d+(?::\d+)?$/, '');
    if (!reference || reference.includes('\0')) throw new RemoteProtocolError('INVALID_FRAME', 'invalid file reference');
    const root = this.workspacePath(input.sessionId);
    if (!root) throw new RemoteProtocolError('FILE_REFERENCE_EXPIRED', 'execution worktree unavailable');
    const requested = resolve(root, reference);
    let target: string;
    try { target = await realpath(requested); } catch { throw new RemoteProtocolError('RESOURCE_NOT_FOUND', 'file not found'); }
    const rootReal = await realpath(root);
    const rel = relative(rootReal, target);
    const inside = rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
    if (!inside && (!isAbsolute(reference) || !await this.referencedFile?.(input.sessionId, requested))) {
      throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'file was not referenced by this conversation');
    }
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'only regular files may be previewed');
    if (info.size > MAX_ATTACHMENT_BYTES) throw new RemoteProtocolError('FILE_TOO_LARGE', 'file exceeds transfer limit');
    const location = inside ? rel : EXTERNAL_FILE_PREFIX + Buffer.from(JSON.stringify({ target, requested })).toString('base64url');
    const record = this.issue({ deviceId: input.deviceId, sessionId: input.sessionId,
      relativePath: location, contentRevision: fileRevision(info) });
    return { id: record.id, session_id: input.sessionId, name: basename(target),
      mime: previewMimeForAttachment(target), size: info.size, revision: record.contentRevision,
      previewable: info.size <= MAX_FILE_PREVIEW_BYTES, downloadable: true, expires_at: record.expiresAt };
  }

  async tree(input: { sessionId: string; directory: string; after?: string }) {
    this.assertVisibleId(input.sessionId);
    const root = this.workspacePath(input.sessionId);
    if (!root || input.directory.includes('\0')) {
      throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'directory must be inside the execution worktree');
    }
    const directory = await resolveWithinWorkspace(root, input.directory || '.');
    if (!directory) throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'directory escaped worktree');
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      .filter(entry => !input.after || entry.name > input.after);
    return { entries: entries.slice(0, 200).map(entry => ({
      name: entry.name,
      reference: join(input.directory, entry.name),
      kind: entry.isDirectory() ? 'directory' as const : 'file' as const,
    })), has_more: entries.length > 200 };
  }

  async listFiles(sessionId: string, after?: string) {
    this.assertVisibleId(sessionId);
    const root = this.workspacePath(sessionId);
    if (!root) throw new RemoteProtocolError('FILE_REFERENCE_EXPIRED', 'execution worktree unavailable');
    let cached = this.listings.get(sessionId);
    if (!cached || cached.root !== root || cached.until <= Date.now()) {
      const files: string[] = [];
      let visited = 0;
      const walk = async (directory: string): Promise<void> => {
        if (++visited > 2000 || files.length >= 20_000) return;
        const absolute = await resolveWithinWorkspace(root, directory || '.');
        if (!absolute) return;
        const entries = await readdir(absolute, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || files.length >= 20_000) continue;
          const name = directory ? join(directory, entry.name) : entry.name;
          if (entry.isDirectory()) await walk(name);
          else if (entry.isFile()) files.push(name);
        }
      };
      await walk('');
      cached = { root, until: Date.now() + 5000, files: files.sort() };
      if (this.listings.size >= 16) this.listings.delete(this.listings.keys().next().value!);
      this.listings.set(sessionId, cached);
    }
    const remaining = cached.files.filter(file => !after || file > after);
    const references: string[] = [];
    let size = 0;
    for (const file of remaining) {
      const bytes = Buffer.byteLength(file);
      if (references.length >= 200 || size + bytes > 128 * 1024) break;
      references.push(file); size += bytes;
    }
    return { references, has_more: references.length < remaining.length };
  }

  private requireReference(deviceId: string, handleId: string): RemoteFileRefRecord {
    const record = this.get(handleId);
    if (!record || record.deviceId !== deviceId || Date.parse(record.expiresAt) <= Date.now()) {
      throw new RemoteProtocolError('FILE_REFERENCE_EXPIRED', 'file reference expired');
    }
    this.assertSessionVisible(record);
    return record;
  }

  private async resolveRecord(record: RemoteFileRefRecord): Promise<string> {
    if (record.relativePath.startsWith(EXTERNAL_FILE_PREFIX)) {
      const external = JSON.parse(Buffer.from(record.relativePath.slice(EXTERNAL_FILE_PREFIX.length), 'base64url').toString()) as {
        target: string; requested: string;
      };
      if (!isAbsolute(external.target) || !await this.referencedFile?.(record.sessionId, external.requested)
        || await realpath(external.requested) !== external.target) {
        throw new RemoteProtocolError('FILE_REFERENCE_EXPIRED', 'external file reference changed');
      }
      return external.target;
    }
    const attachment = this.attachmentFilename(record);
    if (attachment) {
      const path = resolveAttachmentPath(record.sessionId, attachment);
      if (!path) throw new RemoteProtocolError('ATTACHMENT_NOT_FOUND', 'attachment unavailable');
      return path;
    }
    const root = this.workspacePath(record.sessionId);
    if (!root) throw new RemoteProtocolError('FILE_REFERENCE_EXPIRED', 'execution worktree unavailable');
    const candidate = join(root, record.relativePath);
    const info = await lstat(candidate).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) throw new RemoteProtocolError('FILE_REFERENCE_EXPIRED', 'file unavailable');
    const path = await resolveWithinWorkspace(root, record.relativePath);
    if (!path) throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'file escaped worktree');
    return path;
  }

  private assertVisibleId(sessionId: string): void {
    if (this.sessionVisible && !this.sessionVisible(sessionId)) {
      throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'session is not available');
    }
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

function fileRevision(info: Stats): string {
  return 'fs:' + createHash('sha256').update([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')).digest('hex');
}
