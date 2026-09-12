import { MAX_FILE_PREVIEW_BYTES, bytesToBase64Url } from '@gian/remote-protocol';
import type { FileViewerState, RemoteFileHandle } from './types.js';

export function viewerFromPreviewError(handle: RemoteFileHandle, code: string): FileViewerState {
  if (code === 'FILE_TOO_LARGE') {
    return { status: 'too_large', handle, limitLabel: `${MAX_FILE_PREVIEW_BYTES / (1024 * 1024)} MiB` };
  }
  if (code === 'FILE_REFERENCE_EXPIRED') {
    return { status: 'expired', handle };
  }
  return { status: 'error', handle, message: code };
}

export function viewerFromPreviewBytes(
  handle: RemoteFileHandle,
  bytes: Uint8Array,
  mime: string,
): FileViewerState {
  if (mime.startsWith('image/')) {
    const base64 = bytesToBase64Url(bytes)
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    return {
      status: 'image',
      handle,
      dataUrl: `data:${mime};base64,${base64}${'='.repeat((4 - base64.length % 4) % 4)}`,
      mime,
    };
  }
  if (!isTextMime(mime) || looksBinary(bytes)) {
    return { status: 'binary', handle };
  }
  return {
    status: 'ready',
    handle,
    text: new TextDecoder().decode(bytes),
    sizeLabel: `${bytes.byteLength} B`,
  };
}

function isTextMime(mime: string): boolean {
  return mime.startsWith('text/')
    || mime === 'application/json'
    || mime === 'application/x-ndjson'
    || mime === 'application/yaml'
    || mime === 'application/toml';
}

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8000);
  return sample.includes(0);
}
