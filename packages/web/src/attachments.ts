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
