import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveDataDir } from './paths.js';

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const EXT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXT).map(([m, e]) => [e, m]),
);

export const ALLOWED_MIME = new Set(Object.keys(MIME_EXT));
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function sessionDir(sessionId: string): string {
  return join(resolveDataDir(), 'attachments', sessionId);
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

/** Guess MIME from the stored filename's extension. We only ever write the
 *  four extensions in `MIME_EXT`, so the lookup is exhaustive — unknown
 *  returns null and callers should 404. */
export function mimeForAttachment(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXT_MIME[ext] ?? null;
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
): Promise<string> {
  const ext = MIME_EXT[mime];
  if (!ext) throw new Error(`unsupported mime ${mime}`);
  const dir = sessionDir(sessionId);
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  const path = join(dir, filename);
  await writeFile(path, bytes);
  return path;
}

export async function purgeSessionAttachments(sessionId: string): Promise<void> {
  await rm(sessionDir(sessionId), { recursive: true, force: true });
}
