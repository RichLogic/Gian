import { describe, expect, it } from 'vitest';
import {
  bytesToBase64Url,
  generateCanonicalId,
  sha256Hex,
} from '@gian/remote-protocol';
import {
  applyDownloadChunk,
  applyDownloadMetadata,
  completeDownload,
  previewMayComplete,
  startDownload,
} from '../src/controller/download-transfer.js';

const hostId = '11111111-1111-4111-8111-111111111111';
const handle = { id: generateCanonicalId(), sessionId: generateCanonicalId(), label: 'notes.md' };

async function legalMeta(transferId: string, bytes: Uint8Array) {
  return {
    type: 'download.metadata' as const,
    transfer_id: transferId,
    name: 'notes.md',
    mime: 'text/plain',
    size: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    disposition: 'inline' as const,
    preview: true,
  };
}

describe('download transfer validation', () => {
  it('rejects metadata that omits sha256', () => {
    const transferId = generateCanonicalId();
    const current = startDownload({
      hostId,
      purpose: 'save',
      handle,
      name: 'notes.md',
      mime: 'text/plain',
    });
    expect(() => applyDownloadMetadata(current, {
      type: 'download.metadata',
      transfer_id: transferId,
      name: 'notes.md',
      mime: 'text/plain',
      size: 4,
    }, hostId)).toThrow(/closed schema/);
  });

  it('rejects out-of-order chunk sequence and offset', async () => {
    const transferId = generateCanonicalId();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const current = applyDownloadMetadata(
      startDownload({ hostId, purpose: 'save', handle, name: 'notes.md', mime: 'text/plain' }),
      await legalMeta(transferId, bytes),
      hostId,
    );
    expect(() => applyDownloadChunk(current, {
      type: 'attachment.chunk',
      transfer_id: transferId,
      transfer_sequence: 1,
      offset: 0,
      bytes: bytesToBase64Url(bytes),
    }, transferId)).toThrow(/sequence/);
    expect(() => applyDownloadChunk(current, {
      type: 'attachment.chunk',
      transfer_id: transferId,
      transfer_sequence: 0,
      offset: 2,
      bytes: bytesToBase64Url(bytes.subarray(0, 2)),
    }, transferId)).toThrow(/offset/);
  });

  it('rejects a truncated complete even when the hash matches the partial bytes', async () => {
    const transferId = generateCanonicalId();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const partial = bytes.subarray(0, 2);
    let current = applyDownloadMetadata(
      startDownload({ hostId, purpose: 'save', handle, name: 'notes.md', mime: 'text/plain' }),
      await legalMeta(transferId, bytes),
      hostId,
    );
    current = applyDownloadChunk(current, {
      type: 'attachment.chunk',
      transfer_id: transferId,
      transfer_sequence: 0,
      offset: 0,
      bytes: bytesToBase64Url(partial),
    }, transferId);
    await expect(completeDownload(current, {
      type: 'download.complete',
      transfer_id: transferId,
      size: partial.byteLength,
      sha256: await sha256Hex(partial),
    })).rejects.toThrow(/size/);
  });

  it('rejects a complete whose sha256 does not match the bytes', async () => {
    const transferId = generateCanonicalId();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    let current = applyDownloadMetadata(
      startDownload({ hostId, purpose: 'save', handle, name: 'notes.md', mime: 'text/plain' }),
      await legalMeta(transferId, bytes),
      hostId,
    );
    current = applyDownloadChunk(current, {
      type: 'attachment.chunk',
      transfer_id: transferId,
      transfer_sequence: 0,
      offset: 0,
      bytes: bytesToBase64Url(bytes),
    }, transferId);
    await expect(completeDownload(current, {
      type: 'download.complete',
      transfer_id: transferId,
      size: bytes.byteLength,
      sha256: await sha256Hex(new Uint8Array([9, 9, 9, 9])),
    })).rejects.toThrow(/sha256/);
  });

  it('lets a preview complete only for the current matching viewer', () => {
    const current = startDownload({
      hostId,
      purpose: 'preview',
      handle,
      name: 'notes.md',
      mime: 'text/plain',
    });
    expect(previewMayComplete(current, null)).toBe(false);
    expect(previewMayComplete(current, { handle })).toBe(true);
    expect(previewMayComplete(current, {
      handle: { ...handle, id: generateCanonicalId() },
    })).toBe(false);
    expect(previewMayComplete({ ...current, purpose: 'save' }, { handle })).toBe(false);
  });
});
