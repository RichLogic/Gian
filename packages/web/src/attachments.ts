import type { InputItem } from '@gian/shared';

const NATIVE_IMAGE_MIME = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export function isNativeImageMime(mime: string): boolean {
  return NATIVE_IMAGE_MIME.has(mime);
}

export interface ComposerAttachmentPayload {
  path: string;
  name: string;
  mime: string;
  size?: number;
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
