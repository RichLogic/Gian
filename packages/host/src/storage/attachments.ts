import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveDataDir } from './paths.js';

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export const ALLOWED_MIME = new Set(Object.keys(MIME_EXT));
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function sessionDir(sessionId: string): string {
  return join(resolveDataDir(), 'attachments', sessionId);
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
