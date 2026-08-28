import type { InputItem } from '@gian/shared';

/** Shared cap for Composer uploads and pre-session (New Session) staged files. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

const NATIVE_IMAGE_MIME = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export function isNativeImageMime(mime: string): boolean {
  return NATIVE_IMAGE_MIME.has(mime);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * De-duplicate an attachment display name against already-staged names:
 * `image.png` → `image-2.png` → `image-3.png` on collision. Clipboard
 * screenshots often arrive with the same name (`image.png`, or several
 * unnamed files in one paste sharing a timestamp), which made multiple
 * pasted images indistinguishable in the composer.
 */
export function dedupeAttachmentName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface ComposerAttachmentPayload {
  path: string;
  name: string;
  mime: string;
  size?: number;
}

/** Stable Host URL for an attachment that already lives in a Session store. */
export function servedAttachmentUrl(sessionId: string, path: string): string {
  const filename = path.split('/').pop() ?? path;
  return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(filename)}`;
}

export function attachmentInputItem(attachment: ComposerAttachmentPayload): InputItem {
  const metadata = {
    path: attachment.path,
    name: attachment.name,
    mime: attachment.mime,
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
  };
  return isNativeImageMime(attachment.mime)
    ? { type: 'localImage', ...metadata }
    : { type: 'localFile', ...metadata };
}
