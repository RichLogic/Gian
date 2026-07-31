import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { resolveDataDir } from './paths.js';

const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const IMAGE_EXT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(IMAGE_MIME_EXT).map(([m, e]) => [e, m]),
);

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const FALLBACK_ATTACHMENT_MIME = 'application/octet-stream';

function sessionDir(sessionId: string, dataDir = resolveDataDir()): string {
  return join(dataDir, 'attachments', sessionId);
}

/** Ensure the session-owned attachment root exists and return its absolute
 *  path. Codex receives this as a runtime workspace root on every turn so a
 *  later `turn/steer` can read files uploaded while the turn is active. */
export async function ensureSessionAttachmentDir(
  sessionId: string,
  dataDir = resolveDataDir(),
): Promise<string> {
  const dir = sessionDir(sessionId, dataDir);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Resolve to the on-disk path inside the session's attachment dir, with a
 *  path-traversal guard. Returns null when `filename` escapes the session
 *  directory (e.g. `..`, absolute path, or symlink-like tricks via separators). */
export function resolveAttachmentPath(sessionId: string, filename: string): string | null {
  const dir = sessionDir(sessionId);
  const candidate = resolve(dir, filename);
  if (candidate !== resolve(dir, basename(candidate))) return null;
  if (dirname(candidate) !== resolve(dir)) return null;
  return candidate;
}

/** Guess MIME from the stored filename's extension. Images retain their exact
 *  MIME so they can render inline; all other files are deliberately served as
 *  opaque downloads rather than trusted same-origin content. */
export function mimeForAttachment(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return FALLBACK_ATTACHMENT_MIME;
  const ext = filename.slice(dot + 1).toLowerCase();
  return IMAGE_EXT_MIME[ext] ?? FALLBACK_ATTACHMENT_MIME;
}

/** Read attachment bytes by session + filename. Returns null when the file
 *  doesn't exist OR when the filename fails the traversal guard. */
export async function readAttachment(
  sessionId: string,
  filename: string,
): Promise<Buffer | null> {
  const p = resolveAttachmentPath(sessionId, filename);
  if (!p) return null;
  try {
    return await readFile(p);
  } catch {
    return null;
  }
}

export async function writeAttachment(
  sessionId: string,
  bytes: Buffer,
  mime: string,
  originalName?: string,
): Promise<string> {
  const imageExt = IMAGE_MIME_EXT[mime];
  const sourceExt = extname(basename(originalName ?? '')).toLowerCase();
  const sourceLooksLikeImage = Boolean(IMAGE_EXT_MIME[sourceExt.slice(1)]);
  const safeSourceExt = !sourceLooksLikeImage && /^\.[a-z0-9][a-z0-9._+-]{0,15}$/.test(sourceExt)
    ? sourceExt
    : '';
  const ext = imageExt ? `.${imageExt}` : (safeSourceExt || '.bin');
  const dir = await ensureSessionAttachmentDir(sessionId);
  const filename = `${randomUUID()}${ext}`;
  const path = join(dir, filename);
  await writeFile(path, bytes);
  return path;
}

export async function purgeSessionAttachments(sessionId: string): Promise<void> {
  await rm(sessionDir(sessionId), { recursive: true, force: true });
}
