import {
  RemoteProtocolError,
  base64UrlToBytes,
  downloadCompleteSchema,
  downloadMetadataSchema,
  parseClosed,
  parseContentChunk,
  sha256Hex,
} from './protocol.js';
export interface RemoteDownloadHandle { id: string; sessionId: string; label: string; dirLabel?: string; }

export interface DownloadTransfer {
  hostId: string;
  purpose: 'save' | 'preview';
  handle?: RemoteDownloadHandle;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  disposition: 'inline' | 'attachment';
  preview: boolean;
  nextSequence: number;
  nextOffset: number;
  chunks: Uint8Array[];
}

export function startDownload(input: {
  hostId: string;
  purpose: 'save' | 'preview';
  handle?: RemoteDownloadHandle;
  name: string;
  mime: string;
  size?: number;
}): DownloadTransfer {
  return {
    hostId: input.hostId,
    purpose: input.purpose,
    handle: input.handle,
    name: input.name,
    mime: input.mime,
    size: input.size ?? 0,
    sha256: '',
    disposition: 'attachment',
    preview: false,
    nextSequence: 0,
    nextOffset: 0,
    chunks: [],
  };
}

export function applyDownloadMetadata(
  current: DownloadTransfer | undefined,
  message: unknown,
  boundHostId: string,
): DownloadTransfer {
  const meta = parseClosed(downloadMetadataSchema, message);
  if (current && current.hostId !== boundHostId) {
    throw new RemoteProtocolError('INVALID_FRAME', 'download metadata host mismatch');
  }
  if (current?.sha256 && current.sha256 !== meta.sha256) {
    throw new RemoteProtocolError('INVALID_FRAME', 'download metadata sha256 changed');
  }
  if (current && current.size > 0 && current.size !== meta.size) {
    throw new RemoteProtocolError('INVALID_FRAME', 'download metadata size changed');
  }
  return {
    hostId: current?.hostId ?? boundHostId,
    purpose: current?.purpose ?? 'save',
    handle: current?.handle,
    name: meta.name,
    mime: meta.mime,
    size: meta.size,
    sha256: meta.sha256,
    disposition: meta.disposition,
    preview: meta.preview,
    nextSequence: current?.nextSequence ?? 0,
    nextOffset: current?.nextOffset ?? 0,
    chunks: current?.chunks ?? [],
  };
}

export function applyDownloadChunk(
  current: DownloadTransfer,
  message: unknown,
  transferId: string,
): DownloadTransfer {
  const chunk = parseContentChunk(message);
  if (chunk.transfer_id !== transferId) {
    throw new RemoteProtocolError('INVALID_FRAME', 'download chunk transfer mismatch');
  }
  if (!current.sha256) {
    throw new RemoteProtocolError('INVALID_FRAME', 'download metadata required');
  }
  if (chunk.transfer_sequence !== current.nextSequence) {
    throw new RemoteProtocolError('INVALID_FRAME', 'download chunk sequence');
  }
  if (chunk.offset !== current.nextOffset) {
    throw new RemoteProtocolError('INVALID_FRAME', 'download chunk offset');
  }
  const bytes = base64UrlToBytes(chunk.bytes);
  if (bytes.byteLength === 0) {
    throw new RemoteProtocolError('INVALID_FRAME', 'download chunk is empty');
  }
  const nextOffset = current.nextOffset + bytes.byteLength;
  if (nextOffset > current.size) {
    throw new RemoteProtocolError('INVALID_FRAME', 'download exceeds declared size');
  }
  return {
    ...current,
    nextSequence: current.nextSequence + 1,
    nextOffset,
    chunks: [...current.chunks, bytes],
  };
}

export async function completeDownload(
  current: DownloadTransfer,
  message: unknown,
): Promise<Uint8Array> {
  const done = parseClosed(downloadCompleteSchema, message);
  const bytes = concatDownloadBytes(current.chunks);
  if (bytes.byteLength !== current.nextOffset) {
    throw new RemoteProtocolError('INVALID_FRAME', 'download buffer drifted');
  }
  if (done.size !== current.size || bytes.byteLength !== current.size) {
    throw new RemoteProtocolError('INVALID_FRAME', 'download size mismatch');
  }
  const digest = await sha256Hex(bytes);
  if (digest !== done.sha256 || digest !== current.sha256) {
    throw new RemoteProtocolError('INVALID_FRAME', 'download sha256 mismatch');
  }
  return bytes;
}

export function previewMayComplete(
  current: DownloadTransfer,
  viewer: { handle: { id: string } } | null,
): boolean {
  if (current.purpose !== 'preview' || !current.handle || !viewer) return false;
  return viewer.handle.id === current.handle.id;
}

export function concatDownloadBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
